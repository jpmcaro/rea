import * as t from "@babel/types";

import { childNodes } from "./javascriptSemanticTraversal.js";

/** One direct return or yield, excluding every nested callable. */
export interface SemanticCallableResultExpression {
  readonly node: t.Node | null;
  readonly site: t.Node;
  readonly kind: "return" | "yield";
  readonly delegated: boolean;
}

/** Collect direct result syntax without executing or evaluating a callable. */
export const semanticCallableResultExpressions = (
  callable: t.Node,
): readonly SemanticCallableResultExpression[] => {
  if (
    t.isArrowFunctionExpression(callable) &&
    !t.isBlockStatement(callable.body)
  )
    return [
      {
        node: callable.body,
        site: callable.body,
        kind: "return",
        delegated: false,
      },
    ];
  if (!t.isFunction(callable)) return [];
  const output: SemanticCallableResultExpression[] = [];
  const pending = childNodes(callable.body).reverse();
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined || t.isFunction(node) || t.isClass(node)) continue;
    if (t.isReturnStatement(node)) {
      output.push({
        node: node.argument ?? null,
        site: node,
        kind: "return",
        delegated: false,
      });
    }
    if (t.isYieldExpression(node))
      output.push({
        node: node.argument ?? null,
        site: node,
        kind: "yield",
        delegated: node.delegate,
      });
    for (const child of childNodes(node).reverse()) pending.push(child);
  }
  return output;
};

const NORMAL = 1;
const VALUE = 2;
const UNDEFINED = 4;
const THROW = 8;
const LOOP_TRANSFER = 16;
const UNKNOWN = 32;

const completionChildren = (node: t.Statement): readonly t.Statement[] => {
  if (t.isBlockStatement(node)) return node.body;
  if (t.isIfStatement(node))
    return [
      node.consequent,
      ...(node.alternate == null ? [] : [node.alternate]),
    ];
  if (t.isTryStatement(node))
    return [
      node.block,
      ...(node.handler == null ? [] : [node.handler.body]),
      ...(node.finalizer == null ? [] : [node.finalizer]),
    ];
  return t.isLoop(node) ? [node.body] : [];
};

const leafCompletion = (node: t.Statement): number => {
  if (t.isReturnStatement(node))
    return node.argument == null ? UNDEFINED : VALUE;
  if (t.isThrowStatement(node)) return THROW;
  if (t.isBreakStatement(node) || t.isContinueStatement(node))
    return node.label == null ? LOOP_TRANSFER : UNKNOWN;
  if (
    t.isExpressionStatement(node) ||
    t.isVariableDeclaration(node) ||
    t.isFunctionDeclaration(node) ||
    t.isClassDeclaration(node) ||
    t.isEmptyStatement(node) ||
    t.isDebuggerStatement(node)
  )
    return NORMAL;
  return NORMAL | UNKNOWN;
};

const statementCompletion = (
  node: t.Statement,
  result: (node: t.Node | null | undefined) => number,
): number => {
  if (t.isBlockStatement(node)) {
    let completion = NORMAL;
    for (const statement of node.body) {
      if ((completion & NORMAL) === 0) break;
      completion = (completion & ~NORMAL) | result(statement);
    }
    return completion;
  }
  if (t.isIfStatement(node))
    return result(node.consequent) | result(node.alternate);
  if (t.isLoop(node)) return NORMAL | (result(node.body) & ~LOOP_TRANSFER);
  if (t.isTryStatement(node)) {
    // Any expression may throw: include catch outcomes without pretending to
    // prove which operations throw or which exception reaches the handler.
    let completion = result(node.block);
    if (node.handler != null) completion |= result(node.handler.body);
    if (node.finalizer != null) {
      const finalizer = result(node.finalizer);
      completion =
        (finalizer & ~NORMAL) | ((finalizer & NORMAL) === 0 ? 0 : completion);
    }
    return completion;
  }
  return leafCompletion(node);
};

/** Whether direct result expressions cover every normal call result. Bare
 * returns and fallthrough produce undefined, which has no source expression.
 * Unsupported control flow remains unknown; loops may always finish normally.
 * This proves coverage only, never execution or the identity of an expression. */
const callableResultsComplete = (callable: t.Node): boolean => {
  if (!t.isFunction(callable) || callable.async || callable.generator)
    return false;
  if (!t.isBlockStatement(callable.body)) return true;
  const outcomes = new Map<t.Node, number>();
  const pending: { node: t.Statement; finish: boolean }[] = [
    { node: callable.body, finish: false },
  ];
  const result = (node: t.Node | null | undefined): number =>
    node == null ? NORMAL : (outcomes.get(node) ?? UNKNOWN);
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    const { node, finish } = current;
    if (finish) outcomes.set(node, statementCompletion(node, result));
    else {
      pending.push({ node, finish: true });
      for (const child of completionChildren(node))
        pending.push({ node: child, finish: false });
    }
  }
  return (result(callable.body) & ~(VALUE | THROW)) === 0;
};

/** Possible result syntax with a separate proof that it covers normal results. */
export const semanticCallableResultCompletion = (
  callable: t.Node,
): {
  readonly expressions: readonly SemanticCallableResultExpression[];
  readonly complete: boolean;
} => ({
  expressions: semanticCallableResultExpressions(callable),
  complete: callableResultsComplete(callable),
});
