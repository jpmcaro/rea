import { parseExpression } from "@babel/parser";
import * as t from "@babel/types";

import type { JavaScriptModuleOrigin } from "./javascriptSemanticIr.js";
import {
  isUnshadowedGlobal,
  resolveSemanticBindingState,
  semanticScopeId,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import { semanticRequireOrigin } from "./javascriptSemanticRequireOrigin.js";
import {
  semanticAmbientEscapeEffects,
  semanticAmbientOwnSlotFactsReady,
} from "./javascriptSemanticAmbientWrites.js";
import { semanticClassPropertyDescriptors } from "./javascriptSemanticObjectReferences.js";
import {
  semanticBindingAtRead,
  semanticEffectFollowsInitialCapture,
} from "./javascriptSemanticMutationInitializers.js";
import {
  childNodes,
  javaScriptAstChildKeys,
} from "./javascriptSemanticTraversal.js";
import {
  electronMemberPath,
  type JavaScriptIntrinsicInvocation,
} from "./javascriptElectronMemberWrites.js";
import {
  expandJavaScriptInvocationArguments,
  resolveJavaScriptIntrinsicInvocation,
  type JavaScriptBoundHelperRead,
} from "./javascriptIntrinsicInvocation.js";
import {
  semanticArrayIndex,
  SemanticPropertyPathCoverage,
} from "./javascriptSemanticPropertyPaths.js";
import {
  SEMANTIC_PHYSICAL_PROTOTYPE,
  SEMANTIC_SOURCE_PROTO_DESCRIPTOR,
  SEMANTIC_OWN_PROPERTY_DESCRIPTOR,
  semanticCallableValueIdentity,
  semanticArrayReferenceResult,
  semanticFunctionValueReadDependencies,
  type SemanticFunctionValueReadDependency,
  type SemanticFunctionValueReadPath,
  type SemanticFunctionValueProjection,
} from "./javascriptSemanticFunctionValues.js";
import {
  readExactJavaScriptLiteral,
  runtimeFunctionParameters,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  semanticAmbientWriteMayMatch,
  semanticGlobalBindingReadMayHaveChanged,
  semanticOpaqueBindingReadMayHaveChanged,
  type SemanticGlobalBindingFacts,
  semanticArrayIterationMayBeReplaced,
} from "./javascriptSemanticOpaqueEffects.js";

// Match the complete Rolldown runtime operations, including its live getters.
// Names and formatting are irrelevant; lexical roles, operators and keys are not.
const TO_ESM = parseExpression(`(mod, isNodeMode, target) => (
  target = mod != null ? __create(__getProtoOf(mod)) : {},
  __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default")
    ? __defProp(target, "default", {value: mod, enumerable: true}) : target, mod)
)`);
const COPY_PROPS = parseExpression(`(to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function")
    for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
      key = keys[i];
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, {
          get: ((k) => from[k]).bind(null, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
    }
  return to;
}`);
const INTRINSICS: Readonly<Record<string, readonly string[]>> = {
  __create: ["Object", "create"],
  __getProtoOf: ["Object", "getPrototypeOf"],
  __defProp: ["Object", "defineProperty"],
  __getOwnPropNames: ["Object", "getOwnPropertyNames"],
  __getOwnPropDesc: ["Object", "getOwnPropertyDescriptor"],
  __hasOwnProp: ["Object", "prototype", "hasOwnProperty"],
};
const OWN_DESCRIPTOR_INTRINSICS = new Set([
  "intrinsic.Object.getOwnPropertyDescriptor",
  "intrinsic.Reflect.getOwnPropertyDescriptor",
  "intrinsic.Object.getOwnPropertyDescriptors",
]);

interface IntrinsicDependency {
  readonly path: readonly string[];
  readonly readPath?: SemanticFunctionValueReadPath;
  readonly sourceFunction?: t.Function | t.Class;
  readonly capturedAt?: t.Node;
  readonly captures?: readonly (t.Node | undefined)[];
  /** Supplier aliases are selected at initialization, not helper invocation. */
  readonly bindingReads?: readonly {
    readonly binding: JavaScriptSemanticBindingState;
    readonly read: t.Node;
  }[];
}

interface InteropOrigin {
  readonly origin: JavaScriptModuleOrigin;
  readonly dependencies: readonly IntrinsicDependency[];
  readonly defaultIsModule: boolean;
}

interface InteropHelper {
  readonly dependencies: readonly IntrinsicDependency[];
  /** Live lexical slots read when the helper executes, not at declaration. */
  readonly bindings: readonly JavaScriptSemanticBindingState[];
  readonly readyAfter: number;
  readonly identity: boolean;
}

interface InteropReferenceSource {
  /** The result may be the captured source object itself. */
  readonly identity?: true;
  readonly node: t.Expression;
  readonly projection: SemanticFunctionValueProjection | undefined;
  /** Namespace default selection does not select a slot on the input. */
  readonly projectionOffset: number;
  readonly capturePrefix?: readonly t.Node[];
}

const completedFreshObjectFacts =
  new WeakSet<JavaScriptSemanticAnalysisState>();

/** Derived mutation caches must distinguish provisional and final proofs. */
export const semanticFreshObjectFactsReady = (
  state: JavaScriptSemanticAnalysisState,
): boolean => completedFreshObjectFacts.has(state);

/** Ambient writes and deferred opaque calls must both be indexed first. */
export const completeSemanticFreshObjectFacts = (
  state: JavaScriptSemanticAnalysisState,
): void => {
  completedFreshObjectFacts.add(state);
};

/** Prove one inert namespace conversion without relaxing general assignment semantics. */
export const createSemanticModuleInterop = (
  state: JavaScriptSemanticAnalysisState,
  options?: {
    readonly intrinsicPath?: (node: t.Node) => readonly string[] | undefined;
    /** A proven computed value may retain a source read at its own capture. */
    readonly intrinsicValueSource?: (node: t.Node) => t.Node | undefined;
    /** Physical dependencies and capture offsets for a consumer's logical paths. */
    readonly intrinsicReadDependencies?: (
      path: readonly string[],
    ) => readonly SemanticFunctionValueReadDependency[] | undefined;
    /** The consumer supplies proven loader origins with its module-write coverage. */
    readonly loaderOrigin?: (
      node: t.Node,
    ) => JavaScriptModuleOrigin | undefined;
    /** Complete canonical effects, kept separate from nominal alias paths. */
    readonly intrinsicWriteFacts?: SemanticGlobalBindingFacts;
    /** Canonical helpers may need facts independent of a consumer's logical callables. */
    readonly intrinsicInvocationWriteFacts?: (
      path: readonly string[],
    ) => SemanticGlobalBindingFacts | undefined;
    /** Physical bound helper reads can use facts independently of logical receiver paths. */
    readonly boundFunctionWriteFacts?: SemanticGlobalBindingFacts;
    /** Complete normalized source selections, with binding and slot proof at reads. */
    readonly sourceFunctionCapture?: (
      node: t.Node,
      projection: readonly (string | null)[],
    ) =>
      | {
          readonly node: t.Function | t.Class;
          readonly projection: readonly (string | number | null)[];
          readonly captures?: readonly t.Node[];
        }
      | undefined;
    /** Complete source-call/result coverage supersedes nominal native aliases.
     * It is queried separately from cached invocation syntax. */
    readonly sourceCallResultComplete?: (
      node: t.CallExpression | t.OptionalCallExpression,
    ) => boolean;
    /** A producer may supply complete provisional facts before publication. */
    readonly bindingReadMayHaveChanged?: (
      binding: JavaScriptSemanticBindingState,
      read: t.Node,
    ) => boolean;
  },
) => {
  const loaderOrigin =
    options?.loaderOrigin ??
    ((node: t.Node) => semanticRequireOrigin(node, state)?.origin);
  const globalBindingFacts = {
    ambientWrites: state.ambientWrites,
    ambientWriteEffects: state.ambientWriteEffects,
    get complete() {
      return completedFreshObjectFacts.has(state);
    },
  };
  const bindingReadMayHaveChanged = (
    binding: JavaScriptSemanticBindingState,
    read: t.Node,
  ): boolean =>
    options?.bindingReadMayHaveChanged?.(binding, read) ??
    (semanticOpaqueBindingReadMayHaveChanged(binding, read, state) ||
      semanticGlobalBindingReadMayHaveChanged(
        binding,
        read,
        state,
        options?.intrinsicWriteFacts ?? globalBindingFacts,
      ));
  const helpers = new Map<string, InteropHelper | null>();
  const origins = new Map<string, InteropOrigin>();
  const calls = new WeakMap<t.Node, InteropOrigin>();
  const writes: {
    readonly scope: string;
    readonly offset: number;
    readonly path: readonly (string | null)[];
    readonly coverage: SemanticPropertyPathCoverage;
  }[] = [];
  const intrinsicDependencies = new Map<
    string,
    readonly SemanticFunctionValueReadDependency[] | null
  >();
  let dependencyFactsReady = semanticFreshObjectFactsReady(state);
  let dependencySlotsReady = semanticAmbientOwnSlotFactsReady(state);
  const readDependencies = (
    path: SemanticFunctionValueReadPath,
    sourceFunction?: t.Function | t.Class,
  ) => {
    const factsReady = semanticFreshObjectFactsReady(state);
    const slotsReady = semanticAmbientOwnSlotFactsReady(state);
    if (
      dependencyFactsReady !== factsReady ||
      dependencySlotsReady !== slotsReady
    ) {
      // Source ancestry captures refresh with the binding and own-slot owners.
      dependencyFactsReady = factsReady;
      dependencySlotsReady = slotsReady;
      intrinsicDependencies.clear();
    }
    const key = JSON.stringify(path);
    let dependencies = intrinsicDependencies.get(key);
    if (dependencies === undefined) {
      // Recursive source-parent aliases cannot establish their own identity.
      intrinsicDependencies.set(key, null);
      const canonical: SemanticFunctionValueReadPath = [
        path[0] === "intrinsic" ? "global" : path[0]!,
        ...path.slice(1),
      ];
      dependencies =
        options?.intrinsicReadDependencies?.(
          path.map((key) =>
            key === SEMANTIC_PHYSICAL_PROTOTYPE ? "__proto__" : key,
          ),
        ) ??
        (sourceFunction === undefined
          ? semanticFunctionValueReadDependencies(canonical)
          : semanticFunctionValueReadDependencies(canonical, sourceFunction, {
              classParent: (node) => {
                if (node.superClass == null) return undefined;
                const selected = options?.sourceFunctionCapture?.(
                  node.superClass,
                  [],
                );
                if (selected?.projection.length === 0)
                  return {
                    path: semanticCallableValueIdentity(selected.node),
                    source: selected.node,
                  };
                const captured = capturedIntrinsic(node.superClass);
                if (
                  captured === undefined ||
                  captured.sourceFunction !== undefined ||
                  captured.path[0] !== "intrinsic" ||
                  captured.path[1] === "local-receiver" ||
                  dependencyReadChanged(captured)
                )
                  return undefined;
                return { path: ["global", ...captured.path.slice(1)] };
              },
              classOwnPropertyAbsent: (node, member) => {
                const descriptor = semanticClassPropertyDescriptors(
                  node,
                  member,
                  "static",
                );
                return (
                  descriptor.inherits &&
                  descriptor.fields.length === 0 &&
                  descriptor.getters.length === 0 &&
                  !descriptor.mayInvokeSetter
                );
              },
            })) ??
        null;
      intrinsicDependencies.set(key, dependencies);
    }
    return dependencies === null ? undefined : dependencies;
  };
  const invalidatedBindings = new Map<string, boolean>();
  const invalidatedCalls = new WeakMap<t.Node, boolean>();
  const opaqueMutationPath = (node: t.Node): readonly string[] => {
    let current: t.Node | undefined = node;
    while (current !== undefined) {
      if (t.isFunction(current))
        return ["opaque-intrinsic", semanticScopeId("function", current)];
      current = state.parentsByNode.get(current);
    }
    return ["intrinsic"];
  };

  const createIntrinsicPath = (references = false) => {
    const intrinsicBindings = new Map<string, readonly string[] | null>();
    return (node: t.Node): readonly string[] | undefined => {
      let current = node;
      const visited = new Set<string>();
      const pending: { id: string; suffixLength: number }[] = [];
      let suffix: readonly string[] = [];
      const finish = (
        path: readonly string[] | undefined,
      ): readonly string[] | undefined => {
        for (const binding of pending)
          intrinsicBindings.set(
            binding.id,
            path === undefined
              ? null
              : path.slice(0, path.length - binding.suffixLength),
          );
        return path;
      };
      for (;;) {
        const { root, members } = electronMemberPath(current);
        if (members.some((member) => member === null)) return finish(undefined);
        suffix = [...(members as readonly string[]), ...suffix];
        if (references) {
          let method = suffix.length - 1;
          while (
            method >= 0 &&
            ["call", "apply", "bind"].includes(suffix[method]!)
          )
            method -= 1;
          if (
            method >= 0 &&
            semanticArrayReferenceResult(suffix[method]!) !== undefined
          )
            return finish([
              "intrinsic",
              "Array",
              "prototype",
              ...suffix.slice(method),
            ]);
        }
        for (const global of [
          "Object",
          "Function",
          "Reflect",
          ...(references ? ["Array"] : []),
        ])
          if (isUnshadowedGlobal(root, state, global))
            return finish(["intrinsic", global, ...suffix]);
        for (const global of ["globalThis", "global", "window", "self"])
          if (isUnshadowedGlobal(root, state, global))
            return finish(["intrinsic", ...suffix]);
        if (!t.isIdentifier(root)) return finish(undefined);
        const binding = resolveSemanticBindingState(state, root, root.name);
        const cached =
          binding === undefined
            ? undefined
            : intrinsicBindings.get(binding.bindingId);
        if (cached !== undefined)
          return finish(cached === null ? undefined : [...cached, ...suffix]);
        const initializer = semanticStableInitializer(binding, state);
        if (
          binding === undefined ||
          initializer === undefined ||
          initializer.projection.some((segment) => segment === null) ||
          visited.has(binding.bindingId)
        )
          return finish(undefined);
        visited.add(binding.bindingId);
        pending.push({ id: binding.bindingId, suffixLength: suffix.length });
        suffix = [...initializer.projection.map(String), ...suffix];
        current = initializer.node;
      }
    };
  };
  const intrinsicPath = options?.intrinsicPath ?? createIntrinsicPath();
  // Literal array spreads expand to positions only while nothing in this
  // source can have replaced array iteration; see the opaque-effects owner.
  const expandSpreads = !semanticArrayIterationMayBeReplaced(state);
  // Nominal native candidates only add possible result aliases. They never
  // establish callable integrity, freshness, or an escape exclusion.
  const referenceIntrinsicPath = createIntrinsicPath(true);
  // A nominal alias path is sufficient for conservative mutation lookup, but
  // helper proof also needs each read to follow initialization. An alias copy
  // retains the earlier function capture; a member read captures it anew.
  const intrinsicBindingReadMayHaveChanged = (
    binding: JavaScriptSemanticBindingState,
    read: t.Node,
    proofFacts?: SemanticGlobalBindingFacts,
  ): boolean => {
    const facts =
      proofFacts ??
      options?.intrinsicWriteFacts ??
      options?.boundFunctionWriteFacts;
    return (
      facts !== undefined &&
      (semanticOpaqueBindingReadMayHaveChanged(binding, read, state) ||
        semanticGlobalBindingReadMayHaveChanged(binding, read, state, facts))
    );
  };
  const capturedIntrinsic = (
    node: t.Node,
    proofFacts?: SemanticGlobalBindingFacts,
  ): IntrinsicDependency | undefined => {
    const path = intrinsicPath(node);
    if (path === undefined) return undefined;
    const visited = new Set<string>();
    const visitedValues = new Set<t.Node>();
    let current = node;
    let capturedAt = node;
    let captures: readonly t.Node[] = [];
    const bindingReads: NonNullable<
      IntrinsicDependency["bindingReads"]
    >[number][] = [];
    let projection: readonly (string | null)[] = [];
    for (;;) {
      const { root, members } = electronMemberPath(current);
      projection = [...members, ...projection];
      captures = [...members.map(() => current), ...captures];
      if (t.isFunction(root) || t.isClass(root)) {
        if (!projection.every((key): key is string => key !== null))
          return undefined;
        const readPath = [
          ...semanticCallableValueIdentity(root),
          ...projection,
        ];
        return {
          path,
          readPath,
          sourceFunction: root,
          capturedAt,
          captures: [capturedAt, capturedAt, ...captures],
          bindingReads,
        };
      }
      if (!t.isIdentifier(root)) {
        const source = options?.intrinsicValueSource?.(root);
        if (source !== undefined) {
          if (visitedValues.has(root)) return undefined;
          visitedValues.add(root);
          current = source;
          continue;
        }
        const selected = options?.sourceFunctionCapture?.(node, []);
        if (
          selected === undefined ||
          selected.projection.some((key) => key === null)
        )
          return undefined;
        return {
          path,
          readPath: [
            ...semanticCallableValueIdentity(selected.node),
            ...selected.projection.map(String),
          ],
          sourceFunction: selected.node,
          capturedAt,
          captures: [
            capturedAt,
            capturedAt,
            ...(selected.captures ??
              (selected.projection.length === 0
                ? []
                : captures.slice(-selected.projection.length))),
          ],
          bindingReads,
        };
      }
      // Class aliases can have later assignments while this earlier read still
      // captures the original constructor. Reuse the source selection owner's
      // read snapshot before the nominal stable-alias fallback.
      const selectedClass = options?.sourceFunctionCapture?.(root, []);
      if (
        selectedClass?.projection.length === 0 &&
        t.isClass(selectedClass.node) &&
        projection.every((key): key is string => key !== null)
      )
        return {
          path,
          readPath: [
            ...semanticCallableValueIdentity(selectedClass.node),
            ...projection,
          ],
          sourceFunction: selectedClass.node,
          capturedAt,
          captures: [capturedAt, capturedAt, ...captures],
          bindingReads,
        };
      const binding = resolveSemanticBindingState(state, root, root.name);
      if (binding === undefined)
        return {
          path,
          capturedAt,
          captures:
            captures.length > path.length
              ? path.map(() => capturedAt)
              : [
                  ...Array<t.Node>(path.length - captures.length).fill(current),
                  ...captures,
                ],
          bindingReads,
        };
      if (intrinsicBindingReadMayHaveChanged(binding, root, proofFacts))
        return undefined;
      bindingReads.push({ binding, read: root });
      const initializer = semanticStableInitializer(binding, state);
      if (
        initializer === undefined ||
        (!t.isFunctionDeclaration(initializer.node) &&
          (initializer.node.end ?? Infinity) >= (root.start ?? -1)) ||
        visited.has(binding.bindingId)
      )
        return undefined;
      visited.add(binding.bindingId);
      if (captures.length === 0 && !t.isFunctionDeclaration(initializer.node))
        capturedAt = initializer.node;
      projection = [
        ...initializer.projection.map((key) =>
          key === null ? null : String(key),
        ),
        ...projection,
      ];
      captures = [
        ...initializer.projection.map(() => initializer.node),
        ...captures,
      ];
      current = initializer.node;
    }
  };

  const staticString = (node: t.Node | undefined): string | undefined => {
    if (node === undefined) return undefined;
    const visited = new Set<string>();
    let current = node;
    for (;;) {
      const literal = readExactJavaScriptLiteral(current);
      if (literal.found)
        return typeof literal.value === "string" ? literal.value : undefined;
      const expression = unwrapJavaScriptExpression(current).node;
      if (!t.isIdentifier(expression)) return undefined;
      const binding = resolveSemanticBindingState(
        state,
        expression,
        expression.name,
      );
      const initializer = semanticStableInitializer(binding, state);
      if (
        binding === undefined ||
        initializer === undefined ||
        initializer.projection.length !== 0 ||
        (initializer.node.end ?? Infinity) >= (expression.start ?? -1) ||
        visited.has(binding.bindingId)
      )
        return undefined;
      visited.add(binding.bindingId);
      current = initializer.node;
    }
  };

  const retainedReadChanged = (dependency: IntrinsicDependency): boolean => {
    const capture = dependency.capturedAt;
    if (capture === undefined) return true;
    const dependencies = readDependencies(
      dependency.readPath ?? dependency.path,
      dependency.sourceFunction,
    );
    if (dependencies === undefined) return true;
    return dependencies.some(({ path, ownFrom, offset }) => {
      const selectedAt = dependency.captures?.[offset] ?? capture;
      const scope = opaqueMutationPath(selectedAt).join(".");
      return writes.some(
        (write) =>
          (write.scope === scope || write.scope === "intrinsic") &&
          write.offset < (selectedAt.start ?? -1) &&
          (write.path.length === 1 || write.path.length > ownFrom) &&
          write.coverage.covers(
            path[0] === "global" ? ["intrinsic", ...path.slice(1)] : path,
          ),
      );
    });
  };

  const dependencyReadChanged = (
    dependency: IntrinsicDependency,
    facts = options?.intrinsicWriteFacts,
    checkEscapes = false,
  ): boolean => {
    const capture = dependency.capturedAt;
    if (capture === undefined) return true;
    const dependencies = readDependencies(
      dependency.readPath ?? dependency.path,
      dependency.sourceFunction,
    );
    if (dependencies === undefined) return true;
    const captureAt = (offset: number) =>
      dependency.captures?.[offset] ?? capture;
    if (facts !== undefined) {
      if (facts.complete !== true) return true;
      if (
        (facts.opaqueGlobalSites ?? state.opaqueEffects.globalSites).some(
          (effect) =>
            dependencies.some(
              ({ offset }) =>
                !semanticEffectFollowsInitialCapture(
                  captureAt(offset),
                  effect,
                  state,
                ),
            ),
        )
      )
        return true;
      // Possible value identities only invalidate a read; they never establish
      // intrinsic identity. Unknown cross-function execution order stays unsafe.
      const writtenDependencies = dependencies.filter((dependency) =>
        facts.ambientWrites.covers(dependency.path),
      );
      if (
        writtenDependencies.length > 0 &&
        writtenDependencies.some(({ path, ownFrom, offset }) =>
          semanticAmbientWriteMayMatch(
            facts,
            path,
            (effect) =>
              (effect.path.length === 1 || effect.path.length > ownFrom) &&
              !semanticEffectFollowsInitialCapture(
                captureAt(offset),
                effect.node,
                state,
              ),
          ),
        )
      )
        return true;
      // An escaped owner can replace a later-selected property. A callable
      // captured before that exposure retains its own identity.
      const escapeEffects = checkEscapes
        ? (facts.ambientEscapeEffects ?? semanticAmbientEscapeEffects(state))
        : [];
      if (escapeEffects === undefined) return true;
      if (
        dependencies.some(({ path, offset }) =>
          semanticAmbientWriteMayMatch(
            { ambientWriteEffects: escapeEffects },
            path,
            (effect) =>
              !semanticEffectFollowsInitialCapture(
                captureAt(offset),
                effect.node,
                state,
              ),
          ),
        )
      )
        return true;
    }
    return retainedReadChanged(dependency);
  };

  const boundHelperReadChanged = (
    read: t.Node,
    projection: readonly string[],
    bound: NonNullable<JavaScriptIntrinsicInvocation["boundFunction"]>,
    proofFacts?: SemanticGlobalBindingFacts,
    checkEscapes = false,
  ): boolean => {
    const allocation = bound.allocations[0];
    const initial = bound.allocations.at(-1);
    const target = capturedIntrinsic(bound.prototypeTarget, proofFacts);
    if (
      allocation === undefined ||
      initial === undefined ||
      target === undefined
    )
      return true;
    const facts =
      proofFacts ??
      options?.boundFunctionWriteFacts ??
      options?.intrinsicWriteFacts;
    const changed = (dependency: IntrinsicDependency) =>
      dependencyReadChanged(dependency, facts, checkEscapes);
    // Binding copies [[Prototype]], not the target's own helper properties.
    if (
      changed({
        path: target.path,
        readPath: [
          ...(target.readPath ?? target.path),
          SEMANTIC_PHYSICAL_PROTOTYPE,
        ],
        ...(target.sourceFunction === undefined
          ? {}
          : { sourceFunction: target.sourceFunction }),
        capturedAt: initial,
        captures: [
          ...(target.captures ?? target.path.map(() => target.capturedAt)),
          initial,
        ],
      })
    )
      return true;
    for (let index = 1; index < bound.allocations.length; index += 1)
      if (
        changed({
          path: [
            ...semanticCallableValueIdentity(bound.allocations[index]!),
            "__proto__",
          ],
          capturedAt: bound.allocations[index - 1]!,
        })
      )
        return true;
    return (
      [projection[0]!, "__proto__"].some((key) =>
        changed({
          path: [...semanticCallableValueIdentity(allocation), key],
          capturedAt: read,
        }),
      ) ||
      changed({
        path: target.path,
        readPath: [
          ...(target.readPath ?? target.path),
          SEMANTIC_PHYSICAL_PROTOTYPE,
          ...projection,
        ],
        ...(target.sourceFunction === undefined
          ? {}
          : { sourceFunction: target.sourceFunction }),
        capturedAt: read,
        captures: [
          ...(target.captures ?? target.path.map(() => target.capturedAt)),
          initial,
          ...projection.map(() => read),
        ],
      })
    );
  };

  const intrinsicReadChanged = (
    node: t.Node,
    path: readonly string[],
    bound?: JavaScriptBoundHelperRead,
    proofFacts?: SemanticGlobalBindingFacts,
    checkEscapes = false,
  ): boolean => {
    const facts =
      proofFacts ??
      options?.intrinsicWriteFacts ??
      options?.intrinsicInvocationWriteFacts?.(path);
    if (bound !== undefined)
      return boundHelperReadChanged(
        node,
        bound.projection,
        bound.value,
        facts,
        checkEscapes,
      );
    const dependency = capturedIntrinsic(node, facts);
    return (
      (facts !== undefined &&
        dependency === undefined &&
        intrinsicPath(node) !== undefined) ||
      dependencyReadChanged(
        {
          ...dependency,
          path,
          capturedAt: dependency?.capturedAt ?? node,
        },
        facts,
        checkEscapes,
      )
    );
  };

  const resolveBoundIntrinsic = (
    node: t.Node,
    proofFacts?: SemanticGlobalBindingFacts,
    checkEscapes = false,
    references = false,
  ): JavaScriptIntrinsicInvocation | undefined => {
    const selectedPath = references ? referenceIntrinsicPath : intrinsicPath;
    const captured = (value: t.Node) => {
      if (!references) return capturedIntrinsic(value, proofFacts);
      const path = selectedPath(value);
      return path === undefined ? undefined : { path, capturedAt: value };
    };
    const visited = new Set<string>();
    const argumentGroups: t.CallExpression["arguments"][] = [];
    const allocations: t.CallExpression[] = [];
    const allocationTargets: t.Node[] = [];
    const bindReads: {
      readonly node: t.Node;
      readonly allocationIndex: number;
    }[] = [];
    const callableReads: t.Node[] = [];
    let opaqueArguments = false;
    let receiver: t.Node | undefined;
    let current = node;
    for (;;) {
      current = unwrapJavaScriptExpression(current).node;
      if (t.isIdentifier(current)) {
        const binding = resolveSemanticBindingState(
          state,
          current,
          current.name,
        );
        const initializer = semanticStableInitializer(binding, state);
        if (
          binding === undefined ||
          (!references &&
            intrinsicBindingReadMayHaveChanged(binding, current, proofFacts)) ||
          initializer === undefined ||
          initializer.projection.length !== 0 ||
          (initializer.node.end ?? Infinity) >= (current.start ?? -1) ||
          visited.has(binding.bindingId)
        )
          return undefined;
        visited.add(binding.bindingId);
        current = initializer.node;
        continue;
      }
      if (!t.isCallExpression(current)) return undefined;
      allocations.push(current);
      const { root, members } = electronMemberPath(current.callee);
      let bindTarget = root;
      let bindingArguments: JavaScriptIntrinsicInvocation["arguments"] =
        expandJavaScriptInvocationArguments(current.arguments, expandSpreads);
      let capturedValue = captured(current.callee);
      const calleePath = capturedValue?.path ?? selectedPath(current.callee);
      let terminal = calleePath?.at(-1) === "bind";
      let path: readonly string[] | undefined = calleePath?.slice(0, -1);
      if (members.at(-1) === "bind") {
        // A direct .bind may continue a bound callable, without discarding members.
        if (!terminal && members.length !== 1) return undefined;
        if (
          t.isMemberExpression(current.callee) ||
          t.isOptionalMemberExpression(current.callee)
        )
          bindTarget = current.callee.object;
        bindReads.push({
          node: current.callee,
          allocationIndex: allocations.length - 1,
        });
      } else {
        // Reuse the invocation owner for generic call/apply/Reflect.apply of bind.
        const invocation = resolveJavaScriptIntrinsicInvocation(
          current,
          selectedPath,
          (node) => boundIntrinsic(node, proofFacts, checkEscapes, references),
          (node, path, bound) =>
            !references &&
            intrinsicReadChanged(node, path, bound, proofFacts, checkEscapes),
          expandSpreads,
        );
        if (
          invocation?.kind !== "known" ||
          invocation.path.join(".") !== "intrinsic.Function.prototype.bind" ||
          invocation.receiver === undefined
        )
          return undefined;
        bindTarget = invocation.receiver;
        bindingArguments = invocation.arguments;
        capturedValue = captured(bindTarget);
        path = capturedValue?.path ?? selectedPath(bindTarget);
        terminal = path !== undefined;
      }
      // A possible alias can still invoke an intrinsic through bind. Keep its
      // effects when capture proof is unavailable, without proving arguments or
      // weakening the stricter capture proof used for namespace helpers.
      allocationTargets.push(bindTarget);
      callableReads.push(current.callee, bindTarget);
      opaqueArguments ||= terminal && capturedValue === undefined;
      receiver = bindingArguments?.[0];
      const ownArguments = bindingArguments?.slice(1) ?? [];
      opaqueArguments ||=
        bindingArguments === undefined || t.isSpreadElement(receiver);
      opaqueArguments ||= ownArguments.some((argument) =>
        t.isSpreadElement(argument),
      );
      argumentGroups.push(ownArguments);
      if (!terminal || path === undefined) {
        current = bindTarget;
        continue;
      }
      const boundPath = [...path, "bind"];
      const boundFunction = {
        allocations,
        allocationTargets,
        prototypeTarget: bindTarget,
      };
      const helperChanged =
        !references &&
        bindReads.some(({ node, allocationIndex }) => {
          const source =
            allocationIndex === allocations.length - 1
              ? capturedIntrinsic(node, proofFacts)
              : undefined;
          const sourceFacts = proofFacts ?? options?.boundFunctionWriteFacts;
          return source?.sourceFunction !== undefined &&
            sourceFacts !== undefined
            ? dependencyReadChanged(source, sourceFacts, checkEscapes)
            : intrinsicReadChanged(
                node,
                boundPath,
                allocationIndex === allocations.length - 1
                  ? undefined
                  : {
                      value: {
                        ...boundFunction,
                        allocations: allocations.slice(allocationIndex + 1),
                        allocationTargets: allocationTargets.slice(
                          allocationIndex + 1,
                        ),
                      },
                      projection: ["bind"],
                    },
                proofFacts,
                checkEscapes,
              );
        });
      opaqueArguments ||= helperChanged;
      return {
        kind: opaqueArguments ? "opaque" : "known",
        path,
        callableReads,
        boundFunction,
        ...(receiver === undefined ? {} : { receiver }),
        ...(helperChanged ? { receiverUncertain: true } : {}),
        // Rebinding appends arguments to the earlier bound argument list.
        arguments: opaqueArguments
          ? undefined
          : argumentGroups.toReversed().flat(),
      };
    }
  };

  const activeBoundValues = new WeakSet<t.Node>();
  const boundIntrinsic = (
    node: t.Node,
    proofFacts?: SemanticGlobalBindingFacts,
    checkEscapes = false,
    references = false,
  ): JavaScriptIntrinsicInvocation | undefined => {
    if (activeBoundValues.has(node)) return undefined;
    activeBoundValues.add(node);
    try {
      return resolveBoundIntrinsic(node, proofFacts, checkEscapes, references);
    } finally {
      activeBoundValues.delete(node);
    }
  };

  /** Native bind retains its receiver only when its metadata reads cannot
   * invoke a custom accessor. Each rebinding reads its immediate input value. */
  const nonEscapingBoundTarget = (
    node: t.CallExpression | t.OptionalCallExpression,
    proofFacts = options?.boundFunctionWriteFacts ??
      options?.intrinsicWriteFacts,
  ): t.Node | undefined => {
    if (proofFacts?.complete !== true) return undefined;
    const bound = boundIntrinsic(node, proofFacts, true);
    if (bound?.kind !== "known" || bound.boundFunction?.allocations[0] !== node)
      return undefined;
    const target = bound.boundFunction.allocationTargets[0];
    if (target === undefined) return undefined;
    const inputAllocation = bound.boundFunction.allocations[1];
    const source: IntrinsicDependency | undefined =
      inputAllocation === undefined
        ? capturedIntrinsic(target, proofFacts)
        : {
            path: semanticCallableValueIdentity(inputAllocation),
            readPath: semanticCallableValueIdentity(inputAllocation),
            capturedAt: node,
          };
    if (
      source?.readPath?.length !== 2 ||
      (inputAllocation === undefined && source.sourceFunction === undefined)
    )
      return undefined;
    for (const key of ["name", "length"])
      if (
        dependencyReadChanged(
          {
            ...source,
            readPath: [...source.readPath, key],
            capturedAt: node,
            captures: [
              ...(source.captures ?? [source.capturedAt, source.capturedAt]),
              node,
            ],
          },
          proofFacts,
          true,
        )
      )
        return undefined;
    return target;
  };

  const isObjectValue = (node: t.Node, mode: "fresh" | "definite"): boolean => {
    const visited = new Set<string>();
    let current = node;
    for (;;) {
      current = unwrapJavaScriptExpression(current).node;
      if (
        t.isObjectExpression(current) ||
        t.isArrayExpression(current) ||
        t.isFunction(current) ||
        (t.isClass(current) &&
          (mode === "definite" || !current.decorators?.length)) ||
        t.isRegExpLiteral(current) ||
        // Successful construction always supplies an object, but a constructor
        // can return an existing object instead of its fresh instance.
        (mode === "definite" && t.isNewExpression(current))
      )
        return true;
      if (t.isCallExpression(current) || t.isOptionalCallExpression(current)) {
        // Allocation identity needs the complete intrinsic proof, not the
        // nominal paths retained while indexing possible mutator effects.
        const facts = options?.intrinsicWriteFacts ?? globalBindingFacts;
        if (facts.complete !== true) return false;
        const invocation = resolveJavaScriptIntrinsicInvocation(
          current,
          intrinsicPath,
          (node) => boundIntrinsic(node, facts, true),
          (node, path, bound) =>
            intrinsicReadChanged(node, path, bound, facts, true),
          expandSpreads,
        );
        const path = invocation?.path.join(".");
        return (
          invocation?.kind === "known" &&
          (path === "intrinsic.Object.create" ||
            path === "intrinsic.Object.getOwnPropertyDescriptors" ||
            (mode === "fresh" &&
              (path === "intrinsic.Object.getOwnPropertyDescriptor" ||
                path === "intrinsic.Reflect.getOwnPropertyDescriptor")))
        );
      }
      if (!t.isIdentifier(current)) return false;
      const binding = resolveSemanticBindingState(state, current, current.name);
      if (binding !== undefined && bindingReadMayHaveChanged(binding, current))
        return false;
      const selected =
        binding === undefined
          ? undefined
          : semanticBindingAtRead(binding, current, state.parentsByNode);
      const [initial] = selected?.binding.initializers ?? [];
      const initializer =
        unprojectedInitializer(binding, state) ??
        (selected?.hasDefiniteInitializer &&
        selected.binding.initializers.length === 1 &&
        selected.binding.referenceInitializers.length === 0 &&
        initial?.projection.length === 0
          ? initial.node
          : undefined);
      if (
        binding === undefined ||
        initializer === undefined ||
        (!t.isFunctionDeclaration(initializer) &&
          (initializer.end ?? Infinity) >= (current.start ?? -1)) ||
        visited.has(binding.bindingId)
      )
        return false;
      visited.add(binding.bindingId);
      current = initializer;
    }
  };

  const helperProof = (
    binding: JavaScriptSemanticBindingState,
  ): InteropHelper | undefined => {
    const cached = helpers.get(binding.bindingId);
    if (cached !== undefined) return cached ?? undefined;
    helpers.set(binding.bindingId, null);
    if (state.scopesById.get(binding.scopeId)?.kind !== "program")
      return undefined;
    const wrapper = unprojectedInitializer(binding, state);
    if (wrapper === undefined) return undefined;
    if (identityFunction(wrapper, state)) {
      const proof = {
        dependencies: [],
        bindings: [],
        readyAfter: t.isFunctionDeclaration(wrapper)
          ? -1
          : (wrapper.end ?? Infinity),
        identity: true,
      };
      helpers.set(binding.bindingId, proof);
      return proof;
    }
    const wrapperRoles = canonicalRoles(wrapper, TO_ESM, state);
    const copyBinding = wrapperRoles?.get("__copyProps");
    const copy = unprojectedInitializer(copyBinding, state);
    const copyRoles =
      copy === undefined ? undefined : canonicalRoles(copy, COPY_PROPS, state);
    if (
      wrapperRoles === undefined ||
      copyRoles === undefined ||
      copyBinding === undefined ||
      copy === undefined
    )
      return undefined;
    const dependencies: IntrinsicDependency[] = [];
    const bindings = new Set([copyBinding]);
    let readyAfter = Math.max(wrapper.end ?? Infinity, copy.end ?? Infinity);
    for (const roles of [wrapperRoles, copyRoles])
      for (const [role, dependency] of roles) {
        const expected = INTRINSICS[role];
        if (expected === undefined) continue;
        bindings.add(dependency);
        const initializer = unprojectedInitializer(dependency, state);
        const captured =
          initializer === undefined
            ? undefined
            : capturedIntrinsic(initializer);
        if (
          initializer === undefined ||
          captured === undefined ||
          JSON.stringify(captured.path) !==
            JSON.stringify(["intrinsic", ...expected])
        )
          return undefined;
        readyAfter = Math.max(readyAfter, initializer.end ?? Infinity);
        dependencies.push(captured);
        if (role === "__hasOwnProp")
          dependencies.push({
            path: [...captured.path, "call"],
            ...(captured.captures === undefined
              ? {}
              : { captures: captured.captures }),
          });
      }
    dependencies.push(
      { path: ["intrinsic", "Function", "prototype", "bind"] },
      { path: ["intrinsic", "Function", "prototype", "call"] },
    );
    const proof = {
      dependencies,
      bindings: [...bindings],
      identity: false,
      readyAfter,
    };
    helpers.set(binding.bindingId, proof);
    return proof;
  };

  const conversionCall = (
    node: t.Node,
    purpose: "origin" | "reference" = "origin",
  ) => {
    if (!t.isCallExpression(node) || !t.isIdentifier(node.callee))
      return undefined;
    const helper = resolveSemanticBindingState(
      state,
      node.callee,
      node.callee.name,
    );
    const proof = helper === undefined ? undefined : helperProof(helper);
    const input = node.arguments[0];
    const mode = node.arguments[1];
    const literalMode =
      mode === undefined
        ? { found: true, value: false }
        : t.isExpression(mode)
          ? readExactJavaScriptLiteral(mode)
          : { found: false };
    if (
      helper === undefined ||
      proof === undefined ||
      proof.readyAfter >= (node.start ?? -1) ||
      !t.isExpression(input) ||
      node.arguments.length > 2 ||
      (purpose === "origin" &&
        (!literalMode.found ||
          // The callee is captured before arguments; its supporting slots are
          // read when the body runs. Supplier aliases retain their own reads.
          bindingReadMayHaveChanged(helper, node.callee) ||
          proof.bindings.some((binding) =>
            bindingReadMayHaveChanged(binding, node),
          ) ||
          proof.dependencies.some((dependency) =>
            dependency.bindingReads?.some(({ binding, read }) =>
              bindingReadMayHaveChanged(binding, read),
            ),
          )))
    )
      return undefined;
    return {
      input,
      bindings: proof.bindings,
      identity: proof.identity,
      // A truthy node mode forces the module-valued default. Other modes
      // preserve named exports without proving the source's default property.
      defaultIsModule:
        !proof.identity && literalMode.found && Boolean(literalMode.value),
      dependencies: proof.dependencies.map((dependency) => ({
        ...dependency,
        capturedAt: dependency.capturedAt ?? node,
      })),
    };
  };

  const referenceInvocations = new WeakMap<
    t.Node,
    JavaScriptIntrinsicInvocation | null
  >();
  const possibleReferenceInvocation = (
    node: t.CallExpression | t.OptionalCallExpression,
  ) => {
    let selected = referenceInvocations.get(node);
    if (selected === undefined) {
      selected =
        resolveJavaScriptIntrinsicInvocation(
          node,
          referenceIntrinsicPath,
          (value) => boundIntrinsic(value, undefined, false, true),
          () => false,
          expandSpreads,
        ) ?? null;
      referenceInvocations.set(node, selected);
    }
    return selected?.path[1] === "Array" &&
      options?.sourceCallResultComplete?.(node) === true
      ? undefined
      : (selected ?? undefined);
  };

  /** Parsed conversion sources are possible references, never loader proof.
   * The caller owns source captures and mutations; no provisional loader or
   * intrinsic-integrity result is retained in this selection. */
  const callReferenceSources = (
    node: t.Node,
    projection: SemanticFunctionValueProjection | undefined,
    escapedContents = false,
  ): readonly InteropReferenceSource[] => {
    if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
      const invocation = resolveJavaScriptIntrinsicInvocation(
        node,
        intrinsicPath,
        boundIntrinsic,
        intrinsicReadChanged,
        expandSpreads,
      );
      const resultInvocation = possibleReferenceInvocation(node);
      const resultShape =
        resultInvocation?.path.length === 4 &&
        resultInvocation.path.slice(0, 3).join(".") ===
          "intrinsic.Array.prototype"
          ? semanticArrayReferenceResult(resultInvocation.path[3]!)
          : undefined;
      const receiver =
        resultInvocation?.receiver ?? resultInvocation?.memberReceiver;
      if (
        resultInvocation?.kind === "known" &&
        resultShape !== undefined &&
        t.isExpression(receiver)
      ) {
        if (resultShape.kind === "element")
          return [
            {
              node: receiver,
              projection: [null, ...(projection ?? [])],
              projectionOffset: 0,
              capturePrefix: [node],
            },
          ];
        const sources: InteropReferenceSource[] =
          resultShape.kind === "receiver"
            ? [
                {
                  identity: true,
                  node: receiver,
                  projection,
                  projectionOffset: 0,
                },
              ]
            : [];
        const key = projection?.[0];
        if (
          key === null ||
          (typeof key === "string" && semanticArrayIndex(key) !== null) ||
          (escapedContents &&
            (projection === undefined || projection.length === 0))
        ) {
          const suffix = projection?.slice(1) ?? [];
          // Reordering methods retain any input element; the result array's
          // own properties remain distinct for allocating methods.
          sources.push({
            node: receiver,
            projection: [null, ...suffix],
            projectionOffset: 1,
            capturePrefix: [node],
          });
          const inputs = resultShape.arguments;
          if (inputs !== undefined)
            for (const input of resultInvocation.arguments?.slice(
              inputs.start,
              inputs.count === undefined
                ? undefined
                : inputs.start + inputs.count,
            ) ?? [])
              if (t.isExpression(input)) {
                sources.push({
                  node: input,
                  projection: suffix,
                  projectionOffset: 1,
                });
                if (inputs.spreads)
                  sources.push({
                    node: input,
                    projection: [null, ...suffix],
                    projectionOffset: 1,
                    capturePrefix: [node],
                  });
              }
        }
        return sources;
      }
      const prototype = invocation?.arguments?.[0];
      const intrinsic = invocation?.path.join(".");
      if (
        invocation?.kind === "known" &&
        intrinsic === "intrinsic.Object.assign" &&
        t.isExpression(prototype)
      )
        // Object targets retain the identity selected before later arguments.
        // This possible alias is not a primitive-boxing or freshness proof;
        // copied slots remain owned by the shared reference-store graph.
        return [
          {
            identity: true,
            node: prototype,
            projection,
            projectionOffset: 0,
          },
        ];
      if (invocation?.kind === "known" && t.isExpression(prototype)) {
        if (intrinsic === "intrinsic.Object")
          return [
            {
              identity: true,
              node: prototype,
              projection,
              projectionOffset: 0,
            },
          ];
        if (intrinsic === "intrinsic.Reflect.get")
          return [
            {
              node: prototype,
              projection: [
                staticString(invocation.arguments?.[1]) ?? null,
                ...(projection ?? []),
              ],
              projectionOffset: 0,
              capturePrefix: [node],
            },
          ];
        if (
          intrinsic === "intrinsic.Object.values" ||
          intrinsic === "intrinsic.Object.entries"
        ) {
          const entries = intrinsic === "intrinsic.Object.entries";
          const element = projection?.[0];
          const selected =
            element === null ||
            (typeof element === "string" &&
              semanticArrayIndex(element) !== null);
          const contents =
            escapedContents &&
            (projection === undefined || projection.length === 0);
          if (
            contents ||
            (selected &&
              (!entries || projection?.[1] === "1" || projection?.[1] === null))
          ) {
            const offset = entries ? 2 : 1;
            return [
              {
                node: prototype,
                projection: [null, ...(projection?.slice(offset) ?? [])],
                projectionOffset: offset,
                capturePrefix: [node],
              },
            ];
          }
          return [];
        }
      }
      const descriptors =
        intrinsic === "intrinsic.Object.getOwnPropertyDescriptors";
      if (
        invocation?.kind === "known" &&
        t.isExpression(prototype) &&
        (descriptors ||
          intrinsic === "intrinsic.Object.getOwnPropertyDescriptor" ||
          intrinsic === "intrinsic.Reflect.getOwnPropertyDescriptor")
      ) {
        const offset = descriptors ? 2 : 1;
        const key = descriptors
          ? projection !== undefined && projection.length > 0
            ? projection[0]
            : escapedContents
              ? null
              : undefined
          : (staticString(invocation.arguments?.[1]) ?? null);
        const field =
          projection === undefined || projection.length < offset
            ? escapedContents
              ? null
              : undefined
            : projection[offset - 1];
        // A descriptor owns its fields; replacing .value does not mutate the
        // captured property. Only selections through a field expose contents.
        if (
          (typeof key === "string" || key === null) &&
          (field === "value" ||
            field === "get" ||
            field === "set" ||
            field === null)
        )
          return [
            {
              node: prototype,
              projection: [
                SEMANTIC_OWN_PROPERTY_DESCRIPTOR,
                key,
                field,
                ...(projection?.slice(offset) ?? [null]),
              ],
              projectionOffset: offset,
              capturePrefix: [node, node, node],
            },
          ];
        return [];
      }
      if (
        invocation?.kind === "known" &&
        invocation.path.join(".") === "intrinsic.Object.create" &&
        invocation.arguments?.length === 1 &&
        t.isExpression(prototype)
      ) {
        if (projection?.[0] === SEMANTIC_OWN_PROPERTY_DESCRIPTOR) return [];
        if (projection?.length === 0 && !escapedContents) return [];
        const selected = (offset: number): InteropReferenceSource => ({
          node: prototype,
          projection: projection?.slice(offset),
          projectionOffset: offset,
        });
        // An unknown key can select an inherited value or expose the prototype
        // itself through __proto__. Preserve both capture offsets.
        if (projection?.[0] === SEMANTIC_PHYSICAL_PROTOTYPE)
          return [selected(1)];
        if (projection?.[0] === "__proto__")
          return [
            selected(1),
            {
              node: prototype,
              projection: [
                SEMANTIC_SOURCE_PROTO_DESCRIPTOR,
                ...projection.slice(1),
              ],
              projectionOffset: 0,
            },
          ];
        return projection?.[0] === null
          ? [selected(0), selected(1)]
          : [selected(0)];
      }
      if (
        escapedContents &&
        (projection === undefined || projection.length === 0)
      ) {
        const bound = boundIntrinsic(node);
        if (bound?.kind === "known")
          return [bound.receiver, ...(bound.arguments ?? [])]
            .filter((value): value is t.Expression => t.isExpression(value))
            .map((value) => ({
              node: value,
              projection: [],
              projectionOffset: 0,
            }));
      }
    }
    // A changed helper can still return the original input. Only strict loader
    // origin proof requires intact bindings; possible mutation aliases retain
    // the immutable helper-source inventory.
    const converted = conversionCall(node, "reference");
    if (converted === undefined) return [];
    const selected = (offset: number): InteropReferenceSource => ({
      node: converted.input,
      projection: projection?.slice(offset),
      projectionOffset: offset,
    });
    if (converted.identity || projection === undefined) return [selected(0)];
    const key = projection[0];
    // Own namespace writes do not mutate source slots. Escaping the namespace
    // can still expose the source through its default or live named values.
    if (key === undefined) return escapedContents ? [selected(0)] : [];
    if (key !== "default" && key !== null) return [selected(0)];
    if (key === "default" && converted.defaultIsModule) return [selected(1)];
    // Falsy or unknown mode can preserve a source default or install the input
    // as default. Unknown selectors also retain the live named alternative.
    return [selected(0), selected(1)];
  };

  /** A checked conversion does not expose a fresh input to arbitrary code.
   * Forced default mode avoids input property reads; reflection on a fresh
   * ordinary value cannot run Proxy traps. Its emitted descriptors must also
   * be free of inherited callbacks before the input's escape can be excluded. */
  const nonEscapingConversionInput = (
    node: t.Node,
  ): t.Expression | undefined => {
    const facts = options?.intrinsicWriteFacts;
    if (facts?.complete !== true) return undefined;
    const converted = conversionCall(node);
    if (
      converted === undefined ||
      converted.dependencies.some((dependency) =>
        dependencyReadChanged(dependency),
      )
    )
      return undefined;
    if (converted.identity) return converted.input;
    if (
      !converted.defaultIsModule ||
      !isObjectValue(converted.input, "fresh") ||
      [
        "configurable",
        "enumerable",
        "value",
        "writable",
        "get",
        "set",
        "__proto__",
      ].some((key) =>
        semanticAmbientWriteMayMatch(
          facts,
          ["global", "Object", "prototype", key],
          (effect) =>
            !(
              effect.path.length === 2 &&
              effect.path[0] === "global" &&
              effect.path[1] === "Object"
            ) && !semanticEffectFollowsInitialCapture(node, effect.node, state),
        ),
      )
    )
      return undefined;
    return converted.input;
  };

  /** Proven intrinsic arguments can be retained without reaching user code.
   * Unknown descriptor/receiver behavior keeps the caller's raw escape facts. */
  const callArgumentEscapes = (
    node: t.CallExpression | t.OptionalCallExpression,
    dataPropertyIntact?: (target: t.Node, key: string) => boolean,
  ): readonly t.Node[] | undefined => {
    if (options?.intrinsicWriteFacts?.complete !== true) return undefined;
    if (boundIntrinsic(node)?.kind === "known") return [];
    const invocation = resolveJavaScriptIntrinsicInvocation(
      node,
      intrinsicPath,
      boundIntrinsic,
      intrinsicReadChanged,
      expandSpreads,
    );
    if (invocation?.kind !== "known" || invocation.arguments === undefined)
      return undefined;
    const args = invocation.arguments;
    if (args.some((argument) => !t.isExpression(argument))) return undefined;
    const path = invocation.path.join(".");
    if (
      [
        "intrinsic.Object.getOwnPropertyDescriptor",
        "intrinsic.Reflect.getOwnPropertyDescriptor",
        "intrinsic.Object.getOwnPropertyDescriptors",
      ].includes(path) &&
      args[0] !== undefined &&
      isObjectValue(args[0], "fresh")
    )
      // Own reflection on a source allocation neither invokes its property
      // getters nor exposes it to user code. A Proxy remains unresolved.
      return args.slice(1);
    if (path === "intrinsic.Object.create" && args.length === 1) return [];
    if (path === "intrinsic.Reflect.deleteProperty") return args.slice(1, 2);
    if (path === "intrinsic.Reflect.set") {
      const target = args[0];
      const key =
        args[1] === undefined ? undefined : readExactJavaScriptLiteral(args[1]);
      if (
        target !== undefined &&
        key?.found &&
        typeof key.value === "string" &&
        dataPropertyIntact?.(target, key.value)
      )
        // A data store does not invoke an unknown setter with its receiver.
        // The value can still be retained in an externally reachable slot.
        return args.slice(1, 3);
    }
    // Calls can invoke a previously bound intrinsic with no written arguments.
    // Keep raw argument evaluation and the canonical captured arguments unless
    // the intrinsic-specific cases above proved their ownership.
    return [
      ...new Set([
        ...node.arguments.map((argument) =>
          t.isSpreadElement(argument) ? argument.argument : argument,
        ),
        ...(invocation.receiver === undefined ? [] : [invocation.receiver]),
        ...args,
      ]),
    ];
  };

  const callOrigin = (node: t.Node): InteropOrigin | undefined => {
    const cached = calls.get(node);
    if (cached !== undefined) return cached;
    const { root, members } = electronMemberPath(node);
    if (!members.every((member): member is string => member !== null))
      return undefined;
    const converted = conversionCall(root);
    const required =
      converted === undefined ? undefined : loaderOrigin(converted.input);
    if (
      converted === undefined ||
      required === undefined ||
      required.importedPath.length !== 0 ||
      (members[0] === "default" && !converted.defaultIsModule)
    )
      return undefined;
    const result = {
      origin: { ...required, importedPath: members },
      dependencies: converted.dependencies,
      defaultIsModule: converted.defaultIsModule,
    };
    calls.set(node, result);
    return result;
  };

  const origin = (
    binding: JavaScriptSemanticBindingState,
  ): InteropOrigin | undefined => {
    const single = semanticStableInitializer(binding, state);
    if (single !== undefined) {
      if (
        !single.projection.every(
          (key): key is string => typeof key === "string",
        )
      )
        return undefined;
      const converted = callOrigin(single.node);
      if (
        converted?.origin.importedPath.length === 0 &&
        single.projection[0] === "default" &&
        !converted.defaultIsModule
      )
        return undefined;
      const result =
        converted === undefined
          ? undefined
          : {
              ...converted,
              origin: {
                ...converted.origin,
                importedPath: [
                  ...converted.origin.importedPath,
                  ...single.projection,
                ],
              },
            };
      if (result !== undefined) origins.set(binding.bindingId, result);
      return result;
    }
    const [initial, converted] = binding.initializers;
    if (
      binding.definitions.length !== 2 ||
      binding.definitions[0]?.kind !== "variable" ||
      binding.definitions[1]?.kind !== "assignment" ||
      binding.initializers.length !== 2 ||
      initial === undefined ||
      converted === undefined ||
      initial.projection.length !== 0 ||
      converted.projection.length !== 0 ||
      state.conditionallySkippedExpressions.has(initial.node)
    )
      return undefined;
    const call = converted.node;
    const assignment = state.parentsByNode.get(call);
    const statement =
      assignment === undefined
        ? undefined
        : state.parentsByNode.get(assignment);
    const declaration = state.parentsByNode.get(initial.node);
    const declarationStatement =
      declaration === undefined
        ? undefined
        : state.parentsByNode.get(declaration);
    if (
      !t.isCallExpression(call) ||
      !t.isIdentifier(call.callee) ||
      !t.isAssignmentExpression(assignment, { operator: "=" }) ||
      assignment.right !== call ||
      !t.isIdentifier(assignment.left, { name: binding.name }) ||
      !t.isExpressionStatement(statement) ||
      !t.isVariableDeclarator(declaration) ||
      !t.isVariableDeclaration(declarationStatement) ||
      state.parentsByNode.get(statement) !==
        state.parentsByNode.get(declarationStatement) ||
      (initial.node.start ?? Infinity) >= (call.start ?? -1)
    )
      return undefined;
    const convertedCall = conversionCall(call);
    const input = convertedCall?.input;
    if (
      !t.isIdentifier(input) ||
      resolveSemanticBindingState(state, input, input.name) !== binding
    )
      return undefined;
    const required = loaderOrigin(initial.node);
    if (required === undefined || required.importedPath.length !== 0)
      return undefined;
    if (convertedCall === undefined) return undefined;
    const result = {
      origin: required,
      dependencies: convertedCall.dependencies,
      defaultIsModule: convertedCall.defaultIsModule,
    };
    origins.set(binding.bindingId, result);
    return result;
  };
  const invalidatedOrigin = (record: InteropOrigin | undefined): boolean =>
    record?.dependencies.some(retainedReadChanged) ?? false;
  return {
    origin,
    callOrigin,
    callReferenceSources,
    /** Possible allocation ownership does not grant a fresh-object proof. */
    descriptorAllocation: (node: t.Node) => {
      if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))
        return false;
      const invocation = resolveJavaScriptIntrinsicInvocation(
        node,
        intrinsicPath,
        boundIntrinsic,
        intrinsicReadChanged,
        expandSpreads,
      );
      return (
        invocation?.kind === "known" &&
        OWN_DESCRIPTOR_INTRINSICS.has(invocation.path.join("."))
      );
    },
    nonEscapingConversionInput,
    callArgumentEscapes,
    intrinsicPath,
    /** A captured intrinsic object path with complete binding/member proofs. */
    capturedIntrinsicPath: (node: t.Node) => {
      const dependency = capturedIntrinsic(node);
      return dependency !== undefined && !dependencyReadChanged(dependency)
        ? dependency.path
        : undefined;
    },
    /** Native exclusions can opt into owner-escape proof from a frozen snapshot. */
    intrinsicInvocation: (
      node:
        | t.CallExpression
        | t.OptionalCallExpression
        | t.TaggedTemplateExpression,
      proofFacts?: SemanticGlobalBindingFacts,
      checkEscapes = false,
    ) =>
      resolveJavaScriptIntrinsicInvocation(
        node,
        intrinsicPath,
        (node) => boundIntrinsic(node, proofFacts, checkEscapes),
        (node, path, bound) =>
          (checkEscapes && proofFacts?.complete !== true) ||
          intrinsicReadChanged(node, path, bound, proofFacts, checkEscapes),
        expandSpreads,
      ),
    boundIntrinsic,
    nonEscapingBoundTarget,
    boundValuePath: (node: t.Node) => {
      const allocation = boundIntrinsic(node)?.boundFunction?.allocations[0];
      return allocation === undefined
        ? undefined
        : semanticCallableValueIdentity(allocation);
    },
    staticString,
    isFreshObject: (node: t.Node) => isObjectValue(node, "fresh"),
    isDefinitelyObject: (node: t.Node) => isObjectValue(node, "definite"),
    opaqueMutationPath,
    retainWrite: (node: t.Node, path: readonly (string | null)[]) => {
      const coverage = new SemanticPropertyPathCoverage();
      const retained = path[0] === "opaque-intrinsic" ? ["intrinsic"] : path;
      coverage.retain(retained);
      writes.push({
        scope: opaqueMutationPath(node).join("."),
        offset: node.start ?? Infinity,
        path: retained,
        coverage,
      });
    },
    invalidated: (binding: JavaScriptSemanticBindingState): boolean => {
      const cached = invalidatedBindings.get(binding.bindingId);
      if (cached !== undefined) return cached;
      const result = invalidatedOrigin(origins.get(binding.bindingId));
      invalidatedBindings.set(binding.bindingId, result);
      return result;
    },
    invalidatedCall: (node: t.Node): boolean => {
      const cached = invalidatedCalls.get(node);
      if (cached !== undefined) return cached;
      const result = invalidatedOrigin(calls.get(node));
      invalidatedCalls.set(node, result);
      return result;
    },
  };
};

const identityFunction = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (
    !t.isFunction(node) ||
    node.async ||
    node.generator ||
    runtimeFunctionParameters(node).length !== 1
  )
    return false;
  const parameter = runtimeFunctionParameters(node)[0];
  const result = t.isBlockStatement(node.body)
    ? node.body.body.length === 1 && t.isReturnStatement(node.body.body[0])
      ? node.body.body[0].argument
      : undefined
    : node.body;
  return (
    t.isIdentifier(parameter) &&
    t.isIdentifier(result) &&
    resolveSemanticBindingState(state, parameter, parameter.name) !==
      undefined &&
    resolveSemanticBindingState(state, parameter, parameter.name) ===
      resolveSemanticBindingState(state, result, result.name)
  );
};

const unprojectedInitializer = (
  binding: JavaScriptSemanticBindingState | undefined,
  state: JavaScriptSemanticAnalysisState,
): t.Node | undefined => {
  const initializer = semanticStableInitializer(binding, state);
  return initializer?.projection.length === 0 ? initializer.node : undefined;
};

/** Match operations and lexical roles, allowing single-statement control blocks. */
const canonicalRoles = (
  actual: t.Node,
  pattern: t.Node,
  state: JavaScriptSemanticAnalysisState,
): ReadonlyMap<string, JavaScriptSemanticBindingState> | undefined => {
  const roles = new Map<string, JavaScriptSemanticBindingState>();
  const used = new Map<string, string>();
  const pending: { actual: t.Node; pattern: t.Node; parent: t.Node | null }[] =
    [{ actual, pattern, parent: null }];
  while (pending.length !== 0) {
    const pair = pending.pop();
    if (pair === undefined) return undefined;
    const { parent } = pair;
    const controlBody =
      (t.isIfStatement(parent) &&
        (parent.consequent === pair.pattern ||
          parent.alternate === pair.pattern)) ||
      (t.isForStatement(parent) && parent.body === pair.pattern);
    const node = controlBody ? controlBodyOperation(pair.actual) : pair.actual;
    const expected = controlBody
      ? controlBodyOperation(pair.pattern)
      : pair.pattern;
    if (node.type !== expected.type) return undefined;
    const literalKey =
      parent !== null &&
      ((t.isMemberExpression(parent) &&
        !parent.computed &&
        parent.property === expected) ||
        (t.isObjectProperty(parent) &&
          !parent.computed &&
          parent.key === expected));
    if (t.isIdentifier(expected) && t.isIdentifier(node) && !literalKey) {
      const binding = resolveSemanticBindingState(state, node, node.name);
      if (
        binding === undefined ||
        (roles.has(expected.name) && roles.get(expected.name) !== binding) ||
        (used.has(binding.bindingId) &&
          used.get(binding.bindingId) !== expected.name)
      )
        return undefined;
      roles.set(expected.name, binding);
      used.set(binding.bindingId, expected.name);
    }
    const visitorKeys = javaScriptAstChildKeys(expected);
    for (const [key, field] of Object.entries(
      t.NODE_FIELDS[expected.type] ?? {},
    )) {
      if (
        visitorKeys.includes(key) ||
        (t.isIdentifier(expected) && key === "name" && !literalKey)
      )
        continue;
      const fallback: unknown = Reflect.get(field, "default");
      if (
        JSON.stringify(Reflect.get(node, key) ?? fallback) !==
        JSON.stringify(Reflect.get(expected, key) ?? fallback)
      )
        return undefined;
    }
    const children = childNodes(node),
      expectedChildren = childNodes(expected);
    if (children.length !== expectedChildren.length) return undefined;
    for (const [index, child] of children.entries()) {
      const expectedChild = expectedChildren[index];
      if (expectedChild !== undefined)
        pending.push({
          actual: child,
          pattern: expectedChild,
          parent: expected,
        });
    }
  }
  return roles;
};

// Braces around one control-body statement do not add operations. Keep other
// blocks, directives and extra statements intact; their semantics need proof.
// Lexical declarations/references still pass through canonicalRoles' bijection.
const controlBodyOperation = (node: t.Node): t.Node => {
  while (
    t.isBlockStatement(node) &&
    node.directives.length === 0 &&
    node.body.length === 1
  ) {
    const statement = node.body[0];
    if (statement === undefined) break;
    node = statement;
  }
  return node;
};
