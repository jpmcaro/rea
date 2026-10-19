import { describe, expect, it } from "vitest";

import { indexJavaScriptBindingsWithReceiversSteps } from "./javascriptSemanticAnalysis.js";
import { semanticRequireOrigin } from "./javascriptSemanticRequireOrigin.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const LOADERS = [
  ["Module delegate", "module.require.bind(module)"],
  ["wrapper loader", "require.bind(null)"],
] as const;
const HELPERS = [
  ["call", 'load.call(null,"electron")', "()=>({BrowserWindow:class{}})"],
  ["apply", 'load.apply(null,["electron"])', "()=>({BrowserWindow:class{}})"],
  ["bind", 'load.bind(null)("electron")', "()=>()=>({BrowserWindow:class{}})"],
] as const;

describe.each(LOADERS)("bound %s helper writes", (_name, initializer) => {
  it.each(HELPERS)(
    "rejects an overwritten own %s helper",
    (helper, load, value) => {
      for (const write of [
        `load.${helper}=${value};`,
        `Object.assign(load,{${helper}:${value}});`,
        `Object.defineProperty(load,"${helper}",{value:${value}});`,
        `Reflect.set(load,"${helper}",${value});`,
      ]) {
        expect(
          analyzeJavaScriptStaticSource(
            `const load=${initializer};${write}new (${load}.BrowserWindow)({});`,
          ).electron.browser_windows,
          write,
        ).toEqual([]);
      }
    },
  );

  it.each(HELPERS)(
    "preserves an earlier invocation through %s",
    (helper, load, value) => {
      expect(
        analyzeJavaScriptStaticSource(
          `const load=${initializer};new (${load}.BrowserWindow)({});load.${helper}=${value};new (${load}.BrowserWindow)({});`,
        ).electron.browser_windows,
      ).toHaveLength(1);
    },
  );

  it.each(HELPERS)("preserves an intact %s helper", (_helper, load) => {
    expect(
      analyzeJavaScriptStaticSource(
        `const load=${initializer};load.unrelated=other;new (${load}.BrowserWindow)({});`,
      ).electron.browser_windows,
    ).toHaveLength(1);
  });

  it("preserves calls that bypass overwritten own helpers", () => {
    expect(
      analyzeJavaScriptStaticSource(
        `const load=${initializer};load.call=other;load.apply=other;load.bind=other;new (load("electron").BrowserWindow)({});new (Reflect.apply(load,null,["electron"]).BrowserWindow)({});`,
      ).electron.browser_windows,
    ).toHaveLength(2);
  });

  it("rejects helpers from an overwritten bound function prototype", () => {
    expect(
      analyzeJavaScriptStaticSource(
        `const load=${initializer};Object.setPrototypeOf(load,{call:()=>({BrowserWindow:class{}})});new (load.call(null,"electron").BrowserWindow)({});`,
      ).electron.browser_windows,
    ).toEqual([]);
  });
});

it.each([
  ["an intact helper", "", "electron"],
  ["an overwritten helper", "load.call=other;", undefined],
])("refreshes %s when shared facts complete", (_name, write, expected) => {
  const parsed = parseJavaScriptSource(
    `const load=module.require.bind(module);${write}load.call(null,"electron");`,
  );
  if (parsed === null) throw new Error("Expected parsed source");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  );
  const statement = parsed.program.body.at(-1);
  if (
    statement?.type !== "ExpressionStatement" ||
    statement.expression.type !== "CallExpression"
  )
    throw new Error("Expected loader invocation");
  const call = statement.expression;
  expect(semanticRequireOrigin(call, index.bindings)).toBeUndefined();
  completeSemanticSteps(index.indexAmbientWritesSteps());
  expect(semanticRequireOrigin(call, index.bindings)?.origin.specifier).toBe(
    expected,
  );
});

it.each([
  "module.require.call=other;const load=module.require.bind(module);",
  "const load=module.require.bind(module);Object.setPrototypeOf(module.require,{});",
  "const base=module.require.bind(module);base.call=other;const load=base.bind(null);",
])("preserves the bound function's captured prototype: %s", (setup) => {
  expect(
    analyzeJavaScriptStaticSource(
      `${setup}new (load.call(null,"electron").BrowserWindow)({});`,
    ).electron.browser_windows,
  ).toHaveLength(1);
});
