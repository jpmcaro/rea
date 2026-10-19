import { access } from "node:fs/promises";
import { expect, it, onTestFinished } from "vitest";
import { SqliteDatabaseProvider } from "../../../src/sqlite/SqliteDatabaseProvider.js";
import { PrivateRuntimeRoot } from "../../../src/process/PrivateRuntimeRoot.js";
import { OwnedCommandFailure } from "../../../src/process/OwnedCommand.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../../../src/process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../../../src/process/ProcessOwnership.js";
import {
  spawnProviderProcessFixture,
  stopProviderProcessFixture,
  waitForProviderProcessReady,
} from "../../fixtures/providerProcess.js";
import { createDeferred } from "../../fixtures/binarySession.js";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { createSqliteDatabaseFixture } from "../../fixtures/sqlite/database.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../support/workspace/workspaceFixture.js";

const createUnavailableProvider = (
  createRuntime: SqliteDatabaseProvider["createRuntime"],
) =>
  new SqliteDatabaseProvider(
    {},
    () => {
      throw new Error("SQLite worker deliberately unavailable");
    },
    createRuntime,
  );

const cleanupFixture = async () => {
  const workspace = await createTestWorkspace("rea-sqlite-cleanup-");
  const database = createSqliteDatabaseFixture(workspace.root);
  database.close();
  const roots: PrivateRuntimeRoot[] = [];
  let removalAllowed = false;
  let attempts = 0;
  const provider = createUnavailableProvider(async () => {
    const root = await PrivateRuntimeRoot.create({ parent: workspace.root });
    roots.push(root);
    return {
      path: root.path,
      close: async () => {
        attempts += 1;
        if (!removalAllowed) throw new Error("snapshot removal denied");
        await root.close();
      },
    };
  });
  onTestFinished(async () => {
    await Promise.all(roots.map((root) => root.close()));
    await removeTestWorkspace(workspace.root);
  });
  return {
    provider,
    roots,
    path: database.path,
    allowRemoval: () => {
      removalAllowed = true;
    },
    attempts: () => attempts,
  };
};

it("retains failed snapshot owners and blocks new acquisition until retry succeeds", async () => {
  const fixture = await cleanupFixture();
  const first = await fixture.provider.inspect({ path: fixture.path });
  expect(first).toMatchObject({
    ok: false,
    error: { cleanupIncomplete: true },
  });
  const root = fixture.roots[0];
  if (root === undefined) throw new Error("Missing owned root");
  await expect(access(root.path)).resolves.toBeUndefined();
  const second = await fixture.provider.inspect({ path: fixture.path });
  expect(second).toMatchObject({
    ok: false,
    error: { cleanupIncomplete: true },
  });
  expect(fixture.roots).toHaveLength(1);
  expect(fixture.attempts()).toBe(2);
  fixture.allowRemoval();
  await fixture.provider.inspect({ path: fixture.path });
  expect(fixture.roots).toHaveLength(2);
  await expect(access(root.path)).rejects.toMatchObject({ code: "ENOENT" });
  await fixture.provider.close();
});

it("awaits shared shutdown cleanup and retains failures for a later close", async () => {
  const fixture = await cleanupFixture();
  await fixture.provider.inspect({ path: fixture.path });
  const closed = await Promise.allSettled([
    fixture.provider.close(),
    fixture.provider.close(),
  ]);
  expect(closed.map((result) => result.status)).toEqual([
    "rejected",
    "rejected",
  ]);
  expect(fixture.attempts()).toBe(2);
  expect(await fixture.provider.inspect({ path: fixture.path })).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
  fixture.allowRemoval();
  await fixture.provider.close();
  await fixture.provider.close();
  expect(fixture.attempts()).toBe(3);
  for (const root of fixture.roots)
    await expect(access(root.path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("waits for concurrent acquisitions and releases only owners whose cleanup succeeds", async () => {
  const workspace = await createTestWorkspace("rea-sqlite-concurrent-cleanup-");
  const database = createSqliteDatabaseFixture(workspace.root);
  database.close();
  const acquired = createDeferred<void>();
  const release = createDeferred<void>();
  const roots: PrivateRuntimeRoot[] = [];
  const allowed = new Set<PrivateRuntimeRoot>();
  const provider = createUnavailableProvider(async () => {
    const root = await PrivateRuntimeRoot.create({ parent: workspace.root });
    roots.push(root);
    if (roots.length === 2) acquired.resolve();
    await release.promise;
    return {
      path: root.path,
      close: async () => {
        if (!allowed.has(root)) throw new Error("snapshot removal denied");
        await root.close();
      },
    };
  });
  onTestFinished(async () => {
    release.resolve();
    roots.forEach((root) => allowed.add(root));
    await provider.close();
    await removeTestWorkspace(workspace.root);
  });
  const inspections = [
    provider.inspect({ path: database.path }),
    provider.inspect({ path: database.path }),
  ];
  await acquired.promise;
  // Two admitted snapshots occupy capacity even before the worker launches.
  expect(await provider.inspect({ path: database.path })).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError", resource: "capacity" },
  });
  expect(roots).toHaveLength(2);
  expect(
    await provider.inspect(
      { path: database.path },
      { signal: AbortSignal.abort() },
    ),
  ).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
  let settled = false;
  const closing = provider.close().finally(() => {
    settled = true;
  });
  const rejected = expect(closing).rejects.toMatchObject({
    cleanupIncomplete: true,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  release.resolve();
  await Promise.all(inspections);
  await rejected;
  const [first, second] = roots;
  if (first === undefined || second === undefined)
    throw new Error("Missing owned roots");
  allowed.add(first);
  await expect(provider.close()).rejects.toMatchObject({
    cleanupResources: [second.path],
  });
  await expect(access(first.path)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(second.path)).resolves.toBeUndefined();
  allowed.add(second);
  await provider.close();
  await expect(access(second.path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("retains the snapshot until a failed worker cleanup owner can be stopped", async () => {
  const workspace = await createTestWorkspace("rea-sqlite-worker-cleanup-");
  const database = createSqliteDatabaseFixture(workspace.root);
  database.close();
  const child = spawnProviderProcessFixture("graceful");
  let workerRemovalAllowed = false;
  let rootRemovalAllowed = false;
  let workerAttempts = 0;
  let rootAttempts = 0;
  const roots: PrivateRuntimeRoot[] = [];
  const supervisor = new ProviderProcessSupervisor({
    process: child,
    ownsProcessLifetime: true,
    cleanup: async () => {
      workerAttempts += 1;
      if (!workerRemovalAllowed)
        return { cleaned: false, reason: "SQLite worker cleanup denied" };
      await stopProviderProcessFixture(child);
      return { cleaned: true, signaled: true };
    },
  });
  const provider = new SqliteDatabaseProvider(
    {},
    async (spawn) => {
      const stopped = await supervisor.stop();
      if (stopped.status !== "incomplete")
        throw new Error("Expected retained worker");
      throw new OwnedCommandFailure(
        "process",
        "SQLite worker cleanup failed",
        supervisor.snapshot(),
        stopped.reason,
        undefined,
        [spawn.runId, spawn.cwd ?? ""],
        supervisor,
      );
    },
    async () => {
      const root = await PrivateRuntimeRoot.create({ parent: workspace.root });
      roots.push(root);
      return {
        path: root.path,
        close: async () => {
          rootAttempts += 1;
          if (!rootRemovalAllowed)
            throw new Error("SQLite snapshot removal denied");
          await root.close();
        },
      };
    },
  );
  onTestFinished(async () => {
    workerRemovalAllowed = true;
    rootRemovalAllowed = true;
    await supervisor.stop();
    await provider.close();
    await Promise.all(roots.map((root) => root.close()));
    await removeTestWorkspace(workspace.root);
  });
  await waitForProviderProcessReady(child);
  expect(await provider.inspect({ path: database.path })).toMatchObject({
    ok: false,
    error: { cleanupIncomplete: true },
  });
  // The snapshot cannot be removed while its worker may still use it.
  expect(rootAttempts).toBe(0);
  const root = roots[0];
  if (root === undefined) throw new Error("Missing retained snapshot");
  await expect(access(root.path)).resolves.toBeUndefined();
  expect(await provider.inspect({ path: database.path })).toMatchObject({
    ok: false,
    error: { cleanupIncomplete: true },
  });
  expect(roots).toHaveLength(1);
  expect(workerAttempts).toBe(2);
  await expect(provider.close()).rejects.toMatchObject({
    cleanupIncomplete: true,
  });
  expect(rootAttempts).toBe(0);
  workerRemovalAllowed = true;
  await expect(provider.close()).rejects.toMatchObject({
    cleanupResources: [root.path],
  });
  expect(child.signalCode).toBe("SIGKILL");
  expect(workerAttempts).toBe(4);
  expect(rootAttempts).toBe(1);
  rootRemovalAllowed = true;
  await provider.close();
  expect(workerAttempts).toBe(4);
  await expect(access(root.path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps a retained worker owner when the worker fails and its cleanup is unresolved", async () => {
  const workspace = await createTestWorkspace("rea-sqlite-retained-worker-");
  const database = createSqliteDatabaseFixture(workspace.root);
  database.close();
  let mayClean = false;
  let launches = 0;
  // runOwnedCommand retains the incomplete cleanup and then rethrows the
  // worker failure without an owner of its own.
  const provider = new SqliteDatabaseProvider({}, async (spawn) => {
    launches += 1;
    const launched = await spawnOwnedProviderProcess({
      ...spawn,
      command: process.execPath,
      arguments: ["-e", "process.exit(3)"],
    });
    const cleanupOwned =
      launched.cleanup ?? (() => cleanupOwnedProcessGroup(launched.ownership));
    return {
      ...launched,
      cleanup: async () => {
        const cleaned = await cleanupOwned();
        if (!mayClean) throw new Error("injected retained cleanup failure");
        return cleaned;
      },
    };
  });
  onTestFinished(async () => {
    mayClean = true;
    await provider.close();
    await removeTestWorkspace(workspace.root);
  });
  expect(await provider.inspect({ path: database.path })).toMatchObject({
    ok: false,
    error: { cleanupIncomplete: true },
  });
  // The retained owner blocks a new worker until its cleanup succeeds.
  expect(await provider.inspect({ path: database.path })).toMatchObject({
    ok: false,
    error: { cleanupIncomplete: true },
  });
  expect(launches).toBe(1);
  mayClean = true;
  await provider.close();
});

it("resolves a returned cleanup error once its retained root is released", async () => {
  const fixture = await cleanupFixture();
  const first = await fixture.provider.inspect({ path: fixture.path });
  if (first.ok) throw new Error("Expected the denied removal to fail cleanup");
  expect(first.error.cleanupIncomplete).toBe(true);
  const root = fixture.roots[0];
  if (root === undefined) throw new Error("Missing owned root");
  expect(first.error.cleanupResources).toEqual([root.path]);

  fixture.allowRemoval();
  await fixture.provider.close();

  // The exact owner confirmed release, so the error the caller kept no longer
  // reports the removed root as unresolved.
  expect(first.error.cleanupIncomplete).toBe(false);
  expect(first.error.cleanupResources).toEqual([]);
});

it("shrinks a bound error's resources as each owner releases, then resolves it", async () => {
  const workspace = await createTestWorkspace("rea-sqlite-owner-release-");
  const database = createSqliteDatabaseFixture(workspace.root);
  database.close();
  const child = spawnProviderProcessFixture("graceful");
  let workerRemovalAllowed = false;
  let rootRemovalAllowed = false;
  const roots: PrivateRuntimeRoot[] = [];
  const supervisor = new ProviderProcessSupervisor({
    process: child,
    ownsProcessLifetime: true,
    cleanup: async () => {
      if (!workerRemovalAllowed)
        return { cleaned: false, reason: "SQLite worker cleanup denied" };
      await stopProviderProcessFixture(child);
      return { cleaned: true, signaled: true };
    },
  });
  const provider = new SqliteDatabaseProvider(
    {},
    async (spawn) => {
      const stopped = await supervisor.stop();
      if (stopped.status !== "incomplete")
        throw new Error("Expected retained worker");
      throw new OwnedCommandFailure(
        "process",
        "SQLite worker cleanup failed",
        supervisor.snapshot(),
        stopped.reason,
        undefined,
        [spawn.runId, spawn.cwd ?? ""],
        supervisor,
      );
    },
    async () => {
      const root = await PrivateRuntimeRoot.create({ parent: workspace.root });
      roots.push(root);
      return {
        path: root.path,
        close: async () => {
          if (!rootRemovalAllowed)
            throw new Error("SQLite snapshot removal denied");
          await root.close();
        },
      };
    },
  );
  onTestFinished(async () => {
    workerRemovalAllowed = true;
    rootRemovalAllowed = true;
    await supervisor.stop();
    await provider.close();
    await Promise.all(roots.map((root) => root.close()));
    await removeTestWorkspace(workspace.root);
  });
  await waitForProviderProcessReady(child);
  const first = await provider.inspect({ path: database.path });
  if (first.ok) throw new Error("Expected the retained worker to fail cleanup");
  expect(first.error.cleanupIncomplete).toBe(true);
  const root = roots[0];
  if (root === undefined) throw new Error("Missing retained snapshot");
  // Worker and root are both pending, so both owners are reported.
  expect(first.error.cleanupResources.length).toBeGreaterThan(1);
  expect(first.error.cleanupResources).toContain(root.path);

  // The worker confirms release while the root is still denied: the error the
  // caller kept drops only the worker's resources and stays incomplete.
  workerRemovalAllowed = true;
  await expect(provider.close()).rejects.toMatchObject({
    cleanupIncomplete: true,
  });
  expect(first.error.cleanupIncomplete).toBe(true);
  expect(first.error.cleanupResources).toEqual([root.path]);

  rootRemovalAllowed = true;
  await provider.close();
  expect(first.error.cleanupIncomplete).toBe(false);
  expect(first.error.cleanupResources).toEqual([]);
});

it("tracks every unresolved owner in a close aggregate until each root releases", async () => {
  const workspace = await createTestWorkspace("rea-sqlite-aggregate-owners-");
  const database = createSqliteDatabaseFixture(workspace.root);
  database.close();
  const acquired = createDeferred<void>();
  const release = createDeferred<void>();
  const roots: PrivateRuntimeRoot[] = [];
  const allowed = new Set<PrivateRuntimeRoot>();
  const provider = createUnavailableProvider(async () => {
    const root = await PrivateRuntimeRoot.create({ parent: workspace.root });
    roots.push(root);
    if (roots.length === 2) acquired.resolve();
    await release.promise;
    return {
      path: root.path,
      close: async () => {
        if (!allowed.has(root)) throw new Error("snapshot removal denied");
        await root.close();
      },
    };
  });
  onTestFinished(async () => {
    release.resolve();
    roots.forEach((root) => allowed.add(root));
    await provider.close();
    await removeTestWorkspace(workspace.root);
  });
  const inspections = [
    provider.inspect({ path: database.path }),
    provider.inspect({ path: database.path }),
  ];
  await acquired.promise;
  release.resolve();
  for (const settled of await Promise.all(inspections)) {
    if (settled.ok)
      throw new Error("Expected the denied removals to fail cleanup");
    expect(settled.error.cleanupIncomplete).toBe(true);
  }
  const [first, second] = roots;
  if (first === undefined || second === undefined)
    throw new Error("Missing owned roots");

  const aggregate = await provider.close().catch((cause: unknown) => cause);
  expect(aggregate).toMatchObject({ cleanupIncomplete: true });
  expect(aggregate.cleanupResources).toEqual([first.path, second.path]);

  allowed.add(first);
  await expect(provider.close()).rejects.toMatchObject({
    cleanupIncomplete: true,
  });
  expect(aggregate.cleanupIncomplete).toBe(true);
  expect(aggregate.cleanupResources).toEqual([second.path]);

  allowed.add(second);
  await provider.close();
  expect(aggregate.cleanupIncomplete).toBe(false);
  expect(aggregate.cleanupResources).toEqual([]);
});

it("resolves a synthesized descriptor failure once its artifact leases release", async () => {
  const workspace = await createTestWorkspace("rea-sqlite-descriptor-close-");
  const database = createSqliteDatabaseFixture(workspace.root);
  database.close();
  const roots: PrivateRuntimeRoot[] = [];
  let removalAllowed = false;
  let descriptorAllowed = false;
  const artifactResources = new ArtifactResourceScope();
  artifactResources.retain({
    kind: "lease",
    resource: "sqlite-artifact-descriptor",
    lease: {
      release: async () => {
        if (!descriptorAllowed) throw new Error("descriptor close denied");
      },
    },
  });
  const provider = new SqliteDatabaseProvider(
    {},
    () => {
      throw new Error("SQLite worker deliberately unavailable");
    },
    async () => {
      const root = await PrivateRuntimeRoot.create({ parent: workspace.root });
      roots.push(root);
      return {
        path: root.path,
        close: async () => {
          if (!removalAllowed) throw new Error("snapshot removal denied");
          await root.close();
        },
      };
    },
    artifactResources,
  );
  onTestFinished(async () => {
    descriptorAllowed = true;
    removalAllowed = true;
    await provider.close().catch(() => {});
    await Promise.all(roots.map((root) => root.close()));
    await removeTestWorkspace(workspace.root);
  });

  await provider.inspect({ path: database.path });
  const failure: unknown = await provider
    .close()
    .catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(ProviderCleanupError);
  if (!(failure instanceof ProviderCleanupError))
    throw new Error("expected the descriptor/root aggregate");
  expect(failure.cleanupIncomplete).toBe(true);

  // The descriptors and the retained root all release on the next close.
  descriptorAllowed = true;
  removalAllowed = true;
  await provider.close();
  // The caller's aggregate must report completed cleanup: its synthesized
  // descriptor child resolves with the artifact leases it was bound to.
  expect(failure.cleanupIncomplete).toBe(false);
});
