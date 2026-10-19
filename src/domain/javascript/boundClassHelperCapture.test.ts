import * as t from "@babel/types";
import { expect, it } from "vitest";

import {
  createSemanticModuleInterop,
  semanticFreshObjectFactsReady,
} from "./javascriptModuleInterop.js";
import { indexJavaScriptBindingsWithReceiversSteps } from "./javascriptSemanticAnalysis.js";
import { semanticAmbientOwnSlotUnchanged } from "./javascriptSemanticAmbientWrites.js";
import { semanticGlobalBindingReadMayHaveChanged } from "./javascriptSemanticOpaqueEffects.js";
import { createSemanticFunctionValueCapture } from "./javascriptSemanticReturnedReferences.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const boundClassCapture = (source: string) => {
  const parsed = parseJavaScriptSource(source, "bundle.js");
  if (parsed === null) throw new Error("Expected class source");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  );
  completeSemanticSteps(index.indexAmbientWritesSteps());
  const state = index.bindings;
  const nominal = createSemanticModuleInterop(state);
  const capture = createSemanticFunctionValueCapture(state, {
    bindingReadMayHaveChanged: () => false,
    ownSlotUnchanged: (owner, key, read) =>
      semanticAmbientOwnSlotUnchanged(state, owner, key, read),
  });
  const sourcePath = (node: t.Node): readonly string[] | undefined => {
    if (t.isIdentifier(node, { name: "C" }))
      return ["intrinsic", "source-constructor", "C"];
    if (
      t.isMemberExpression(node) &&
      !node.computed &&
      t.isIdentifier(node.property)
    ) {
      const owner = sourcePath(node.object);
      if (owner !== undefined) return [...owner, node.property.name];
    }
    return nominal.intrinsicPath(node);
  };
  const facts = {
    ambientWrites: state.ambientWrites,
    ambientWriteEffects: state.ambientWriteEffects,
    opaqueGlobalSites: state.opaqueEffects.globalSites,
    complete: true,
  };
  const interop = createSemanticModuleInterop(state, {
    intrinsicPath: sourcePath,
    boundFunctionWriteFacts: facts,
    sourceFunctionCapture: capture,
  });
  const statement = parsed.program.body.at(-1);
  const allocation = t.isExpressionStatement(statement)
    ? statement.expression
    : undefined;
  if (!t.isNewExpression(allocation)) throw new Error("Expected new Bound()");
  const bound = interop.boundIntrinsic(allocation.callee, facts, true);
  const binding = bound?.boundFunction?.allocations[0];
  return {
    kind: bound?.kind,
    nonEscaping:
      binding !== undefined &&
      interop.nonEscapingBoundTarget(binding, facts) ===
        bound?.boundFunction?.allocationTargets[0],
  };
};

it.each([
  "class B{}class C extends B{}const Bound=C.bind(null);new Bound();",
  "class B{}class C extends B{}const Bound=C.bind(null);B.bind=other;new Bound();",
  "class B{}class C extends B{}const Bound=C.bind(null);Object.setPrototypeOf(C,other);new Bound();",
  "class B{}class C extends B{}C.bind=other;const Bound=Function.prototype.bind.call(C,null);new Bound();",
  "class B{static bind=other}class C extends B{}const Bound=Function.prototype.bind.call(C,null);new Bound();",
  "class B{}let C=class extends B{};const Bound=C.bind(null);C=other;new Bound();",
  "class B{}class C extends B{}B=other;const Bound=C.bind(null);new Bound();",
  "class B{}class C extends B{static get __proto__(){return {bind:other}}}const Bound=C.bind(null);new Bound();",
  "class B{}class C extends B{static get __proto__(){return {bind:other}}}const Bound=C.bind(null).bind(null);new Bound();",
  "class B{static get __proto__(){return {bind:other}}}class C extends B{}const Bound=C.bind(null);new Bound();",
])(
  "captures a class independently of later or bypassed helpers: %s",
  (source) => {
    expect(boundClassCapture(source).kind).toBe("known");
  },
);

it.each([
  "class B{}class C extends B{}B.bind=other;const Bound=C.bind(null);new Bound();",
  "class B{}const savedB=B;class C extends B{}B=other;savedB.bind=other;const Bound=C.bind(null);new Bound();",
  "class B{}class C extends B{}C.bind=other;const Bound=C.bind(null);new Bound();",
  "class B{static bind=other}class C extends B{}const Bound=C.bind(null);new Bound();",
  "class B{static bind(){}}class C extends B{}const Bound=C.bind(null);new Bound();",
  "class B{static get bind(){return other}}class C extends B{}const Bound=C.bind(null);new Bound();",
  "class B{}class C extends B{}Object.setPrototypeOf(B,other);const Bound=C.bind(null);new Bound();",
  "class C extends unknown{}const Bound=C.bind(null);new Bound();",
  "class B{}class C extends B{static get __proto__(){return {bind:other}}}const Bound=C.__proto__.bind(null);new Bound();",
  "class B{static get __proto__(){return {bind:other}}}class C extends B{}const Bound=C.__proto__.bind(null);new Bound();",
  "class A{static get ['__proto__'](){return {bind:other}}}class B extends A{}class C extends B{}const Bound=C.__proto__.bind(null);new Bound();",
])("rejects an unproven inherited class helper: %s", (source) => {
  expect(boundClassCapture(source).kind).not.toBe("known");
});

it.each([
  "class B{}class C extends B{}const Bound=C.bind(null);new Bound();",
  "class B{}class C extends B{}const Bound=C.bind(null);Object.defineProperty(C,'name',{get(){return other}});new Bound();",
  "class B{}class C extends B{}const Bound=C.bind(null).bind(null);new Bound();",
])("keeps initial class bind metadata reads local: %s", (source) => {
  expect(boundClassCapture(source).nonEscaping).toBe(true);
});

it.each([
  "class B{}class C extends B{static get name(){return other}}const Bound=C.bind(null);new Bound();",
  "class B{}class C extends B{static get length(){return other}}const Bound=C.bind(null);new Bound();",
  "class B{}class C extends B{}Object.defineProperty(C,'name',{get(){return other}});const Bound=C.bind(null);new Bound();",
  "class B{}class C extends B{}Object.defineProperty(C,'length',{get(){return other}});const Bound=C.bind(null);new Bound();",
  "class B{}class C extends B{}const Inner=C.bind(null);Object.defineProperty(Inner,'name',{get(){return other}});const Bound=Inner.bind(null);new Bound();",
])("retains possible bind metadata accessor effects: %s", (source) => {
  expect(boundClassCapture(source).nonEscaping).toBe(false);
});

it("refreshes class ancestry after source facts complete", () => {
  const parsed = parseJavaScriptSource(
    "class B{};(class extends B{}).bind(null);",
    "bundle.js",
  )!;
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  );
  const state = index.bindings;
  const facts = {
    ambientWrites: state.ambientWrites,
    ambientWriteEffects: state.ambientWriteEffects,
    opaqueGlobalSites: state.opaqueEffects.globalSites,
    get complete() {
      return semanticFreshObjectFactsReady(state);
    },
  };
  const nominal = createSemanticModuleInterop(state);
  const capture = createSemanticFunctionValueCapture(state, {
    bindingReadMayHaveChanged: (binding, read) =>
      !facts.complete ||
      semanticGlobalBindingReadMayHaveChanged(binding, read, state, facts),
    ownSlotUnchanged: (owner, key, read) =>
      semanticAmbientOwnSlotUnchanged(state, owner, key, read),
  });
  const sourcePath = (node: t.Node): readonly string[] | undefined => {
    if (t.isClass(node)) return ["intrinsic", "source-constructor", "C"];
    if (
      t.isMemberExpression(node) &&
      !node.computed &&
      t.isIdentifier(node.property)
    ) {
      const owner = sourcePath(node.object);
      if (owner !== undefined) return [...owner, node.property.name];
    }
    return nominal.intrinsicPath(node);
  };
  const interop = createSemanticModuleInterop(state, {
    intrinsicPath: sourcePath,
    boundFunctionWriteFacts: facts,
    sourceFunctionCapture: capture,
  });
  const last = parsed.program.body.at(-1);
  if (!t.isExpressionStatement(last)) throw new Error("Expected bind call");
  expect(interop.boundIntrinsic(last.expression, facts, true)?.kind).not.toBe(
    "known",
  );
  completeSemanticSteps(index.indexAmbientWritesSteps());
  const fresh = createSemanticModuleInterop(state, {
    intrinsicPath: sourcePath,
    boundFunctionWriteFacts: facts,
    sourceFunctionCapture: capture,
  });
  expect(fresh.boundIntrinsic(last.expression, facts, true)?.kind).toBe(
    "known",
  );
  expect(interop.boundIntrinsic(last.expression, facts, true)?.kind).toBe(
    "known",
  );
});
