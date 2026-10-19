import * as t from "@babel/types";

import type { JavaScriptIntrinsicInvocation } from "./javascriptElectronMemberWrites.js";
import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";

/**
 * Expand literal array spreads into positional arguments only when the caller
 * has established that array iteration is intact for this source. Spreading
 * runs the array iterator, which earlier source may replace through
 * `Array.prototype[Symbol.iterator]` or the shared array iterator prototype,
 * so the syntactic elements are otherwise not proof of the values the call
 * receives. A remaining spread element is an unknown argument list.
 */
export const expandJavaScriptInvocationArguments = (
  arguments_: readonly t.CallExpression["arguments"][number][],
  expandSpreads: boolean,
): t.CallExpression["arguments"] => {
  if (!expandSpreads) return [...arguments_];
  const expanded: t.CallExpression["arguments"] = [];
  const pending = [...arguments_].reverse();
  while (pending.length > 0) {
    const argument = pending.pop();
    if (argument === undefined) break;
    const array = t.isSpreadElement(argument)
      ? unwrapJavaScriptExpression(argument.argument).node
      : undefined;
    if (
      t.isArrayExpression(array) &&
      array.elements.every(
        (element) => t.isExpression(element) || t.isSpreadElement(element),
      )
    )
      for (let index = array.elements.length - 1; index >= 0; index -= 1) {
        const element = array.elements[index];
        if (element !== null && element !== undefined) pending.push(element);
      }
    else expanded.push(argument);
  }
  return expanded;
};

/** `apply` reads its array argument by index; holes and spreads stay unknown. */
const arrayArguments = (node: t.Node | undefined, expandSpreads: boolean) => {
  const array =
    node === undefined ? undefined : unwrapJavaScriptExpression(node).node;
  if (
    !t.isArrayExpression(array) ||
    array.elements.some((element) => element === null)
  )
    return undefined;
  const expanded = expandJavaScriptInvocationArguments(
    array.elements.filter(
      (element): element is t.Expression | t.SpreadElement => element !== null,
    ),
    expandSpreads,
  );
  return expanded.every((element) => t.isExpression(element))
    ? expanded.filter((element): element is t.Expression =>
        t.isExpression(element),
      )
    : undefined;
};

const invocationArguments = (
  method: "call" | "apply",
  arguments_: JavaScriptIntrinsicInvocation["arguments"],
  expandSpreads: boolean,
) =>
  t.isSpreadElement(arguments_?.[0])
    ? undefined
    : method === "apply"
      ? arrayArguments(arguments_?.[1], expandSpreads)
      : arguments_?.slice(1);

/** A helper selection retains its physical bound owner and every member read. */
export interface JavaScriptBoundHelperRead {
  readonly value: NonNullable<JavaScriptIntrinsicInvocation["boundFunction"]>;
  readonly projection: readonly string[];
}

/**
 * Normalize known invocation syntax once, retaining bound argument prefixes.
 * Binding a function alone is not a write; only its eventual call is examined.
 */
export const resolveJavaScriptIntrinsicInvocation = (
  node:
    | t.CallExpression
    | t.OptionalCallExpression
    | t.TaggedTemplateExpression,
  intrinsicPath: (node: t.Node) => readonly string[] | undefined,
  boundIntrinsic: (node: t.Node) => JavaScriptIntrinsicInvocation | undefined,
  intrinsicReadChanged: (
    node: t.Node,
    path: readonly string[],
    boundHelper?: JavaScriptBoundHelperRead,
  ) => boolean,
  /** Whether literal array spreads may be expanded; see the expansion helper. */
  expandSpreads = false,
): JavaScriptIntrinsicInvocation | undefined => {
  const visited = new Set<t.Node>();
  let callee: t.Node = t.isTaggedTemplateExpression(node)
    ? node.tag
    : node.callee;
  let arguments_: JavaScriptIntrinsicInvocation["arguments"] =
    // The template object is a runtime allocation, not a source expression.
    // Retain its callable/receiver without inventing positional argument facts.
    t.isTaggedTemplateExpression(node)
      ? undefined
      : expandJavaScriptInvocationArguments(node.arguments, expandSpreads);
  let receiver: t.Node | undefined;
  const callableReads: t.Node[] = [];
  let explicitReceiver = false;
  for (;;) {
    callee = unwrapJavaScriptExpression(callee).node;
    if (t.isSequenceExpression(callee)) {
      const finalExpression = callee.expressions.at(-1);
      if (finalExpression === undefined) return undefined;
      // The comma operator returns the final value without its member receiver.
      // Keep that lost receiver explicit so intrinsic call/apply stays unknown.
      explicitReceiver = true;
      callee = finalExpression;
      continue;
    }
    if (visited.has(callee)) return undefined;
    visited.add(callee);
    let path = intrinsicPath(callee);
    if (path !== undefined && intrinsicReadChanged(callee, path))
      // Callable identity uncertainty does not change the receiver selected by
      // an ordinary member call or by an already-proven invocation helper.
      return {
        kind: "opaque",
        path,
        arguments: undefined,
        ...(callableReads.length === 0 ? {} : { callableReads }),
        ...(receiver === undefined ? {} : { receiver }),
        ...(!explicitReceiver &&
        (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee))
          ? { memberReceiver: callee.object }
          : {}),
      };
    if (path === undefined) {
      let helperTarget: t.Node = callee;
      const helpers: string[] = [];
      while (
        t.isMemberExpression(helperTarget) ||
        t.isOptionalMemberExpression(helperTarget)
      ) {
        const method = semanticStaticPropertyKey(
          helperTarget.property,
          helperTarget.computed,
        );
        if (method !== "call" && method !== "apply" && method !== "bind") break;
        helpers.push(method);
        helperTarget = unwrapJavaScriptExpression(helperTarget.object).node;
      }
      if (helpers.length > 0) {
        helpers.reverse();
        const bound = boundIntrinsic(helperTarget);
        if (bound !== undefined) {
          if (
            bound.kind === "opaque" ||
            bound.boundFunction === undefined ||
            intrinsicReadChanged(callee, [...bound.path, ...helpers], {
              value: bound.boundFunction,
              projection: helpers,
            })
          )
            return { kind: "opaque", path: bound.path, arguments: undefined };
          // After proving the whole selection, normalize the selected generic
          // helper with its actual receiver, just like an unbound helper value.
          path = ["intrinsic", "Function", "prototype", ...helpers];
        }
      }
    }
    if (path === undefined) {
      const bound = boundIntrinsic(callee);
      if (bound === undefined) return undefined;
      if (bound.kind === "opaque") return bound;
      callableReads.push(...(bound.callableReads ?? []));
      path = bound.path;
      receiver = bound.receiver;
      explicitReceiver = true;
      arguments_ =
        bound.arguments === undefined
          ? undefined
          : [...bound.arguments, ...(arguments_ ?? [])];
    }
    const method = path.length > 3 ? path.at(-1) : undefined;
    if (method === "call" || method === "apply") {
      // These properties hold generic function values. Their receiver selects
      // the callable; property-chain depth does not consume more arguments.
      const callable: t.Node | undefined = explicitReceiver
        ? receiver
        : t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)
          ? callee.object
          : undefined;
      if (!t.isExpression(callable))
        return { kind: "opaque", path, arguments: undefined };
      callee = callable;
      receiver = arguments_?.[0];
      explicitReceiver = true;
      arguments_ = invocationArguments(method, arguments_, expandSpreads);
      continue;
    }
    if (path.join(".") === "intrinsic.Reflect.apply") {
      const callable = arguments_?.[0];
      if (!t.isExpression(callable)) return undefined;
      callee = callable;
      receiver = arguments_?.[1];
      explicitReceiver = true;
      arguments_ = arrayArguments(arguments_?.[2], expandSpreads);
      continue;
    }
    const memberReceiver =
      !explicitReceiver &&
      (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee))
        ? callee.object
        : undefined;
    return {
      kind: "known",
      path,
      arguments: arguments_,
      ...(callableReads.length === 0 ? {} : { callableReads }),
      ...(receiver === undefined ? {} : { receiver }),
      ...(memberReceiver === undefined ? {} : { memberReceiver }),
    };
  }
};
