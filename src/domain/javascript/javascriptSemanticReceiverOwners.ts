import * as t from "@babel/types";

import { semanticObjectPrototypeProperty } from "./javascriptAstValues.js";
import type {
  JavaScriptSemanticAnalysisState,
  JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import { delayedInstanceFieldValue } from "./javascriptSemanticEvaluationOrder.js";

/** The nearest function evaluating a read, including arrows. Method keys and
 * decorators execute outside that function; instance fields are deferred. */
export const createSemanticFunctionEvaluationOwner = (
  state: JavaScriptSemanticAnalysisState,
) => {
  const owners = new WeakMap<t.Node, t.Function | null>();
  return (node: t.Node): t.Function | undefined => {
    const visited: t.Node[] = [];
    let current: t.Node | undefined = node;
    let owner: t.Function | null = null;
    while (current !== undefined) {
      const prior = owners.get(current);
      if (prior !== undefined) {
        owner = prior;
        break;
      }
      visited.push(current);
      const parent = state.parentsByNode.get(current);
      if (delayedInstanceFieldValue(parent, current)) break;
      if (
        t.isFunction(parent) &&
        (parent.body === current ||
          parent.params.some((parameter) => parameter === current))
      ) {
        owner = parent;
        break;
      }
      current = parent;
    }
    for (const visitedNode of visited) owners.set(visitedNode, owner);
    return owner ?? undefined;
  };
};

/** An outer binding may retain a value from an earlier activation, even when
 * its assignment expression belongs to the currently invoked function. */
export const semanticBindingIsFunctionLocal = (
  binding: JavaScriptSemanticBindingState,
  owner: t.Function,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const ownerScope = state.scopeByNode.get(owner);
  if (ownerScope === undefined) return false;
  let scope = state.scopesById.get(binding.scopeId);
  while (scope !== undefined) {
    if (scope === ownerScope) return true;
    scope =
      scope.parentScopeId === null
        ? undefined
        : state.scopesById.get(scope.parentScopeId);
  }
  return false;
};

/** Arrows inherit this and super; computed keys and decorators execute outside
 * the method or class whose declaration contains them. */
export const createSemanticLexicalReceiverOwner = (
  state: JavaScriptSemanticAnalysisState,
) => {
  const owners = new WeakMap<t.Node, t.Node>();
  return (node: t.Node): t.Node => {
    const visited: t.Node[] = [];
    let current = node;
    let owner: t.Node = state.program;
    for (;;) {
      const cached = owners.get(current);
      if (cached !== undefined) {
        owner = cached;
        break;
      }
      visited.push(current);
      let parent = state.parentsByNode.get(current);
      if (parent === undefined) break;
      if (t.isDecorator(current)) {
        while (
          parent !== undefined &&
          !t.isFunction(parent) &&
          !t.isClass(parent) &&
          !t.isClassProperty(parent) &&
          !t.isClassPrivateProperty(parent) &&
          !t.isClassAccessorProperty(parent)
        )
          parent = state.parentsByNode.get(parent);
        current = parent ?? state.program;
        continue;
      }
      if (
        (t.isFunction(parent) &&
          !t.isArrowFunctionExpression(parent) &&
          !(
            (t.isObjectMethod(parent) || t.isClassMethod(parent)) &&
            parent.computed &&
            parent.key === current
          )) ||
        t.isStaticBlock(parent) ||
        ((t.isClassProperty(parent) ||
          t.isClassPrivateProperty(parent) ||
          t.isClassAccessorProperty(parent)) &&
          parent.value === current)
      ) {
        owner = parent;
        break;
      }
      current = parent;
    }
    for (const visitedNode of visited) owners.set(visitedNode, owner);
    return owner;
  };
};

/** The home is lexical; its declared base is only a possible source lookup.
 * Consumers with mutation facts select the home's physical prototype instead.
 * The invocation keeps the lexical receiver independently. */
export const createSemanticSuperLookup = (
  state: JavaScriptSemanticAnalysisState,
) => {
  const lexicalOwner = createSemanticLexicalReceiverOwner(state);
  return (node: t.Super) => {
    const owner = lexicalOwner(node);
    const parent = state.parentsByNode.get(owner);
    if (t.isObjectMethod(owner) && t.isObjectExpression(parent)) {
      const prototype = semanticObjectPrototypeProperty(parent);
      return { owner, home: parent, base: prototype?.value, projection: [] };
    }
    const home =
      parent === undefined ? undefined : state.parentsByNode.get(parent);
    if (!t.isClass(home)) return undefined;
    const isStatic =
      t.isStaticBlock(owner) || ("static" in owner && owner.static);
    return {
      owner,
      home,
      base: home.superClass ?? undefined,
      projection: isStatic ? [] : ["prototype"],
    };
  };
};
