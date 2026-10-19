import * as t from "@babel/types";
import { javaScriptRuntimeContext } from "./javascriptSourceParser.js";
import { unwrapJavaScriptExpression } from "./javascriptAstValues.js";
import { range } from "./javascriptStaticAnalysisHelpers.js";

import {
  resolveSemanticBindingState,
  semanticResolutionBlocked,
  semanticStableInitializer,
  isUnshadowedGlobal,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
  type JavaScriptSemanticInitializer,
} from "./javascriptSemanticState.js";
import {
  semanticHostRequireIntact,
  semanticHostRequireBindingWritesIntact,
  semanticRequireOrigin,
  type JavaScriptRequireOrigin,
} from "./javascriptSemanticRequireOrigin.js";
import {
  semanticBindingAtRead,
  semanticEffectFollowsInitialCapture,
} from "./javascriptSemanticMutationInitializers.js";
import {
  semanticBindingMayHaveBlockFunctionWrite,
  semanticAmbientWriteMayMatch,
  type SemanticGlobalBindingFacts,
  semanticGlobalBindingReadMayHaveChanged,
  semanticOpaqueBindingReadMayHaveChanged,
} from "./javascriptSemanticOpaqueEffects.js";

/**
 * Recover a literal require reached through esbuild's CommonJS `__require` shim.
 *
 * esbuild replaces `require` with an IIFE that selects the host `require` at
 * runtime and otherwise falls back to the passed function:
 *
 *   var Q = (e => typeof require < "u" ? require : typeof Proxy < "u"
 *     ? new Proxy(e, { get: (t, n) => (typeof require < "u" ? require : t)[n] })
 *     : e)(function (e) { ... });
 *
 * Minification then turns `require("electron")` into `Q("electron")`, which the
 * direct-require resolver cannot follow. The shim is accepted only when the
 * captured binding value is a flat IIFE whose arrow callee guards the
 * unshadowed global `require` behind its availability test, and is applied to a
 * fallback function. `Q("electron")` inside that scope is then the same literal
 * require. Syntax is proven, never inferred from the binding name, and a shim
 * that would always return its fallback is refused.
 */
export const semanticRequireShimOrigin = (
  node: t.Node | null | undefined,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptRequireOrigin | undefined =>
  semanticRequireOrigin(node, state, "shim");

/** The captured callable value is shared by direct and normalized helper calls. */
export const semanticRequireShimBinding = (
  reference: t.Identifier,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const binding = resolveSemanticBindingState(state, reference, reference.name);
  if (
    binding === undefined ||
    semanticResolutionBlocked(state, reference, reference.name) ||
    semanticOpaqueBindingReadMayHaveChanged(binding, reference, state) ||
    semanticBindingMayHaveBlockFunctionWrite(binding, state)
  )
    return false;
  const atRead = semanticBindingAtRead(
    withoutExactSelfCopies(binding, state),
    reference,
    state.parentsByNode,
    (initializer, read) =>
      initializer.projection.length === 0 &&
      !semanticOpaqueBindingReadMayHaveChanged(binding, read, state) &&
      !semanticGlobalBindingReadMayHaveChanged(binding, read, state) &&
      semanticRequireShimValueSource(initializer.node, state) !== undefined,
  );
  if (
    // Unordered reads retain possible initializers for conservative alias
    // effects. They do not prove that the loader exists at this call site.
    !atRead.hasDefiniteInitializer ||
    semanticGlobalBindingReadMayHaveChanged(atRead.binding, reference, state) ||
    !bindsRequireShim(atRead.binding, state)
  )
    return false;
  // Delegate integrity belongs to the invocation, after any helper binding or
  // alias capture. A later bare require assignment cannot replace this value.
  return true;
};

/**
 * `Q = Q` reads and writes one binding, so it cannot introduce a value that
 * the binding does not already hold at that point; the possible values before
 * and after the assignment are the same set. Remove such writes before
 * selecting the value at a read. Any projection, destructuring copy, default
 * or a name that resolves elsewhere (another binding, `with`, direct eval) is
 * a real assignment and stays.
 */
const withoutExactSelfCopies = (
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticBindingState => {
  const isExactSelfCopy = (
    initializer: JavaScriptSemanticBindingState["referenceInitializers"][number],
  ): boolean => {
    if (
      initializer.projection.length !== 0 ||
      initializer.selection !== undefined ||
      initializer.entryBody !== undefined ||
      initializer.copyKind !== undefined ||
      initializer.copyProjectionOffset !== undefined ||
      initializer.fallbackSources !== undefined ||
      initializer.requiredSources !== undefined
    )
      return false;
    const source = unwrapJavaScriptExpression(initializer.node).node;
    return (
      t.isIdentifier(source) &&
      source.name === binding.name &&
      !semanticResolutionBlocked(state, source, source.name) &&
      resolveSemanticBindingState(state, source, source.name)?.bindingId ===
        binding.bindingId
    );
  };
  // A `var` reassignment is recorded beside the declaration's initializer and
  // as an assignment definition; other assignments are reference
  // initializers. Every list can hold copies.
  const copiedTargets = new Set<string>();
  const copies = new Set<JavaScriptSemanticInitializer>();
  for (const initializer of [
    ...binding.initializers,
    ...binding.referenceInitializers,
  ]) {
    if (!isExactSelfCopy(initializer)) continue;
    copies.add(initializer);
    const assignment = state.parentsByNode.get(initializer.node);
    if (
      t.isAssignmentExpression(assignment, { operator: "=" }) &&
      assignment.right === initializer.node &&
      t.isIdentifier(assignment.left)
    )
      copiedTargets.add(JSON.stringify(range(assignment.left)));
  }
  if (copies.size === 0) return binding;
  return {
    ...binding,
    initializers: binding.initializers.filter(
      (initializer) => !copies.has(initializer),
    ),
    referenceInitializers: binding.referenceInitializers.filter(
      (initializer) => !copies.has(initializer),
    ),
    definitions: binding.definitions.filter(
      (definition) =>
        definition.kind !== "assignment" ||
        !copiedTargets.has(JSON.stringify(definition.location)),
    ),
  };
};

/**
 * Prove that this binding is the whole shim result, never a destructured or
 * member projection of it. `semanticStableInitializer` pairs the initializer
 * with its projection, so a destructured property such as
 * `const { notTheLoader: Q } = shim(fallback)` reads the shim node with a
 * nonempty projection and must not alias the host loader. Reference and
 * default sources copy a value through destructuring the same way, so they are
 * refused too.
 */
const bindsRequireShim = (
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (binding.referenceInitializers.length !== 0) return false;
  const stable = semanticStableInitializer(binding, state);
  if (
    stable === undefined ||
    stable.projection.length !== 0 ||
    !t.isCallExpression(stable.node)
  )
    return false;
  // Provenance can be queried while effect indexing is still in progress.
  // The proof includes host-loader integrity, so do not retain it beyond the
  // shared provenance owner's dependency-aware query lifetime.
  return semanticRequireShimValueSource(stable.node, state) !== undefined;
};

/** Resolve the selected source once for consumers that need capture timing. */
export const semanticRequireShimValueSource = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.Node | undefined =>
  t.isCallExpression(node)
    ? semanticRequireShimInitializerSource(node, state)
    : undefined;

/**
 * A flat IIFE whose arrow callee guards the host `require` with its
 * availability and is applied to a fallback function. esbuild emits exactly
 * this shape, so the argument count and callee form are part of the proof.
 */
const semanticRequireShimInitializerSource = (
  call: t.CallExpression,
  state: JavaScriptSemanticAnalysisState,
  intact: (node: t.Node) => boolean = (node) =>
    isGlobalRequire(node, call, state),
): t.Node | undefined => {
  const callee = call.callee;
  if (
    (!t.isArrowFunctionExpression(callee) && !t.isFunctionExpression(callee)) ||
    callee.generator ||
    callee.async ||
    callee.params.length !== 1 ||
    !t.isIdentifier(callee.params[0]) ||
    call.arguments.length !== 1 ||
    // Arguments run before the guard reads require. Only creating a function
    // is inert here; an evaluated fallback could replace the host loader.
    (!t.isFunctionExpression(call.arguments[0]) &&
      !t.isArrowFunctionExpression(call.arguments[0]))
  )
    return undefined;
  const body = t.isBlockStatement(callee.body) ? undefined : callee.body;
  return body === undefined ? undefined : selectsGlobalRequire(body, intact);
};

/**
 * The expression yields the unshadowed global `require` on the branch its own
 * availability guard selects.
 *
 * esbuild reaches `require` only through its availability test and nests that
 * test for the Proxy fallback, so a nested conditional is followed only when
 * its own guard establishes the same availability. Any other condition, such
 * as a literal `false`, is refused: the shim would then always return the
 * fallback and never load the requested module.
 */
const selectsGlobalRequire = (
  expression: t.Expression,
  intact: (node: t.Node) => boolean,
): t.Node | undefined => {
  if (t.isConditionalExpression(expression)) {
    if (!guardsRequireAvailability(expression.test, intact)) return undefined;
    return selectsGlobalRequire(expression.consequent, intact);
  }
  return intact(expression) ? expression : undefined;
};

/**
 * The unshadowed global `require` at the point `capture` runs. This reuses the
 * direct resolver's host-loader checks so a module-level replacement, such as
 * `require = mockLoader` before the shim, is not mistaken for the host loader.
 */
const isGlobalRequire = (
  node: t.Node,
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  t.isIdentifier(node, { name: "require" }) &&
  semanticHostRequireIntact(node, capture, state);

/**
 * Whether `test` is the availability check for the host `require`. esbuild
 * emits `typeof require < "u"` after minification and `typeof require !==
 * "undefined"` before it; both are accepted, and nothing weaker, so a branch
 * reached under an unrelated condition is not treated as the host loader.
 */
const guardsRequireAvailability = (
  test: t.Expression,
  intact: (node: t.Node) => boolean,
): boolean => {
  if (!t.isBinaryExpression(test)) return false;
  const testOnLeft = isTypeofRequire(test.left, intact);
  const testOnRight = isTypeofRequire(test.right, intact);
  if (testOnLeft === testOnRight) return false;
  const literal = readLiteralText(testOnLeft ? test.right : test.left);
  if (test.operator === "<") return testOnLeft && literal === "u";
  return (
    (test.operator === "!=" || test.operator === "!==") &&
    literal === "undefined"
  );
};

/** Whether this operand is `typeof require` for the unshadowed host `require`. */
const isTypeofRequire = (
  node: t.Node,
  intact: (node: t.Node) => boolean,
): boolean =>
  t.isUnaryExpression(node, { operator: "typeof" }) && intact(node.argument);

const readLiteralText = (node: t.Node): string | undefined =>
  t.isStringLiteral(node) ? node.value : undefined;

/** A proven host-binding selection executes neither the fallback nor its body.
 * Availability is independent of module.require's delegate validity: consulting
 * that validity here would make escape exclusion depend on its own result. */
export const createSemanticRequireShimInertQuery = (
  state: JavaScriptSemanticAnalysisState,
  facts: SemanticGlobalBindingFacts,
): ((node: t.Node) => boolean) => {
  // An unshadowed name is not proof of existence. Unknown scripts and ES
  // modules can select the alternate, including all of its source effects.
  if (
    state.program.sourceType !== "script" ||
    javaScriptRuntimeContext(state.program) !== "commonjs"
  )
    return () => false;
  const cached = new WeakMap<t.Node, boolean>();
  const initializerInert = (call: t.CallExpression): boolean => {
    if (facts.complete !== true) return false;
    const prior = (effect: t.Node | undefined) =>
      !semanticEffectFollowsInitialCapture(call, effect, state);
    return (
      semanticRequireShimInitializerSource(
        call,
        state,
        (reference) =>
          isUnshadowedGlobal(reference, state, "require") &&
          semanticHostRequireBindingWritesIntact(call, state) &&
          !(facts.opaqueGlobalSites ?? state.opaqueEffects.globalSites).some(
            prior,
          ) &&
          ![...state.opaqueEffects.byScope.values()].some((sites) =>
            sites.some(prior),
          ) &&
          !semanticAmbientWriteMayMatch(
            facts,
            ["global", "require"],
            ({ node }) => prior(node),
          ),
      ) !== undefined
    );
  };
  return (node) => {
    let current: t.Node | undefined = node;
    const pending: t.Node[] = [];
    let inert = false;
    while (current !== undefined) {
      const prior = cached.get(current);
      if (prior !== undefined) {
        inert = prior;
        break;
      }
      pending.push(current);
      if (t.isCallExpression(current) && initializerInert(current)) {
        inert = true;
        break;
      }
      current = state.parentsByNode.get(current);
    }
    for (const visited of pending) cached.set(visited, inert);
    return inert;
  };
};
