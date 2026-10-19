import {
  createAnalysisExecution,
  type AnalysisExecution,
  type ExecutionOptions,
} from "../application/AnalysisProvider.js";
import type { SqliteDatabasePort } from "../application/sqlite/SqliteDatabasePort.js";
import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
} from "../artifacts/AnalysisCleanupLease.js";
import {
  ArtifactResourceRetryFailure,
  ArtifactResourceScope,
} from "../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import type {
  AnalysisCapturedOutput,
  AnalysisError,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { createEvidence } from "../domain/evidence.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  inspectSqliteDatabaseInputSchema,
  sqliteDatabaseSchema,
  type InspectSqliteDatabaseInput,
  SQLITE_PROVIDER_IDENTITY,
  sqliteInspectionParameters,
} from "../domain/sqlite/sqliteDatabase.js";
import { isAbsolute } from "node:path";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import {
  OwnedCommandFailure,
  ownedCommandResources,
} from "../process/OwnedCommand.js";
import type {
  ProviderProcessStopResult,
  ProviderProcessSupervisor,
} from "../process/ProviderProcess.js";
import { sqliteDatabaseFailure } from "./SqliteDatabaseFailures.js";
import { captureSqliteDatabaseSnapshot } from "./SqliteDatabaseSnapshot.js";
import { SQLITE_DATABASE_LIMITS } from "./SqliteDatabaseLimits.js";

import {
  executeSqliteDatabaseWorker,
  type SqliteWorkerLauncher,
} from "./SqliteDatabaseWorkerExecution.js";

const operation = "inspect_sqlite_database";
type SqliteOutcome = Result<AnalysisExecution, AnalysisError>;
type SqliteRuntimeRoot = Pick<PrivateRuntimeRoot, "path" | "close">;
interface PendingSnapshotCleanup {
  readonly input: InspectSqliteDatabaseInput;
  readonly result: SqliteOutcome;
  readonly output: AnalysisCapturedOutput | undefined;
  process: ProviderProcessSupervisor | undefined;
  readonly lease: AnalysisCleanupLease;
}
/** Inspect a provider-owned copy through a cancellable SQLite child, without source writes. */
export class SqliteDatabaseProvider implements SqliteDatabasePort {
  readonly #active = new Set<Promise<SqliteOutcome>>();
  readonly #artifactResources: ArtifactResourceScope;
  readonly #pendingCleanup = new Map<
    SqliteRuntimeRoot,
    PendingSnapshotCleanup
  >();
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #retryPromise: Promise<Result<null, AnalysisError>> | undefined;
  constructor(
    readonly environment: Readonly<NodeJS.ProcessEnv> = process.env,
    readonly launcher?: SqliteWorkerLauncher,
    readonly createRuntime: () => Promise<
      Pick<PrivateRuntimeRoot, "path" | "close">
    > = () => PrivateRuntimeRoot.create({ prefix: "rea-sqlite-database-" }),
    artifactResources: ArtifactResourceScope = new ArtifactResourceScope(),
  ) {
    this.#artifactResources = artifactResources;
  }

  /** Return exact original DB/WAL identities and current schema/selected committed rows. */
  async inspect(
    input: InspectSqliteDatabaseInput,
    options?: ExecutionOptions,
  ): Promise<SqliteOutcome> {
    if (this.#closed || options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    if (this.#active.size >= SQLITE_DATABASE_LIMITS.concurrentInspections)
      return err(
        new AnalysisResourceConstraintError(
          operation,
          "capacity",
          "SQLite inspection capacity is occupied. Retry after an active inspection completes.",
          {
            active_inspections: this.#active.size,
            max_concurrent_inspections:
              SQLITE_DATABASE_LIMITS.concurrentInspections,
            input_bytes_per_inspection: SQLITE_DATABASE_LIMITS.inputBytes,
          },
          {
            remediationAction:
              "Retry after an active SQLite inspection completes.",
          },
        ),
      );
    const inspection = this.#artifactResources
      .run(() => this.#inspect(input, options))
      .catch((cause: unknown) =>
        err(
          selectedFailure(
            sqliteDatabaseFailure(
              cause,
              input.path,
              "artifact-read",
              options?.signal,
            ),
            options?.signal,
          ),
        ),
      );
    this.#active.add(inspection);
    try {
      return await inspection;
    } finally {
      this.#active.delete(inspection);
    }
  }

  /** Await inspections and retry retained descriptors, workers, and snapshot roots. */
  close(): Promise<void> {
    this.#closed = true;
    this.#closePromise ??= Promise.allSettled(this.#active)
      .then(async () => {
        let descriptorFailure: AnalysisError | undefined;
        try {
          await this.#artifactResources.close();
        } catch (cause: unknown) {
          const cleanup = ArtifactReaderFailure.cleanupObservation(
            cause,
            "SQLite artifact descriptors",
          );
          descriptorFailure = new ProviderCleanupError(
            SQLITE_PROVIDER_IDENTITY.id,
            cleanup.resources,
            { reason: cleanup.reason },
            { operation, cause },
          );
          // A synthesized descriptor failure must resolve with its artifact
          // leases: without the binding a later close() that releases every
          // descriptor leaves the caller's error reporting incomplete cleanup
          // and its stale descriptor paths forever.
          if (
            cause instanceof ArtifactResourceRetryFailure &&
            cause.cleanupLeases.length > 0
          )
            new AnalysisCleanupLeaseGroup(descriptorFailure, [
              ...cause.cleanupLeases,
            ]);
        }
        const cleaned = await this.#retryCleanup();
        if (descriptorFailure !== undefined && !cleaned.ok)
          throw new ProviderCleanupError(
            SQLITE_PROVIDER_IDENTITY.id,
            [
              ...descriptorFailure.cleanupResources,
              ...cleaned.error.cleanupResources,
            ],
            {
              failures: [
                projectAnalysisError(descriptorFailure),
                projectAnalysisError(cleaned.error),
              ],
            },
            { operation },
          ).bindCleanupDependencies([descriptorFailure, cleaned.error]);
        if (descriptorFailure !== undefined) throw descriptorFailure;
        if (!cleaned.ok) throw cleaned.error;
      })
      .catch((cause: unknown) => {
        this.#closePromise = undefined;
        throw cause;
      });
    return this.#closePromise;
  }

  #retryCleanup(): Promise<Result<null, AnalysisError>> {
    this.#retryPromise ??= this.#cleanupPending().finally(() => {
      this.#retryPromise = undefined;
    });
    return this.#retryPromise;
  }

  /** Live attribution for one retained root: worker resources, then the root, then nothing. */
  #resourcesFor(root: SqliteRuntimeRoot): readonly string[] {
    const pending = this.#pendingCleanup.get(root);
    if (pending === undefined) return [];
    if (pending.process !== undefined) {
      const ownership = pending.process.launch.ownership;
      return ownership === undefined
        ? ["owned-sqlite-worker", root.path]
        : ownedCommandResources(ownership, root.path);
    }
    return [root.path];
  }

  /** Retain a root and its worker under one lease, so returned errors track the exact owner. */
  #retainPending(
    root: SqliteRuntimeRoot,
    pending: {
      readonly input: InspectSqliteDatabaseInput;
      readonly result: SqliteOutcome;
      readonly output: AnalysisCapturedOutput | undefined;
      process: ProviderProcessSupervisor | undefined;
    },
  ): AnalysisCleanupLease {
    const retained = this.#pendingCleanup.get(root);
    if (retained !== undefined) {
      this.#pendingCleanup.set(root, { ...pending, lease: retained.lease });
      return retained.lease;
    }
    const provider = this;
    const lease = new AnalysisCleanupLease(
      () => provider.#releaseRetained(root),
      {
        get cleanupResources() {
          return provider.#resourcesFor(root);
        },
      },
    );
    this.#pendingCleanup.set(root, { ...pending, lease });
    return lease;
  }

  /** Release one retained root: confirm its worker has stopped, then remove the snapshot. */
  async #releaseRetained(root: SqliteRuntimeRoot): Promise<void> {
    const pending = this.#pendingCleanup.get(root);
    if (pending === undefined) return;
    if (pending.process !== undefined) {
      const stopped = await pending.process.stop();
      if (stopped.status === "incomplete") {
        throw new ProviderCleanupError(
          SQLITE_PROVIDER_IDENTITY.id,
          [
            pending.process.launch.ownership?.runId ?? "owned-sqlite-worker",
            root.path,
          ],
          {
            reason: stopped.reason,
            previous_error: pending.result.ok
              ? null
              : projectAnalysisError(pending.result.error),
            ...(pending.output === undefined
              ? {}
              : { captured_output: { ...pending.output } }),
          },
          { operation },
        );
      }
      pending.process = undefined;
    }
    const cleaned = await cleanupSqliteRoot(
      root,
      pending.result,
      pending.input,
      pending.output,
    );
    if (!cleaned.ok) throw cleaned.error;
    this.#pendingCleanup.delete(root);
  }

  async #cleanupPending(): Promise<Result<null, AnalysisError>> {
    const failures: AnalysisError[] = [];
    for (const [root, pending] of [...this.#pendingCleanup]) {
      try {
        await pending.lease.release();
      } catch (cause: unknown) {
        const failure =
          cause instanceof ProviderCleanupError
            ? cause
            : new ProviderCleanupError(
                SQLITE_PROVIDER_IDENTITY.id,
                this.#resourcesFor(root),
                {
                  reason:
                    cause instanceof Error ? cause.message : String(cause),
                },
                { operation, cause },
              );
        // The lease stays bound across retries, so this failure resolves and
        // its resource list empties when the exact owner later confirms release.
        new AnalysisCleanupLeaseGroup(failure, [pending.lease]);
        failures.push(failure);
      }
    }
    if (failures.length === 1 && failures[0] !== undefined)
      return err(failures[0]);
    return failures.length === 0
      ? ok(null)
      : err(
          new ProviderCleanupError(
            SQLITE_PROVIDER_IDENTITY.id,
            failures.flatMap((failure) => failure.cleanupResources),
            { failures: failures.map(projectAnalysisError) },
            { operation },
          ).bindCleanupDependencies(failures),
        );
  }

  async #inspect(
    input: InspectSqliteDatabaseInput,
    options?: ExecutionOptions,
  ): Promise<SqliteOutcome> {
    let root: Pick<PrivateRuntimeRoot, "path" | "close"> | undefined;
    let processOwner: ProviderProcessSupervisor | undefined;
    let processCleanup:
      | Extract<ProviderProcessStopResult, { status: "incomplete" }>
      | undefined;
    let retainedOutput: AnalysisCapturedOutput | undefined;
    let phase = "configuration";
    let result: Result<AnalysisExecution, AnalysisError>;
    try {
      if (options?.signal?.aborted) throw new AnalysisCancelledError(operation);
      validateSqliteInput(input);
      const retired = await this.#retryCleanup();
      if (!retired.ok) return retired;
      if (this.#closed || options?.signal?.aborted)
        throw new AnalysisCancelledError(operation);
      root = await this.createRuntime();
      phase = "artifact-read";
      const snapshot = await captureSqliteDatabaseSnapshot(
        input.path,
        root.path,
        this.#artifactResources,
        options?.signal,
      );
      phase = "worker";
      const inspection = await executeSqliteDatabaseWorker({
        input,
        root: root.path,
        snapshotPath: snapshot.snapshotPath,
        environment: this.environment,
        resourceScope: this.#artifactResources,
        ...(this.launcher === undefined ? {} : { launcher: this.launcher }),
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
        captured: (output) => {
          retainedOutput = output;
        },
        retainCleanup: (owner, result) => {
          processOwner = owner;
          processCleanup = result;
        },
      });
      const validated = sqliteDatabaseSchema.safeParse({
        artifact: snapshot.artifact,
        wal: snapshot.wal,
        ...inspection,
      });
      if (!validated.success)
        throw new AnalysisOutputError(
          operation,
          "SQLite worker report dimensions or identity fields are invalid",
          retainedOutput === undefined
            ? undefined
            : { capturedOutput: retainedOutput },
        );
      result = ok(createSqliteObservation(validated.data, input.path));
    } catch (cause: unknown) {
      // A failure rethrown after retainCleanup carries no owner of its own;
      // keep the retained worker instead of discarding it.
      if (
        cause instanceof OwnedCommandFailure &&
        cause.cleanupOwner !== undefined
      )
        processOwner = cause.cleanupOwner;
      const failure = sqliteDatabaseFailure(
        cause,
        input.path,
        phase,
        options?.signal,
      );
      retainedOutput ??= failure.capturedOutput;
      result = err(selectedFailure(failure, options?.signal, retainedOutput));
    }
    if (root !== undefined) {
      if (processOwner !== undefined) {
        const lease = this.#retainPending(root, {
          input,
          result,
          output: retainedOutput,
          process: processOwner,
        });
        if (processCleanup !== undefined) {
          const ownership = processOwner.launch.ownership;
          const failure = sqliteCleanupFailure(
            ownership === undefined
              ? ["owned-sqlite-worker", root.path]
              : ownedCommandResources(ownership, root.path),
            processCleanup.reason,
            result,
            input,
            retainedOutput,
            processCleanup.cleanupResult === undefined
              ? undefined
              : {
                  ...(processCleanup.cleanupResult.failures === undefined
                    ? {}
                    : {
                        failures: processCleanup.cleanupResult.failures.map(
                          (failure) => ({ ...failure }),
                        ),
                      }),
                  ...(processCleanup.cleanupResult.unverified === undefined
                    ? {}
                    : {
                        unverified: processCleanup.cleanupResult.unverified.map(
                          (process) => ({ ...process }),
                        ),
                      }),
                },
          );
          new AnalysisCleanupLeaseGroup(failure, [lease]);
          return err(failure);
        }
        // A failure rethrown with a retained owner reports the same worker and
        // root; bind it too so a later confirmed release clears it.
        if (!result.ok && result.error.cleanupIncomplete)
          new AnalysisCleanupLeaseGroup(result.error, [lease]);
        return result;
      }
      const cleaned = await cleanupSqliteRoot(
        root,
        result,
        input,
        retainedOutput,
      );
      if (!cleaned.ok) {
        const lease = this.#retainPending(root, {
          input,
          result,
          output: retainedOutput,
          process: undefined,
        });
        // The wrapper embeds any prior cleanup failure as previous_error;
        // keep that failure as a separate cleanup dependency so the wrapper
        // resolves only after both the root retry and the prior failure release.
        new AnalysisCleanupLeaseGroup(cleaned.error, [lease]);
        if (!result.ok && result.error.cleanupIncomplete)
          cleaned.error.bindCleanupDependencies([result.error]);
        return cleaned;
      }
    }
    // Completion was acknowledged before cleanup. A later abort does not erase it.
    return result;
  }
}

const selectedFailure = (
  failure: AnalysisError,
  signal?: AbortSignal,
  output?: AnalysisCapturedOutput,
): AnalysisError =>
  signal?.aborted &&
  failure._tag !== "AnalysisCancelledError" &&
  !failure.cleanupIncomplete
    ? new AnalysisCancelledError(
        operation,
        output === undefined ? undefined : { capturedOutput: output },
      )
    : failure;
const createSqliteObservation = (
  report: ReturnType<typeof sqliteDatabaseSchema.parse>,
  path: string,
): AnalysisExecution => {
  const locations: AnalysisExecution["locations"][number][] = [
    { kind: "artifact-path", path },
  ];
  if (report.wal !== null)
    locations.push({ kind: "artifact-path", path: report.wal.path });
  return createAnalysisExecution(
    report,
    { ...SQLITE_PROVIDER_IDENTITY, version: `SQLite ${report.engine.version}` },
    {
      rawResult: null,
      subject: { path, format: "file", sha256: report.artifact.sha256 },
      locations,
      limitations: report.limitations,
    },
  );
};
const cleanupSqliteRoot = async (
  root: Pick<PrivateRuntimeRoot, "path" | "close">,
  result: Result<AnalysisExecution, AnalysisError>,
  input: InspectSqliteDatabaseInput,
  output?: AnalysisCapturedOutput,
): Promise<Result<null, AnalysisError>> => {
  try {
    await root.close();
    return ok(null);
  } catch (cause: unknown) {
    return err(
      sqliteCleanupFailure(
        [root.path],
        cause instanceof Error ? cause.message : String(cause),
        result,
        input,
        output,
        undefined,
        cause,
      ),
    );
  }
};

const sqliteCleanupFailure = (
  resources: readonly string[],
  reason: string,
  result: SqliteOutcome,
  input: InspectSqliteDatabaseInput,
  output?: AnalysisCapturedOutput,
  details?: Readonly<Record<string, JsonValue>>,
  cause?: unknown,
): ProviderCleanupError => {
  const partialObservation = result.ok
    ? createEvidence(result.value.subject ?? undefined, result.value.provider, {
        operation,
        parameters: sqliteInspectionParameters(input),
        result: result.value.result,
        confidence: "observed",
        locations: result.value.locations,
        limitations: result.value.limitations,
      })
    : result.error.partialObservation;
  return new ProviderCleanupError(
    SQLITE_PROVIDER_IDENTITY.id,
    resources,
    {
      ...details,
      reason,
      previous_error: result.ok ? null : projectAnalysisError(result.error),
      ...(output === undefined ? {} : { captured_output: { ...output } }),
    },
    {
      operation,
      ...(cause === undefined ? {} : { cause }),
      ...(partialObservation === undefined ? {} : { partialObservation }),
    },
  );
};

const validateSqliteInput = (input: InspectSqliteDatabaseInput): void => {
  const parsed = inspectSqliteDatabaseInputSchema.safeParse(input);
  if (!parsed.success || !isAbsolute(input.path))
    throw new AnalysisInputError(operation, undefined, [
      {
        path: ["path"],
        reason: "invalid_format",
        message: parsed.success
          ? "path must be an absolute local filesystem path"
          : parsed.error.message,
      },
    ]);
};

