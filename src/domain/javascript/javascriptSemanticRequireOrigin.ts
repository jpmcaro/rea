import * as t from "@babel/types";
import { javaScriptRuntimeContext } from "./javascriptSourceParser.js";
import {
  createSemanticRequireShimInertQuery,
  semanticRequireShimBinding,
  semanticRequireShimValueSource,
} from "./javascriptRequireShimOrigin.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";
import { semanticExpressionValueDiscarded } from "./javascriptSemanticExpressionUsage.js";
import {
  semanticOwnReferenceCandidates,
  semanticEverySourcePropertySlot,
} from "./javascriptSemanticObjectReferences.js";
import {
  createSemanticModuleStorageQuery,
  semanticAmbientBindingPaths,
  semanticAmbientReferencePaths,
  semanticAmbientEscapeEffects,
  semanticAmbientIdentitySourcesReady,
  semanticAmbientOwnSlotUnchanged,
  semanticAmbientPrototypeUnchanged,
  type SemanticModuleProjection as ModuleProjection,
} from "./javascriptSemanticAmbientWrites.js";
import {
  semanticCopiedReferencePath,
  semanticReferenceSourcesInactive,
} from "./javascriptSemanticReferenceSources.js";
import {
  electronMemberPath,
  semanticIntrinsicMutation,
  semanticIntrinsicMutationTargets,
} from "./javascriptElectronMemberWrites.js";

import { BUILTIN_RESOURCE_METHODS } from "./javascriptBuiltinResourceMethods.js";
import type { JavaScriptModuleOrigin } from "./javascriptSemanticIr.js";
import {
  resolveSemanticBindingState,
  isUnmodifiedCommonJsWrapperBinding,
  commonJsWrapperBindingDeclaration,
  isUnshadowedGlobal,
  semanticResolutionBlocked,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import {
  readExactJavaScriptLiteral,
  semanticStaticPropertyKey,
  semanticObjectPrototypeProperty,
  staticObjectOwnProperty,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  semanticPropertyPathKeyMatches,
  type JavaScriptSemanticPropertyPath,
} from "./javascriptSemanticPropertyPaths.js";
import { stringValue } from "./javascriptStaticAnalysisHelpers.js";
import {
  createSemanticPrecedingEffectIndex,
  semanticBindingAtRead,
  semanticDefiniteMutationPrecedesRead,
  semanticEffectTiming,
  semanticEffectFollowsInitialCapture,
  semanticTopLevelEffectFollowsCapture,
} from "./javascriptSemanticMutationInitializers.js";
import {
  createSemanticModuleInterop,
  semanticFreshObjectFactsReady,
} from "./javascriptModuleInterop.js";
import {
  INVOCATION_HELPERS,
  semanticFunctionValueIdentity,
  isSemanticUnknownReferenceIdentity,
  semanticFunctionValueReadDependencies,
  SEMANTIC_OWN_PROPERTY_DESCRIPTOR,
} from "./javascriptSemanticFunctionValues.js";
import {
  semanticGlobalBindingReadMayHaveChanged,
  semanticAmbientWriteMayMatch,
  semanticOpaqueBindingReadMayHaveChanged,
  semanticSiteMayExecute,
  semanticStrictContext,
} from "./javascriptSemanticOpaqueEffects.js";

export interface JavaScriptRequireOrigin {
  readonly origin: JavaScriptModuleOrigin;
  readonly call: t.CallExpression | t.OptionalCallExpression;
}

export type JavaScriptRequireLoaderFact =
  | "commonjs-loader"
  | "factory-loader"
  | "create-require"
  | "local"
  | "unknown";

/** Classify a bare `require(...)` using the shared lexical binding owner. */
export const semanticRequireLoaderAt = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  state: JavaScriptSemanticAnalysisState,
  factoryBindingIds: ReadonlySet<string>,
): JavaScriptRequireLoaderFact => {
  const callee = unwrapJavaScriptExpression(node.callee).node;
  const loader = t.isIdentifier(callee, { name: "require" })
    ? callee
    : (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
        ["resolve", "main"].includes(
          semanticStaticPropertyKey(callee.property, callee.computed) ?? "",
        ) &&
        t.isIdentifier(callee.object, { name: "require" })
      ? callee.object
      : undefined;
  if (loader === undefined) return "local";
  const binding = resolveSemanticBindingState(state, loader, "require");
  if (binding === undefined) {
    if (semanticResolutionBlocked(state, loader, "require")) return "unknown";
    return semanticHostRequireBindingWritesIntact(node, state)
      ? "commonjs-loader"
      : "unknown";
  }
  if (factoryBindingIds.has(binding.bindingId))
    return binding.initializers.length === 0 ? "factory-loader" : "unknown";
  if (
    binding.hostOrigin === "commonjs-wrapper" &&
    [...binding.declarationKinds].every((kind) => kind === "var")
  ) {
    if (binding.definitions.some(({ kind }) => kind === "function"))
      return "local";
    return !semanticHostRequireBindingWritesIntact(node, state) ||
      commonJsWrapperBindingHasPriorWrite(node, binding, state)
      ? "unknown"
      : "commonjs-loader";
  }
  if (isWrapperRequireInitializerCall(binding, node, state))
    return semanticHostRequireBindingWritesIntact(node, state)
      ? "commonjs-loader"
      : "unknown";
  const wrapperBinding = commonJsWrapperBindingDeclaration(
    loader,
    "require",
    state,
  );
  if (
    wrapperBinding !== undefined &&
    semanticHostRequireBindingWritesIntact(node, state) &&
    !commonJsWrapperBindingHasPriorWrite(node, wrapperBinding, state)
  )
    return "commonjs-loader";
  if (isSemanticCreateRequireBinding(binding, state)) return "create-require";
  const initializer = semanticStableInitializer(binding, state)?.node;
  if (
    (binding.kind === "function" || binding.kind === "class") &&
    initializer !== undefined
  )
    return "local";
  if (
    binding.declarationKinds.size === 1 &&
    binding.declarationKinds.has("const") &&
    (t.isFunctionExpression(initializer) ||
      t.isArrowFunctionExpression(initializer))
  )
    return "local";
  return "unknown";
};

const commonJsWrapperBindingHasPriorWrite = (
  site: t.Node,
  binding: NonNullable<ReturnType<typeof resolveSemanticBindingState>>,
  state: JavaScriptSemanticAnalysisState,
  duringInitializer = false,
): boolean => {
  const writes = state.bindingWrites.get(binding.bindingId) ?? [];
  const declarationInitializers = binding.initializers
    .map(({ node }) => node)
    .filter(
      (initializer) =>
        !(
          duringInitializer &&
          semanticReadDuringInitializer(site, initializer, state)
        ) &&
        !writes.some((write) => semanticNodeWithin(initializer, write, state)),
    );
  return (
    writes.some(
      (write) => !semanticEffectFollowsInitialCapture(site, write, state),
    ) ||
    declarationInitializers.some(
      (initializer) =>
        !semanticEffectFollowsInitialCapture(site, initializer, state),
    )
  );
};

const semanticNodeWithin = (
  node: t.Node,
  ancestor: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  let current: t.Node | undefined = node;
  while (current !== undefined) {
    if (current === ancestor) return true;
    current = state.parentsByNode.get(current);
  }
  return false;
};

/** Function bodies/default parameters and instance fields run after their
 * enclosing value is allocated; computed keys still run during allocation. */
const semanticReadDuringInitializer = (
  site: t.Node,
  initializer: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  let current = site;
  while (current !== initializer) {
    const parent = state.parentsByNode.get(current);
    if (parent === undefined) return false;
    if (
      t.isFunction(parent) &&
      (parent.body === current ||
        parent.params.some((param) => param === current))
    ) {
      const invocation = state.parentsByNode.get(parent);
      if (
        parent.async ||
        parent.generator ||
        !t.isCallExpression(invocation) ||
        unwrapJavaScriptExpression(invocation.callee).node !== parent
      )
        return false;
    }
    if (
      (t.isClassProperty(parent) ||
        t.isClassPrivateProperty(parent) ||
        t.isClassAccessorProperty(parent)) &&
      !parent.static &&
      parent.value === current
    )
      return false;
    current = parent;
  }
  return true;
};

/** Classify a call through an exact recovered factory-loader binding. */
export const semanticFactoryRequireLoaderAt = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  state: JavaScriptSemanticAnalysisState,
  bindingIds: ReadonlySet<string>,
): JavaScriptRequireLoaderFact | undefined => {
  const callee = unwrapJavaScriptExpression(node.callee).node;
  if (t.isIdentifier(callee))
    return semanticFactoryLoaderMemberAt(node, state, bindingIds, null);
  if (
    (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
    semanticStaticPropertyKey(callee.property, callee.computed) === "bind"
  )
    return semanticFactoryLoaderMemberAt(node, state, bindingIds, "bind");
  return undefined;
};

/** Classify an exact loader call by binding identity and expected member. */
export const semanticFactoryLoaderMemberAt = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  state: JavaScriptSemanticAnalysisState,
  bindingIds: ReadonlySet<string>,
  member: string | null,
): JavaScriptRequireLoaderFact | undefined => {
  const callee = unwrapJavaScriptExpression(node.callee).node;
  let loader: t.Identifier | undefined;
  if (member === null) {
    if (t.isIdentifier(callee)) loader = callee;
  } else if (
    (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
    semanticStaticPropertyKey(callee.property, callee.computed) === member
  ) {
    const root = unwrapJavaScriptExpression(callee.object).node;
    if (t.isIdentifier(root)) loader = root;
  }
  if (loader === undefined) return undefined;
  const binding = resolveSemanticBindingState(state, loader, loader.name);
  if (binding === undefined || !bindingIds.has(binding.bindingId))
    return undefined;
  return binding.initializers.length === 0 ? "factory-loader" : "unknown";
};

const isSemanticCreateRequireBinding = (
  binding: NonNullable<ReturnType<typeof resolveSemanticBindingState>>,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (binding.initializers.length !== 1) return false;
  const initializer = semanticStableInitializer(binding, state)?.node;
  if (!t.isCallExpression(initializer)) return false;
  const callee = unwrapJavaScriptExpression(initializer.callee).node;
  if (t.isIdentifier(callee)) {
    const origins = resolveSemanticBindingState(
      state,
      callee,
      callee.name,
    )?.directOrigins;
    if (origins?.length !== 1) return false;
    const [origin] = origins;
    return (
      origin?.importedPath.at(-1) === "createRequire" &&
      ["module", "node:module"].includes(origin.specifier)
    );
  }
  const chain = semanticMemberChain(callee);
  if (chain === undefined || chain.members.at(-1) !== "createRequire")
    return false;
  if (!t.isNode(chain.root)) return false;
  const root = unwrapJavaScriptExpression(chain.root).node;
  if (!t.isIdentifier(root)) return false;
  const origins = resolveSemanticBindingState(
    state,
    root,
    root.name,
  )?.directOrigins;
  if (origins?.length !== 1) return false;
  const [origin] = origins;
  return (
    origin?.importedPath.length === 0 &&
    ["module", "node:module"].includes(origin.specifier)
  );
};

/** The RHS call runs before its assignment replaces Node's wrapper loader. */
const isWrapperRequireInitializerCall = (
  binding: NonNullable<ReturnType<typeof resolveSemanticBindingState>>,
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const scope = state.scopesById.get(binding.scopeId);
  if (
    scope?.kind !== "program" ||
    binding.kind !== "variable" ||
    binding.declarationKinds.size !== 1 ||
    !binding.declarationKinds.has("var") ||
    binding.initializers.length !== 1 ||
    binding.initializers[0]?.node !== node
  )
    return false;
  const assignment = state.parentsByNode.get(node);
  if (
    !t.isAssignmentExpression(assignment) ||
    assignment.right !== node ||
    state.conditionallySkippedExpressions.has(node)
  )
    return false;
  const statement = state.parentsByNode.get(assignment);
  if (!t.isExpressionStatement(statement)) return false;
  if (state.parentsByNode.get(statement) !== state.program) return false;
  const target = unwrapJavaScriptExpression(assignment.left).node;
  return (
    t.isIdentifier(target, { name: "require" }) &&
    resolveSemanticBindingState(state, target, target.name) === binding
  );
};

// Ambient indexing finishes before these derived facts are consumed. Keep only
// replacement sites, rather than rescanning unrelated global member writes.
const globalProcessReplacements = new WeakMap<
  JavaScriptSemanticAnalysisState,
  readonly (t.Node | undefined)[]
>();
const moduleRequireWrites = new WeakMap<
  JavaScriptSemanticAnalysisState,
  {
    readonly ambientCount: number;
    readonly ambientSourcesReady: boolean;
    readonly escapeEffects: ReturnType<typeof semanticAmbientEscapeEffects>;
    readonly freshObjectFactsReady: boolean;
    readonly opaqueScopeCount: number;
    readonly writes: readonly ModuleDelegateWrite[];
  }
>();

interface ModuleDelegateOwner {
  readonly delegate: "require" | "_load";
  readonly shared: boolean;
}

interface ModuleDelegateWrite extends ModuleDelegateOwner {
  readonly node: t.Node;
  /** Deleting the wrapper's inherited require is inert until its own slot can change. */
  readonly deletesInitiallyAbsentOwnSlot?: true;
  /** ||= and ??= cannot write an intact, initially callable delegate. */
  readonly shortCircuitsOnInitialDelegate?: true;
  /** Metadata preserves an existing shared data value, but cannot prove one exists. */
  readonly preservesInitialDataValue?: true;
  /** Copy identity and capture points are separate from prior-effect validity. */
  readonly delegateCopy?: {
    readonly target: t.Node;
    readonly targetKind: "module" | "delegate" | "prototype" | "module-owner";
    readonly values: readonly t.Node[];
    /** Reflect.set also looks up a descriptor on its independent first target. */
    readonly lookupTarget?: t.Node;
  };
}

const writesModuleRequire = (
  state: JavaScriptSemanticAnalysisState,
): readonly ModuleDelegateWrite[] => {
  const cached = moduleRequireWrites.get(state);
  const ambientCount = state.ambientWriteEffects.length;
  const ambientSourcesReady = semanticAmbientIdentitySourcesReady(state);
  const escapeEffects = semanticAmbientEscapeEffects(state);
  const freshObjectFactsReady = semanticFreshObjectFactsReady(state);
  const opaqueScopeCount = state.opaqueEffects.byScope.size;
  if (
    cached?.ambientCount === ambientCount &&
    cached.ambientSourcesReady === ambientSourcesReady &&
    cached.escapeEffects === escapeEffects &&
    cached.freshObjectFactsReady === freshObjectFactsReady &&
    cached.opaqueScopeCount === opaqueScopeCount
  )
    return cached.writes;
  // Interop invocation resolution may ask for require provenance while this
  // index is being built. Publish a temporary empty result to break that cycle.
  moduleRequireWrites.set(state, {
    ambientCount,
    ambientSourcesReady,
    escapeEffects,
    freshObjectFactsReady,
    opaqueScopeCount,
    writes: [],
  });
  const writes: ModuleDelegateWrite[] = [];
  const interop = createSemanticModuleInterop(state, {
    intrinsicWriteFacts: {
      ambientWrites: state.ambientWrites,
      ambientWriteEffects: state.ambientWriteEffects,
      complete: freshObjectFactsReady,
    },
  });
  const inertShimNode = createSemanticRequireShimInertQuery(state, {
    ambientWrites: state.ambientWrites,
    ambientWriteEffects: state.ambientWriteEffects,
    complete: freshObjectFactsReady,
  });
  const retain = (path: JavaScriptSemanticPropertyPath, node: t.Node): void => {
    if (inertShimNode(node)) return;
    if (isSemanticUnknownReferenceIdentity(path)) {
      writes.push(
        { node, delegate: "require", shared: true },
        { node, delegate: "_load", shared: true },
      );
      return;
    }
    const owner = semanticModuleDelegateWriteOwner(path, node, interop, state);
    if (owner !== undefined) writes.push({ node, ...owner });
  };
  // Ambient indexing owns container stores and intrinsic prototype aliases.
  // Queries made during indexing must be refreshed when those facts arrive.
  for (const { node, path } of state.ambientWriteEffects) {
    if (node === undefined) continue;
    retain(path, node);
  }
  const projectionMayAliasModule = createSemanticModuleStorageQuery(
    state,
    interop,
  );
  const isModuleObject = (
    node: t.Node,
    visited = new Set<string>(),
    projection: ModuleProjection = [],
  ): boolean => {
    const completed = semanticAmbientReferencePaths(
      node,
      node,
      projection.map(({ key }) => (key === null ? null : String(key))),
      state,
    );
    if (
      completed !== undefined &&
      !completed.some(
        (path) => path[0] === "commonjs-module" && path.length > 1,
      )
    )
      return completed.some(
        (path) =>
          path[0] === null ||
          (path[0] === "commonjs-module" && path.length === 1),
      );
    const { root: value, members } = electronMemberPath(node);
    const selected = [
      ...members.map((key) => ({ key, capture: node })),
      ...projection,
    ];
    if (t.isCallExpression(value) || t.isOptionalCallExpression(value))
      return interop.callReferenceSources(value, members).some((source) => {
        const path = source.projection;
        if (
          path?.[0] !== SEMANTIC_OWN_PROPERTY_DESCRIPTOR ||
          (path[2] !== "value" && path[2] !== null)
        )
          return false;
        const keys = [path[1]!, ...path.slice(3)];
        return isModuleObject(source.node, visited, [
          ...keys.map((key) => ({
            key: typeof key === "symbol" ? null : key,
            capture: value,
          })),
          ...projection,
        ]);
      });
    if (!t.isIdentifier(value)) return false;
    if (value.name === "module") {
      const original =
        resolveSemanticBindingState(state, value, "module") === undefined
          ? !semanticResolutionBlocked(state, value, "module")
          : isUnmodifiedCommonJsWrapperBinding(value, "module", state);
      return (
        original &&
        (selected.length === 0 || projectionMayAliasModule(selected))
      );
    }
    const binding = resolveSemanticBindingState(state, value, value.name);
    if (binding === undefined || visited.has(binding.bindingId)) return false;
    const next = new Set(visited).add(binding.bindingId);
    const atRead = semanticBindingAtRead(
      binding,
      value,
      state.parentsByNode,
    ).binding;
    // A module property starts distinct, but a visible replacement can store
    // the module itself. Retain the complete path through nested projections.
    // Separate capture sites keep a copied slot fixed while allowing a later
    // read of a property inside that captured object to see intervening writes.
    const sources = [
      ...atRead.initializers.map((initializer) => ({
        node: initializer.node,
        path: [
          ...initializer.projection.map((key) => ({
            key,
            capture: initializer.node,
          })),
          ...selected,
        ],
      })),
      ...atRead.referenceInitializers.flatMap((initializer) => {
        if (semanticReferenceSourcesInactive(initializer, state, "syntax-only"))
          return [];
        const path = semanticCopiedReferencePath(
          initializer,
          selected.map(({ key }) => key),
          "reference",
        );
        if (path === null) return [];
        const captures = [
          ...initializer.projection.map(() => initializer.node),
          ...selected.map(({ capture }) => capture),
        ];
        const offset = initializer.copyProjectionOffset;
        if (offset !== undefined) {
          captures.splice(offset, 1);
          captures[offset] = initializer.node;
        }
        return [
          {
            node: initializer.node,
            path: path.map((key, index) => ({
              key: typeof key === "object" ? null : key,
              capture: captures[index] ?? initializer.node,
            })),
          },
        ];
      }),
    ];
    return sources.some(({ node: init, path }) =>
      isModuleObject(init, next, path),
    );
  };
  // Direct eval can reach the wrapper's live delegate through the module
  // binding or visible captured contents even when the saved loader is shadowed.
  // Its text is opaque: both the instance/prototype method and Module._load can
  // change. Keeping these in the shared index preserves invocation/capture
  // semantics for wrappers, saved delegates, and createRequire results.
  for (const [scopeId, effects] of state.opaqueEffects.byScope) {
    let visible: JavaScriptSemanticBindingState[] | undefined;
    const visibleBindings = (): readonly JavaScriptSemanticBindingState[] => {
      if (visible !== undefined) return visible;
      visible = [];
      const names = new Set<string>();
      let scope = state.scopesById.get(scopeId);
      while (scope !== undefined) {
        for (const binding of scope.bindings.values()) {
          if (names.has(binding.name)) continue;
          names.add(binding.name);
          visible.push(binding);
        }
        scope =
          scope.parentScopeId === null
            ? undefined
            : state.scopesById.get(scope.parentScopeId);
      }
      return visible;
    };
    for (const effect of effects) {
      if (inertShimNode(effect)) continue;
      const moduleBinding = resolveSemanticBindingState(
        state,
        effect,
        "module",
      );
      const seesWrapperModule =
        moduleBinding === undefined
          ? !semanticResolutionBlocked(state, effect, "module")
          : isUnmodifiedCommonJsWrapperBinding(effect, "module", state);
      if (
        !seesWrapperModule &&
        !visibleBindings().some((binding) =>
          semanticAmbientBindingPaths(binding, effect, state).some(
            (path) =>
              semanticModuleDelegateWriteOwner(
                [...path, "require"],
                effect,
                interop,
                state,
              ) ||
              semanticModuleDelegateWriteOwner(
                [...path, "_load"],
                effect,
                interop,
                state,
              ),
          ),
        )
      )
        continue;
      writes.push(
        { node: effect, delegate: "require", shared: true },
        { node: effect, delegate: "_load", shared: true },
      );
    }
  }
  traverseJavaScriptAst(state.program, {
    enter: (node) => {
      const target = t.isAssignmentExpression(node)
        ? node.left
        : t.isUpdateExpression(node) ||
            t.isUnaryExpression(node, { operator: "delete" })
          ? node.argument
          : undefined;
      if (
        (t.isMemberExpression(target) ||
          t.isOptionalMemberExpression(target)) &&
        isModuleObject(target.object)
      ) {
        const key = semanticStaticPropertyKey(target.property, target.computed);
        retain(["commonjs-module", key], node);
      }
      if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
        const invocation = interop.intrinsicInvocation(node);
        const mutation = semanticIntrinsicMutation(invocation);
        if (invocation !== undefined && mutation !== undefined) {
          const targets = semanticIntrinsicMutationTargets(
            invocation,
            interop.isFreshObject,
          );
          // A known mutator whose recipient is unexamined, such as a spread
          // or missing argument list, can write the module object itself
          // once it runs. An opaque callee is an uncertain helper identity,
          // which the escape owner handles; it has no argument facts here.
          if (
            invocation.kind === "known" &&
            targets.some(
              (target) => target === undefined || t.isSpreadElement(target),
            )
          ) {
            if (semanticSiteMayExecute(node, state)) retain([null], node);
          } else if (
            targets.some(
              (target) => target !== undefined && isModuleObject(target),
            )
          ) {
            const key =
              "key" in mutation
                ? (interop.staticString(mutation.key) ?? null)
                : null;
            retain(["commonjs-module", key], node);
          }
        }
      }
    },
  });
  // Initial absence and truthiness are facts of the canonical delegate owner.
  // Inert deletes and short-circuit assignments do not invalidate each other's
  // initial-state proof. Any preceding non-inert write or escape removes it.
  let effectiveWrites = writes;
  const copiesInitialDelegate = new Set<ModuleDelegateWrite>();
  const isInitialDelegate = (value: t.Node): boolean =>
    hostLoaderPath(value, state, true)?.join(".") ===
    `intrinsic.${HOST_LOADER}.delegate`;
  for (const write of writes) {
    const copy = write.delegateCopy;
    if (
      write.delegate === "require" &&
      copy !== undefined &&
      (copy.lookupTarget === undefined ||
        [HOST_MODULE, HOST_MODULE_PROTOTYPE].includes(
          hostLoaderPath(copy.lookupTarget, state, true)?.join(".") ?? "",
        ) ||
        initialDelegateLookupWithoutSetter(
          copy.lookupTarget,
          write.node,
          state,
        )) &&
      (copy.targetKind === "delegate"
        ? isInitialDelegate(copy.target)
        : (copy.targetKind === "module-owner"
            ? [HOST_MODULE, HOST_MODULE_PROTOTYPE]
            : [
                copy.targetKind === "module"
                  ? HOST_MODULE
                  : HOST_MODULE_PROTOTYPE,
              ]
          ).includes(
            hostLoaderPath(copy.target, state, true)?.join(".") ?? "",
          )) &&
      copy.values.every(isInitialDelegate)
    )
      copiesInitialDelegate.add(write);
  }
  const requiresPriorChange = (write: ModuleDelegateWrite): boolean =>
    write.deletesInitiallyAbsentOwnSlot === true ||
    write.shortCircuitsOnInitialDelegate === true ||
    write.preservesInitialDataValue === true ||
    copiesInitialDelegate.has(write);
  if (escapeEffects !== undefined && writes.some(requiresPriorChange)) {
    const possibleDefinitions = createSemanticPrecedingEffectIndex(
      state.parentsByNode,
      (capture, effect) =>
        semanticEffectFollowsInitialCapture(capture, effect, state),
    );
    for (const write of writes)
      if (!requiresPriorChange(write)) possibleDefinitions.add(write);
    for (const escape of escapeEffects)
      if (moduleDelegateOwner(escape.path) !== undefined)
        possibleDefinitions.add(escape);
    effectiveWrites = writes.filter(
      (write) =>
        !requiresPriorChange(write) ||
        possibleDefinitions.mayPrecede(write.node),
    );
  }
  moduleRequireWrites.set(state, {
    ambientCount,
    ambientSourcesReady,
    escapeEffects,
    freshObjectFactsReady,
    opaqueScopeCount,
    writes: effectiveWrites,
  });
  return effectiveWrites;
};

/** Unknown keys and spreads cannot prove the loader delegate was untouched. */
const objectMayDefineDelegate = (
  node: t.Node | undefined,
  state: JavaScriptSemanticAnalysisState,
  invokesSetters = false,
  delegate: "require" | "_load" = "require",
): boolean => {
  if (node === undefined) return true;
  node = unwrapJavaScriptExpression(node).node;
  const literal = readExactJavaScriptLiteral(node);
  // Exact non-string primitives have no own keys after boxing. Nonempty
  // strings do: their indexed characters can invoke target setters.
  if (
    t.isRegExpLiteral(node) ||
    (t.isArrayExpression(node) &&
      node.elements.every((element) => element === null)) ||
    (literal.found &&
      (typeof literal.value !== "string" || literal.value.length === 0)) ||
    t.isBigIntLiteral(node) ||
    (t.isUnaryExpression(node) &&
      (node.operator === "+" || node.operator === "-") &&
      (t.isNumericLiteral(node.argument) ||
        (node.operator === "-" && t.isBigIntLiteral(node.argument)))) ||
    (t.isUnaryExpression(node, { operator: "void" }) &&
      readExactJavaScriptLiteral(node.argument).found) ||
    isUnshadowedGlobal(node, state, "undefined")
  )
    return false;
  return (
    !t.isObjectExpression(node) ||
    node.properties.some((property) => {
      if (t.isSpreadElement(property)) return true;
      const key = semanticStaticPropertyKey(property.key, property.computed);
      return (
        key === null ||
        key === delegate ||
        // Object.assign invokes the legacy prototype setter for an own
        // __proto__ key. A literal prototype initializer creates no own key.
        (invokesSetters &&
          delegate === "require" &&
          key === "__proto__" &&
          (t.isObjectMethod(property) ||
            property.computed ||
            property.shorthand))
      );
    })
  );
};

/** Initial setter absence depends on the owners actually traversed by the
 * operation, checked against the completed mutation and escape snapshot. */
const initialAssignmentSettersAbsent = (
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
  owners: readonly (readonly string[])[],
): boolean => {
  const escapes = semanticAmbientEscapeEffects(state);
  if (!semanticFreshObjectFactsReady(state) || escapes === undefined)
    return false;
  const precedes = (node: t.Node | undefined): boolean =>
    node !== capture &&
    (node === undefined ||
      !semanticEffectFollowsInitialCapture(capture, node, state));
  const affectsOwner = (path: JavaScriptSemanticPropertyPath): boolean =>
    owners.some((owner) =>
      path
        .slice(0, owner.length)
        .every((key, index) =>
          semanticPropertyPathKeyMatches(key, owner[index]!),
        ),
    );
  return (
    !state.opaqueEffects.globalSites.some(precedes) &&
    !state.ambientWriteEffects.some(
      (effect) => affectsOwner(effect.path) && precedes(effect.node),
    ) &&
    !escapes.some(
      (effect) => affectsOwner(effect.path) && precedes(effect.node),
    )
  );
};

/** Reflect.set reads descriptors without invoking getters. An ordinary lookup
 * without a setter either copies the initial value to the receiver or fails
 * without changing it. Value and prototype captures keep their own read times. */
const initialDelegateLookupWithoutSetter = (
  target: t.Node,
  read: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (!semanticFreshObjectFactsReady(state)) return false;
  const facts = {
    ownSlotUnchanged: (owner: t.Node, key: string, at: t.Node) =>
      semanticAmbientOwnSlotUnchanged(state, owner, key, at),
    physicalPrototype: (owner: t.Node, at: t.Node) =>
      semanticAmbientPrototypeUnchanged(state, owner, at)
        ? { status: "unchanged" as const }
        : { status: "unknown" as const },
  };
  const targets = semanticOwnReferenceCandidates(target, [], state, facts);
  return (
    targets.complete &&
    targets.nodes.every(
      (node) =>
        t.isObjectExpression(node) &&
        semanticEverySourcePropertySlot(
          node,
          "require",
          read,
          state,
          facts,
          (slot) =>
            slot.kind === "missing" ||
            (slot.kind === "source" && !slot.mayInvokeSetter) ||
            (slot.kind === "ordinary-prototype" &&
              initialAssignmentSettersAbsent(read, state, [
                ["global", "Object", "prototype"],
              ])),
        ),
    )
  );
};

/** Literal assign sources expose data values at their creation captures. Only
 * the final own property is copied; unknown keys, accessors and prototype-setter
 * keys can have other effects and cannot certify an initial-value copy. */
const assignedDelegateValues = (
  sources: readonly (t.Node | undefined)[],
  state: JavaScriptSemanticAnalysisState,
  capture: t.Node,
): readonly t.Node[] | undefined => {
  const values: t.Node[] = [];
  for (const source of sources) {
    if (source === undefined) return undefined;
    const object = unwrapJavaScriptExpression(source).node;
    if (!t.isObjectExpression(object)) {
      const literal = readExactJavaScriptLiteral(object);
      if (
        literal.found &&
        typeof literal.value === "string" &&
        initialAssignmentSettersAbsent(capture, state, [
          ["commonjs-module"],
          ["global", "Object", "prototype"],
        ])
      )
        continue;
      if (objectMayDefineDelegate(object, state, true)) return undefined;
      continue;
    }
    const prototype = semanticObjectPrototypeProperty(object);
    if (
      object.properties.some((property) => {
        if (t.isSpreadElement(property)) return true;
        const key = semanticStaticPropertyKey(property.key, property.computed);
        return (
          key === null ||
          (t.isObjectMethod(property) && property.kind !== "method") ||
          (key === "__proto__" && property !== prototype)
        );
      })
    )
      return undefined;
    const own = staticObjectOwnProperty(object, "require");
    if (own.status === "missing") continue;
    if (own.status !== "explicit" || !t.isObjectProperty(own.property))
      return undefined;
    values.push(own.property.value);
  }
  return values;
};

/** Whether the original global process object can still own effects at this source site. */
export const semanticOriginalGlobalProcessAt = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  let replacements = globalProcessReplacements.get(state);
  if (replacements === undefined) {
    replacements = [
      ...state.ambientWriteEffects
        .filter(
          ({ path }) =>
            path.length <= 2 &&
            path.every((key, index) =>
              semanticPropertyPathKeyMatches(
                key,
                ["global", "process"][index]!,
              ),
            ),
        )
        .map(({ node: write }) => write),
      ...(state.ambientBindingWrites.get("process") ?? []),
    ];
    globalProcessReplacements.set(state, replacements);
  }
  return !replacements.some(
    (write) =>
      !semanticTopLevelEffectFollowsCapture(node, write, state.parentsByNode),
  );
};

/** Node's unbound process reference shares the cached process exports object. */
export const semanticGlobalProcessOrigin = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptModuleOrigin | undefined =>
  t.isIdentifier(node, { name: "process" }) &&
  resolveSemanticBindingState(state, node, "process") === undefined &&
  !semanticResolutionBlocked(state, node, "process") &&
  semanticOriginalGlobalProcessAt(node, state)
    ? { specifier: "node:process", importedPath: [], resolutionMode: "require" }
    : undefined;

/** Resolve qualified global-object process references, preserving their selected path. */
export const semanticGlobalProcessPathOrigin = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptModuleOrigin | undefined => {
  const members: string[] = [];
  let current = unwrapJavaScriptExpression(node).node;
  while (
    t.isMemberExpression(current) ||
    t.isOptionalMemberExpression(current)
  ) {
    const key = semanticStaticPropertyKey(current.property, current.computed);
    if (key === null) return undefined;
    members.unshift(key);
    current = unwrapJavaScriptExpression(current.object).node;
  }
  if (
    !t.isIdentifier(current) ||
    !["globalThis", "global", "window", "self"].includes(current.name) ||
    resolveSemanticBindingState(state, current, current.name) !== undefined ||
    semanticResolutionBlocked(state, current, current.name) ||
    members[0] !== "process" ||
    !semanticOriginalGlobalProcessAt(node, state)
  )
    return undefined;
  return {
    specifier: "node:process",
    importedPath: members.slice(1),
    resolutionMode: "require",
  };
};

/** Strip a static member chain, returning its root expression and member path. */
export const semanticMemberChain = (
  node: t.Node | null | undefined,
):
  | { readonly root: t.Node | null | undefined; readonly members: string[] }
  | undefined => {
  const members: string[] = [];
  let current = node;
  while (current !== null && current !== undefined) {
    current = unwrapJavaScriptExpression(current).node;
    if (
      !t.isMemberExpression(current) &&
      !t.isOptionalMemberExpression(current)
    )
      break;
    const member = semanticStaticPropertyKey(
      current.property,
      current.computed,
    );
    if (member === null || !t.isNode(current.object)) return undefined;
    members.push(member);
    current = current.object;
  }
  return { root: current, members: members.reverse() };
};

/**
 * Whether no write to the module `require` delegate happens before `capture`
 * runs. A saved `require` function still calls the current `module.require`, so
 * this check belongs at the point the loader is invoked, not only where it was
 * captured.
 */
export const semanticHostRequireModuleWritesIntact = (
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  !writesModuleRequire(state).some(
    ({ node: write }) =>
      !semanticEffectFollowsInitialCapture(capture, write, state),
  );

/** Select the delegate owner independently of how its identity was exposed. */
const moduleDelegateOwner = (
  path: JavaScriptSemanticPropertyPath,
): ModuleDelegateOwner | undefined => {
  if (path[0] !== "commonjs-module") return undefined;
  // Ambient value normalization already selects the shared Module owners.
  // Module.prototype owns require: changing its parent cannot replace that
  // slot, while changing the wrapper's immediate prototype can hide it.
  const wrapper = path.length <= 2;
  const shared =
    path.length === 3 && (path[1] === "__proto__" || path[1] === "constructor");
  if (!wrapper && !shared) return undefined;
  // The inherited instance method dispatches through Module._load as well.
  const delegate = shared && path[1] === "constructor" ? "_load" : "require";
  const owner = { delegate, shared } as const;
  const key = path.at(-1)!;
  if (path.length === 1) return owner;
  if (
    !semanticPropertyPathKeyMatches(key, delegate) &&
    !(wrapper && key === "__proto__")
  )
    return undefined;
  return owner;
};

/** Initial data descriptors are owner facts, independent of loader validity. */
export const semanticInitialModuleDelegateDataProperty = (
  path: readonly string[],
): ReturnType<typeof semanticFunctionValueReadDependencies> | undefined => {
  const owner = moduleDelegateOwner(path);
  return owner !== undefined && path.at(-1) === owner.delegate
    ? semanticFunctionValueReadDependencies(path)
    : undefined;
};

/** Retain explicit captured values separately from omitted descriptor fields.
 * Own-slot and prototype proofs exclude inherited fields and callbacks. */
const initialDelegateDescriptor = (
  input: t.Node | undefined,
  projection: readonly string[],
  read: t.Node,
  state: JavaScriptSemanticAnalysisState,
):
  | { readonly values: readonly t.Node[]; readonly omitsValue: boolean }
  | undefined => {
  if (input === undefined) return undefined;
  const ownSlotUnchanged = (owner: t.Node, key: string, capture: t.Node) =>
    semanticAmbientOwnSlotUnchanged(state, owner, key, capture);
  const references = semanticOwnReferenceCandidates(
    input,
    projection,
    state,
    { ownSlotUnchanged },
    read,
  );
  if (
    !references.complete ||
    references.absent ||
    references.nodes.length === 0
  )
    return undefined;
  const escapeEffects = semanticAmbientEscapeEffects(state);
  const values: t.Node[] = [];
  let omitsValue = false;
  const complete = references.nodes.every((descriptor) => {
    if (
      !t.isObjectExpression(descriptor) ||
      !semanticAmbientPrototypeUnchanged(state, descriptor, read)
    )
      return false;
    const prototype = semanticObjectPrototypeProperty(descriptor);
    if (prototype !== undefined && !t.isNullLiteral(prototype.value))
      return false;
    const fields = [
      "value",
      "get",
      "set",
      "enumerable",
      "configurable",
      "writable",
    ];
    for (const key of fields) {
      const own = staticObjectOwnProperty(descriptor, key);
      if (
        !ownSlotUnchanged(descriptor, key, read) ||
        own.status === "dynamic" ||
        (own.status === "explicit" && !t.isObjectProperty(own.property)) ||
        (own.status !== "missing" && ["get", "set"].includes(key))
      )
        return false;
      if (key === "value") {
        if (own.status === "explicit" && t.isObjectProperty(own.property))
          values.push(own.property.value);
        else omitsValue = true;
      }
    }
    return (
      prototype !== undefined ||
      (escapeEffects !== undefined &&
        !state.opaqueEffects.globalSites.some(
          (effect) => !semanticEffectFollowsInitialCapture(read, effect, state),
        ) &&
        [...fields, "__proto__"].every(
          (key) =>
            !semanticAmbientWriteMayMatch(
              state,
              ["global", "Object", "prototype", key],
              (effect) =>
                !(effect.path.length === 2 && effect.path[1] === "Object") &&
                !semanticEffectFollowsInitialCapture(read, effect.node, state),
            ),
        ) &&
        [...fields, "__proto__"].every(
          (key) =>
            !semanticAmbientWriteMayMatch(
              { ambientWriteEffects: escapeEffects },
              ["global", "Object", "prototype", key],
              (effect) =>
                !semanticEffectFollowsInitialCapture(read, effect.node, state),
            ),
        ))
    );
  });
  return complete ? { values, omitsValue } : undefined;
};

/** Suppressing a native write requires completed helper and owner integrity. */
const completedNativeInvocation = (
  node: t.CallExpression | t.OptionalCallExpression,
  interop: ReturnType<typeof createSemanticModuleInterop>,
  state: JavaScriptSemanticAnalysisState,
) =>
  interop.intrinsicInvocation(
    node,
    {
      ambientWrites: state.ambientWrites,
      ambientWriteEffects: state.ambientWriteEffects,
      complete: semanticFreshObjectFactsReady(state),
    },
    true,
  );

/** Classify a canonical write; initial absence still needs prior-effect proof. */
export const semanticModuleDelegateWriteOwner = (
  path: JavaScriptSemanticPropertyPath,
  node: t.Node,
  interop: ReturnType<typeof createSemanticModuleInterop>,
  state: JavaScriptSemanticAnalysisState,
): Omit<ModuleDelegateWrite, "node"> | undefined => {
  const owner = moduleDelegateOwner(path);
  if (owner === undefined || path.length === 1) return owner;
  const wrapper = !owner.shared;
  const { delegate } = owner;
  const key = path.at(-1)!;
  if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
    const invocation = interop.intrinsicInvocation(node);
    const mutation = semanticIntrinsicMutation(invocation);
    const args = invocation?.arguments;
    if (
      wrapper &&
      key === "require" &&
      invocation?.kind === "known" &&
      mutation?.kind === "delete"
    )
      return { ...owner, deletesInitiallyAbsentOwnSlot: true };
    if (mutation?.kind === "set-prototype") return wrapper ? owner : undefined;
    if (mutation?.kind === "set" && key === "require") {
      const native = completedNativeInvocation(node, interop, state);
      const target = args?.[3] ?? args?.[0];
      const value = args?.[2];
      if (
        native?.kind === "known" &&
        native.path.join(".") === "intrinsic.Reflect.set" &&
        args?.[0] !== undefined &&
        !args.some(t.isSpreadElement) &&
        target !== undefined &&
        value !== undefined
      )
        return {
          ...owner,
          delegateCopy: {
            target,
            targetKind: "module-owner",
            lookupTarget: args[0],
            values: [value],
          },
        };
    }
    if (mutation?.kind === "assign") {
      if (
        args !== undefined &&
        !args
          .slice(1)
          .some((source) =>
            objectMayDefineDelegate(source, state, wrapper, delegate),
          )
      )
        return undefined;
      const values =
        wrapper && delegate === "require" && args !== undefined
          ? assignedDelegateValues(args.slice(1), state, node)
          : undefined;
      // Possible native ownership retains writes. Suppressing one requires
      // completed proof that the selected callable and helpers stayed native.
      const native =
        values === undefined
          ? undefined
          : completedNativeInvocation(node, interop, state);
      return native?.kind === "known" &&
        native.path.join(".") === "intrinsic.Object.assign" &&
        values !== undefined &&
        args?.[0] !== undefined
        ? {
            ...owner,
            delegateCopy: {
              target: args[0],
              targetKind: "module",
              values,
            },
          }
        : owner;
    }
    if (
      (mutation?.kind === "define-property" && mutation.receiver !== true) ||
      mutation?.kind === "define-properties"
    ) {
      const native = completedNativeInvocation(node, interop, state);
      const descriptor =
        native?.kind !== "known"
          ? undefined
          : mutation.kind === "define-property"
            ? initialDelegateDescriptor(args?.[2], [], node, state)
            : initialDelegateDescriptor(args?.[1], [delegate], node, state);
      if (descriptor !== undefined) {
        if (owner.shared && descriptor.values.length === 0)
          return { ...owner, preservesInitialDataValue: true };
        if (
          delegate === "require" &&
          args?.[0] !== undefined &&
          (owner.shared || !descriptor.omitsValue)
        )
          return {
            ...owner,
            delegateCopy: {
              target: args[0],
              targetKind: owner.shared ? "prototype" : "module",
              values: descriptor.values,
            },
          };
      }
    }
    if (mutation?.kind === "define-properties")
      return objectMayDefineDelegate(args?.[1], state, false, delegate)
        ? owner
        : undefined;
    // Defining an own __proto__ property does not invoke the legacy setter.
    return key !== "__proto__" || mutation?.kind === "set" ? owner : undefined;
  }
  if (
    key === delegate &&
    t.isAssignmentExpression(node) &&
    (node.operator === "=" || node.operator === "&&=")
  )
    return {
      ...owner,
      delegateCopy: {
        target: node.left,
        targetKind: "delegate",
        values: [node.right],
      },
    };
  if (
    key === delegate &&
    t.isAssignmentExpression(node) &&
    (node.operator === "||=" || node.operator === "??=")
  )
    return { ...owner, shortCircuitsOnInitialDelegate: true };
  if (
    wrapper &&
    key === "require" &&
    t.isUnaryExpression(node, { operator: "delete" })
  )
    return { ...owner, deletesInitiallyAbsentOwnSlot: true };
  return key !== "__proto__" || t.isAssignmentExpression(node)
    ? owner
    : undefined;
};

const wrapperArgumentReferences = new WeakMap<
  JavaScriptSemanticAnalysisState,
  readonly t.Identifier[]
>();

const ordinaryFunctionOwnsArguments = (
  node: t.Node,
  parent: t.Node | undefined,
): boolean =>
  t.isFunction(parent) &&
  !t.isArrowFunctionExpression(parent) &&
  (parent.body === node || parent.params.some((param) => param === node));

const withinWrapperArgumentsScope = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  let current = node;
  for (;;) {
    const parent = state.parentsByNode.get(current);
    if (parent === undefined) return current === state.program;
    if (ordinaryFunctionOwnsArguments(current, parent)) return false;
    current = parent;
  }
};

const COMMONJS_WRAPPER_PARAMETERS = [
  "exports",
  "require",
  "module",
  "__filename",
  "__dirname",
] as const;

/** Capturing a wrapper var before a later source write still reads the host
 * parameter. Whole-binding stability cannot describe that earlier value. */
export const semanticCommonJsWrapperInitialBinding = (
  reference: t.Node,
  name: "exports" | "module",
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (
    !t.isIdentifier(reference, { name }) ||
    javaScriptRuntimeContext(state.program) !== "commonjs"
  )
    return false;
  const binding = commonJsWrapperBindingDeclaration(reference, name, state);
  return (
    binding !== undefined &&
    !commonJsWrapperBindingHasPriorWrite(reference, binding, state, true)
  );
};

/** Parameter mapping shares the canonical arguments slots only in sloppy
 * wrappers; slot deletion and descriptor severing belong to heap facts. */
export const semanticCommonJsWrapperMappedParameterSlot = (
  name: (typeof COMMONJS_WRAPPER_PARAMETERS)[number],
  state: JavaScriptSemanticAnalysisState,
): string | undefined =>
  javaScriptRuntimeContext(state.program) === "commonjs" &&
  !semanticStrictContext(state.program, state)
    ? String(COMMONJS_WRAPPER_PARAMETERS.indexOf(name))
    : undefined;

/** Ordinary functions own arguments; arrow bodies retain the wrapper object. */
const semanticWrapperArgumentReferences = (
  state: JavaScriptSemanticAnalysisState,
): readonly t.Identifier[] => {
  let references = wrapperArgumentReferences.get(state);
  if (references === undefined) {
    const found: t.Identifier[] = [];
    traverseJavaScriptAst(state.program, {
      skip: (node) => {
        const parent = state.parentsByNode.get(node);
        // Ordinary functions own arguments in parameters and bodies, while
        // computed method keys and decorators still run in the outer scope.
        return ordinaryFunctionOwnsArguments(node, parent);
      },
      enter: (node) => {
        const parent = state.parentsByNode.get(node);
        if (
          t.isIdentifier(node, { name: "arguments" }) &&
          parent !== undefined &&
          t.isReferenced(node, parent, state.parentsByNode.get(parent))
        )
          found.push(node);
      },
    });
    references = found;
    wrapperArgumentReferences.set(state, references);
  }
  return references;
};

/** The original wrapper arguments object retains its values even in strict code.
 * Binding mapping and the identities stored in its slots are separate facts.
 */
export const semanticCommonJsWrapperArgumentsReference = (
  reference: t.Node,
  state: JavaScriptSemanticAnalysisState,
):
  | {
      readonly original: "exact" | "possible" | false;
      readonly replacements: readonly t.Node[];
    }
  | undefined => {
  if (
    !t.isIdentifier(reference, { name: "arguments" }) ||
    state.program.sourceType !== "script" ||
    javaScriptRuntimeContext(state.program) !== "commonjs" ||
    !semanticWrapperArgumentReferences(state).includes(reference)
  )
    return undefined;
  const binding = resolveSemanticBindingState(state, reference, "arguments");
  if (
    binding !== undefined &&
    (state.scopesById.get(binding.scopeId)?.kind !== "program" ||
      [...binding.declarationKinds].some((kind) => kind !== "var") ||
      binding.definitions.some(({ kind }) => kind === "function"))
  )
    return undefined;
  const writes = [
    ...(binding?.initializers.map(({ node }) => node) ?? []),
    ...(binding?.referenceInitializers.map(({ node }) => node) ?? []),
    ...(binding === undefined
      ? []
      : (state.bindingWrites.get(binding.bindingId) ?? [])),
    ...(state.ambientBindingWrites.get("arguments") ?? []),
  ].filter(
    (write) =>
      withinWrapperArgumentsScope(write, state) &&
      !semanticEffectFollowsInitialCapture(reference, write, state),
  );
  if (writes.length === 0) return { original: "exact", replacements: [] };
  const replacements = new Map<
    t.Node,
    {
      readonly source: t.Node | undefined;
      readonly candidates:
        | ReturnType<typeof semanticOwnReferenceCandidates>
        | undefined;
      distinct: boolean;
    }
  >();
  for (const write of writes) {
    const parent = state.parentsByNode.get(write);
    const mutation =
      (t.isAssignmentExpression(parent) && parent.right === write) ||
      (t.isVariableDeclarator(parent) && parent.init === write)
        ? parent
        : write;
    if (replacements.has(mutation)) continue;
    const source =
      t.isAssignmentExpression(mutation, { operator: "=" }) &&
      t.isIdentifier(mutation.left, { name: "arguments" })
        ? mutation.right
        : t.isVariableDeclarator(mutation) &&
            t.isIdentifier(mutation.id, { name: "arguments" })
          ? mutation.init
          : undefined;
    const candidates =
      source == null
        ? undefined
        : semanticOwnReferenceCandidates(source, [], state, {
            // Binding/conditional sources are available before ambient facts.
            // A member or getter source needs completed slot proof, so it
            // cannot establish a disjoint replacement here.
            ownSlotUnchanged: () => false,
            bindingReadMayHaveChanged: (candidate, read) =>
              // The implicit wrapper entry is not an ordinary empty var.
              // Do not let generic logical-initializer coverage erase it
              // while resolving an alias back to this same binding.
              (candidate === binding &&
                ![
                  ...candidate.initializers,
                  ...candidate.referenceInitializers,
                ].some(({ node }) => {
                  const owner = state.parentsByNode.get(node);
                  return (
                    ((t.isVariableDeclarator(owner) && owner.init === node) ||
                      (t.isAssignmentExpression(owner, { operator: "=" }) &&
                        owner.right === node)) &&
                    semanticDefiniteMutationPrecedesRead(
                      owner,
                      read,
                      state.parentsByNode,
                    )
                  );
                })) ||
              semanticOpaqueBindingReadMayHaveChanged(candidate, read, state),
          });
    replacements.set(mutation, {
      source: source ?? undefined,
      candidates,
      distinct: false,
    });
  }
  const replacementBefore = (read: t.Node) =>
    [...replacements].findLast(
      ([replacement, { distinct }]) =>
        distinct &&
        semanticDefiniteMutationPrecedesRead(
          replacement,
          read,
          state.parentsByNode,
        ) &&
        [...replacements].every(
          ([write, { distinct: otherDistinct }]) =>
            write === replacement ||
            otherDistinct ||
            semanticEffectFollowsInitialCapture(read, write, state) ||
            semanticEffectTiming(replacement, write, state) === "before",
        ),
    );
  // The shared reference query leaves ambient identifiers as captured leaves.
  // Resolve only those leaves back through this binding's already-proven
  // replacements. A monotone worklist avoids recursive alias evaluation.
  for (let changed = true; changed;) {
    changed = false;
    for (const value of replacements.values()) {
      if (
        value.distinct ||
        value.candidates?.complete !== true ||
        value.candidates.nodes.length === 0
      )
        continue;
      if (
        value.candidates.nodes.every(
          (node) =>
            t.isObjectExpression(node) ||
            t.isArrayExpression(node) ||
            t.isFunction(node) ||
            t.isClass(node) ||
            readExactJavaScriptLiteral(node).found ||
            (t.isIdentifier(node, { name: "arguments" }) &&
              resolveSemanticBindingState(state, node, "arguments") ===
                undefined &&
              semanticWrapperArgumentReferences(state).includes(node) &&
              replacementBefore(node) !== undefined),
        )
      ) {
        value.distinct = true;
        changed = true;
      }
    }
  }
  // A definite assignment can still return the original object through self,
  // conditional or captured aliases. Cut that edge only after the shared
  // reference owner proves a distinct value, with no later uncertain write.
  // Logical writes can retain the initially truthy wrapper object.
  const selected = replacementBefore(reference);
  return {
    original: selected === undefined ? "possible" : false,
    replacements: [...replacements].flatMap(([mutation, { source }]) =>
      source === undefined ||
      (selected !== undefined &&
        mutation !== selected[0] &&
        semanticEffectTiming(selected[0], mutation, state) === "before")
        ? []
        : [source],
    ),
  };
};

/** Sloppy mapped slots can also be replaced by writes to wrapper parameters.
 * A parameter write does not identify the old captured argument object as its
 * RHS. Keep the selected value unknown unless its mapping is immutable.
 */
export const semanticCommonJsWrapperArgumentValueChanged = (
  key: string | null | undefined,
  capture: t.Node | undefined,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (semanticStrictContext(state.program, state)) return false;
  const parameters = COMMONJS_WRAPPER_PARAMETERS;
  const names =
    key == null
      ? parameters
      : parameters.filter((_name, index) => String(index) === key);
  const scope = state.scopeByNode.get(state.program);
  return names.some((name) => {
    const binding = scope?.bindings.get(name);
    if (
      binding !== undefined &&
      [...binding.declarationKinds].some((kind) => kind !== "var")
    )
      return false;
    return (
      (binding !== undefined &&
        (capture === undefined
          ? binding.initializers.length > 0 ||
            (state.bindingWrites.get(binding.bindingId)?.length ?? 0) > 0
          : commonJsWrapperBindingHasPriorWrite(capture, binding, state))) ||
      (state.ambientBindingWrites.get(name) ?? []).some(
        (write) =>
          capture === undefined ||
          !semanticEffectFollowsInitialCapture(capture, write, state),
      )
    );
  });
};

/** Sloppy wrapper slots also map writes back to the require parameter. */
const semanticWrapperArgumentsExposedBefore = (
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  state.program.sourceType === "script" &&
  javaScriptRuntimeContext(state.program) === "commonjs" &&
  !semanticStrictContext(state.program, state) &&
  semanticWrapperArgumentReferences(state).some((reference) => {
    const member = state.parentsByNode.get(reference);
    if (
      (t.isMemberExpression(member) || t.isOptionalMemberExpression(member)) &&
      member.object === reference &&
      ["length", "3", "4"].includes(
        semanticStaticPropertyKey(member.property, member.computed) ?? "",
      )
    ) {
      if (
        semanticExpressionValueDiscarded(
          member,
          state.parentsByNode.get(member),
        )
      )
        return false;
    }
    return (
      semanticCommonJsWrapperArgumentsReference(reference, state)?.original &&
      !semanticEffectFollowsInitialCapture(capture, reference, state)
    );
  });

/** Binding integrity is independent of module.require's delegate validity.
 * The shim's inertness proof uses this same owner without recursively asking
 * whether the delegate escaped through the shim's own alternate branch.
 */
export const semanticHostRequireBindingWritesIntact = (
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  !semanticWrapperArgumentsExposedBefore(capture, state) &&
  !(state.ambientBindingWrites.get("require") ?? []).some(
    (write) => !semanticEffectFollowsInitialCapture(capture, write, state),
  );

/** Whether no module or ambient write replaces require before capture runs. */
export const semanticHostRequireWritesIntact = (
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  semanticHostRequireBindingWritesIntact(capture, state) &&
  semanticHostRequireModuleWritesIntact(capture, state);

/**
 * Whether `reference` reads the intact host `require` at the point `capture`
 * runs. This is the single owner for the host-loader checks shared by the
 * direct resolver and by the esbuild shim resolver, which reaches `require`
 * only through a `typeof require` guard. It applies the mandatory write checks
 * and the binding check together; a caller that has its own binding exception
 * must still require {@link semanticHostRequireWritesIntact} separately.
 */
export const semanticHostRequireIntact = (
  reference: t.Identifier,
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  semanticHostRequireWritesIntact(capture, state) &&
  semanticHostRequireBindingIntact(reference, state);

/** Whether the `require` reference is the unmodified CommonJS wrapper loader. */
const semanticHostRequireBindingIntact = (
  reference: t.Identifier,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const binding = resolveSemanticBindingState(state, reference, "require");
  if (binding !== undefined)
    return isUnmodifiedCommonJsWrapperBinding(reference, "require", state);
  return !semanticResolutionBlocked(state, reference, "require");
};

const HOST_MODULE = "node-wrapper-module";
const HOST_MODULE_PROTOTYPE = "node-module-prototype";
const HOST_LOADER = "node-host-loader";
const HOST_LOADER_IDENTITIES: Readonly<Record<string, readonly string[]>> = {
  wrapper: ["global", "require"],
  shim: ["global", "require"],
  delegate: ["commonjs-module", "__proto__", "require"],
  factory: ["commonjs-module", "constructor", "createRequire"],
};

/** Resolve the value read at each alias capture, rather than its current name. */
const hostLoaderPath = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  // The write index proves source identity separately from initial-state
  // validity; its preceding-effect gate must validate every such candidate.
  initialModuleDelegate = false,
): readonly string[] | undefined => {
  let current = node;
  let selected: ModuleProjection = [];
  const visited = new Set<string>();
  // Preserve a rejected helper read through the invocation owner's generic
  // call/apply normalization; returning no path would retry its receiver.
  const invalid = ["invalid-host-loader"];
  const untouched = (
    path: readonly string[],
    captures: readonly t.Node[],
    ownFrom = 0,
  ): boolean => {
    if (!state.ambientWrites.covers(path)) return true;
    return !state.ambientWriteEffects.some((effect) => {
      if (isSemanticUnknownReferenceIdentity(effect.path))
        return captures.some(
          (capture) =>
            !semanticEffectFollowsInitialCapture(capture, effect.node, state),
        );
      return (
        effect.path.length > ownFrom &&
        effect.path.length <= path.length &&
        effect.path.every((key, index) =>
          semanticPropertyPathKeyMatches(key, path[index]!),
        ) &&
        !semanticEffectFollowsInitialCapture(
          captures[Math.min(effect.path.length - 1, captures.length - 1)]!,
          effect.node,
          state,
        )
      );
    });
  };
  const helpersIntact = (
    initial: readonly string[],
    suffix: ModuleProjection,
  ): boolean => {
    let identity: readonly string[] | undefined = initial;
    for (const { key, capture } of suffix) {
      if (typeof key !== "string" || identity === undefined) return false;
      if (
        !untouched([...identity, key], [capture], identity.length) ||
        (INVOCATION_HELPERS.includes(key) &&
          (!untouched(["global", "Function", "prototype", key], [capture]) ||
            !untouched([...identity, "__proto__"], [capture], identity.length)))
      )
        return false;
      identity = semanticFunctionValueIdentity([...identity, key]);
    }
    return identity !== undefined;
  };
  const callable = (
    kind: "wrapper" | "shim" | "delegate" | "created" | "factory",
    suffix: ModuleProjection = selected,
  ): readonly string[] | undefined => {
    // Factory results are fresh callables. Their own invocation helpers do not
    // have a shared ambient identity, so only direct invocation is proven.
    if (kind === "created" && suffix.length !== 0) return invalid;
    const identity = HOST_LOADER_IDENTITIES[kind];
    if (identity !== undefined && !helpersIntact(identity, suffix))
      return invalid;
    return [
      "intrinsic",
      HOST_LOADER,
      kind,
      ...suffix.map(({ key }) => String(key)),
    ];
  };
  const factoryPath = (
    origin: JavaScriptModuleOrigin,
    projection: ModuleProjection,
    importedAt: t.Node,
  ): readonly string[] | undefined => {
    if (!["module", "node:module"].includes(origin.specifier)) return undefined;
    const path = [
      ...origin.importedPath.map((key) => ({ key, capture: importedAt })),
      ...projection,
    ];
    // Namespace exports are captured values. Only default/Module selects the
    // mutable constructor object; CommonJS has no synthetic default property.
    if (origin.resolutionMode !== "require") {
      const exported = path.shift();
      if (exported?.key === "createRequire") return callable("factory", path);
      if (exported?.key !== "default" && exported?.key !== "Module")
        return undefined;
    }
    while (path[0]?.key === "Module") {
      const property = path.shift()!;
      if (
        !untouched(
          ["commonjs-module", "constructor", "Module"],
          [property.capture],
        )
      )
        return undefined;
    }
    const factory = path.shift();
    if (
      factory?.key !== "createRequire" ||
      !untouched(
        ["commonjs-module", "constructor", "createRequire"],
        [factory.capture],
      )
    )
      return undefined;
    return callable("factory", path);
  };
  for (;;) {
    const { root, members } = electronMemberPath(current);
    selected = [
      ...members.map((key) => ({ key, capture: current })),
      ...selected,
    ];
    if (selected.some(({ key }) => key === null)) return undefined;
    if (t.isIdentifier(root)) {
      const binding = resolveSemanticBindingState(state, root, root.name);
      if (
        semanticResolutionBlocked(state, root, root.name) ||
        (binding !== undefined &&
          (semanticOpaqueBindingReadMayHaveChanged(binding, root, state) ||
            semanticGlobalBindingReadMayHaveChanged(binding, root, state)))
      )
        return undefined;
      if (
        root.name === "require" &&
        semanticHostRequireIntact(root, root, state)
      )
        return callable("wrapper");
      if (
        root.name === "module" &&
        (binding === undefined ||
          (commonJsWrapperBindingDeclaration(root, "module", state) !==
            undefined &&
            !commonJsWrapperBindingHasPriorWrite(root, binding, state))) &&
        !(state.ambientBindingWrites.get("module") ?? []).some(
          (write) => !semanticEffectFollowsInitialCapture(root, write, state),
        )
      ) {
        if (selected.length === 0) return [HOST_MODULE];
        if (
          initialModuleDelegate &&
          (selected.map(({ key }) => key).join(".") === "__proto__" ||
            selected.map(({ key }) => key).join(".") ===
              "constructor.prototype")
        ) {
          const path = [
            "commonjs-module",
            ...selected.map(({ key }) => String(key)),
          ];
          const escapes = semanticAmbientEscapeEffects(state);
          const intact =
            escapes !== undefined &&
            semanticFunctionValueReadDependencies(path).every((dependency) => {
              const capture =
                selected[Math.max(0, dependency.offset - 1)]?.capture ?? root;
              return (
                untouched(dependency.path, [capture], dependency.ownFrom) &&
                !semanticAmbientWriteMayMatch(
                  { ambientWriteEffects: escapes },
                  dependency.path,
                  (effect) =>
                    effect.path.length > dependency.ownFrom &&
                    !semanticEffectFollowsInitialCapture(
                      capture,
                      effect.node,
                      state,
                    ),
                )
              );
            });
          if (intact) return [HOST_MODULE_PROTOTYPE];
        }
        const [property, ...suffix] = selected;
        return property?.key === "require" &&
          (initialModuleDelegate ||
            semanticHostRequireModuleWritesIntact(property.capture, state))
          ? callable("delegate", suffix)
          : undefined;
      }
      if (
        binding === undefined &&
        ["Function", "Reflect"].includes(root.name)
      ) {
        const path = [root.name, ...selected.map(({ key }) => String(key))];
        const helperStart = root.name === "Function" ? 0 : 1;
        const identity =
          root.name === "Function"
            ? ["global", "Function"]
            : ["global", "Reflect", "apply"];
        return untouched(
          ["global", ...path],
          [root, root, ...selected.map(({ capture }) => capture)],
        ) && helpersIntact(identity, selected.slice(helperStart))
          ? ["intrinsic", ...path]
          : invalid;
      }
      if (binding === undefined || visited.has(binding.bindingId))
        return undefined;
      visited.add(binding.bindingId);
      if (
        binding.memberWrites.some(
          (effect) =>
            effect.path.length <= selected.length &&
            effect.path.every((key, index) =>
              semanticPropertyPathKeyMatches(key, String(selected[index]!.key)),
            ) &&
            !semanticEffectFollowsInitialCapture(
              selected[Math.max(0, effect.path.length - 1)]?.capture ?? root,
              effect.node,
              state,
            ),
        )
      )
        return invalid;

      if (semanticRequireShimBinding(root, state)) return callable("shim");
      const atRead = semanticBindingAtRead(binding, root, state.parentsByNode);
      // Direct import origins describe entry values. A preceding assignment or
      // an uncertain replacement must be resolved before using that entry.
      if (
        binding.directOrigins.length === 1 &&
        !atRead.hasDefiniteInitializer
      ) {
        if (
          (state.bindingWrites.get(binding.bindingId) ?? []).some(
            (write) => !semanticEffectFollowsInitialCapture(root, write, state),
          )
        )
          return undefined;
        const origin = binding.directOrigins[0]!;
        if (!binding.runtimeImport && origin.resolutionMode !== "require")
          return undefined;
        return factoryPath(origin, selected, root);
      }
      const [initializer] = atRead.binding.initializers;
      if (
        !atRead.hasDefiniteInitializer ||
        initializer === undefined ||
        atRead.binding.initializers.length !== 1 ||
        atRead.binding.referenceInitializers.length !== 0 ||
        state.conditionallySkippedExpressions.has(initializer.node)
      )
        return undefined;
      selected = [
        ...initializer.projection.map((key) => ({
          key,
          capture: initializer.node,
        })),
        ...selected,
      ];
      current = initializer.node;
      continue;
    }
    if (t.isCallExpression(root) || t.isOptionalCallExpression(root)) {
      // A required Module export supplies the same public factory as its ESM
      // export. Keep factory selection at its own read, including destructuring.
      if (selected.some(({ key }) => key === "createRequire")) {
        const required = semanticRequireOrigin(root, state)?.origin;
        if (required !== undefined)
          return factoryPath(required, selected, root);
      }
      const invocation = hostLoaderInvocation(root, state);
      if (
        invocation?.kind === "known" &&
        invocation.path.join(".") === `intrinsic.${HOST_LOADER}.factory` &&
        invocation.arguments?.length === 1
      )
        return callable("created");
    }
    return undefined;
  }
};

const hostLoaderInvocations = new WeakMap<
  JavaScriptSemanticAnalysisState,
  ReturnType<typeof createSemanticModuleInterop>
>();
const activeHostInvocations = new WeakSet<t.Node>();

/** Share proven host callable paths with receiver and bound-allocation owners. */
export const semanticRequireFunctionPath = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): readonly string[] | undefined => {
  const path = hostLoaderPath(node, state);
  return path?.[1] === HOST_LOADER ? path : undefined;
};

/** Share call/apply/bind argument normalization with all other intrinsic users. */
const hostLoaderInvocation = (
  node: t.CallExpression | t.OptionalCallExpression,
  state: JavaScriptSemanticAnalysisState,
) => {
  if (activeHostInvocations.has(node)) return undefined;
  activeHostInvocations.add(node);
  try {
    let resolver = hostLoaderInvocations.get(state);
    if (resolver === undefined) {
      resolver = createSemanticModuleInterop(state, {
        intrinsicPath: (value) => hostLoaderPath(value, state),
        intrinsicValueSource: (value) =>
          semanticRequireShimValueSource(value, state),
        intrinsicReadDependencies: (path) => {
          const identity =
            path[0] === "intrinsic" && path[1] === HOST_LOADER
              ? HOST_LOADER_IDENTITIES[path[2]!]
              : undefined;
          if (identity === undefined) return undefined;
          return semanticFunctionValueReadDependencies([
            ...identity,
            ...path.slice(3),
          ]).map((dependency) => ({
            ...dependency,
            // The logical loader prefix has three slots. Keep every suffix
            // read at its original capture when selecting the physical owner.
            offset: dependency.offset + 3 - identity.length,
          }));
        },
        // Logical loader paths are checked above; physical bound helper slots
        // need the ambient owner's completed facts, including later publication.
        boundFunctionWriteFacts: {
          ambientWrites: state.ambientWrites,
          ambientWriteEffects: state.ambientWriteEffects,
          get complete() {
            return semanticFreshObjectFactsReady(state);
          },
        },
      });
      hostLoaderInvocations.set(state, resolver);
    }
    return resolver.intrinsicInvocation(node);
  } finally {
    activeHostInvocations.delete(node);
  }
};

/** Recover a proven host-loader call and its exact selected export path. */
export const semanticRequireOrigin = (
  node: t.Node | null | undefined,
  state: JavaScriptSemanticAnalysisState,
  loader: "host" | "shim" = "host",
): JavaScriptRequireOrigin | undefined => {
  const chain = semanticMemberChain(node);
  const current = chain?.root;
  if (
    chain === undefined ||
    (!t.isCallExpression(current) && !t.isOptionalCallExpression(current))
  )
    return undefined;
  if (
    loader === "host" &&
    t.isIdentifier(current.callee, { name: "require" })
  ) {
    const requireBinding = resolveSemanticBindingState(
      state,
      current.callee,
      "require",
    );
    if (
      semanticHostRequireWritesIntact(current, state) &&
      (semanticHostRequireBindingIntact(current.callee, state) ||
        (requireBinding !== undefined &&
          isWrapperRequireInitializerCall(requireBinding, current, state)))
    ) {
      const specifier = stringValue(current.arguments[0]);
      return specifier === undefined
        ? undefined
        : {
            origin: {
              specifier,
              importedPath: chain.members,
              resolutionMode: "require",
            },
            call: current,
          };
    }
  }
  const invocation = hostLoaderInvocation(current, state);
  if (
    invocation?.kind !== "known" ||
    invocation.path.length !== 3 ||
    invocation.path[1] !== HOST_LOADER
  )
    return undefined;
  const kind = invocation.path[2];
  const specifier = stringValue(invocation.arguments?.[0]);
  if (
    specifier === undefined ||
    !(
      loader === "shim" ? ["shim"] : ["wrapper", "delegate", "created"]
    ).includes(kind ?? "")
  )
    return undefined;
  if (kind === "delegate") {
    const receiver = invocation.receiver ?? invocation.memberReceiver;
    if (
      receiver === undefined ||
      hostLoaderPath(receiver, state)?.join(".") !== HOST_MODULE ||
      writesModuleRequire(state).some(
        ({ node: write, delegate }) =>
          delegate === "_load" &&
          !semanticEffectFollowsInitialCapture(current, write, state),
      )
    )
      return undefined;
  } else if (
    writesModuleRequire(state).some(
      ({ node: write, shared }) =>
        (kind === "wrapper" || kind === "shim" || shared) &&
        !semanticEffectFollowsInitialCapture(current, write, state),
    )
  )
    return undefined;
  return {
    origin: {
      specifier,
      importedPath: chain.members,
      resolutionMode: "require",
    },
    call: current,
  };
};

/** Node's fs.promises export and fs/promises require share one object. */
export const semanticRequireExportsIdentity = <Key>(
  specifier: string,
  path: readonly Key[],
): { readonly specifier: string; readonly path: readonly (Key | string)[] } => {
  const name = specifier.replace(/^node:/u, "");
  if (name === "fs/promises") return { specifier: name, path };
  return name === "fs" && path[0] === "promises" && path.length > 1
    ? { specifier: "fs/promises", path: path.slice(1) }
    : { specifier: name, path };
};

const MUTABLE_BUILTIN_DEFAULTS = new Set([
  ...Object.keys(BUILTIN_RESOURCE_METHODS),
  "http",
  "https",
  "child_process",
  "timers",
  "process",
]);

/** Mutable default/object selections share CommonJS identity; namespace slots do not. */
export const semanticMutableBuiltinOrigin = <Key = never>(
  origin: JavaScriptModuleOrigin,
  selected: readonly Key[] = [],
):
  | { readonly specifier: string; readonly path: readonly (Key | string)[] }
  | undefined => {
  const path = [...origin.importedPath, ...selected];
  if (origin.resolutionMode === "require")
    return { specifier: origin.specifier, path };
  const specifier = origin.specifier.replace(/^node:/u, "");
  if (!MUTABLE_BUILTIN_DEFAULTS.has(specifier)) return undefined;
  if (path[0] === "default") return { specifier, path: path.slice(1) };
  if (specifier === "process" && (path[0] === "env" || path[0] === "argv"))
    return { specifier, path };
  return specifier === "fs" && path[0] === "promises"
    ? { specifier, path }
    : undefined;
};
