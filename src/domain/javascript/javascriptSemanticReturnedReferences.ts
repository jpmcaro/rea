import * as t from "@babel/types";

import {
  readExactJavaScriptLiteral,
  semanticObjectPrototypeProperty,
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  createSemanticModuleInterop,
  semanticFreshObjectFactsReady,
} from "./javascriptModuleInterop.js";
import {
  semanticCallableResultExpressions,
  semanticCallableResultCompletion,
  type SemanticCallableResultExpression,
} from "./javascriptSemanticCallableResults.js";
import { SemanticGetterExpansion } from "./javascriptSemanticGetterQueries.js";
import {
  semanticBindingAtRead,
  semanticEffectTiming,
  semanticLiteralActivationIsImmediate,
} from "./javascriptSemanticMutationInitializers.js";
import { delayedInstanceFieldValue } from "./javascriptSemanticEvaluationOrder.js";
import {
  semanticAmbientOwnSlotFactsReady,
  semanticAmbientPrototypeUnchanged,
} from "./javascriptSemanticAmbientWrites.js";
import {
  createSemanticLexicalReceiverOwner,
  createSemanticSuperLookup,
} from "./javascriptSemanticReceiverOwners.js";
import { semanticReferenceSourcesInactive } from "./javascriptSemanticReferenceSources.js";
import {
  semanticArrayIndex,
  type JavaScriptSemanticPropertyPath,
} from "./javascriptSemanticPropertyPaths.js";
import {
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
  type JavaScriptSemanticInitializer,
} from "./javascriptSemanticState.js";

/** A reference potentially handed to a caller or generator consumer. */
export interface SemanticReturnedReference {
  /** The producing callable evaluates this expression during a synchronous call. */
  readonly synchronousOwner?: t.Function;
  readonly node: t.Node;
  readonly projection: JavaScriptSemanticPropertyPath;
}

export interface SemanticReturnedReferenceSelection {
  readonly references: readonly SemanticReturnedReference[];
  readonly complete: boolean;
  /** Both states close the supported source-local may-target graph. Widened
   * joined projections without dropping represented targets; it does not
   * claim runtime completeness and never establishes an exact capture. */
  readonly precision: "exact" | "widened";
}

type Projection = readonly (string | number | null)[];

interface ValueSelection {
  /** `undefined` selects any projection depth after different depths merge. */
  readonly path: Projection | undefined;
  /** Object spread reads only own properties at these projection offsets. */
  readonly ownOnly?: readonly number[];
  readonly instance?: true;
  /** Select this state from the result after resolving and invoking a callable. */
  readonly invocation?: ValueSelection;
}

interface Candidate extends ValueSelection {
  readonly node: t.Node;
  readonly captures?: readonly t.Node[];
  /** A projected descriptor invokes its getter instead of exposing the function. */
  readonly accessorRead?: boolean;
  readonly descriptorReceiver?: {
    readonly node: t.Node;
    readonly instance?: true;
  };
  /** A prototype lookup keeps the original receiver until a value is selected. */
  readonly prototypeReceiver?:
    | NonNullable<Candidate["descriptorReceiver"]>
    | undefined;
  readonly receiverContext?: {
    readonly owner: t.ObjectMethod | t.ClassMethod;
    readonly receiver: NonNullable<Candidate["descriptorReceiver"]>;
  };
}

type ThisReferences = (
  node: t.ThisExpression,
) =>
  | { readonly owner: t.Function; readonly receivers: readonly t.Node[] }
  | undefined;

interface CallableReference {
  readonly node: t.Function | t.Class;
  readonly projection: readonly (string | number | null)[];
  readonly captures?: readonly t.Node[];
}

interface CallableReferenceSelection {
  readonly references: readonly CallableReference[];
  readonly complete: boolean;
  readonly precision: "exact" | "widened";
}

/** These leaves have no source-callable edges, but keep coverage incomplete. */
const isTerminalCallableLiteral = (node: t.Node): boolean => {
  const value = unwrapJavaScriptExpression(node).node;
  return (
    readExactJavaScriptLiteral(value).found ||
    t.isBigIntLiteral(value) ||
    t.isRegExpLiteral(value)
  );
};

interface CallableCaptureProofs {
  readonly bindingReadMayHaveChanged: (
    binding: JavaScriptSemanticBindingState,
    read: t.Node,
  ) => boolean;
  readonly ownSlotUnchanged: (
    owner: t.Node,
    key: string,
    read: t.Node,
  ) => boolean;
  readonly prototypeUnchanged?: (owner: t.Node, read: t.Node) => boolean;
}

const shiftedOwnSelections = (
  selections: readonly number[] | undefined,
  offset: number,
): readonly number[] =>
  (selections ?? [])
    .map((index) => index + offset)
    .filter((index) => index >= 0);

/** Join two projections of one source read. Differing keys widen to `null`;
 * differing depths widen to any depth. */
const joinProjection = (
  left: Projection | undefined,
  right: Projection | undefined,
): Projection | undefined => {
  if (left === undefined || right === undefined || left.length !== right.length)
    return undefined;
  return left.map((key, index) => (key === right[index] ? key : null));
};

const sameProjection = (
  left: Projection | undefined,
  right: Projection | undefined,
): boolean =>
  left === undefined
    ? right === undefined
    : right !== undefined &&
      left.length === right.length &&
      left.every((key, index) => key === right[index]);

const sameCaptures = (
  left: readonly t.Node[] | undefined,
  right: readonly t.Node[] | undefined,
): boolean =>
  left === undefined
    ? right === undefined
    : right !== undefined &&
      left.length === right.length &&
      left.every((node, index) => node === right[index]);

/** Prefix a projection; an any-depth selection stays any depth. */
const extendProjection = (
  path: Projection | undefined,
  prefix: Projection,
): Projection | undefined =>
  path === undefined ? undefined : [...prefix, ...path];

/** Pending call-result selections deeper than this collapse to any depth. */
const INVOCATION_DEPTH_LIMIT = 4;

const invocationDepth = (invocation: ValueSelection | undefined): number =>
  invocation === undefined ? 0 : 1 + invocationDepth(invocation.invocation);

/** Replace the projection, own-only offsets and capture record of a candidate.
 * An any-depth selection carries neither offsets nor captures, and empty
 * offsets are omitted so equal selections compare equal. */
const reselect = (
  item: Candidate,
  selection: {
    readonly path: Projection | undefined;
    readonly ownOnly?: readonly number[] | undefined;
    readonly captures?: readonly t.Node[] | undefined;
  },
  overrides: Partial<Candidate> = {},
): Candidate => ({
  node: item.node,
  path: selection.path,
  ...(item.instance === undefined ? {} : { instance: item.instance }),
  ...(item.invocation === undefined ? {} : { invocation: item.invocation }),
  ...(item.accessorRead === undefined
    ? {}
    : { accessorRead: item.accessorRead }),
  ...(item.descriptorReceiver === undefined
    ? {}
    : { descriptorReceiver: item.descriptorReceiver }),
  ...(item.prototypeReceiver === undefined
    ? {}
    : { prototypeReceiver: item.prototypeReceiver }),
  ...(item.receiverContext === undefined
    ? {}
    : { receiverContext: item.receiverContext }),
  ...(selection.path === undefined ||
  selection.ownOnly === undefined ||
  selection.ownOnly.length === 0
    ? {}
    : { ownOnly: selection.ownOnly }),
  ...(selection.path === undefined || selection.captures === undefined
    ? {}
    : { captures: selection.captures }),
  ...overrides,
});

interface ObjectTargetIndex {
  readonly prototype: t.ObjectProperty | undefined;
  readonly unknownProperties: boolean;
  readonly propertyByName: ReadonlyMap<
    string,
    t.ObjectMethod | t.ObjectProperty
  >;
  readonly trailingUnknownsByProperty: ReadonlyMap<
    t.ObjectMethod | t.ObjectProperty,
    ObjectTargetUnknown
  >;
  readonly pairedAccessors: ReadonlyMap<t.ObjectMethod, t.ObjectMethod>;
}

interface ObjectTargetUnknown {
  readonly node: t.ObjectMethod | t.ObjectProperty | t.SpreadElement;
  readonly previous: ObjectTargetUnknown | undefined;
}

const callableInitializersAt = (
  node: t.Identifier,
  state: JavaScriptSemanticAnalysisState,
): {
  readonly initializers: readonly JavaScriptSemanticInitializer[];
  readonly definite: boolean;
} => {
  const binding = resolveSemanticBindingState(state, node, node.name);
  if (binding === undefined) return { initializers: [], definite: false };
  const selected = semanticBindingAtRead(binding, node, state.parentsByNode);
  return {
    initializers: [
      ...selected.binding.initializers,
      ...selected.binding.referenceInitializers.filter(
        (initializer) =>
          !semanticReferenceSourcesInactive(initializer, state, "syntax-only"),
      ),
    ],
    definite:
      selected.hasDefiniteInitializer ||
      semanticStableInitializer(selected.binding, state) !== undefined,
  };
};

type ClassMember =
  | t.ClassMethod
  | t.ClassPrivateMethod
  | t.ClassProperty
  | t.ClassPrivateProperty
  | t.ClassAccessorProperty;
interface ClassTargetMember {
  readonly node: ClassMember;
  readonly key:
    | { readonly kind: "public"; readonly name: string | null }
    | {
        readonly kind: "private";
        readonly name: string;
        readonly declaration: t.PrivateName;
      };
  readonly kind: "method" | "get" | "set" | "accessor" | "field";
  readonly value: t.Node | null;
  readonly static: boolean;
  readonly decorated: boolean;
}
type ClassMemberLayer = "static" | "prototype" | "fields";
interface ClassTargetIndex {
  readonly static: readonly ClassTargetMember[];
  readonly prototype: readonly ClassTargetMember[];
  readonly fields: readonly ClassTargetMember[];
  readonly privateByName: ReadonlyMap<string, readonly ClassTargetMember[]>;
  readonly staticEvaluationOrder: ReadonlyMap<t.Node, number>;
  readonly constructorMethod?: t.ClassMethod;
}
interface ClassLineage {
  readonly classes: readonly t.Class[];
  readonly unknownBase?: t.Node;
}

/** Only a complete, unprojected local capture proves one superclass identity. */
const definiteClassAt = (
  expression: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.Class | undefined => {
  let node = unwrapJavaScriptExpression(expression).node;
  const seen = new Set<JavaScriptSemanticInitializer>();
  while (t.isIdentifier(node)) {
    const selected = callableInitializersAt(node, state);
    const initializer = selected.initializers[0];
    if (
      !selected.definite ||
      selected.initializers.length !== 1 ||
      initializer === undefined ||
      initializer.projection.length > 0 ||
      seen.has(initializer)
    )
      return undefined;
    seen.add(initializer);
    node = unwrapJavaScriptExpression(initializer.node).node;
  }
  return t.isClass(node) ? node : undefined;
};

const classLineage = (
  node: t.Class,
  state: JavaScriptSemanticAnalysisState,
  cache: WeakMap<t.Class, ClassLineage>,
): ClassLineage => {
  const prior = cache.get(node);
  if (prior !== undefined) return prior;
  const classes = [node];
  const seen = new Set<t.Class>(classes);
  let current = node;
  let unknownBase: t.Node | undefined;
  while (current.superClass != null) {
    const base = definiteClassAt(current.superClass, state);
    if (base === undefined) {
      unknownBase = current.superClass;
      break;
    }
    if (seen.has(base)) break;
    seen.add(base);
    classes.push(base);
    current = base;
  }
  const result = {
    classes,
    ...(unknownBase === undefined ? {} : { unknownBase }),
  };
  cache.set(node, result);
  return result;
};

/** Methods/accessors form descriptors; fields initialize afterward. */
const classTargetIndex = (
  node: t.Class,
  cache: WeakMap<t.Class, ClassTargetIndex>,
): ClassTargetIndex => {
  const prior = cache.get(node);
  if (prior !== undefined) return prior;
  const descriptors: ClassTargetMember[] = [];
  const fields: ClassTargetMember[] = [];
  const privateByName = new Map<string, ClassTargetMember[]>();
  const staticEvaluationOrder = new Map<t.Node, number>();
  let constructor: t.ClassMethod | undefined;
  for (const [position, member] of node.body.body.entries()) {
    if (t.isStaticBlock(member)) {
      staticEvaluationOrder.set(member, position);
      continue;
    }
    if (t.isClassMethod(member, { kind: "constructor" })) {
      constructor = member;
      continue;
    }
    if (
      !t.isClassMethod(member) &&
      !t.isClassPrivateMethod(member) &&
      !t.isClassProperty(member) &&
      !t.isClassPrivateProperty(member) &&
      !t.isClassAccessorProperty(member)
    )
      continue;
    const target = classMemberTarget(member);
    if (
      target.static &&
      (target.kind === "field" || target.kind === "accessor")
    )
      staticEvaluationOrder.set(member, position);
    (target.kind === "field" ? fields : descriptors).push(target);
    if (target.key.kind === "private") {
      const named = privateByName.get(target.key.name) ?? [];
      named.push(target);
      privateByName.set(target.key.name, named);
    }
  }
  const result = {
    static: [
      ...descriptors.filter((member) => member.static),
      ...fields.filter((member) => member.static),
    ],
    prototype: descriptors.filter((member) => !member.static),
    fields: fields.filter((member) => !member.static),
    privateByName,
    staticEvaluationOrder,
    ...(constructor === undefined ? {} : { constructorMethod: constructor }),
  };
  cache.set(node, result);
  return result;
};

const classMemberTarget = (member: ClassMember): ClassTargetMember => {
  const method = t.isClassMethod(member) || t.isClassPrivateMethod(member);
  return {
    node: member,
    key: t.isPrivateName(member.key)
      ? {
          kind: "private",
          name: member.key.id.name,
          declaration: member.key,
        }
      : {
          kind: "public",
          name: semanticStaticPropertyKey(
            member.key,
            "computed" in member && member.computed,
          ),
        },
    kind: method
      ? member.kind === "get" || member.kind === "set"
        ? member.kind
        : "method"
      : t.isClassAccessorProperty(member)
        ? "accessor"
        : "field",
    value: method ? member : (member.value ?? null),
    static: member.static === true,
    decorated: (member.decorators?.length ?? 0) > 0,
  };
};

/** Private lookup selects a lexical declaration, never a public property path. */
export const createSemanticPrivateMemberTargets = (
  state: JavaScriptSemanticAnalysisState,
  indexes = new WeakMap<t.Class, ClassTargetIndex>(),
) => {
  const resolved = new WeakMap<
    t.PrivateName,
    {
      readonly owner: t.Class;
      readonly members: readonly ClassTargetMember[];
      readonly lineage: ClassLineage;
    }
  >();
  const lineages = new WeakMap<t.Class, ClassLineage>();
  return (name: t.PrivateName) => {
    const prior = resolved.get(name);
    if (prior !== undefined) return prior;
    let child: t.Node = name;
    for (
      let parent = state.parentsByNode.get(child);
      parent !== undefined;
      parent = state.parentsByNode.get(child)
    ) {
      if (t.isClass(parent) && parent.body === child) {
        const members = classTargetIndex(parent, indexes).privateByName.get(
          name.id.name,
        );
        if (members !== undefined) {
          const declaration = {
            owner: parent,
            members,
            lineage: classLineage(parent, state, lineages),
          };
          resolved.set(name, declaration);
          return declaration;
        }
      }
      child = parent;
    }
    return undefined;
  };
};

const selectPrivateTargets = (
  members: readonly ClassTargetMember[],
  item: Candidate,
  path: Candidate["path"],
  pending: Candidate[],
): void => {
  const ownOnly =
    path === undefined || item.path === undefined
      ? []
      : shiftedOwnSelections(item.ownOnly, path.length - item.path.length);
  for (const member of members) {
    if (member.value === null || member.kind === "set") continue;
    if (member.kind === "get") {
      // The read invokes the getter; a following call invokes its result.
      pending.push({
        node: member.value,
        path: [],
        invocation: {
          path,
          ownOnly,
          ...(item.instance === true ? { instance: true } : {}),
          ...(item.invocation === undefined
            ? {}
            : { invocation: item.invocation }),
        },
      });
    } else
      pending.push(
        reselect(
          item,
          { path, ownOnly, captures: item.captures },
          { node: member.value },
        ),
      );
  }
};

const selectClassTargets = (
  members: readonly ClassTargetMember[],
  key: string | number | null | undefined,
  definitelyPresent: (member: ClassTargetMember) => boolean = () => true,
): {
  readonly values: readonly t.Node[];
  readonly members: readonly ClassTargetMember[];
  readonly own: boolean;
} => {
  const values: t.Node[] = [];
  const selected: ClassTargetMember[] = [];
  let own = false;
  const accessorKinds = new Set<"get" | "set">();
  for (const member of members.toReversed()) {
    if (member.key.kind === "private") continue;
    const name = member.key.name;
    if (key != null && name !== null && name !== String(key)) continue;
    const exact = key != null && name === String(key);
    const definite = exact && definitelyPresent(member);
    if (definite) own = true;
    if (definite && (member.kind === "get" || member.kind === "set")) {
      if (accessorKinds.has(member.kind)) continue;
      accessorKinds.add(member.kind);
      selected.push(member);
      if (member.kind === "get" && member.value !== null)
        values.push(member.value);
      if (accessorKinds.size === 2) break;
      continue;
    }
    if (definite && member.kind === "accessor") {
      selected.push(member);
      if (!accessorKinds.has("get") && member.value !== null)
        values.push(member.value);
      break;
    }
    if (member.kind === "set") {
      selected.push(member);
      continue;
    }
    // An accessor pair replaces an earlier data descriptor, in either order.
    if (definite && accessorKinds.size > 0) break;
    const value = member.value;
    selected.push(member);
    if (value != null) values.push(value);
    if (definite) break;
  }
  return { values, members: selected, own };
};

/** Class descriptors exist before static initialization; fields do not. */
export const createSemanticStaticClassSlotReferences = (
  state: JavaScriptSemanticAnalysisState,
  isFreshObject: (node: t.Node) => boolean,
) => {
  const indexes = new WeakMap<t.Class, ClassTargetIndex>();
  const lineages = new WeakMap<t.Class, ClassLineage>();
  return (owner: t.Class, key: string, read: t.Node | undefined) => {
    const owners: t.Class[] = [];
    const values: {
      readonly node: t.Node;
      readonly getterResult?: t.Function;
    }[] = [];
    let own = false;
    let local = true;
    for (const declaring of classLineage(owner, state, lineages).classes) {
      owners.push(declaring);
      const index = classTargetIndex(declaring, indexes);
      let current = read;
      let child: t.Node | undefined;
      let deferred = false;
      while (
        current !== undefined &&
        state.parentsByNode.get(current) !== declaring.body
      ) {
        if (
          t.isFunction(current) &&
          (current.body === child ||
            current.params.some((parameter) => parameter === child)) &&
          !semanticLiteralActivationIsImmediate(current, state.parentsByNode)
        )
          deferred = true;
        if (delayedInstanceFieldValue(current, child)) {
          const body = state.parentsByNode.get(current);
          const owner =
            body === undefined ? undefined : state.parentsByNode.get(body);
          if (
            !t.isClass(owner) ||
            !semanticLiteralActivationIsImmediate(owner, state.parentsByNode)
          )
            deferred = true;
        }
        child = current;
        current = state.parentsByNode.get(current);
      }
      const position =
        current === undefined
          ? undefined
          : index.staticEvaluationOrder.get(current);
      const completed =
        read !== undefined &&
        semanticEffectTiming(read, declaring, state) === "before";
      const initialized = (member: ClassTargetMember): boolean | undefined => {
        if (member.kind !== "field" && member.kind !== "accessor") return true;
        if (position !== undefined) {
          if (
            (index.staticEvaluationOrder.get(member.node) ?? Infinity) <
            position
          )
            return true;
          // A deferred body can run after later fields initialize. Its
          // creation position is only an earliest activation bound.
          return deferred ? undefined : false;
        }
        return completed ? true : undefined;
      };
      const selected = selectClassTargets(
        index.static.filter((member) => initialized(member) !== false),
        key,
        (member) => initialized(member) === true,
      );
      for (const member of selected.members)
        if (member.kind === "get" && t.isFunction(member.value)) {
          for (const { node } of semanticCallableResultExpressions(
            member.value,
          ))
            if (node !== null)
              values.push({ node, getterResult: member.value });
        } else if (member.kind !== "set" && member.value !== null)
          values.push({ node: member.value });
      local &&=
        !declaring.decorators?.length &&
        selected.members.every(
          (member) =>
            member.key.kind === "public" &&
            member.key.name === key &&
            !member.decorated &&
            member.kind !== "get" &&
            (member.kind === "set" ||
              member.value === null ||
              isFreshObject(member.value)),
        );
      if (selected.own) {
        own = true;
        break;
      }
      // A source binding alone does not prove that the runtime superclass
      // still names this declaration; reuse the completed fresh-value proof.
      if (declaring.superClass != null && !isFreshObject(declaring.superClass))
        local = false;
    }
    return {
      own,
      ownLocal: own && local,
      values,
      owners,
      inherited: owner.superClass,
    };
  };
};

const constructorReplacesReceiver = (
  constructor: t.Function | undefined,
  results: readonly SemanticCallableResultExpression[],
  isDefinitelyObject: (node: t.Node) => boolean,
): boolean => {
  const result = results[0];
  return (
    constructor !== undefined &&
    t.isBlockStatement(constructor.body) &&
    results.length === 1 &&
    result !== undefined &&
    constructor.body.body.some((statement) => statement === result.site) &&
    result.node !== null &&
    isDefinitelyObject(result.node)
  );
};

export const semanticConstructorKeepsReceiver = (
  node: t.Function,
  isDefinitelyObject: (node: t.Node) => boolean,
): boolean =>
  !constructorReplacesReceiver(
    node,
    semanticCallableResultExpressions(node),
    isDefinitelyObject,
  );

/** An unclassified return may supply any reference to an invocation caller.
 * The caller owns whether this denotes an allocated or unresolved receiver. */
export const createSemanticUnknownCallableResults = (
  state: JavaScriptSemanticAnalysisState,
  isFreshObject: (node: t.Node) => boolean,
  isDefinitelyObject: (node: t.Node) => boolean,
  options: { readonly thisIsUnknown?: boolean } = {},
) => {
  const references = createSemanticFunctionValueReferences(state);
  const classes = new WeakMap<t.Class, ClassTargetIndex>();
  const active = new WeakSet<t.Node>();
  const cached = [
    new WeakMap<t.Function, boolean>(),
    new WeakMap<t.Function, boolean>(),
  ] as const;
  const knownValue = (input: t.Node, thisIsUnknown: boolean): boolean => {
    const node = unwrapJavaScriptExpression(input).node;
    if (t.isThisExpression(node)) return !thisIsUnknown;
    if (readExactJavaScriptLiteral(node).found || isFreshObject(node))
      return true;
    if (active.has(node)) return false;
    active.add(node);
    let known = false;
    if (t.isIdentifier(node) && isDefinitelyObject(node)) {
      // Reuse the callable owner's captured alias selection, including its
      // completeness proof. Projected and mixed values remain unknown here.
      const selected = callableInitializersAt(node, state);
      const source = selected.initializers[0];
      known =
        selected.definite &&
        selected.initializers.length === 1 &&
        source?.projection.length === 0 &&
        knownValue(source.node, thisIsUnknown);
    } else if (t.isNewExpression(node) && isFreshObject(node.callee)) {
      const values = references(node.callee);
      const source = values[0];
      if (values.length === 1 && source?.projection.length === 0) {
        const target = source.node;
        if (t.isFunction(target)) known = !unknownResult(target, false);
        else if (target.superClass == null) {
          const constructor = classTargetIndex(
            target,
            classes,
          ).constructorMethod;
          known =
            constructor === undefined || !unknownResult(constructor, false);
        }
      }
    }
    active.delete(node);
    return known;
  };
  const unknownResult = (
    node: t.Function,
    thisIsUnknown = options.thisIsUnknown === true,
  ): boolean => {
    const results = cached[thisIsUnknown ? 1 : 0];
    const prior = results.get(node);
    if (prior !== undefined) return prior;
    // Recursive result identities cannot establish their own locality.
    results.set(node, true);
    const unknown = semanticCallableResultExpressions(node).some(
      (result) =>
        result.kind === "return" &&
        result.node !== null &&
        !knownValue(result.node, thisIsUnknown),
    );
    results.set(node, unknown);
    return unknown;
  };
  return unknownResult;
};

/** A stage's return affects subsequent derived initialization, never its own
 * field initializers or constructor body. Reuse the class descriptor owner. */
export const createSemanticClassConstructionStages = (
  state: JavaScriptSemanticAnalysisState,
  isDefinitelyObject: (node: t.Node) => boolean,
  isFreshObject: (node: t.Node) => boolean,
  includeUnknownResults = true,
) => {
  const indexes = new WeakMap<t.Class, ClassTargetIndex>();
  const lineages = new WeakMap<t.Class, ClassLineage>();
  const references = createSemanticFunctionValueReferences(state);
  const unknownResult = createSemanticUnknownCallableResults(
    state,
    isFreshObject,
    isDefinitelyObject,
  );
  return (node: t.Class, allocation?: t.Node) => {
    let fresh = true;
    const lineage = classLineage(node, state, lineages);
    // A possibly changed constructor parent preserves its declared stages as
    // alternatives. Inject the other parent receiver at that edge, after the
    // old base's own initialization; it never becomes the old base's `this`.
    // Unknown activation discovery has no capture and retains the source graph.
    const changedParents = new Set(
      allocation !== undefined && semanticAmbientOwnSlotFactsReady(state)
        ? lineage.classes.filter(
            (owner) =>
              owner.superClass != null &&
              !semanticAmbientPrototypeUnchanged(state, owner, allocation),
          )
        : [],
    );
    const stages: {
      owner: t.Function | t.Class;
      constructor: t.Function | undefined;
      fields: readonly ClassTargetMember[];
      derived: boolean;
      fresh: boolean;
      local: boolean;
      keepsReceiver: boolean;
      unknownReceiver: boolean;
      unknownResult: boolean;
    }[] = [];
    const base = lineage.unknownBase;
    const candidates = base === undefined ? [] : references(base);
    const candidate = candidates.length === 1 ? candidates[0] : undefined;
    let unknownReceiver =
      base !== undefined &&
      !t.isNullLiteral(unwrapJavaScriptExpression(base).node);
    if (
      base !== undefined &&
      candidate?.projection.length === 0 &&
      t.isFunction(candidate.node) &&
      isFreshObject(base)
    ) {
      const stage = {
        owner: candidate.node,
        constructor: candidate.node,
        fields: [],
        derived: false,
        fresh,
        local: changedParents.size === 0,
        keepsReceiver: true,
        unknownReceiver: false,
        unknownResult: false,
      };
      fresh = !constructorReplacesReceiver(
        candidate.node,
        semanticCallableResultExpressions(candidate.node),
        isDefinitelyObject,
      );
      stage.keepsReceiver = fresh;
      unknownReceiver = includeUnknownResults && unknownResult(candidate.node);
      stage.unknownResult = unknownReceiver;
      stages.push(stage);
    }
    const locals = new Map<t.Class, boolean>();
    const optionalStages = new Set<t.Class>();
    let local = true;
    let optional = false;
    for (const owner of lineage.classes) {
      locals.set(owner, local);
      if (optional) optionalStages.add(owner);
      optional ||= changedParents.has(owner);
      if (owner.superClass != null && !isFreshObject(owner.superClass))
        local = false;
    }
    for (const owner of [...lineage.classes].reverse()) {
      const index = classTargetIndex(owner, indexes);
      if (changedParents.has(owner)) {
        // The other parent may keep the new allocation or return any object.
        // An optional old ancestor's return cannot exclude either alternative.
        fresh = true;
        unknownReceiver = true;
      }
      unknownReceiver ||= locals.get(owner) !== true;
      const stage = {
        owner,
        constructor: index.constructorMethod,
        fields: index.fields,
        derived: owner.superClass != null,
        fresh,
        local: locals.get(owner) === true && !optionalStages.has(owner),
        keepsReceiver: true,
        unknownReceiver,
        unknownResult: false,
      };
      const replacesReceiver =
        locals.get(owner) === true &&
        constructorReplacesReceiver(
          index.constructorMethod,
          index.constructorMethod === undefined
            ? []
            : semanticCallableResultExpressions(index.constructorMethod),
          isDefinitelyObject,
        );
      fresh &&= !replacesReceiver;
      stage.keepsReceiver = fresh;
      unknownReceiver =
        (!replacesReceiver && unknownReceiver) ||
        (includeUnknownResults &&
          index.constructorMethod !== undefined &&
          unknownResult(index.constructorMethod));
      // A provisional result alias cannot contribute its own top mutation to
      // the frozen proof that decides whether that alias is a local object.
      // The completed receiver owner refines these result alternatives later.
      if (
        !includeUnknownResults &&
        index.constructorMethod !== undefined &&
        semanticCallableResultExpressions(index.constructorMethod).some(
          (result) => result.kind === "return",
        )
      )
        unknownReceiver = false;
      stage.unknownResult = unknownReceiver;
      stages.push(stage);
    }
    return stages;
  };
};

/** Resolve possible local callable identities without claiming call execution. */
const createSemanticCallableReferences = (
  state: JavaScriptSemanticAnalysisState,
  mode: "callable" | "contents" | "function-values" | "results" | "accessors",
  definiteObjectProof?: (node: t.Node) => boolean,
  captureProofs?: CallableCaptureProofs,
  thisReferences?: ThisReferences,
  callResultSources?: (
    node: t.CallExpression | t.OptionalCallExpression,
  ) => readonly t.Node[],
  includeContainerContents = false,
): ((
  callee: t.Node | readonly t.Node[],
  projection?: readonly (string | number | null)[],
  projectionRead?: t.Node,
) => CallableReferenceSelection) => {
  let results = new WeakMap<t.Node, Map<string, CallableReferenceSelection>>();
  const objectTargets = new WeakMap<t.ObjectExpression, ObjectTargetIndex>();
  const classTargets = new WeakMap<t.Class, ClassTargetIndex>();
  const privateTargets = createSemanticPrivateMemberTargets(
    state,
    classTargets,
  );
  const superLookup = createSemanticSuperLookup(state);
  const lexicalReceiverOwner = createSemanticLexicalReceiverOwner(state);
  const staticReceiver = (node: t.ThisExpression): t.Class | undefined => {
    const owner = lexicalReceiverOwner(node);
    if (
      !t.isStaticBlock(owner) &&
      !(
        (t.isClassProperty(owner) ||
          t.isClassPrivateProperty(owner) ||
          t.isClassAccessorProperty(owner)) &&
        owner.static
      )
    )
      return undefined;
    const body = state.parentsByNode.get(owner);
    const declaring =
      body === undefined ? undefined : state.parentsByNode.get(body);
    return t.isClass(declaring) ? declaring : undefined;
  };
  const classLineages = new WeakMap<t.Class, ClassLineage>();
  const interop = createSemanticModuleInterop(state);
  const isDefinitelyObject = definiteObjectProof ?? interop.isDefinitelyObject;
  const captureIds = new WeakMap<t.Node, number>();
  let nextCaptureId = 0;
  const captureKey = (captures?: readonly t.Node[]) =>
    captures?.map((node) => {
      let id = captureIds.get(node);
      if (id === undefined) {
        id = nextCaptureId++;
        captureIds.set(node, id);
      }
      return id;
    });
  let factsReady = semanticFreshObjectFactsReady(state);
  let ownSlotFactsReady =
    captureProofs === undefined || semanticAmbientOwnSlotFactsReady(state);
  return (callee, projection = [], projectionRead) => {
    const ready = semanticFreshObjectFactsReady(state);
    const slotsReady =
      captureProofs === undefined || semanticAmbientOwnSlotFactsReady(state);
    if (factsReady !== ready || ownSlotFactsReady !== slotsReady) {
      // Neither provisional binding nor own-slot uncertainty is a final fact.
      factsReady = ready;
      ownSlotFactsReady = slotsReady;
      results = new WeakMap();
    }
    const roots: readonly t.Node[] = t.isNode(callee) ? [callee] : callee;
    const single = t.isNode(callee) ? callee : undefined;
    const captureSite = roots[0];
    if (captureSite === undefined)
      return { references: [], complete: true, precision: "exact" };
    const projectionKey = JSON.stringify([
      projection,
      projectionRead === undefined ? undefined : captureKey([projectionRead]),
    ]);
    const existing =
      single === undefined
        ? undefined
        : results.get(single)?.get(projectionKey);
    if (existing !== undefined) return existing;
    let complete = !includeContainerContents;
    let widened = false;
    const functions = new Map<
      t.Function | t.Class,
      Map<string, CallableReference>
    >();
    const retain = (
      node: t.Function | t.Class,
      path: Projection,
      captures?: readonly t.Node[],
    ) => {
      const paths = functions.get(node) ?? new Map();
      paths.set(
        JSON.stringify(
          captureProofs === undefined ? path : [path, captureKey(captures)],
        ),
        {
          node,
          projection: path,
          ...(captures === undefined ? {} : { captures }),
        },
      );
      functions.set(node, paths);
    };
    // A transition depends on the source read and its current selection, not
    // on the initializer history used to reach it. Keeping history out of the
    // state lets shared diamonds and reassignment webs converge to the finite
    // may-target fixed point instead of enumerating alias permutations. A
    // source reached again under another projection joins both projections:
    // differing keys widen to `null` and differing depths widen to any depth.
    // Widening never drops represented targets, but completion stays unknown
    // and an exact capture is refused after a join.
    interface SelectionState {
      item: Candidate;
      queued: boolean;
    }
    let states = new WeakMap<t.Node, Map<string, SelectionState>>();
    let work: SelectionState[] = [];
    const getterExpansion =
      thisReferences === undefined
        ? undefined
        : new SemanticGetterExpansion(state);
    let expandsReceiver = false;
    const invocationKey = (invocation: ValueSelection | undefined): unknown =>
      invocation === undefined
        ? undefined
        : [
            invocation.path === undefined ? "*" : invocation.path,
            invocation.ownOnly ?? [],
            invocation.instance === true,
            invocationKey(invocation.invocation),
          ];
    const selectionKey = (item: Candidate): string =>
      JSON.stringify([
        item.instance === true,
        item.accessorRead === true,
        invocationKey(item.invocation),
        item.descriptorReceiver === undefined
          ? undefined
          : [
              captureKey([item.descriptorReceiver.node]),
              item.descriptorReceiver.instance === true,
            ],
        item.prototypeReceiver === undefined
          ? undefined
          : [
              captureKey([item.prototypeReceiver.node]),
              item.prototypeReceiver.instance === true,
            ],
        item.receiverContext === undefined
          ? undefined
          : [
              captureKey([
                item.receiverContext.owner,
                item.receiverContext.receiver.node,
              ]),
              item.receiverContext.receiver.instance === true,
            ],
      ]);
    // Nested call results such as `a = a()` would otherwise stack one pending
    // selection per cycle turn. Beyond the bound, any projection of the result
    // remains a candidate and the exact selection is lost.
    const boundInvocation = (candidate: Candidate): Candidate => {
      if (invocationDepth(candidate.invocation) <= INVOCATION_DEPTH_LIMIT)
        return candidate;
      complete = false;
      widened = true;
      return { ...candidate, invocation: { path: undefined, ownOnly: [] } };
    };
    const joinSelections = (
      previous: Candidate,
      incoming: Candidate,
    ): Candidate | undefined => {
      const path = joinProjection(previous.path, incoming.path);
      const ownOnly =
        path === undefined
          ? []
          : (previous.ownOnly ?? []).filter((offset) =>
              (incoming.ownOnly ?? []).includes(offset),
            );
      const captures =
        sameProjection(previous.path, incoming.path) &&
        sameCaptures(previous.captures, incoming.captures)
          ? previous.captures
          : undefined;
      if (
        sameProjection(path, previous.path) &&
        ownOnly.length === (previous.ownOnly ?? []).length &&
        captures === previous.captures
      )
        return undefined;
      return reselect(previous, { path, ownOnly, captures });
    };
    const enqueue = (candidate: Candidate): void => {
      const widening = getterExpansion?.widening === true;
      // The fallback is reachability over receiver contents, independent of
      // suffix permutations and alias ancestry. Calls expose both their
      // callable and result contents in this conservative pass.
      const selection: Candidate = widening
        ? {
            node: candidate.node,
            path: [],
            ...(candidate.instance === undefined
              ? {}
              : { instance: candidate.instance }),
            ...(candidate.descriptorReceiver === undefined
              ? {}
              : { descriptorReceiver: candidate.descriptorReceiver }),
            ...(candidate.prototypeReceiver === undefined
              ? {}
              : { prototypeReceiver: candidate.prototypeReceiver }),
            ...(candidate.receiverContext === undefined
              ? {}
              : { receiverContext: candidate.receiverContext }),
          }
        : boundInvocation(candidate);
      const node = unwrapJavaScriptExpression(selection.node).node;
      const item = { ...selection, node };
      const key = selectionKey(item);
      const byKey = states.get(node) ?? new Map<string, SelectionState>();
      states.set(node, byKey);
      const existing = byKey.get(key);
      if (existing === undefined) {
        const created = { item, queued: true };
        byKey.set(key, created);
        work.push(created);
        return;
      }
      const joined = joinSelections(existing.item, item);
      if (joined === undefined) return;
      complete = false;
      widened = true;
      existing.item = joined;
      if (!existing.queued) {
        existing.queued = true;
        work.push(existing);
      }
    };
    // A consumer needing only the union of several roots shares completed
    // expansions. Each root keeps its own capture context.
    const enqueueRoots = (): void => {
      for (let index = roots.length - 1; index >= 0; index--) {
        const node = roots[index];
        if (node === undefined) continue;
        if (isTerminalCallableLiteral(node)) {
          complete = false;
          continue;
        }
        enqueue({
          node,
          path: projection,
          ...(captureProofs === undefined
            ? {}
            : { captures: projection.map(() => projectionRead ?? node) }),
        });
      }
    };
    enqueueRoots();
    while (work.length > 0) {
      const current = work.pop();
      if (current === undefined) break;
      current.queued = false;
      const item = current.item;
      const node = item.node;
      const widening = getterExpansion?.widening === true;
      if (isTerminalCallableLiteral(node)) {
        complete = false;
        continue;
      }
      if (item.path === undefined || item.path.includes(null)) complete = false;
      if (expandsReceiver && getterExpansion?.reserveResult() === false) {
        if (getterExpansion.widen()) {
          complete = false;
          states = new WeakMap();
          work = [];
          enqueueRoots();
        }
        continue;
      }
      const pending: Candidate[] = [];
      const lexicalStatic = t.isThisExpression(node)
        ? staticReceiver(node)
        : undefined;
      if (
        t.isThisExpression(node) &&
        (thisReferences !== undefined || lexicalStatic !== undefined)
      ) {
        // Receiver sources are independently selected at their invocation.
        // Re-entering a receiver's bindings terminates through the shared
        // selection states, so recursive getters form a finite graph.
        const selected = thisReferences?.(node);
        expandsReceiver ||=
          selected !== undefined || lexicalStatic !== undefined;
        const receivers: NonNullable<Candidate["descriptorReceiver"]>[] =
          lexicalStatic === undefined
            ? (selected?.receivers.map((node) => ({ node })) ?? [])
            : [{ node: lexicalStatic }];
        if (lexicalStatic !== undefined) complete = false;
        if (
          selected?.owner === item.receiverContext?.owner &&
          item.receiverContext !== undefined
        )
          receivers.push(item.receiverContext.receiver);
        for (const receiver of receivers)
          pending.push({ ...item, ...receiver });
      } else if (
        t.isSuper(node) &&
        (item.path === undefined || item.path.length > 0)
      ) {
        // Possible lexical-home lookup is not proof that a runtime prototype
        // or its selected member still has its source identity.
        complete = false;
        const lookup = superLookup(node);
        if (lookup?.base !== undefined)
          pending.push({
            ...item,
            node: lookup.base,
            path: extendProjection(item.path, lookup.projection),
          });
      } else if (widening && t.isFunction(node)) {
        retain(node, []);
        const receiverContext =
          (t.isObjectMethod(node) || t.isClassMethod(node)) &&
          (node.kind === "get" || node.kind === "set") &&
          item.descriptorReceiver !== undefined
            ? { owner: node, receiver: item.descriptorReceiver }
            : item.receiverContext;
        for (const result of semanticCallableResultExpressions(node))
          if (result.node !== null)
            pending.push({
              node: result.node,
              path: [],
              ...(receiverContext === undefined ? {} : { receiverContext }),
            });
      } else if (t.isIdentifier(node)) {
        const selected = callableInitializersAt(node, state);
        complete &&= selected.definite;
        if (captureProofs !== undefined) {
          const binding = resolveSemanticBindingState(state, node, node.name);
          complete &&=
            binding !== undefined &&
            !captureProofs.bindingReadMayHaveChanged(binding, node) &&
            selected.initializers.every(
              ({ node: value }) =>
                t.isFunctionDeclaration(value) ||
                (value.end ?? Infinity) < (node.start ?? -1),
            );
        }
        for (const initializer of selected.initializers)
          pending.push(
            reselect(
              item,
              {
                path: extendProjection(item.path, initializer.projection),
                ownOnly: shiftedOwnSelections(
                  item.ownOnly,
                  initializer.projection.length,
                ),
                captures:
                  item.captures === undefined
                    ? undefined
                    : [
                        ...initializer.projection.map(() => initializer.node),
                        ...item.captures,
                      ],
              },
              { node: initializer.node },
            ),
          );
      } else if (
        t.isMemberExpression(node) ||
        t.isOptionalMemberExpression(node)
      ) {
        const path: (string | number | null)[] = [];
        let receiver: t.Node = node;
        let privateRead = false;
        while (
          t.isMemberExpression(receiver) ||
          t.isOptionalMemberExpression(receiver)
        ) {
          if (t.isPrivateName(receiver.property)) {
            privateRead = true;
            const declaration = privateTargets(receiver.property);
            selectPrivateTargets(
              declaration?.members ?? [],
              item,
              extendProjection(item.path, path.toReversed()),
              pending,
            );
            break;
          }
          path.push(
            semanticStaticPropertyKey(receiver.property, receiver.computed),
          );
          receiver = unwrapJavaScriptExpression(receiver.object).node;
        }
        if (!privateRead)
          pending.push(
            reselect(
              item,
              {
                path: extendProjection(item.path, path.toReversed()),
                ownOnly: shiftedOwnSelections(item.ownOnly, path.length),
                captures:
                  item.captures === undefined
                    ? undefined
                    : [...path.map(() => node), ...item.captures],
              },
              { node: receiver },
            ),
          );
        if (captureProofs !== undefined && (privateRead || path.includes(null)))
          complete = false;
      } else if (
        t.isConditionalExpression(node) ||
        t.isLogicalExpression(node)
      ) {
        pending.push(
          {
            ...item,
            node: t.isConditionalExpression(node) ? node.consequent : node.left,
          },
          {
            ...item,
            node: t.isConditionalExpression(node) ? node.alternate : node.right,
          },
        );
      } else if (t.isSequenceExpression(node)) {
        const last = node.expressions.at(-1);
        if (last !== undefined) pending.push({ ...item, node: last });
      } else if (t.isAssignmentExpression(node, { operator: "=" })) {
        pending.push({ ...item, node: node.right });
      } else if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
        complete = false;
        // Native returned inputs and opt-in reachability are possible contents,
        // not exact return identity. Keep the original capture and projection;
        // call-result cycles close in the same selection states as alias cycles.
        const identitySources = interop
          .callReferenceSources(node, undefined)
          .flatMap((source) => (source.identity === true ? [source.node] : []));
        for (const source of [
          ...identitySources,
          ...(callResultSources?.(node) ?? []),
        ])
          pending.push({ ...item, node: source });
        const invocation = interop.intrinsicInvocation(node);
        const target = invocation?.arguments?.[0];
        if (
          invocation?.path.join(".") === "intrinsic.Reflect.construct" &&
          t.isExpression(target)
        ) {
          // Nominal intrinsic selection adds possible result contents only.
          // It cannot establish helper integrity or a strict receiver proof.
          pending.push({ ...item, node: target, instance: true });
        } else {
          pending.push({
            node: node.callee,
            path: [],
            invocation: {
              path: item.path,
              ownOnly: item.ownOnly ?? [],
              ...(item.instance === true ? { instance: true } : {}),
              ...(item.invocation === undefined
                ? {}
                : { invocation: item.invocation }),
            },
          });
        }
      } else if (t.isFunction(node) && item.instance === true) {
        // An ordinary constructor's new object is distinct from the callable.
        // Only an explicit returned value can supply a callable result here.
        for (const result of semanticCallableResultExpressions(node))
          if (result.node !== null)
            pending.push({
              node: result.node,
              path: item.path,
              ownOnly: item.ownOnly ?? [],
              ...(item.invocation === undefined
                ? {}
                : { invocation: item.invocation }),
            });
      } else if (
        t.isFunction(node) &&
        (item.path === undefined || item.path.length === 0) &&
        item.invocation !== undefined
      ) {
        for (const result of semanticCallableResultExpressions(node))
          if (result.node !== null)
            pending.push({ ...item.invocation, node: result.node });
      } else if (
        (mode === "function-values" || item.accessorRead === true) &&
        (t.isObjectMethod(node) || t.isClassMethod(node)) &&
        (node.kind === "get" || node.kind === "set")
      ) {
        // A property read selects an accessor's result, not its function.
        complete = false;
        expandsReceiver = true;
        if (node.kind === "get")
          for (const result of semanticCallableResultExpressions(node))
            if (result.node !== null)
              pending.push({
                node: result.node,
                path: item.path,
                ownOnly: item.ownOnly ?? [],
                ...(item.descriptorReceiver === undefined
                  ? {}
                  : {
                      receiverContext: {
                        owner: node,
                        receiver: item.descriptorReceiver,
                      },
                    }),
                ...(item.invocation === undefined
                  ? {}
                  : { invocation: item.invocation }),
              });
      } else if (
        mode === "accessors" &&
        (t.isObjectMethod(node) || t.isClassMethod(node)) &&
        (node.kind === "get" || node.kind === "set")
      ) {
        // Any depth can select this descriptor or project through its result.
        if (item.path === undefined || item.path.length === 0)
          retain(node, [], item.captures);
        if (
          (item.path === undefined || item.path.length > 0) &&
          node.kind === "get"
        )
          for (const result of semanticCallableResultExpressions(node))
            if (result.node !== null)
              pending.push({ ...item, node: result.node });
      } else if (
        t.isFunction(node) &&
        item.invocation === undefined &&
        (item.path === undefined ||
          item.path.length === 0 ||
          mode === "function-values")
      ) {
        if (item.path === undefined || item.path.includes(null))
          complete = false;
        if (mode !== "accessors") {
          if (item.path !== undefined) retain(node, item.path, item.captures);
          else {
            // Any depth selects the callable itself or an unknown member of it.
            retain(node, [], item.captures);
            if (mode === "function-values") retain(node, [null], item.captures);
          }
        }
        // An escaped lexical closure can expose its enclosing receiver when
        // invoked. Ordinary functions establish their own receiver instead.
        if (
          mode === "contents" &&
          thisReferences !== undefined &&
          t.isArrowFunctionExpression(node)
        )
          for (const result of semanticCallableResultExpressions(node))
            if (result.node !== null)
              pending.push({ ...item, node: result.node });
      } else if (
        t.isObjectExpression(node) &&
        (item.path === undefined ||
          item.path.length > 0 ||
          mode === "contents" ||
          includeContainerContents)
      ) {
        if (captureProofs !== undefined) {
          const key = item.path?.[0];
          const index = objectTargetIndex(node, objectTargets);
          const property =
            key == null ? undefined : index.propertyByName.get(String(key));
          const read = item.captures?.[0] ?? captureSite;
          const own =
            property !== undefined &&
            (t.isObjectProperty(property) ||
              t.isObjectMethod(property, { kind: "method" }) ||
              (mode === "accessors" && t.isObjectMethod(property))) &&
            !index.trailingUnknownsByProperty.has(property);
          const inherited =
            mode === "accessors" &&
            property === undefined &&
            index.prototype !== undefined &&
            !index.unknownProperties &&
            captureProofs.prototypeUnchanged?.(node, read) === true;
          complete &&=
            key != null &&
            (own || inherited) &&
            captureProofs.ownSlotUnchanged(node, String(key), read);
        }
        selectObjectTargets(
          node,
          item,
          pending,
          objectTargets,
          mode === "accessors",
        );
      } else if (
        t.isArrayExpression(node) &&
        (item.path === undefined ||
          item.path.length > 0 ||
          mode === "contents" ||
          includeContainerContents)
      ) {
        const [key, ...rest] = item.path ?? [];
        const path = item.path === undefined ? undefined : rest;
        const index =
          path === undefined || key === undefined || key === null
            ? null
            : semanticArrayIndex(key);
        let uncertainOffset = false;
        let selectedOwn = false;
        node.elements.forEach((element, offset) => {
          if (element === null) return;
          if (t.isSpreadElement(element)) {
            uncertainOffset = true;
            pending.push({
              ...item,
              node: element.argument,
              path: extendProjection(path, [null]),
            });
          } else if (index === null || uncertainOffset || index === offset) {
            selectedOwn ||= index === offset && !uncertainOffset;
            if (isTerminalCallableLiteral(element)) {
              complete = false;
              return;
            }
            pending.push(
              reselect(
                item,
                {
                  path,
                  ownOnly: shiftedOwnSelections(item.ownOnly, -1),
                  captures: item.captures?.slice(1),
                },
                { node: element, prototypeReceiver: undefined },
              ),
            );
          }
        });
        if (captureProofs !== undefined)
          complete &&=
            selectedOwn &&
            index !== null &&
            captureProofs.ownSlotUnchanged(
              node,
              String(index),
              item.captures?.[0] ?? captureSite,
            );
      } else if (t.isNewExpression(node)) {
        complete = false;
        pending.push({ ...item, node: node.callee, instance: true });
      } else if (t.isClass(node)) {
        const lineage = classLineage(node, state, classLineages);
        const prototype = item.path?.[0] === "prototype";
        const [key, ...rest] =
          item.path === undefined
            ? []
            : prototype
              ? item.path.slice(1)
              : item.path;
        const path = item.path === undefined ? undefined : rest;
        if (
          mode !== "function-values" ||
          item.path === undefined ||
          item.path.length !== 0 ||
          item.instance === true ||
          node.decorators?.length
        )
          complete = false;
        const value = (
          selectedNode: t.Node,
          path: Candidate["path"],
          exposesCallable = false,
        ) =>
          pending.push({
            node: selectedNode,
            path,
            ownOnly:
              path === undefined || item.path === undefined
                ? []
                : shiftedOwnSelections(
                    item.ownOnly,
                    path.length - item.path.length,
                  ),
            descriptorReceiver: item.prototypeReceiver ?? {
              node,
              ...(item.instance === true ? { instance: true } : {}),
            },
            accessorRead: exposesCallable
              ? false
              : path === undefined
                ? mode !== "accessors"
                : key !== undefined &&
                  (mode !== "accessors" || path.length > 0),
            ...(item.invocation === undefined
              ? {}
              : { invocation: item.invocation }),
          });
        if (item.path === undefined) {
          // Any depth can select the constructor, every public member and
          // whatever those members expose, including an accessor's own
          // callable through its descriptor. Private storage is never reached
          // through a public projection.
          if (mode === "function-values" && item.instance !== true)
            retain(node, []);
          for (const owner of lineage.classes) {
            const index = classTargetIndex(owner, classTargets);
            if (index.constructorMethod !== undefined)
              value(index.constructorMethod, undefined);
            for (const member of [
              ...index.static,
              ...index.prototype,
              ...index.fields,
            ]) {
              if (member.key.kind === "private" || member.value === null)
                continue;
              value(member.value, undefined);
              if (member.kind === "get" || member.kind === "set")
                value(member.value, undefined, true);
            }
          }
          if (lineage.unknownBase !== undefined)
            pending.push({ ...item, node: lineage.unknownBase });
        } else {
          const select = (layer: ClassMemberLayer): boolean => {
            for (const owner of lineage.classes) {
              const selected = selectClassTargets(
                classTargetIndex(owner, classTargets)[layer],
                key,
              );
              const values =
                mode === "accessors" && path !== undefined && path.length === 0
                  ? selected.members.flatMap((member) =>
                      member.value === null ? [] : [member.value],
                    )
                  : selected.values;
              for (const selectedValue of values) value(selectedValue, path);
              if (selected.own) return true;
            }
            return false;
          };
          if (
            mode === "function-values" &&
            item.instance !== true &&
            !prototype &&
            key === undefined
          )
            retain(node, []);
          else if (mode === "contents" && key === undefined) {
            for (const owner of lineage.classes) {
              const index = classTargetIndex(owner, classTargets);
              for (const member of [
                ...index.static,
                ...index.prototype,
                ...index.fields,
              ]) {
                if (member.key.kind === "private") continue;
                const selected = member.value;
                if (selected != null) value(selected, []);
              }
            }
          } else if (item.instance === true && !prototype) {
            const constructor = classTargetIndex(
              node,
              classTargets,
            ).constructorMethod;
            const results =
              constructor === undefined
                ? []
                : semanticCallableResultExpressions(constructor);
            for (const result of results)
              if (result.node !== null) value(result.node, item.path);
            const replaced = constructorReplacesReceiver(
              constructor,
              results,
              isDefinitelyObject,
            );
            if (!replaced && key !== undefined) {
              // Every inherited field is an own slot on the new object, so base
              // fields precede even a derived prototype method or accessor.
              if (!select("fields")) {
                select("prototype");
                if (lineage.unknownBase !== undefined)
                  pending.push({ ...item, node: lineage.unknownBase });
              }
            }
          } else if (key === undefined) {
            if (!prototype) {
              let followBaseResults = mode === "results";
              for (const owner of lineage.classes) {
                const constructor = classTargetIndex(
                  owner,
                  classTargets,
                ).constructorMethod;
                if (constructor === undefined) continue;
                value(constructor, []);
                // Invocation selects the first constructor, but normal derived
                // completion preserves the object supplied by super(). Only a
                // definite replacement can hide a possible inherited result.
                if (!followBaseResults) break;
                if (
                  constructorReplacesReceiver(
                    constructor,
                    semanticCallableResultExpressions(constructor),
                    isDefinitelyObject,
                  )
                ) {
                  followBaseResults = false;
                  break;
                }
              }
              if (followBaseResults && lineage.unknownBase !== undefined)
                pending.push({ ...item, node: lineage.unknownBase });
            }
          } else if (!select(prototype ? "prototype" : "static")) {
            if (!prototype && key === "__proto__" && node.superClass != null)
              pending.push({ ...item, node: node.superClass, path });
            else if (lineage.unknownBase !== undefined)
              pending.push({ ...item, node: lineage.unknownBase });
            if (
              mode === "function-values" &&
              !prototype &&
              !(key === "__proto__" && node.superClass != null)
            )
              retain(node, item.path);
          }
        }
      } else complete = false;
      for (let index = pending.length - 1; index >= 0; index--) {
        const child = pending[index];
        if (child !== undefined)
          enqueue(
            item.receiverContext === undefined ||
              child.receiverContext !== undefined
              ? child
              : { ...child, receiverContext: item.receiverContext },
          );
      }
    }
    const references = [...functions.values()].flatMap((paths) => [
      ...paths.values(),
    ]);
    const output: CallableReferenceSelection = {
      references,
      complete,
      precision: widened ? "widened" : "exact",
    };
    if (single !== undefined) {
      const byProjection = results.get(single) ?? new Map();
      byProjection.set(projectionKey, output);
      results.set(single, byProjection);
    }
    return output;
  };
};

/** Select callable values, accessor descriptors, or escaped contents. */
export const createSemanticCallableTargets = (
  state: JavaScriptSemanticAnalysisState,
  mode: "callable" | "contents" | "accessors" = "callable",
  isDefinitelyObject?: (node: t.Node) => boolean,
  thisReferences?: ThisReferences,
) => {
  const references = createSemanticCallableReferences(
    state,
    mode,
    isDefinitelyObject,
    undefined,
    thisReferences,
  );
  return (callee: t.Node): readonly t.Function[] =>
    references(callee).references.flatMap(({ node }) =>
      t.isFunction(node) ? [node] : [],
    );
};

/** Descriptor lookup retains accessor callables without invoking getters.
 * A supplied projection read can follow the capture of the target value. */
export const createSemanticAccessorReferences = (
  state: JavaScriptSemanticAnalysisState,
  captureProofs?: CallableCaptureProofs,
) =>
  createSemanticCallableReferences(
    state,
    "accessors",
    undefined,
    captureProofs,
  );

/** Select a callable once and leave its remaining value projection to its owner. */
export const createSemanticFunctionValueReferences = (
  state: JavaScriptSemanticAnalysisState,
  isDefinitelyObject?: (node: t.Node) => boolean,
  // Dedicated escape/construction queries may add reachability; ordinary
  // function values and exact captures must use the unextended selection.
  callResultSources?: (
    node: t.CallExpression | t.OptionalCallExpression,
  ) => readonly t.Node[],
  includeContainerContents = false,
) => {
  const references = createSemanticCallableReferences(
    state,
    "function-values",
    isDefinitelyObject,
    undefined,
    undefined,
    callResultSources,
    includeContainerContents,
  );
  return Object.assign(
    (callee: t.Node, projection?: readonly (string | number | null)[]) =>
      references(callee, projection).references,
    {
      // Only possible reachability is shared; this union grants no root-local
      // capture proof and never enters the single-root result cache.
      fromRoots: (roots: readonly t.Node[]) => references(roots).references,
    },
  );
};

/** Opt-in exact capture proof; possible-target consumers retain incomplete selections. */
export const createSemanticFunctionValueCapture = (
  state: JavaScriptSemanticAnalysisState,
  proofs: CallableCaptureProofs,
) => {
  const references = createSemanticCallableReferences(
    state,
    "function-values",
    undefined,
    proofs,
  );
  return (
    callee: t.Node,
    projection?: readonly (string | number | null)[],
  ): CallableReference | undefined => {
    const selected = references(callee, projection);
    return selected.complete && selected.references.length === 1
      ? selected.references[0]
      : undefined;
  };
};

/** Resolve local result references conservatively, without claiming call execution. */
export const createSemanticReturnedReferences = (
  state: JavaScriptSemanticAnalysisState,
  isDefinitelyObject?: (node: t.Node) => boolean,
  captureProofs?: CallableCaptureProofs,
): ((callee: t.Node) => SemanticReturnedReferenceSelection) => {
  const targets = createSemanticCallableReferences(
    state,
    "results",
    isDefinitelyObject,
  );
  // Possible targets remain useful to escapes even when their identity cannot
  // be proved. Result coverage additionally requires every selected binding
  // and own property to retain the callable captured at this read.
  const capturedTargets = createSemanticCallableReferences(
    state,
    "results",
    isDefinitelyObject,
    captureProofs ?? {
      bindingReadMayHaveChanged: () => true,
      ownSlotUnchanged: () => false,
    },
  );
  const completions = new WeakMap<
    t.Node,
    ReturnType<typeof semanticCallableResultCompletion>
  >();
  const completion = (callable: t.Node) => {
    let result = completions.get(callable);
    if (result === undefined) {
      result = semanticCallableResultCompletion(callable);
      completions.set(callable, result);
    }
    return result;
  };
  let results = new WeakMap<t.Node, SemanticReturnedReferenceSelection>();
  let factsReady = semanticFreshObjectFactsReady(state);
  let slotsReady = semanticAmbientOwnSlotFactsReady(state);
  return (callee) => {
    const ready = semanticFreshObjectFactsReady(state);
    const ownSlotsReady = semanticAmbientOwnSlotFactsReady(state);
    if (factsReady !== ready || slotsReady !== ownSlotsReady) {
      factsReady = ready;
      slotsReady = ownSlotsReady;
      results = new WeakMap();
    }
    const prior = results.get(callee);
    if (prior !== undefined) return prior;
    const selected = targets(callee);
    const references = selected.references.flatMap(({ node: callable }) =>
      completion(callable).expressions.flatMap(({ node, delegated }) =>
        node === null
          ? []
          : [
              {
                node,
                projection: delegated ? [null] : [],
                ...(t.isFunction(callable) &&
                !callable.async &&
                !callable.generator
                  ? { synchronousOwner: callable }
                  : {}),
              },
            ],
      ),
    );
    const output: SemanticReturnedReferenceSelection = {
      references,
      complete:
        selected.complete &&
        capturedTargets(callee).complete &&
        selected.references.every(
          ({ node, projection }) =>
            projection.length === 0 && completion(node).complete,
        ),
      precision: selected.precision,
    };
    if (selected.precision === "widened")
      state.returnedReferenceWidenings.add(callee);
    results.set(callee, output);
    return output;
  };
};

const selectObjectTargets = (
  node: t.ObjectExpression,
  item: Candidate,
  pending: Candidate[],
  indexes: WeakMap<t.ObjectExpression, ObjectTargetIndex>,
  accessors: boolean,
): void => {
  const [key, ...rest] = item.path ?? [];
  const path = item.path === undefined ? undefined : rest;
  const index = objectTargetIndex(node, indexes);
  const selection = {
    path,
    ownOnly: shiftedOwnSelections(item.ownOnly, -1),
    captures: item.captures?.slice(1),
  };
  // Any depth can read an accessor's result; a final descriptor lookup keeps
  // the accessor callable itself.
  const selected: Partial<Candidate> = {
    descriptorReceiver: item.prototypeReceiver ?? { node },
    prototypeReceiver: undefined,
    accessorRead:
      item.path === undefined
        ? !accessors
        : item.ownOnly?.includes(0) === true ||
          (key !== undefined && !accessors),
  };
  const select = (value: t.Node) => {
    pending.push(reselect(item, selection, { ...selected, node: value }));
    // Any depth includes the whole object, whose escape exposes an accessor
    // callable through its descriptor; a known key only reads through it.
    if (
      item.path === undefined &&
      !accessors &&
      t.isObjectMethod(value) &&
      value.kind !== "method"
    )
      pending.push(
        reselect(item, selection, {
          ...selected,
          node: value,
          accessorRead: false,
        }),
      );
  };
  // Spread reads only own properties of its source at the first offset.
  const spread = (argument: t.Node) =>
    pending.push(
      reselect(
        item,
        {
          path: item.path,
          ownOnly: [...new Set([0, ...(item.ownOnly ?? [])])],
          captures: item.captures,
        },
        { node: argument, prototypeReceiver: undefined },
      ),
    );
  if (key !== null && key !== undefined) {
    const property = index.propertyByName.get(String(key));
    if (property !== undefined) {
      // A final data descriptor has no accessor callable. Its stored value is
      // a different selection, even when that value is itself a function.
      if (
        accessors &&
        path !== undefined &&
        path.length === 0 &&
        !index.trailingUnknownsByProperty.has(property) &&
        (t.isObjectProperty(property) ||
          t.isObjectMethod(property, { kind: "method" }))
      )
        return;
      const unknowns: ObjectTargetUnknown[] = [];
      for (
        let unknown = index.trailingUnknownsByProperty.get(property);
        unknown !== undefined;
        unknown = unknown.previous
      )
        unknowns.push(unknown);
      for (const { node: unknown } of unknowns.reverse())
        if (t.isSpreadElement(unknown)) spread(unknown.argument);
        else select(t.isObjectProperty(unknown) ? unknown.value : unknown);
      select(t.isObjectProperty(property) ? property.value : property);
      const paired = t.isObjectMethod(property)
        ? index.pairedAccessors.get(property)
        : undefined;
      if (paired !== undefined) select(paired);
      return;
    }
  }
  let replaced = false;
  for (const property of [...node.properties].reverse()) {
    if (replaced) break;
    if (property === index.prototype) continue;
    if (t.isSpreadElement(property)) {
      spread(property.argument);
      continue;
    }
    const name = semanticStaticPropertyKey(property.key, property.computed);
    if (
      key !== null &&
      key !== undefined &&
      name !== null &&
      name !== String(key)
    )
      continue;
    select(t.isObjectProperty(property) ? property.value : property);
    if (key !== null && key !== undefined && name === String(key))
      replaced = true;
  }
  if (
    !replaced &&
    !item.ownOnly?.includes(0) &&
    index.prototype !== undefined
  ) {
    // The inherited __proto__ accessor can expose the prototype object itself.
    // Keep ordinary prototype lookup too: an intervening descriptor may
    // override that accessor and return a different value.
    if (key === "__proto__") select(index.prototype.value);
    pending.push({
      ...item,
      node: index.prototype.value,
      prototypeReceiver: item.prototypeReceiver ?? { node },
    });
  }
};

const objectTargetIndex = (
  node: t.ObjectExpression,
  indexes: WeakMap<t.ObjectExpression, ObjectTargetIndex>,
): ObjectTargetIndex => {
  const existing = indexes.get(node);
  if (existing !== undefined) return existing;
  const prototype = semanticObjectPrototypeProperty(node);
  const propertyByName = new Map<string, t.ObjectMethod | t.ObjectProperty>();
  const trailingUnknownsByProperty = new Map<
    t.ObjectMethod | t.ObjectProperty,
    ObjectTargetUnknown
  >();
  const pairedAccessors = new Map<t.ObjectMethod, t.ObjectMethod>();
  const pendingPairs = new Map<string, t.ObjectMethod>();
  let trailingUnknown: ObjectTargetUnknown | undefined;
  for (const property of [...node.properties].reverse()) {
    if (property === prototype) continue;
    if (t.isSpreadElement(property)) {
      trailingUnknown = { node: property, previous: trailingUnknown };
      continue;
    }
    const name = semanticStaticPropertyKey(property.key, property.computed);
    if (name === null) {
      trailingUnknown = { node: property, previous: trailingUnknown };
      continue;
    }
    if (propertyByName.has(name)) {
      const later = pendingPairs.get(name);
      if (later !== undefined) {
        if (!t.isObjectMethod(property) || property.kind === "method")
          pendingPairs.delete(name);
        else if (property.kind !== later.kind) {
          pairedAccessors.set(later, property);
          pendingPairs.delete(name);
        }
      }
      continue;
    }
    propertyByName.set(name, property);
    if (t.isObjectMethod(property) && property.kind !== "method")
      pendingPairs.set(name, property);
    if (trailingUnknown !== undefined)
      trailingUnknownsByProperty.set(property, trailingUnknown);
  }
  const created = {
    prototype,
    unknownProperties: trailingUnknown !== undefined,
    propertyByName,
    trailingUnknownsByProperty,
    pairedAccessors,
  };
  indexes.set(node, created);
  return created;
};
