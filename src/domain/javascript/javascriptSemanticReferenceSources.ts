import * as t from "@babel/types";
import {
  readExactJavaScriptLiteral,
  semanticStaticPropertyKey,
  semanticObjectPrototypeProperty,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import {
  semanticArrayIndex,
  type JavaScriptSemanticPropertyPath as PropertyPath,
} from "./javascriptSemanticPropertyPaths.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import { evaluateSemanticExpression } from "./javascriptSemanticValues.js";
import {
  semanticContainer,
  semanticSlotAtPath,
} from "./javascriptSemanticSlots.js";
import {
  semanticExpressionEvaluationOrder,
  semanticCapturePrecedesUserCode,
} from "./javascriptSemanticMutationInitializers.js";
import {
  semanticSourceFunctionOwnPropertyDefined,
  semanticInitialBuiltinPrototypeDataProperty,
} from "./javascriptSemanticFunctionValues.js";
import {
  childNodes,
  traverseJavaScriptAst,
} from "./javascriptSemanticTraversal.js";
import type {
  JavaScriptSemanticProperty,
  JavaScriptSemanticValue,
} from "./javascriptSemanticValueTypes.js";

/** A retained source and the pattern selection that guards its reference. */
export interface JavaScriptSemanticReferenceSource {
  readonly node: t.Node;
  readonly projection: PropertyPath;
  readonly selection?: t.AssignmentPattern;
}

/** Exclude references whose source slot or destructuring fallback is absent.
 * Before member effects exist, only inline syntax can prove a fallback unused;
 * named values must stay possible until their mutation facts are available. */
export const semanticReferenceSourcesInactive = (
  reference: {
    readonly requiredSources?: readonly JavaScriptSemanticReferenceSource[];
    readonly fallbackSources?: readonly JavaScriptSemanticReferenceSource[];
  },
  state: JavaScriptSemanticAnalysisState,
  mode: "effects" | "syntax-only" = "effects",
): boolean =>
  reference.fallbackSources?.some(
    (source) =>
      referenceSelectionStable(source, state) &&
      syntaxReferenceSourceDefined(source, state),
  ) === true ||
  (mode === "effects" &&
    (reference.requiredSources?.some(
      (source) => selectedDefaultInput(source, state)?.presence === "absent",
    ) === true ||
      reference.fallbackSources?.some((source) => {
        // Selection precedes effects through the chosen reference. A later escape
        // cannot make a fallback that was excluded at destructuring reachable.
        const slot = selectedDefaultInput(source, state);
        return (
          slot?.presence === "present" &&
          (slot.value.status === "literal" ||
            slot.value.status === "union" ||
            slot.value.status === "object" ||
            slot.value.status === "array")
        );
      }) === true));

interface PatternSelectionFacts {
  readonly root: t.Node;
  readonly effects: readonly t.Node[];
  readonly arrays: readonly t.ArrayPattern[];
  readonly reads: readonly {
    readonly node: t.ObjectProperty;
    readonly projection: PropertyPath;
  }[];
  readonly objectRests: readonly {
    readonly node: t.RestElement;
    readonly projection: PropertyPath;
  }[];
  readonly projections: WeakMap<t.Node, PropertyPath>;
  readonly inertPrefixes: WeakMap<t.AssignmentPattern, boolean>;
  readonly prototypeReads: WeakMap<
    t.Node,
    Map<
      string,
      readonly { readonly node: t.Node; readonly unmodeledPrototype: boolean }[]
    >
  >;
  readonly uncertainReads: WeakMap<JavaScriptSemanticValue, readonly t.Node[]>;
}

const patternSelectionFacts = new WeakMap<t.Node, PatternSelectionFacts>();

/** Pattern syntax is immutable; index it once, without traversing default bodies. */
const selectionFacts = (
  selection: t.AssignmentPattern,
  state: JavaScriptSemanticAnalysisState,
  source?: t.Node,
): PatternSelectionFacts => {
  let root: t.Node = selection;
  for (;;) {
    const parent = state.parentsByNode.get(root);
    // A fallback allocates a new source for its own left-hand pattern. Reads
    // from the enclosing input do not project through that fresh allocation.
    if (t.isAssignmentPattern(parent) && parent.right === source) break;
    if (
      !(
        t.isObjectPattern(parent) ||
        t.isArrayPattern(parent) ||
        t.isRestElement(parent) ||
        (t.isObjectProperty(parent) && parent.value === root) ||
        (t.isAssignmentPattern(parent) && parent.left === root)
      )
    )
      break;
    root = parent;
  }
  const cached = patternSelectionFacts.get(root);
  if (cached !== undefined) return cached;
  const effects: t.Node[] = [];
  const arrays: t.ArrayPattern[] = [];
  const reads: { node: t.ObjectProperty; projection: PropertyPath }[] = [];
  const objectRests: { node: t.RestElement; projection: PropertyPath }[] = [];
  const projections = new WeakMap<t.Node, PropertyPath>();
  projections.set(root, []);
  const skipped = new Set<t.Node>();
  traverseJavaScriptAst(root, {
    skip: (node) => skipped.has(node),
    enter: (node, parent) => {
      const projection =
        projections.get(node) ??
        (parent === null ? [] : projections.get(parent)) ??
        [];
      projections.set(node, projection);
      if (t.isAssignmentPattern(node)) {
        skipped.add(node.right);
        if (!syntaxDataSource(node.right)) effects.push(node.right);
      } else if (t.isObjectProperty(node)) {
        const selected = [
          ...projection,
          semanticStaticPropertyKey(node.key, node.computed),
        ];
        reads.push({ node, projection: selected });
        projections.set(node.value, selected);
        skipped.add(node.key);
        if (node.computed && !readExactJavaScriptLiteral(node.key).found)
          effects.push(node.key);
      } else if (t.isMemberExpression(node)) {
        effects.push(node);
        skipped.add(node.object);
        skipped.add(node.property);
      } else if (t.isArrayPattern(node)) {
        arrays.push(node);
        for (const [index, element] of node.elements.entries())
          if (element !== null)
            projections.set(element, [...projection, index]);
      } else if (t.isRestElement(node) && t.isObjectPattern(parent)) {
        objectRests.push({ node, projection });
      }
    },
  });
  const facts: PatternSelectionFacts = {
    root,
    effects,
    arrays,
    reads,
    objectRests,
    projections,
    inertPrefixes: new WeakMap(),
    prototypeReads: new WeakMap(),
    uncertainReads: new WeakMap(),
  };
  patternSelectionFacts.set(root, facts);
  return facts;
};

const referenceSelectionPrecedes = (
  selection: t.AssignmentPattern,
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  // The selected input is read before its default or nested pattern executes.
  // A member assignment target is different: its receiver/key is evaluated
  // before that input read, while its eventual setter runs afterward.
  let current: t.Node | undefined = node;
  while (current !== undefined && current !== selection) {
    if (current === selection.right) return true;
    if (
      current === selection.left &&
      (t.isObjectPattern(current) || t.isArrayPattern(current))
    )
      return true;
    current = state.parentsByNode.get(current);
  }
  return (
    semanticExpressionEvaluationOrder(selection, node, state.parentsByNode) ===
    "before"
  );
};

const selectionProjectsSource = (
  source: JavaScriptSemanticReferenceSource,
  selection: t.AssignmentPattern,
  facts: PatternSelectionFacts,
  prefix: PropertyPath = [],
): boolean => {
  const projection = facts.projections.get(selection);
  return (
    projection !== undefined &&
    projection.length + prefix.length === source.projection.length &&
    projection.every(
      (key, index) => key === source.projection[index + prefix.length],
    )
  );
};

/** A for-of input owns the element prefix; its binding pattern starts inside it. */
const iterationSourcePrefix = (
  source: JavaScriptSemanticReferenceSource,
  facts: PatternSelectionFacts,
  state: JavaScriptSemanticAnalysisState,
): PropertyPath | undefined => {
  let parent = state.parentsByNode.get(facts.root);
  if (t.isVariableDeclarator(parent)) parent = state.parentsByNode.get(parent);
  if (t.isVariableDeclaration(parent)) parent = state.parentsByNode.get(parent);
  if (!t.isForOfStatement(parent) || parent.right !== source.node) return [];
  // An expanded slot is a candidate, not proof of what the loop yields.
  // Custom iteration and async thenable unwrapping can supply another value.
  return !parent.await &&
    state.prototypeEnumerationMayAffect === false &&
    syntaxArrayIterationSource(source.node, [])
    ? source.projection.slice(0, 1)
    : undefined;
};

/** Earlier defaults, keys, stores and custom iteration can change a later slot. */
const referenceSelectionStable = (
  source: JavaScriptSemanticReferenceSource,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const selection = source.selection;
  if (selection === undefined) return true;
  const prefixFacts = selectionFacts(selection, state);
  const followsSelection = (node: t.Node): boolean =>
    referenceSelectionPrecedes(selection, node, state);
  let inertPrefix = prefixFacts.inertPrefixes.get(selection);
  if (inertPrefix === undefined) {
    inertPrefix = prefixFacts.effects.every(
      (effect) =>
        (effect === selection.left &&
          t.isMemberExpression(effect) &&
          t.isIdentifier(effect.object) &&
          resolveSemanticBindingState(
            state,
            effect.object,
            effect.object.name,
          ) !== undefined &&
          (!effect.computed ||
            readExactJavaScriptLiteral(effect.property).found)) ||
        followsSelection(effect),
    );
    prefixFacts.inertPrefixes.set(selection, inertPrefix);
  }
  if (
    !inertPrefix ||
    (state.prototypeEnumerationMayAffect === false &&
      !syntaxDataSourceFacts(source.node).requiresKnownReadPrefix)
  )
    return inertPrefix;
  const facts = selectionFacts(selection, state, source.node);
  const prefix = iterationSourcePrefix(source, facts, state);
  if (prefix === undefined) return false;
  if (
    !facts.arrays.every(
      (array) =>
        followsSelection(array) ||
        (state.prototypeEnumerationMayAffect === false &&
          syntaxArrayIterationSource(source.node, [
            ...prefix,
            ...(facts.projections.get(array) ?? []),
          ])),
    ) ||
    !selectionProjectsSource(source, selection, facts, prefix)
  )
    return false;
  let sourceReads = facts.prototypeReads.get(source.node);
  if (sourceReads === undefined) {
    sourceReads = new Map();
    facts.prototypeReads.set(source.node, sourceReads);
  }
  const prefixKey = JSON.stringify(prefix);
  let prototypeReads = sourceReads.get(prefixKey);
  if (prototypeReads === undefined) {
    // A wide pattern shares one source inventory. Do not rescan all own slots
    // separately for every default or every consumer of the same reference.
    prototypeReads = facts.reads
      .map(({ node, projection }) => ({
        node,
        projection: [...prefix, ...projection],
      }))
      .filter(
        (read) =>
          !syntaxReferenceSourceDefined({
            node: source.node,
            projection: read.projection,
          }),
      )
      .map(({ node, projection }) => ({
        node,
        unmodeledPrototype: syntaxProjectionReadsUnmodeledPrototype(
          source.node,
          projection,
        ),
      }));
    sourceReads.set(prefixKey, prototypeReads);
  }
  return prototypeReads.every(
    ({ node, unmodeledPrototype }) =>
      (state.prototypeEnumerationMayAffect === false && !unmodeledPrototype) ||
      followsSelection(node),
  );
};

interface SyntaxDataSourceFacts {
  readonly inert: boolean;
  readonly requiresKnownReadPrefix: boolean;
}

const syntaxDataSources = new WeakMap<t.Node, SyntaxDataSourceFacts>();

/** Prove inert evaluation and reads without traversing deferred callable bodies. */
const syntaxDataSourceFacts = (root: t.Node): SyntaxDataSourceFacts => {
  const cached = syntaxDataSources.get(root);
  if (cached !== undefined) return cached;
  let safe = true;
  let requiresKnownReadPrefix = false;
  const skipped = new Set<t.Node>();
  traverseJavaScriptAst(root, {
    skip: (node) => !safe || skipped.has(node),
    enter: (node) => {
      // Allocation fixes own slots, not inherited reads. Callable prototypes
      // and primitive boxing need their own read-path proof; array/string
      // metadata can also lead to a boxed number on the next projection.
      if (
        t.isFunction(node) ||
        t.isClassExpression(node) ||
        t.isRegExpLiteral(node) ||
        t.isArrayExpression(node) ||
        t.isLiteral(node)
      )
        requiresKnownReadPrefix = true;
      if (
        t.isClassMethod(node) &&
        node.kind !== "method" &&
        node.kind !== "constructor"
      )
        requiresKnownReadPrefix = true;
      if (
        readExactJavaScriptLiteral(node).found ||
        t.isBigIntLiteral(node) ||
        t.isFunctionExpression(node) ||
        t.isArrowFunctionExpression(node) ||
        t.isRegExpLiteral(node)
      ) {
        for (const child of childNodes(node)) skipped.add(child);
        return;
      }
      if (t.isClassExpression(node)) {
        if (node.superClass != null || (node.decorators?.length ?? 0) > 0) {
          safe = false;
          return;
        }
        for (const child of childNodes(node))
          if (child !== node.body) skipped.add(child);
        return;
      }
      if (t.isClassBody(node)) return;
      if (
        t.isObjectMethod(node, { kind: "method" }) ||
        t.isClassMethod(node) ||
        t.isClassPrivateMethod(node) ||
        t.isClassProperty(node) ||
        t.isClassPrivateProperty(node) ||
        t.isClassAccessorProperty(node)
      ) {
        const computed = "computed" in node && node.computed;
        // Static data initializers run now and must pass the same inertness
        // proof as their containing expression. Accessors remain unresolved.
        if (
          (node.decorators?.length ?? 0) > 0 ||
          (computed && semanticStaticPropertyKey(node.key, true) === null) ||
          ("static" in node &&
            node.static &&
            !t.isClassMethod(node, { kind: "method" }) &&
            !t.isClassPrivateMethod(node) &&
            !t.isClassProperty(node) &&
            !t.isClassPrivateProperty(node))
        ) {
          safe = false;
          return;
        }
        // Computed keys run now, even when their final spelling is known.
        // Method bodies and instance field initializers run only on later use.
        for (const child of childNodes(node))
          if (
            !(computed && child === node.key) &&
            !(
              (t.isClassProperty(node) || t.isClassPrivateProperty(node)) &&
              node.static &&
              child === node.value
            )
          )
            skipped.add(child);
        return;
      }
      if (t.isObjectExpression(node) || t.isArrayExpression(node)) return;
      if (
        t.isObjectProperty(node) &&
        semanticStaticPropertyKey(node.key, node.computed) !== null
      ) {
        if (!node.computed) skipped.add(node.key);
        return;
      }
      if (
        t.isUnaryExpression(node, { operator: "void" }) ||
        (t.isUnaryExpression(node) &&
          (node.operator === "+" || node.operator === "-") &&
          semanticStaticPropertyKey(node, true) !== null)
      )
        return;
      if (unwrapJavaScriptExpression(node).node !== node) return;
      safe = false;
    },
  });
  const facts = { inert: safe, requiresKnownReadPrefix };
  syntaxDataSources.set(root, facts);
  return facts;
};

const syntaxDataSource = (root: t.Node): boolean =>
  syntaxDataSourceFacts(root).inert;

const semanticDataSources = new WeakMap<JavaScriptSemanticValue, boolean>();

/** Unknown slots may be accessors; do not use their siblings as a no-effect proof. */
const semanticDataSource = (root: JavaScriptSemanticValue): boolean => {
  const cached = semanticDataSources.get(root);
  if (cached !== undefined) return cached;
  const pending = [root];
  const visited = new Set<JavaScriptSemanticValue>();
  let safe = true;
  while (pending.length > 0 && safe) {
    const value = pending.pop();
    if (
      value === undefined ||
      value.status === "literal" ||
      value.status === "union"
    )
      continue;
    if (visited.has(value)) continue;
    visited.add(value);
    const container = semanticContainer(value);
    if (container === null || container.coverage.status !== "complete") {
      safe = false;
      break;
    }
    for (const slot of container.slots) {
      if (slot.presence === "unknown-coverage") safe = false;
      if (slot.presence === "present") pending.push(slot.value);
    }
  }
  semanticDataSources.set(root, safe);
  return safe;
};

const semanticSlotReadKnown = (
  slot: JavaScriptSemanticProperty | undefined,
): boolean =>
  slot?.presence === "absent" ||
  (slot?.presence === "present" &&
    (slot.value.status === "literal" ||
      slot.value.status === "union" ||
      slot.value.status === "object" ||
      slot.value.status === "array"));

/** Only reads before this selection can run an accessor that changes its input. */
const semanticReadPrefixKnown = (
  source: JavaScriptSemanticReferenceSource,
  value: JavaScriptSemanticValue,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const selection = source.selection;
  if (selection === undefined) return false;
  const facts = selectionFacts(selection, state);
  const followsSelection = (node: t.Node): boolean =>
    referenceSelectionPrecedes(selection, node, state);
  // Array element reads come from iteration, not the object-property inventory.
  // Retain the complete data proof for any iteration before this selection.
  if (
    !facts.arrays.every(followsSelection) ||
    !selectionProjectsSource(source, selection, facts)
  )
    return false;
  let uncertainReads = facts.uncertainReads.get(value);
  if (uncertainReads === undefined) {
    const selectedSlot = (projection: PropertyPath) => {
      const path = referenceSourcePath({ ...source, projection });
      return path === undefined ? undefined : semanticSlotAtPath(value, path);
    };
    const propertyReads = facts.reads
      .filter((read) => {
        // Missing properties are inert once the shared prototype proof passed.
        // A known container is a data value; its unread children are irrelevant.
        return !semanticSlotReadKnown(selectedSlot(read.projection));
      })
      .map(({ node }) => node);
    // Object rest reads every retained own field, including getters omitted
    // from the explicit-property inventory. Keep their effects ordered too.
    const restReads = facts.objectRests
      .filter((read) => {
        const slot = selectedSlot(read.projection);
        if (slot?.presence !== "present") return true;
        const container = semanticContainer(slot.value);
        // Rest copies field values without traversing the values' children.
        return (
          container === null ||
          container.coverage.status !== "complete" ||
          !container.slots.every(semanticSlotReadKnown)
        );
      })
      .map(({ node }) => node);
    uncertainReads = [...propertyReads, ...restReads];
    facts.uncertainReads.set(value, uncertainReads);
  }
  return uncertainReads.every(followsSelection);
};

const selectedDefaultInput = (
  source: JavaScriptSemanticReferenceSource,
  state: JavaScriptSemanticAnalysisState,
) => {
  if (!referenceSelectionStable(source, state)) return undefined;
  const path = referenceSourcePath(source);
  if (path === undefined) return undefined;
  // An inert pattern prefix preserves the RHS capture until this selection.
  // Reuse that capture, including its shared named-source snapshot cache.
  const value = evaluateSemanticExpression(source.node, state, source.node);
  if (
    !syntaxDataSource(source.node) &&
    !semanticDataSource(value) &&
    !semanticReadPrefixKnown(source, value, state)
  )
    return undefined;
  return semanticSlotAtPath(value, path);
};

interface LiteralObjectReferenceSource {
  readonly node: t.Node;
  readonly key: string | null;
  readonly kind: "data" | "spread" | "get" | "set" | "method";
  readonly capture: t.Node;
}

interface LiteralObjectReferenceSources {
  readonly properties: ReadonlyMap<string, t.Node>;
  readonly sources: readonly LiteralObjectReferenceSource[];
  readonly unknownKeys: boolean;
  readonly prototype: t.Node | undefined;
}

const literalObjectReferenceSources = new WeakMap<
  t.ObjectExpression,
  LiteralObjectReferenceSources
>();

/** Keep the prototype initializer separate from own data named `__proto__`. */
export const semanticLiteralObjectReferenceSources = (
  node: t.ObjectExpression,
): LiteralObjectReferenceSources => {
  const cached = literalObjectReferenceSources.get(node);
  if (cached !== undefined) return cached;
  const properties = new Map<string, t.Node>();
  const sources: LiteralObjectReferenceSource[] = [];
  let unknownKeys = false;
  const prototypeProperty = semanticObjectPrototypeProperty(node);
  const prototype = prototypeProperty?.value;
  for (const property of node.properties) {
    if (t.isSpreadElement(property)) {
      sources.push({
        node: property.argument,
        key: null,
        kind: "spread",
        capture: property,
      });
      unknownKeys = true;
      continue;
    }
    const key = semanticStaticPropertyKey(property.key, property.computed);
    if (property === prototypeProperty) continue;
    const value = t.isObjectProperty(property) ? property.value : property;
    sources.push({
      node: value,
      key,
      kind: t.isObjectProperty(property) ? "data" : property.kind,
      capture: property,
    });
    if (key === null) unknownKeys = true;
    else properties.set(key, value);
  }
  const result = { properties, sources, unknownKeys, prototype };
  literalObjectReferenceSources.set(node, result);
  return result;
};

type SyntaxDataValue =
  | t.Node
  | "defined"
  | "undefined"
  | "effectful-read"
  | { readonly initialPrototype: true }
  | { readonly prototypeOf: t.Function | t.ClassExpression };

const initialPrototypeDataProperty = (
  owner: "Object" | "Array",
  key: string,
): SyntaxDataValue | undefined =>
  semanticInitialBuiltinPrototypeDataProperty(owner, key)
    ? { initialPrototype: true }
    : owner === "Array"
      ? initialPrototypeDataProperty("Object", key)
      : undefined;

const literalClassSlots = new WeakMap<
  t.ClassExpression,
  {
    readonly statics: ReadonlyMap<string, SyntaxDataValue>;
    readonly prototype: ReadonlyMap<string, SyntaxDataValue>;
  }
>();

/** Methods are installed before any static field initializer executes. An
 * uninitialized field still shadows inherited and initial metadata slots. */
const syntaxClassSlots = (node: t.ClassExpression) => {
  const cached = literalClassSlots.get(node);
  if (cached !== undefined) return cached;
  const statics = new Map<string, SyntaxDataValue>();
  const prototype = new Map<string, SyntaxDataValue>();
  prototype.set("constructor", node);
  for (const member of node.body.body) {
    if (!t.isClassMethod(member) || member.kind === "constructor") continue;
    const name = semanticStaticPropertyKey(member.key, member.computed);
    if (name !== null)
      (member.static ? statics : prototype).set(
        name,
        member.kind === "method" ? member : "effectful-read",
      );
  }
  for (const member of node.body.body) {
    if (!t.isClassProperty(member, { static: true })) continue;
    const name = semanticStaticPropertyKey(member.key, member.computed);
    if (name !== null) statics.set(name, member.value ?? "undefined");
  }
  const result = { statics, prototype };
  literalClassSlots.set(node, result);
  return result;
};

const syntaxDataProperty = (
  root: SyntaxDataValue,
  key: string,
): SyntaxDataValue | undefined => {
  if (typeof root === "string") return undefined;
  // Presence of an inherited data value does not certify further reads from
  // that shared callable, whose own properties and prototype may have changed.
  if ("initialPrototype" in root) return "effectful-read";
  if ("prototypeOf" in root) {
    const owner = root.prototypeOf;
    if (t.isClassExpression(owner))
      return syntaxClassSlots(owner).prototype.get(key) ?? "effectful-read";
    // Generator prototypes inherit their constructor; it is not an own link
    // back to the generator function, unlike ordinary constructor prototypes.
    return key === "constructor" && !owner.generator && !owner.async
      ? owner
      : "effectful-read";
  }
  let node = unwrapJavaScriptExpression(root).node;
  const receiver = node;
  while (t.isObjectExpression(node)) {
    const source = semanticLiteralObjectReferenceSources(node);
    const property = source.properties.get(key);
    if (property !== undefined) return property;
    if (source.prototype === undefined)
      return initialPrototypeDataProperty("Object", key);
    node = unwrapJavaScriptExpression(source.prototype).node;
  }
  if (t.isArrayExpression(node)) {
    if (key === "length") return "defined";
    const index = semanticArrayIndex(key);
    return index === null
      ? initialPrototypeDataProperty("Array", key)
      : (node.elements[index] ?? undefined);
  }
  // Literal allocation creates this own data slot with value zero, regardless
  // of RegExp.prototype. The source-selection gate owns intervening effects.
  if (t.isRegExpLiteral(node))
    return key === "lastIndex" ? "defined" : "effectful-read";
  if (t.isClassExpression(node)) {
    const slot = syntaxClassSlots(node).statics.get(key);
    if (slot !== undefined) return slot;
  }
  if (t.isFunction(node) || t.isClassExpression(node))
    return semanticSourceFunctionOwnPropertyDefined(node, key)
      ? key === "prototype"
        ? { prototypeOf: node }
        : "defined"
      : "effectful-read";
  // Strings are boxed when selected directly, but a primitive __proto__
  // initializer is ignored instead of becoming a boxed prototype object.
  if (node === receiver) {
    const literal = readExactJavaScriptLiteral(node);
    if (literal.found && typeof literal.value === "string") {
      if (key === "length") return "defined";
      const index = semanticArrayIndex(key);
      if (index !== null && index < literal.value.length) return "defined";
    }
    if (
      (literal.found &&
        (typeof literal.value === "number" ||
          typeof literal.value === "boolean")) ||
      t.isBigIntLiteral(node) ||
      (t.isUnaryExpression(node) &&
        (node.operator === "+" || node.operator === "-"))
    )
      return "effectful-read";
  }
  // Non-null primitive prototype initializers leave the default prototype in
  // place. Its data slots still require the separate initial-capture proof.
  return node !== receiver &&
    readExactJavaScriptLiteral(node).found &&
    !t.isNullLiteral(node)
    ? initialPrototypeDataProperty("Object", key)
    : undefined;
};

/** Keep unknown prototype reads tied to their selected receiver, rather than
 * poisoning unrelated sibling reads merely because a literal contains RegExp. */
const syntaxProjectionReadsUnmodeledPrototype = (
  root: t.Node,
  projection: PropertyPath,
): boolean => {
  let value: SyntaxDataValue | undefined =
    unwrapJavaScriptExpression(root).node;
  for (const key of projection) {
    if (value === undefined) return false;
    // A scalar's presence does not certify the prototype of its boxed value.
    if (typeof value === "string") return value === "defined";
    if (key === null || typeof key === "object") return true;
    value = syntaxDataProperty(value, String(key));
    if (value === "effectful-read") return true;
  }
  return false;
};

/** Only a literal array with the initial array prototypes supplies a known
 * iterator. Numeric properties on a callable are not iteration elements. */
const syntaxArrayIterationSource = (
  root: t.Node,
  projection: PropertyPath | undefined,
): boolean => {
  if (projection === undefined) return false;
  let value: SyntaxDataValue | undefined = root;
  for (const key of projection) {
    if (value === undefined || key === null || typeof key === "object")
      return false;
    value = syntaxDataProperty(value, String(key));
  }
  return (
    value !== undefined &&
    typeof value !== "string" &&
    !("prototypeOf" in value) &&
    !("initialPrototype" in value) &&
    t.isArrayExpression(unwrapJavaScriptExpression(value).node)
  );
};

/** Reuse literal data slots without consulting potentially stale bindings. */
const syntaxReferenceSourceDefined = (
  source: JavaScriptSemanticReferenceSource,
  state?: JavaScriptSemanticAnalysisState,
): boolean => {
  if (!syntaxDataSource(source.node)) return false;
  let value: SyntaxDataValue | undefined = unwrapJavaScriptExpression(
    source.node,
  ).node;
  for (const key of source.projection) {
    if (value === undefined || key === null || typeof key === "object")
      return false;
    value = syntaxDataProperty(value, String(key));
  }
  if (
    value === undefined ||
    value === "undefined" ||
    value === "effectful-read"
  )
    return false;
  if (value === "defined" || "prototypeOf" in value) return true;
  if ("initialPrototype" in value)
    return (
      state !== undefined &&
      state.prototypeEnumerationMayAffect === false &&
      semanticCapturePrecedesUserCode(source.node, state)
    );
  const node = unwrapJavaScriptExpression(value).node;
  return (
    readExactJavaScriptLiteral(node).found ||
    t.isBigIntLiteral(node) ||
    (t.isUnaryExpression(node) &&
      (node.operator === "+" || node.operator === "-")) ||
    t.isObjectExpression(node) ||
    t.isArrayExpression(node) ||
    t.isRegExpLiteral(node) ||
    t.isClassExpression(node) ||
    t.isFunction(node)
  );
};

/** Select a retained source slot at its capture, before later effects. */
export const semanticSelectedReferenceSlot = (
  source: JavaScriptSemanticReferenceSource,
  state: JavaScriptSemanticAnalysisState,
  capturePoint?: t.Node,
) => {
  const path = referenceSourcePath(source);
  if (path === undefined) return undefined;
  return semanticSlotAtPath(
    evaluateSemanticExpression(source.node, state, capturePoint),
    path,
  );
};

const referenceSourcePath = (
  source: JavaScriptSemanticReferenceSource,
): string[] | undefined => {
  const path: string[] = [];
  for (const key of source.projection) {
    if (key === null || typeof key === "object") return undefined;
    path.push(String(key));
  }
  return path;
};

/** Follow copied child references without equating a fresh rest copy with its source. */
export const semanticCopiedReferencePath = (
  initializer: JavaScriptSemanticBindingState["referenceInitializers"][number],
  path: PropertyPath,
  effect: "write" | "escape" | "reference",
): PropertyPath | null => {
  const offset = initializer.copyProjectionOffset;
  if (offset === undefined) return [...initializer.projection, ...path];
  const copiedPath = [...initializer.projection.slice(offset + 1), ...path];
  if (effect === "write" && copiedPath.length < 2) return null;
  if (effect === "reference" && copiedPath.length === 0) return null;
  let [key, ...remaining] = copiedPath;
  if (initializer.copyKind === "array-rest") {
    const startIndex = initializer.copyStartIndex ?? 0;
    if (key === undefined || key === null)
      key = { excludedKeys: [], startIndex };
    else if (typeof key === "object")
      key = {
        excludedKeys: key.excludedKeys.flatMap((name) => {
          const index = semanticArrayIndex(name);
          return index === null ? [] : [String(index + startIndex)];
        }),
        startIndex: (key.startIndex ?? 0) + startIndex,
      };
    else {
      const index = semanticArrayIndex(key);
      if (index === null) return null;
      key = index + startIndex;
    }
  } else {
    const excludedKeys = initializer.copyExcludedKeys ?? [];
    if (key === undefined || key === null) key = { excludedKeys };
    else if (typeof key === "object")
      key = {
        ...key,
        excludedKeys: [...new Set([...key.excludedKeys, ...excludedKeys])].sort(
          compareUnicodeCodePoints,
        ),
      };
    else if (excludedKeys.includes(String(key))) return null;
  }
  return [...initializer.projection.slice(0, offset), key, ...remaining];
};
