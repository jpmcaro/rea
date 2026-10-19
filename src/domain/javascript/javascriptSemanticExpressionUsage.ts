import * as t from "@babel/types";

/** Immediate value consumption only: discarding a result does not erase its
 * evaluation effects, including computed keys, getters and nested calls. */
export const semanticExpressionValueDiscarded = (
  node: t.Node,
  parent: t.Node | null | undefined,
): boolean =>
  (t.isSequenceExpression(parent) && parent.expressions.at(-1) !== node) ||
  (t.isConditionalExpression(parent) && parent.test === node) ||
  (t.isExpressionStatement(parent) && parent.expression === node) ||
  (t.isUnaryExpression(parent) &&
    ["void", "typeof", "!"].includes(parent.operator)) ||
  ((t.isIfStatement(parent) ||
    t.isWhileStatement(parent) ||
    t.isDoWhileStatement(parent)) &&
    parent.test === node) ||
  (t.isForStatement(parent) &&
    (parent.init === node || parent.test === node || parent.update === node));
