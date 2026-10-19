import * as t from "@babel/types";
import { semanticExpressionValueDiscarded } from "./javascriptSemanticExpressionUsage.js";

import {
  semanticStaticPropertyKey,
  semanticWriteSiteReadsFirst,
  semanticWriteSiteTarget,
  semanticWriteTargets,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  createSemanticModuleInterop,
  semanticFreshObjectFactsReady,
} from "./javascriptModuleInterop.js";
import {
  createSemanticCallableTargets,
  createSemanticAccessorReferences,
  createSemanticClassConstructionStages,
  createSemanticFunctionValueReferences,
  createSemanticFunctionValueCapture,
  createSemanticPrivateMemberTargets,
  createSemanticReturnedReferences,
  semanticConstructorKeepsReceiver,
  createSemanticUnknownCallableResults,
  type SemanticReturnedReference,
} from "./javascriptSemanticReturnedReferences.js";
import {
  semanticAmbientOwnSlotUnchanged,
  semanticAmbientIdentitySourcesReady,
  semanticAmbientOwnSlotFactsReady,
  semanticAmbientPrototypeUnchanged,
} from "./javascriptSemanticAmbientWrites.js";
import {
  semanticGlobalBindingReadMayHaveChanged,
  semanticOpaqueBindingReadMayHaveChanged,
  semanticStrictContext,
  type SemanticGlobalBindingFacts,
} from "./javascriptSemanticOpaqueEffects.js";
import { createSemanticLexicalReceiverOwner } from "./javascriptSemanticReceiverOwners.js";
import {
  semanticLiteralObjectReferenceSources,
  semanticReferenceSourcesInactive,
} from "./javascriptSemanticReferenceSources.js";
import { semanticEffectTiming } from "./javascriptSemanticMutationInitializers.js";
import {
  isUnshadowedGlobal,
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticInitializer,
} from "./javascriptSemanticState.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";
import { javaScriptRuntimeContext } from "./javascriptSourceParser.js";

import {
  semanticAllocatedReceiverIdentity,
  type SemanticAllocatedReceiverIdentity,
} from "./javascriptSemanticStorageIdentities.js";

export interface SemanticConstructedReceiver {
  readonly identity: SemanticAllocatedReceiverIdentity;
  readonly allocation: t.Node;
  readonly prototypeSource: t.Node;
  readonly prototypeSourceLocal: boolean;
  readonly target: t.Function | t.Class;
  readonly activations: readonly t.Node[];
  readonly fields: readonly {
    readonly key: string | null;
    readonly node: t.Node;
    readonly value: t.Node | null;
    readonly own: boolean;
  }[];
}

/** The supplied object may be any local or shared reference. This is mutation
 * possibility evidence, never a strict identity or an allocated heap key. */
export interface SemanticUnknownConstructorReceiver {
  readonly kind: "unknown-constructor-receiver";
  readonly allocation: t.Node;
  readonly source: t.Function | t.Class;
}

type ReceiverQuery = ((node: t.ThisExpression) => readonly t.Node[]) & {
  nonEscapingBoundTarget(node: t.Node): t.Node | undefined;
  privateReadSources(
    node: t.MemberExpression | t.OptionalMemberExpression,
  ): readonly SemanticReturnedReference[];
  wrapper(node: t.ThisExpression): boolean;
  constructed(node: t.ThisExpression): readonly SemanticConstructedReceiver[];
  unknown(
    node: t.ThisExpression,
  ): readonly SemanticUnknownConstructorReceiver[];
  completion(node: t.Node):
    | {
        readonly receivers: readonly SemanticConstructedReceiver[];
        readonly unknown: readonly SemanticUnknownConstructorReceiver[];
        readonly sources: readonly (t.Function | t.Class)[];
        readonly complete: boolean;
      }
    | undefined;
  allocatedBefore(
    receiver: SemanticConstructedReceiver,
    mutation: t.Node,
  ): boolean;
};

/** Expressions that can supply a receiver; the Program denotes the global object. */
const receiverQueries = new WeakMap<
  JavaScriptSemanticAnalysisState,
  ReceiverQuery
>();

type ReceiverSite = readonly [node: t.Node, parent: t.Node | null];
interface ParsedReceiverSites {
  readonly sites: readonly ReceiverSite[];
  readonly writes: WeakMap<t.Node, t.Node>;
}
const receiverSites = new WeakMap<
  JavaScriptSemanticAnalysisState,
  ParsedReceiverSites
>();

/** Retain syntax once per source; each proof snapshot selects uses afresh. */
const parsedReceiverSites = (
  state: JavaScriptSemanticAnalysisState,
): ParsedReceiverSites => {
  const prior = receiverSites.get(state);
  if (prior !== undefined) return prior;
  const sites: ReceiverSite[] = [];
  const writes = new WeakMap<t.Node, t.Node>();
  traverseJavaScriptAst(state.program, {
    enter: (node, parent) => {
      sites.push([node, parent]);
      const target = semanticWriteSiteTarget(node);
      if (target !== null)
        for (const leaf of semanticWriteTargets(target)) writes.set(leaf, node);
    },
  });
  const parsed = { sites, writes };
  receiverSites.set(state, parsed);
  return parsed;
};

/** Possible receiver identity is shared by all ambient-write consumers. */
export const createSemanticReceiverReferences = (
  state: JavaScriptSemanticAnalysisState,
  isDefinitelyObject?: (node: t.Node) => boolean,
  intrinsicWriteFacts?: SemanticGlobalBindingFacts,
) => {
  const customContext =
    isDefinitelyObject !== undefined || intrinsicWriteFacts !== undefined;
  const prior = customContext ? undefined : receiverQueries.get(state);
  if (prior !== undefined) return prior;
  const privateTargets = createSemanticPrivateMemberTargets(state);
  const lexicalOwner = createSemanticLexicalReceiverOwner(state);
  let receivers: WeakMap<t.Function, Set<t.Node>> | undefined;
  let constructed = new WeakMap<t.Node, SemanticConstructedReceiver[]>();
  let unknownReceivers = new WeakMap<
    t.Node,
    SemanticUnknownConstructorReceiver[]
  >();
  let completions = new WeakMap<
    t.Node,
    {
      receivers: SemanticConstructedReceiver[];
      unknown: SemanticUnknownConstructorReceiver[];
      sources: (t.Function | t.Class)[];
      complete: boolean;
    }
  >();
  let activationSites = new WeakMap<t.Node, Set<t.Node>>();
  let unknownActivations = new WeakSet<t.Node>();
  let nonEscapingBoundTarget:
    | ((node: t.Node) => t.Node | undefined)
    | undefined;
  let classReceiverUnknown: ((owner: t.Class) => boolean) | undefined;
  let factsReady = semanticFreshObjectFactsReady(state);
  let capturesReady = semanticAmbientIdentitySourcesReady(state);
  let ownSlotFactsReady = semanticAmbientOwnSlotFactsReady(state);
  const indexReceivers = () => {
    const indexed = new WeakMap<t.Function, Set<t.Node>>();
    receivers = indexed;
    constructed = new WeakMap();
    unknownReceivers = new WeakMap();
    completions = new WeakMap();
    activationSites = new WeakMap();
    unknownActivations = new WeakSet();
    const targets = createSemanticCallableTargets(
      state,
      "callable",
      isDefinitelyObject,
    );
    const contents = createSemanticCallableTargets(
      state,
      "contents",
      isDefinitelyObject,
    );
    // Receiver indexing finishes before escape selection. Read its selected
    // public accessor receivers when an actual escape exposes a returned this.
    const escapedContents = createSemanticCallableTargets(
      state,
      "contents",
      isDefinitelyObject,
      (node) => {
        const owner = lexicalOwner(node);
        return (t.isObjectMethod(owner) || t.isClassMethod(owner)) &&
          (owner.kind === "get" || owner.kind === "set")
          ? { owner, receivers: [...(indexed.get(owner) ?? [])] }
          : undefined;
      },
    );
    const accessors = createSemanticCallableTargets(
      state,
      "accessors",
      isDefinitelyObject,
    );
    const inactiveDefaults = new WeakSet<t.Node>();
    const defaultSources = new Map<
      t.AssignmentPattern,
      Set<JavaScriptSemanticInitializer>
    >();
    for (const binding of state.bindingsById.values())
      for (const reference of binding.referenceInitializers)
        for (const source of reference.fallbackSources ?? []) {
          if (source.selection === undefined) continue;
          const sources = defaultSources.get(source.selection) ?? new Set();
          sources.add(source);
          defaultSources.set(source.selection, sources);
        }
    // Nested patterns can select from the original input or an outer default.
    // The expression is inactive only when every retained input excludes it.
    for (const [selection, sources] of defaultSources)
      if (
        [...sources].every((source) =>
          semanticReferenceSourcesInactive(
            { fallbackSources: [source] },
            state,
            "syntax-only",
          ),
        )
      )
        inactiveDefaults.add(selection.right);
    const intrinsics = createSemanticModuleInterop(state);
    const definiteObject = isDefinitelyObject ?? intrinsics.isDefinitelyObject;
    const constructorValues = createSemanticFunctionValueReferences(state);
    // Before the ambient snapshot exists these are possible source receivers,
    // not binding-integrity proofs. Incomplete global binding facts must not
    // turn a source declaration into a permanent unknown mutation of itself.
    // The completed/custom query below rechecks its captured global identity.
    const sourceObjects =
      !customContext && !semanticFreshObjectFactsReady(state)
        ? createSemanticModuleInterop(state, {
            bindingReadMayHaveChanged: (binding, read) =>
              semanticOpaqueBindingReadMayHaveChanged(binding, read, state),
          })
        : intrinsics;
    const receiverObjects =
      intrinsicWriteFacts === undefined
        ? sourceObjects
        : createSemanticModuleInterop(state, {
            intrinsicPath: intrinsics.intrinsicPath,
            intrinsicWriteFacts,
            bindingReadMayHaveChanged: (binding, read) =>
              semanticOpaqueBindingReadMayHaveChanged(binding, read, state) ||
              semanticGlobalBindingReadMayHaveChanged(
                binding,
                read,
                state,
                intrinsicWriteFacts,
              ),
          });
    const includeUnknownResults =
      customContext || semanticFreshObjectFactsReady(state);
    const unknownResult = createSemanticUnknownCallableResults(
      state,
      receiverObjects.isFreshObject,
      definiteObject,
    );
    const classStages = createSemanticClassConstructionStages(
      state,
      definiteObject,
      receiverObjects.isFreshObject,
      includeUnknownResults,
    );
    const classConstructionUnknown = new WeakMap<t.Class, boolean>();
    classReceiverUnknown = (owner) =>
      classConstructionUnknown.get(owner) ??
      classStages(owner, state.program).at(-1)?.unknownReceiver === true;
    const retainClassConstruction = (
      stages: ReturnType<typeof classStages>,
    ) => {
      for (const stage of stages)
        if (t.isClass(stage.owner))
          classConstructionUnknown.set(
            stage.owner,
            classConstructionUnknown.get(stage.owner) === true ||
              stage.unknownReceiver,
          );
    };
    const unknownConstructionRoots = new Set<t.Node>();
    // Stored values widen activation timing. Only exposed constructors also
    // permit a caller to change a derived parent before an unknown allocation.
    const escapedConstructionRoots = new Set<t.Node>();
    const groups = new Map<
      string,
      { node: t.Node; targets: readonly t.Function[] }
    >();
    const paths = new WeakMap<t.Node, readonly string[]>();
    const covered = new WeakSet<t.Node>();
    const localPath = (node: t.Node): readonly string[] | undefined => {
      const current = unwrapJavaScriptExpression(node).node;
      const cached = paths.get(current);
      if (cached !== undefined) return cached;
      const functions = targets(current);
      if (
        functions.length > 0 ||
        constructorValues(current).some(
          ({ node, projection }) => t.isClass(node) && projection.length === 0,
        )
      ) {
        const id = String(groups.size);
        groups.set(id, { node: current, targets: functions });
        const path = ["intrinsic", "local-receiver", id];
        paths.set(current, path);
        return path;
      }
      if (
        t.isMemberExpression(current) ||
        t.isOptionalMemberExpression(current)
      ) {
        const key = semanticStaticPropertyKey(
          current.property,
          current.computed,
        );
        if (key === "call" || key === "apply" || key === "bind") {
          const path = localPath(current.object);
          if (path !== undefined) return [...path, key];
        }
      }
      return intrinsics.intrinsicPath(current);
    };
    const invocationFacts = intrinsicWriteFacts ?? {
      ambientWrites: state.ambientWrites,
      ambientWriteEffects: state.ambientWriteEffects,
      opaqueGlobalSites: state.opaqueEffects.globalSites,
      get complete() {
        return semanticFreshObjectFactsReady(state);
      },
    };
    const sourceCaptureProofs: Parameters<
      typeof createSemanticFunctionValueCapture
    >[1] = {
      bindingReadMayHaveChanged: (binding, read) =>
        invocationFacts.complete !== true ||
        semanticOpaqueBindingReadMayHaveChanged(binding, read, state) ||
        semanticGlobalBindingReadMayHaveChanged(
          binding,
          read,
          state,
          invocationFacts,
        ),
      ownSlotUnchanged: (owner, key, read) =>
        semanticAmbientOwnSlotUnchanged(state, owner, key, read),
    };
    const sourceCapture = createSemanticFunctionValueCapture(
      state,
      sourceCaptureProofs,
    );
    const accessorReferences = createSemanticAccessorReferences(state, {
      ...sourceCaptureProofs,
      prototypeUnchanged: (owner, read) =>
        semanticAmbientPrototypeUnchanged(state, owner, read),
    });
    const nativeSetReceivers = new WeakMap<
      t.Node,
      { readonly target: t.Node; readonly receiver: t.Node }
    >();
    const invocations = createSemanticModuleInterop(state, {
      intrinsicPath: localPath,
      // Canonical helpers need mutation proof before normalizing a source call;
      // the synthetic source path still selects possible activation targets.
      intrinsicInvocationWriteFacts: (path) =>
        path[1] === "local-receiver" ? undefined : invocationFacts,
      boundFunctionWriteFacts: invocationFacts,
      sourceFunctionCapture: sourceCapture,
    });
    nonEscapingBoundTarget = (node) =>
      t.isCallExpression(node)
        ? invocations.nonEscapingBoundTarget(node, invocationFacts)
        : undefined;
    const escapedConstructorValues = createSemanticFunctionValueReferences(
      state,
      undefined,
      (node) => {
        // This adds escape reachability, never identity of a bound object with
        // its target. Ordinary constructor/capture queries keep their owner.
        const bound = invocations.boundIntrinsic(node);
        const source =
          bound?.path.length === 3 && bound.path[1] === "local-receiver"
            ? groups.get(bound.path[2]!)
            : undefined;
        return source === undefined ? [] : [source.node];
      },
      true,
    );
    const lexicalReceiverUses = new Map<t.Node, Set<t.Function>>();
    const receiverRoots = new Set<t.Node>();
    const absentReceivers = new WeakSet<t.Node>();
    const retain = (target: t.Function, receiver?: t.Node) => {
      const values = indexed.get(target) ?? new Set<t.Node>();
      if (t.isSuper(receiver)) {
        const owner = lexicalOwner(receiver);
        const uses = lexicalReceiverUses.get(owner) ?? new Set<t.Function>();
        uses.add(target);
        lexicalReceiverUses.set(owner, uses);
      } else {
        receiverRoots.add(target);
        if (receiver !== undefined) values.add(receiver);
      }
      indexed.set(target, values);
    };
    const privateReceivers = (
      name: t.PrivateName,
    ): readonly t.Node[] | undefined => {
      const declaration = privateTargets(name);
      if (declaration === undefined) return undefined;
      const values = new Set<t.Node>();
      if (declaration.members.some((member) => member.static))
        values.add(declaration.owner);
      if (declaration.members.some((member) => !member.static)) {
        // A successful private lookup checks the declaring class's brand. Its
        // instance starts fresh unless super() supplies an existing object.
        // Unknown bases and returned values cannot prove global exclusion.
        const inherited =
          declaration.owner.superClass == null
            ? []
            : returned(declaration.owner.superClass).references.map(
                ({ node }) => node,
              );
        for (const node of inherited) values.add(node);
        if (inherited.some((node) => !receiverObjects.isFreshObject(node)))
          values.add(state.program);
      }
      return [...values];
    };
    const privateParentUses: { name: t.PrivateName; target: t.Function }[] = [];
    const retainReceivers = (
      target: t.Function,
      values: readonly t.Node[],
      name?: t.PrivateName,
    ) => {
      if (values.length === 0) retain(target);
      for (const receiver of values) retain(target, receiver);
      if (name !== undefined) privateParentUses.push({ name, target });
    };
    const receiverNonNullish = (value: t.Node | undefined): boolean =>
      value !== undefined &&
      (definiteObject(value) ||
        (t.isLiteral(value) && !t.isNullLiteral(value)) ||
        ["globalThis", "global", "window", "self", "module"].some((name) =>
          isUnshadowedGlobal(value, state, name),
        ));
    // Source-home lookup and invocation receivers have different owners.
    // Propagate the full receiver representation before selecting escaped
    // getter contents, and again after escapes add unknown caller alternatives.
    const propagateLexicalReceivers = () => {
      const reachable = new Set(receiverRoots);
      const roots = [
        ...reachable,
        ...[...lexicalReceiverUses.keys()].filter(
          (owner) => !t.isFunction(owner),
        ),
      ];
      for (let cursor = 0; cursor < roots.length; cursor++)
        for (const target of lexicalReceiverUses.get(roots[cursor]!) ?? [])
          if (!reachable.has(target)) {
            reachable.add(target);
            roots.push(target);
          }
      // An unobserved cycle has no recovered activation that could exclude an
      // unknown caller. Keep the same global fallback as an unobserved method.
      for (const owner of lexicalReceiverUses.keys())
        if (t.isFunction(owner) && !reachable.has(owner))
          retain(owner, state.program);
      const pending = [...lexicalReceiverUses.keys()];
      const queued = new Set(pending);
      for (let cursor = 0; cursor < pending.length; cursor++) {
        const owner = pending[cursor]!;
        queued.delete(owner);
        const declaringBody = state.parentsByNode.get(owner);
        const declaring =
          declaringBody === undefined
            ? undefined
            : state.parentsByNode.get(declaringBody);
        const isStatic =
          t.isStaticBlock(owner) ||
          ((t.isClassProperty(owner) ||
            t.isClassPrivateProperty(owner) ||
            t.isClassAccessorProperty(owner)) &&
            owner.static);
        const values =
          isStatic && t.isClass(declaring)
            ? [declaring]
            : t.isFunction(owner)
              ? [
                  ...(indexed.get(owner) ?? [state.program]),
                  ...inheritedReceiver(owner),
                ]
              : [...inheritedReceiver(owner)];
        for (const target of lexicalReceiverUses.get(owner) ?? []) {
          const prior = indexed.get(target)?.size ?? 0;
          for (const value of values) {
            retain(target, value);
            if (
              !receiverNonNullish(value) &&
              !semanticStrictContext(target, state)
            )
              retain(target, state.program);
          }
          if (
            absentReceivers.has(owner) &&
            !semanticStrictContext(target, state)
          )
            retain(target, state.program);
          let changed = (indexed.get(target)?.size ?? 0) !== prior;
          if (absentReceivers.has(owner) && !absentReceivers.has(target)) {
            absentReceivers.add(target);
            changed = true;
          }
          const copy = <T>(map: WeakMap<t.Node, T[]>) => {
            const source = map.get(owner) ?? [];
            const selected = map.get(target) ?? [];
            for (const value of source)
              if (!selected.includes(value)) {
                selected.push(value);
                changed = true;
              }
            map.set(target, selected);
          };
          copy(constructed);
          copy(unknownReceivers);
          if (
            unknownActivations.has(owner) &&
            !unknownActivations.has(target)
          ) {
            unknownActivations.add(target);
            changed = true;
          }
          if (
            changed &&
            lexicalReceiverUses.has(target) &&
            !queued.has(target)
          ) {
            queued.add(target);
            pending.push(target);
          }
        }
      }
    };
    const addUnknown = (
      owner: t.Node,
      value: SemanticUnknownConstructorReceiver,
    ) => {
      const values = unknownReceivers.get(owner) ?? [];
      values.push(value);
      unknownReceivers.set(owner, values);
    };
    const construct = (
      callee: t.Node,
      allocation: t.Node,
      newTarget = callee,
    ) => {
      // Bound construction ignores the bound this argument and initializes the
      // original constructor's stages. Its parent is read at this allocation,
      // not when bind captured the constructor value.
      const bound = invocations.boundIntrinsic(callee, invocationFacts, true);
      let boundConstructionComplete = true;
      if (bound?.path.length === 3 && bound.path[1] === "local-receiver") {
        const source = groups.get(bound.path[2]!);
        if (source !== undefined) {
          // The weak pass selects possible source receivers before it owns
          // helper-integrity facts. Its unresolved bind proof must not publish
          // a wildcard write that permanently invalidates that same capture.
          // Completed/custom queries recheck the captured helper normally.
          boundConstructionComplete =
            bound.kind === "known" || !includeUnknownResults;
          covered.add(callee);
          for (const read of bound.callableReads ?? []) covered.add(read);
          const boundNewTarget =
            newTarget === callee
              ? bound
              : invocations.boundIntrinsic(newTarget, invocationFacts, true);
          if (
            newTarget === callee ||
            (bound.kind === "known" &&
              boundNewTarget?.kind === "known" &&
              bound.boundFunction?.allocations[0] !== undefined &&
              bound.boundFunction.allocations[0] ===
                boundNewTarget.boundFunction?.allocations[0])
          )
            newTarget = source.node;
          callee = source.node;
        }
      }
      // An explicit returned object does not replace the fresh receiver used
      // inside a base constructor.
      for (const target of targets(callee)) retain(target);
      const add = (owner: t.Node, value: SemanticConstructedReceiver) => {
        const values = constructed.get(owner) ?? [];
        values.push(value);
        constructed.set(owner, values);
      };
      const completion = completions.get(allocation) ?? {
        receivers: [],
        unknown: [],
        sources: [],
        complete:
          boundConstructionComplete && receiverObjects.isFreshObject(callee),
      };
      completions.set(allocation, completion);
      for (const { node: target, projection } of constructorValues(callee)) {
        if (projection.length !== 0) continue;
        completion.sources.push(target);
        const unknown: SemanticUnknownConstructorReceiver = {
          kind: "unknown-constructor-receiver",
          allocation,
          source: target,
        };
        if (!boundConstructionComplete && includeUnknownResults)
          completion.unknown.push(unknown);
        const identity = semanticAllocatedReceiverIdentity(allocation);
        const stages = t.isClass(target) ? classStages(target, allocation) : [];
        retainClassConstruction(stages);
        const activations: t.Node[] = t.isFunction(target)
          ? [target]
          : stages.flatMap((stage) => [
              ...(stage.constructor === undefined ? [] : [stage.constructor]),
              ...stage.fields.map((field) => field.node),
            ]);
        for (const owner of activations) {
          const sites = activationSites.get(owner) ?? new Set();
          sites.add(allocation);
          activationSites.set(owner, sites);
        }
        const base = {
          identity,
          allocation,
          prototypeSource: newTarget,
          prototypeSourceLocal:
            boundConstructionComplete &&
            receiverObjects.isFreshObject(newTarget),
          target,
          activations,
        };
        if (t.isFunction(target)) {
          const receiver = { ...base, fields: [] };
          add(target, receiver);
          if (semanticConstructorKeepsReceiver(target, definiteObject))
            completion.receivers.push(receiver);
          if (includeUnknownResults && unknownResult(target))
            completion.unknown.push(unknown);
        } else {
          const fields: SemanticConstructedReceiver["fields"][number][] = [];
          for (const stage of stages) {
            if (stage.unknownReceiver) {
              for (const field of stage.fields) addUnknown(field.node, unknown);
              if (stage.constructor !== undefined)
                addUnknown(stage.constructor, unknown);
            }
            if (!stage.fresh) continue;
            for (const field of stage.fields) {
              add(field.node, { ...base, fields: [...fields] });
              if (field.key.kind === "public")
                fields.push({
                  key: field.key.name,
                  node: field.node,
                  value: field.value,
                  own: stage.local,
                });
            }
            if (stage.constructor !== undefined)
              add(stage.constructor, {
                ...base,
                fields: [...fields],
              });
          }
          if (stages.at(-1)?.keepsReceiver)
            completion.receivers.push({ ...base, fields: [...fields] });
          if (stages.at(-1)?.unknownResult) completion.unknown.push(unknown);
        }
      }
      covered.add(callee);
    };
    const { sites, writes } = parsedReceiverSites(state);
    const inactiveNodes = new WeakSet<t.Node>();
    sites.forEach(([node, parent]) => {
      if (
        inactiveDefaults.has(node) ||
        (parent !== null && inactiveNodes.has(parent))
      ) {
        inactiveNodes.add(node);
        return;
      }
      if (t.isPrivateName(node)) {
        // A decorator can expose the original callable even when the private
        // slot itself never leaves the class's lexical scope.
        for (const member of privateTargets(node)?.members ?? [])
          if (
            member.key.kind === "private" &&
            member.key.declaration === node &&
            member.decorated &&
            member.value !== null
          )
            for (const target of contents(member.value))
              retain(target, state.program);
      }
      if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
        const privateName = t.isPrivateName(node.property)
          ? node.property
          : undefined;
        const values =
          privateName === undefined
            ? [node.object]
            : privateReceivers(privateName);
        const members =
          privateName === undefined
            ? accessors(node)
            : (privateTargets(privateName)?.members.flatMap((member) =>
                t.isFunction(member.value) ? [member.value] : [],
              ) ?? []);
        const write = writes.get(node);
        const deletion = t.isUnaryExpression(write, { operator: "delete" });
        for (const member of members) {
          if (
            values !== undefined &&
            (t.isObjectMethod(member) ||
              t.isClassMethod(member) ||
              t.isClassPrivateMethod(member)) &&
            ((member.kind === "get" &&
              !deletion &&
              (write === undefined || semanticWriteSiteReadsFirst(write))) ||
              (member.kind === "set" && write !== undefined && !deletion))
          )
            retainReceivers(member, values, privateName);
        }
      }
      if (t.isNewExpression(node)) {
        construct(node.callee, node);
        return;
      }
      if (
        !t.isCallExpression(node) &&
        !t.isOptionalCallExpression(node) &&
        !t.isTaggedTemplateExpression(node)
      )
        return;
      const invocation = invocations.intrinsicInvocation(node);
      const setterInvocation = includeUnknownResults
        ? invocations.intrinsicInvocation(node, invocationFacts, true)
        : intrinsics.intrinsicInvocation(node);
      if (
        setterInvocation?.kind === "known" &&
        setterInvocation.arguments !== undefined &&
        !setterInvocation.arguments.some(t.isSpreadElement)
      ) {
        const args = setterInvocation.arguments;
        const target = args[0];
        let receiver = target;
        let keys: readonly string[] | undefined;
        const operation = setterInvocation.path.join(".");
        // Native [[Set]] runs only the selected setter and native [[Get]] only
        // the selected getter, each with the explicit receiver argument or the
        // target when that argument is omitted.
        const invokedAccessor: "get" | "set" =
          operation === "intrinsic.Reflect.get" ? "get" : "set";
        if (
          operation === "intrinsic.Reflect.set" ||
          operation === "intrinsic.Reflect.get"
        ) {
          const receiverIndex = invokedAccessor === "set" ? 3 : 2;
          receiver =
            args.length <= receiverIndex ? target : args[receiverIndex];
          const key = intrinsics.staticString(args[1]);
          if (key !== undefined) keys = [key];
        } else if (operation === "intrinsic.Object.assign") {
          const copied = new Set<string>();
          const knownSources = args.slice(1).every((source) => {
            if (!t.isObjectExpression(source)) return false;
            const own = semanticLiteralObjectReferenceSources(source);
            // Source getters run between target writes and can change a later
            // descriptor. Unknown enumerations retain the ordinary escape.
            if (
              own.unknownKeys ||
              own.sources.some(
                ({ kind }) => kind !== "data" && kind !== "method",
              )
            )
              return false;
            for (const key of own.properties.keys()) copied.add(key);
            return true;
          });
          if (knownSources && copied.size > 0) keys = [...copied];
        }
        if (
          t.isExpression(target) &&
          t.isExpression(receiver) &&
          keys !== undefined
        ) {
          // The target value is captured at its argument, but native [[Set]]
          // selects its descriptor after every argument has been evaluated.
          const selections = keys.map((key) =>
            accessorReferences(target, [key], node),
          );
          // Provisional receiver selection cannot prove its own write snapshot.
          // Completed queries require the same binding and descriptor capture
          // proof as other source callable consumers before removing an escape.
          if (
            selections.every(
              (selected) =>
                selected.complete ||
                (!includeUnknownResults && selected.references.length > 0),
            )
          ) {
            nativeSetReceivers.set(node, { target, receiver });
            for (const { node: member } of selections.flatMap(
              (selected) => selected.references,
            )) {
              if (!t.isObjectMethod(member) && !t.isClassMethod(member))
                continue;
              retain(member);
              if (member.kind !== invokedAccessor) continue;
              retain(member, receiver);
              const value = unwrapJavaScriptExpression(receiver).node;
              const nonNullish =
                definiteObject(value) ||
                (t.isLiteral(value) && !t.isNullLiteral(value));
              if (!nonNullish && !semanticStrictContext(member, state))
                retain(member, state.program);
              const activations = activationSites.get(member) ?? new Set();
              activations.add(node);
              activationSites.set(member, activations);
            }
          }
        }
      }
      if (
        invocation?.kind === "known" &&
        invocation.path.join(".") === "intrinsic.Reflect.construct"
      ) {
        const target = invocation.arguments?.[0];
        const newTarget = invocation.arguments?.[2];
        if (t.isExpression(target))
          construct(
            target,
            node,
            t.isExpression(newTarget) ? newTarget : target,
          );
        return;
      }
      if (
        invocation?.path.length !== 3 ||
        invocation.path[1] !== "local-receiver"
      )
        return;
      const group = groups.get(invocation.path[2]!);
      if (group === undefined) return;
      covered.add(group.node);
      for (const read of invocation.callableReads ?? []) covered.add(read);
      const callee = unwrapJavaScriptExpression(
        t.isTaggedTemplateExpression(node) ? node.tag : node.callee,
      ).node;
      const receiver = invocation.receiver ?? invocation.memberReceiver;
      const branded =
        invocation.receiver === undefined &&
        callee === group.node &&
        (t.isMemberExpression(callee) ||
          t.isOptionalMemberExpression(callee)) &&
        t.isPrivateName(callee.property)
          ? privateReceivers(callee.property)
          : undefined;
      for (const target of group.targets) {
        const activations = activationSites.get(target) ?? new Set();
        activations.add(node);
        activationSites.set(target, activations);
        if (branded !== undefined) {
          retainReceivers(
            target,
            branded,
            (t.isMemberExpression(callee) ||
              t.isOptionalMemberExpression(callee)) &&
              t.isPrivateName(callee.property)
              ? callee.property
              : undefined,
          );
          continue;
        }
        retain(target, receiver);
        if (
          invocation.receiverUncertain === true ||
          t.isSpreadElement(receiver) ||
          (invocation.kind === "opaque" && receiver === undefined)
        )
          retain(target, state.program);
        // Unknown arguments can be nullish. Only proven objects/non-null
        // literals exclude sloppy receiver substitution; reads remain strict.
        const value =
          receiver === undefined
            ? undefined
            : unwrapJavaScriptExpression(receiver).node;
        if (receiver === undefined) absentReceivers.add(target);
        const nonNullish = t.isSuper(value) || receiverNonNullish(value);
        if (!nonNullish && !semanticStrictContext(target, state))
          retain(target, state.program);
      }
    });
    propagateLexicalReceivers();
    // Recovered calls are not a complete use set: stored, returned or passed
    // callable values can be invoked through a receiver we did not recover.
    const inactiveTargets = new Set<t.Function>();
    const storedSources: [t.Node, t.Node][] = [];
    const escapedValues = new WeakSet<t.Node>();
    sites.forEach(([node, initialParent]) => {
      let parent = initialParent;
      if (inactiveNodes.has(node)) {
        if (t.isFunction(node)) inactiveTargets.add(node);
        else if (
          parent !== null &&
          t.isIdentifier(node) &&
          t.isReferenced(node, parent, state.parentsByNode.get(parent))
        )
          for (const target of contents(node)) inactiveTargets.add(target);
        return;
      }
      if (parent !== null && t.isClassDeclaration(node)) {
        storedSources.push([node, parent]);
        if (
          t.isExportNamedDeclaration(parent) ||
          t.isExportDefaultDeclaration(parent)
        ) {
          unknownConstructionRoots.add(node);
          escapedConstructionRoots.add(node);
        }
        return;
      }
      if (parent === null || !t.isExpression(node)) return;
      if (
        t.isIdentifier(node) &&
        !t.isReferenced(node, parent, state.parentsByNode.get(parent))
      )
        return;
      let current: t.Node = node;
      // Follow edges that select this value before deciding whether it is
      // stored, consumed, or discarded. The expression's syntax alone does
      // not distinguish an escaped instance from a local method receiver.
      for (;;) {
        if (covered.has(current)) return;
        // Assignment patterns and loops evaluate target addresses without
        // reading their old values. Keys, receivers and defaults keep their
        // own evaluated sites; only target leaves belong to the write index.
        const write = writes.get(current);
        if (write !== undefined && !semanticWriteSiteReadsFirst(write)) return;
        if (semanticExpressionValueDiscarded(current, parent)) return;
        if (
          parent === null ||
          !(
            ((t.isMemberExpression(parent) ||
              t.isOptionalMemberExpression(parent)) &&
              parent.object === current) ||
            unwrapJavaScriptExpression(parent).node === current ||
            t.isSequenceExpression(parent) ||
            t.isConditionalExpression(parent) ||
            t.isLogicalExpression(parent) ||
            (t.isAssignmentExpression(parent, { operator: "=" }) &&
              parent.right === current &&
              t.isIdentifier(parent.left) &&
              resolveSemanticBindingState(
                state,
                parent.left,
                parent.left.name,
              ) !== undefined)
          )
        )
          break;
        current = parent;
        parent = state.parentsByNode.get(current) ?? null;
      }
      if (
        (t.isVariableDeclarator(parent) && parent.init === current) ||
        ((t.isObjectProperty(parent) ||
          t.isClassProperty(parent) ||
          t.isClassPrivateProperty(parent) ||
          t.isClassAccessorProperty(parent)) &&
          parent.value === current) ||
        t.isArrayExpression(parent) ||
        (t.isSpreadElement(parent) &&
          t.isArrayExpression(state.parentsByNode.get(parent))) ||
        (t.isClass(parent) && parent.superClass === current)
      ) {
        storedSources.push([node, parent]);
        // A stored class may be constructed through an unrecovered consumer.
        unknownConstructionRoots.add(node);
        return;
      }
      if (escapedValues.has(current)) return;
      escapedValues.add(current);
      // A source return is not itself a receiver escape. Accessor reads own
      // the returned value; argument/store escapes below substitute its this.
      const sourceReturn =
        t.isReturnStatement(parent) ||
        (t.isArrowFunctionExpression(parent) && parent.body === current);
      const consumer =
        t.isCallExpression(parent) || t.isOptionalCallExpression(parent)
          ? invocations.intrinsicInvocation(parent)
          : undefined;
      const exposesConstructor =
        !sourceReturn &&
        (consumer?.kind !== "known" || consumer.path[1] === "local-receiver");
      const prototypeConsumer =
        consumer?.kind === "known" &&
        consumer.path.length === 3 &&
        ["Object", "Reflect"].includes(consumer.path[1] ?? "") &&
        ["getPrototypeOf", "setPrototypeOf"].includes(consumer.path[2] ?? "");
      // Literal invocation arrays can contain a consumed callable selection.
      // Walk their leaves without hiding other arguments or nested contents.
      const values = [current];
      while (values.length > 0) {
        const value = values.pop();
        if (value === undefined || covered.has(value)) continue;
        const setter =
          parent === null ? undefined : nativeSetReceivers.get(parent);
        // The native operation calls the selected source setter with its fixed
        // receiver; it does not independently invoke every function in either
        // input. Any source-body escape is still indexed at its own use site.
        if (
          setter !== undefined &&
          (value === setter.target || value === setter.receiver)
        )
          continue;
        if (!prototypeConsumer || value !== consumer?.arguments?.[0])
          unknownConstructionRoots.add(value);
        if (exposesConstructor) escapedConstructionRoots.add(value);
        const unwrapped = unwrapJavaScriptExpression(value).node;
        if (t.isArrayExpression(unwrapped)) {
          for (const element of unwrapped.elements)
            if (element !== null)
              values.push(
                t.isSpreadElement(element) ? element.argument : element,
              );
          continue;
        }
        for (const target of (sourceReturn ? contents : escapedContents)(
          value,
        )) {
          unknownActivations.add(target);
          retain(target, state.program);
        }
      }
    });
    // Construction escape tracking needs the union, rather than a separate
    // alias walk for each stored value. The callable owner shares completed
    // prefixes without changing any root's selection or cycle context.
    const escapedConstructors = new Set(
      escapedConstructorValues
        .fromRoots([...escapedConstructionRoots])
        .filter(
          ({ node, projection }) => t.isClass(node) && projection.length === 0,
        )
        .map(({ node }) => node),
    );
    for (const { node, projection } of constructorValues.fromRoots([
      ...unknownConstructionRoots,
      ...escapedConstructors,
    ])) {
      if (!t.isClass(node) || projection.length !== 0) continue;
      const unknown =
        includeUnknownResults && escapedConstructors.has(node)
          ? {
              kind: "unknown-constructor-receiver" as const,
              allocation: node,
              source: node,
            }
          : undefined;
      for (const stage of classStages(node)) {
        if (stage.constructor !== undefined) {
          unknownActivations.add(stage.constructor);
          if (unknown !== undefined && stage.derived)
            addUnknown(stage.constructor, unknown);
        }
        for (const field of stage.fields) {
          unknownActivations.add(field.node);
          if (unknown !== undefined && stage.derived)
            addUnknown(field.node, unknown);
        }
      }
      const receiverStages = classStages(node, state.program);
      retainClassConstruction(receiverStages);
      for (const stage of receiverStages)
        if (stage.unknownReceiver)
          for (const field of stage.fields) {
            const unknown = unknownReceivers.get(field.node) ?? [];
            unknown.push({
              kind: "unknown-constructor-receiver",
              allocation: node,
              source: node,
            });
            unknownReceivers.set(field.node, unknown);
          }
    }
    // Private brands constrain the receiver to a constructed instance. Parent
    // changes must be compared with construction captures, including escapes,
    // rather than with the private method's source position.
    for (const { name, target } of privateParentUses) {
      const declaration = privateTargets(name);
      if (
        declaration?.members.some((member) => !member.static) === true &&
        classReceiverUnknown(declaration.owner)
      )
        retain(target, state.program);
    }
    // An explicitly unused default is a known non-invocation. Keep independent
    // calls and escapes, and leave unobserved stored/exported uses unknown.
    for (const [node, parent] of storedSources) {
      if (inactiveTargets.size === 0) break;
      const declaration = state.parentsByNode.get(parent);
      // A local function initializer defines the target rather than using it.
      if (
        t.isFunction(node) &&
        t.isVariableDeclarator(parent) &&
        !t.isExportNamedDeclaration(
          declaration === undefined
            ? undefined
            : state.parentsByNode.get(declaration),
        )
      )
        continue;
      for (const target of contents(node)) inactiveTargets.delete(target);
    }
    for (const target of inactiveTargets) {
      const parent = state.parentsByNode.get(target);
      if (
        !indexed.has(target) &&
        !t.isExportNamedDeclaration(parent) &&
        !t.isExportDefaultDeclaration(parent)
      )
        retain(target);
    }
    propagateLexicalReceivers();
  };
  const returned = createSemanticReturnedReferences(state, isDefinitelyObject);
  const inheritedReceiver = (owner: t.Node): readonly t.Node[] => {
    if (
      !(
        (t.isClassMethod(owner) && owner.kind === "constructor") ||
        ((t.isClassProperty(owner) ||
          t.isClassPrivateProperty(owner) ||
          t.isClassAccessorProperty(owner)) &&
          !owner.static)
      )
    )
      return [];
    const body = state.parentsByNode.get(owner);
    const declaring =
      body === undefined ? undefined : state.parentsByNode.get(body);
    if (!t.isClass(declaring) || declaring.superClass == null) return [];
    if (receivers === undefined) indexReceivers();
    const inherited = returned(declaring.superClass).references.map(
      ({ node }) => node,
    );
    return classReceiverUnknown?.(declaring)
      ? [state.program, ...inherited]
      : inherited;
  };
  const refresh = () => {
    const captured = semanticAmbientIdentitySourcesReady(state);
    if (capturesReady !== captured) {
      capturesReady = captured;
      receivers = undefined;
    }
    const ready = semanticFreshObjectFactsReady(state);
    const slotsReady = semanticAmbientOwnSlotFactsReady(state);
    if (
      (!customContext && factsReady !== ready) ||
      ownSlotFactsReady !== slotsReady
    ) {
      // Frozen binding proofs still acquire completed slot facts. A receiver
      // indexed while resolving escapes must not retain provisional failures.
      factsReady = ready;
      ownSlotFactsReady = slotsReady;
      receivers = undefined;
    }
  };
  const query = (node: t.ThisExpression): readonly t.Node[] => {
    refresh();
    const owner = lexicalOwner(node);
    if (t.isProgram(owner))
      return javaScriptRuntimeContext(owner) === "unknown" ? [owner] : [];
    if (
      t.isStaticBlock(owner) ||
      ((t.isClassProperty(owner) ||
        t.isClassPrivateProperty(owner) ||
        t.isClassAccessorProperty(owner)) &&
        owner.static)
    ) {
      // Static initialization uses the declaring constructor, including in
      // lexical arrows. Its inherited helpers can still be shared intrinsics.
      const body = state.parentsByNode.get(owner);
      const declaring =
        body === undefined ? undefined : state.parentsByNode.get(body);
      return t.isClass(declaring) ? [declaring] : [];
    }
    if (!t.isFunction(owner)) return inheritedReceiver(owner);
    if (receivers === undefined) indexReceivers();
    const known = receivers?.get(owner);
    // Unrecovered calls/accessors may choose the global receiver. Absence of
    // a recovered call is not evidence that a source-visible write is harmless.
    return known === undefined
      ? [state.program, ...inheritedReceiver(owner)]
      : [...known, ...inheritedReceiver(owner)];
  };
  const result: ReceiverQuery = Object.assign(query, {
    nonEscapingBoundTarget: (node: t.Node) => {
      if (!t.isCallExpression(node)) return undefined;
      refresh();
      if (receivers === undefined) indexReceivers();
      return nonEscapingBoundTarget?.(node);
    },
    privateReadSources: (
      node: t.MemberExpression | t.OptionalMemberExpression,
    ): readonly SemanticReturnedReference[] => {
      if (!t.isPrivateName(node.property)) return [];
      // Private storage belongs to the lexical brand, never an unknown public
      // property spelling. These are possible sources; mutations remain owned
      // by the storage graph and no initializer proves a later slot intact.
      return (privateTargets(node.property)?.members ?? []).flatMap(
        (member) => {
          if (member.value === null || member.kind === "set") return [];
          return member.kind === "get"
            ? returned(member.value).references
            : [{ node: member.value, projection: [] }];
        },
      );
    },
    wrapper: (node: t.ThisExpression) =>
      t.isProgram(lexicalOwner(node)) &&
      javaScriptRuntimeContext(state.program) === "commonjs",
    constructed: (node: t.ThisExpression) => {
      const owner = lexicalOwner(node);
      if (
        t.isProgram(owner) ||
        t.isStaticBlock(owner) ||
        ((t.isClassProperty(owner) ||
          t.isClassPrivateProperty(owner) ||
          t.isClassAccessorProperty(owner)) &&
          owner.static)
      )
        return [];
      query(node);
      if (receivers === undefined) indexReceivers();
      return constructed.get(owner) ?? [];
    },
    completion: (node: t.Node) => {
      if (
        !t.isNewExpression(node) &&
        !t.isCallExpression(node) &&
        !t.isOptionalCallExpression(node)
      )
        return undefined;
      refresh();
      if (receivers === undefined) indexReceivers();
      const completion = completions.get(node);
      return completion?.sources.length ? completion : undefined;
    },
    unknown: (node: t.ThisExpression) => {
      const owner = lexicalOwner(node);
      if (
        t.isProgram(owner) ||
        t.isStaticBlock(owner) ||
        ((t.isClassProperty(owner) ||
          t.isClassPrivateProperty(owner) ||
          t.isClassAccessorProperty(owner)) &&
          owner.static)
      )
        return [];
      query(node);
      if (receivers === undefined) indexReceivers();
      return unknownReceivers.get(owner) ?? [];
    },
    allocatedBefore: (
      receiver: SemanticConstructedReceiver,
      mutation: t.Node,
    ) => {
      let owner: t.Node | undefined = mutation;
      while (owner !== undefined && !receiver.activations.includes(owner))
        owner = state.parentsByNode.get(owner);
      if (owner === undefined || unknownActivations.has(owner)) return false;
      let parent = state.parentsByNode.get(receiver.allocation);
      while (parent !== undefined) {
        if (t.isLoop(parent) || t.isFunction(parent)) return false;
        parent = state.parentsByNode.get(parent);
      }
      return [...(activationSites.get(owner) ?? [])].every(
        (site) =>
          site === receiver.allocation ||
          semanticEffectTiming(receiver.allocation, site, state) === "after",
      );
    },
  });
  if (!customContext) receiverQueries.set(state, result);
  return result;
};
