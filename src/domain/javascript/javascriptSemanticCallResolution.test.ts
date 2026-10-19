import * as t from "@babel/types";
import { expect, it, vi } from "vitest";

import {
  indexJavaScriptBindingsSteps,
  indexJavaScriptBindingsWithReceiversSteps,
} from "./javascriptSemanticAnalysis.js";
import {
  resolveLocalCallables,
  type LocalCallableResolution,
} from "./javascriptSemanticCallResolution.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { createSemanticReturnedReferences } from "./javascriptSemanticReturnedReferences.js";
import { semanticCallableResultCompletion } from "./javascriptSemanticCallableResults.js";
import {
  indexJavaScriptAmbientWritesSteps,
  semanticAmbientOwnSlotFactsReady,
  semanticAmbientOwnSlotUnchanged,
} from "./javascriptSemanticAmbientWrites.js";
import { semanticFreshObjectFactsReady } from "./javascriptModuleInterop.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import {
  completeSemanticSteps,
  traverseJavaScriptAst,
} from "./javascriptSemanticTraversal.js";

const indexed = (source: string) => {
  const parsed = parseJavaScriptSource(source, "callback.js");
  if (parsed === null) throw new Error("Expected valid callback fixture");
  const steps = indexJavaScriptBindingsSteps(parsed.program);
  let step = steps.next();
  while (step.done !== true) step = steps.next();
  const state = step.value;
  const callableById = new Map(
    state.callables.map((callable) => [callable.callableId, callable]),
  );
  const bindingCache = new WeakMap<t.Identifier, LocalCallableResolution>();
  return {
    state,
    callableById,
    bindingCache,
    resolve: (node: t.Node) =>
      resolveLocalCallables({
        node,
        state,
        callableById,
        bindingCache,
        seenInitializers: new Set(),
      }),
  };
};

it("bounds shared partial callback alias expansion by AST size", () => {
  const measure = (depth: number) => {
    const context =
      indexed(`function fallback(){return {member:1};} function choose(cb,flag){
      if(flag)cb=fallback;
      const a0=cb;
      ${Array.from({ length: depth }, (_, i) => `const a${i + 1}=flag?a${i}:a${i};`).join("")}
      return a${depth}();
    }`);
    const choose = context.state.program.body[1];
    if (!t.isFunctionDeclaration(choose)) throw new Error("Missing choose");
    const last = choose.body.body.at(-1);
    if (!t.isReturnStatement(last) || !t.isCallExpression(last.argument))
      throw new Error("Missing call");
    const reads = vi.spyOn(context.bindingCache, "get");
    const result = context.resolve(last.argument.callee);
    expect(result).toMatchObject({ complete: false });
    expect(result.callableIds).toHaveLength(1);
    const callReads = reads.mock.calls.length;
    const lookups = context.state.scopes.map((scope) =>
      vi.spyOn(scope.bindings, "get"),
    );
    try {
      const returned = createSemanticReturnedReferences(context.state)(
        last.argument.callee,
      );
      expect(returned.references).toHaveLength(1);
      expect(returned.complete).toBe(false);
      return {
        callReads,
        referenceReads: lookups.reduce(
          (total, lookup) => total + lookup.mock.calls.length,
          0,
        ),
      };
    } finally {
      for (const lookup of lookups) lookup.mockRestore();
    }
  };
  const small = measure(8);
  const large = measure(12);
  expect(small.callReads).toBeGreaterThan(0);
  expect(large.callReads).toBeLessThan(3 * small.callReads);
  expect(small.referenceReads).toBeGreaterThan(0);
  expect(large.referenceReads).toBeLessThan(3 * small.referenceReads);
});

it.each([
  ["if(flag){cb=fallback;cb();}", true],
  ["if(flag)cb=fallback;cb();", false],
  ["cb ||= fallback;cb();", false],
  ["cb=fallback;{cb();}", true],
  ["cb=fallback;if(flag){cb();}", true],
  ["cb=fallback;while(flag){cb();}", true],
  ["{cb();}cb=fallback;", false],
  ["(()=>{cb();})();cb=fallback;", false],
  ["function use(){cb();}use();cb=fallback;", false],
  ["class Hold{value=cb()}cb=fallback;", false],
] as const)(
  "reports initializer coverage at the read: %s",
  (body, expected) => {
    const { state } = indexed(`function choose(cb,flag){${body}}`);
    const binding = [...state.bindingsById.values()].find(
      (binding) => binding.name === "cb",
    );
    if (binding === undefined) throw new Error("Missing cb binding");
    let reads = 0;
    traverseJavaScriptAst(state.program, {
      enter(node) {
        if (
          t.isCallExpression(node) &&
          t.isIdentifier(node.callee, { name: "cb" })
        ) {
          reads++;
          expect(
            semanticBindingAtRead(binding, node.callee, state.parentsByNode)
              .hasDefiniteInitializer,
          ).toBe(expected);
        }
      },
    });
    expect(reads).toBe(1);
  },
);

it("does not reuse a later resolved callback at an earlier read", () => {
  const context = indexed(
    `function fallback(){} function choose(cb){cb();cb=fallback;cb();}`,
  );
  const choose = context.state.program.body[1];
  if (!t.isFunctionDeclaration(choose)) throw new Error("Missing choose");
  const calls = choose.body.body.flatMap((statement) =>
    t.isExpressionStatement(statement) &&
    t.isCallExpression(statement.expression)
      ? [statement.expression.callee]
      : [],
  );
  const [before, after] = calls;
  if (before === undefined || after === undefined)
    throw new Error("Missing callback reads");
  expect(context.resolve(after)).toMatchObject({ complete: true });
  expect(context.resolve(before)).toMatchObject({
    complete: false,
    callableIds: [],
  });
  expect(context.resolve(after)).toMatchObject({ complete: true });
});

it.each([false, true])(
  "bounds separate branch assignments with intrinsic cycle=%s",
  (cyclic) => {
    const measure = (depth: number) => {
      const context = indexed(`function fallback(){return {};}
function choose(flag){let a0=${cyclic ? "flag?a0:{make:fallback}" : "{make:fallback}"};
${Array.from({ length: depth }, (_, i) => `let a${i + 1};if(flag)a${i + 1}=a${i};else a${i + 1}=a${i};`).join("")}
return a${depth}.make();}`);
      const choose = context.state.program.body[1];
      if (!t.isFunctionDeclaration(choose)) throw new Error("Missing choose");
      const last = choose.body.body.at(-1);
      if (!t.isReturnStatement(last) || !t.isCallExpression(last.argument))
        throw new Error("Missing call");
      const lookups = context.state.scopes.map((scope) =>
        vi.spyOn(scope.bindings, "get"),
      );
      try {
        expect(
          createSemanticReturnedReferences(context.state)(last.argument.callee)
            .references,
        ).toHaveLength(1);
        return lookups.reduce(
          (total, lookup) => total + lookup.mock.calls.length,
          0,
        );
      } finally {
        for (const lookup of lookups) lookup.mockRestore();
      }
    };
    const small = measure(8),
      large = measure(12);
    expect(small).toBeGreaterThan(0);
    expect(large).toBeLessThan(3 * small);
  },
);

it.each(["||=", "??="])(
  "retains definite assignment to an empty local: %s",
  (operator) => {
    const { state } = indexed(
      `function choose(){let cb;cb ${operator} fallback;cb();}`,
    );
    const binding = [...state.bindingsById.values()].find(
      (binding) => binding.name === "cb",
    );
    if (binding === undefined) throw new Error("Missing cb binding");
    let reads = 0;
    traverseJavaScriptAst(state.program, {
      enter(node) {
        if (
          t.isCallExpression(node) &&
          t.isIdentifier(node.callee, { name: "cb" })
        ) {
          reads++;
          expect(
            semanticBindingAtRead(binding, node.callee, state.parentsByNode)
              .hasDefiniteInitializer,
          ).toBe(true);
        }
      },
    });
    expect(reads).toBe(1);
  },
);

it("does not memoize alias cycle cuts across entry paths", () => {
  const context = indexed(
    `function fallback(){} let a,b; function setA(){a=flag?b:fallback;} function setB(){b=a;} a(); b();`,
  );
  const callees = context.state.program.body.flatMap((statement) =>
    t.isExpressionStatement(statement) &&
    t.isCallExpression(statement.expression)
      ? [statement.expression.callee]
      : [],
  );
  const fallback = context.state.callables.find(
    (callable) => callable.name === "fallback",
  );
  if (fallback === undefined) throw new Error("Missing fallback");
  for (const node of [...callees, ...callees].reverse()) {
    const warm = context.resolve(node);
    const cold = resolveLocalCallables({
      node,
      state: context.state,
      callableById: context.callableById,
      bindingCache: new WeakMap(),
      seenInitializers: new Set(),
    });
    expect(warm).toEqual(cold);
    expect(warm).toMatchObject({
      complete: false,
      cycleDependent: true,
      callableIds: [fallback.callableId],
    });
  }
});

it.each([
  ["function f(){}", false],
  ["function f(){return}", false],
  ["function f(){function nested(){return {}}}", false],
  ["function f(){return {};return}", true],
  ["function f(){try{return {}}catch(error){}}", false],
  ["function f(){try{return {}}catch(error){throw error}}", true],
  ["function f(){try{return}finally{return {}}}", true],
  ["function f(){try{return {}}finally{if(flag)return}}", false],
  ["function f(){do{return {}}while(flag)}", false],
  ["function f(){while(flag){if(other)return}return {}}", false],
  ["function f(){switch(flag){default:return {}}}", false],
  ["function f(){block:{return {}}}", false],
  ["async function f(){return {}}", false],
  ["function* f(){return {}}", false],
  ["(()=>({}));", true],
  ["(async()=>({}));", false],
])("bounds direct result completion proof: %s", (source, complete) => {
  const parsed = parseJavaScriptSource(source, "completion.js");
  const statement = parsed?.program.body[0];
  if (statement === undefined) throw new Error("Missing callable fixture");
  const callable = t.isExpressionStatement(statement)
    ? statement.expression
    : statement;
  expect(semanticCallableResultCompletion(callable).complete).toBe(complete);
});

it("retains possible results while refreshing completed callee captures", () => {
  const parsed = parseJavaScriptSource(
    "const holder={proto(){return {__proto__:null}}};holder.proto();",
    "completion.js",
  );
  if (parsed === null) throw new Error("Expected parsed source");
  const { bindings: state } = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  );
  const last = state.program.body.at(-1);
  if (!t.isExpressionStatement(last) || !t.isCallExpression(last.expression))
    throw new Error("Expected method invocation");
  const returned = createSemanticReturnedReferences(state, undefined, {
    bindingReadMayHaveChanged: () => false,
    ownSlotUnchanged: (owner, key, read) =>
      semanticAmbientOwnSlotUnchanged(state, owner, key, read),
  });
  const callee = last.expression.callee;
  const provisional = returned(callee);
  expect(provisional.complete).toBe(false);
  expect(provisional.references).toHaveLength(1);
  const snapshots: { fresh: boolean; complete: boolean }[] = [];
  completeSemanticSteps(
    indexJavaScriptAmbientWritesSteps(state.program, state, () => () => {
      if (semanticAmbientOwnSlotFactsReady(state))
        snapshots.push({
          fresh: semanticFreshObjectFactsReady(state),
          complete: returned(callee).complete,
        });
    }),
  );
  expect(snapshots.length).toBeGreaterThan(0);
  for (const snapshot of snapshots)
    expect(snapshot).toEqual({ fresh: false, complete: true });
  expect(returned(callee).references).toEqual(provisional.references);
});

const meshLookups = (writes: number): number => {
  const source = `function f(){} function g(){} let a=f,b=g;
function run(){${Array.from({ length: writes }, (_, index) =>
    index % 2 === 0 ? "a=b;" : "b=a;",
  ).join("")} a();}`;
  const context = indexed(source);
  const run = context.state.program.body[3];
  if (!t.isFunctionDeclaration(run)) throw new Error("Missing run");
  const statement = run.body.body.at(-1);
  if (
    !t.isExpressionStatement(statement) ||
    !t.isCallExpression(statement.expression)
  )
    throw new Error("Missing mesh call");
  const lookups = vi.spyOn(context.bindingCache, "get");
  const result = context.resolve(statement.expression.callee);
  expect(result).toMatchObject({ complete: false, cycleDependent: true });
  expect(
    result.callableIds.map((id) => context.callableById.get(id)?.name).sort(),
  ).toEqual(["f", "g"]);
  return lookups.mock.calls.length;
};

it("closes cycles at full-binding reads with bounded lookup growth", () => {
  const six = meshLookups(6);
  const eight = meshLookups(8);
  const ten = meshLookups(10);
  const twelve = meshLookups(12);
  expect(six).toBeGreaterThan(0);
  expect(eight).toBeLessThan(3 * six);
  expect(ten).toBeLessThan(3 * eight);
  expect(twelve).toBeLessThan(3 * ten);
});
