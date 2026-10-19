import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const HELPERS = [
  ["call.call", 'load.call.call(load,null,"electron")'],
  ["call.apply", 'load.call.apply(load,[null,"electron"])'],
  ["apply.call", 'load.apply.call(load,null,["electron"])'],
  ["apply.apply", 'load.apply.apply(load,[null,["electron"]])'],
  ["call.call.call", 'load.call.call.call(load.call,load,null,"electron")'],
  ["bind.call", 'load.bind.call(load,null)("electron")'],
  ["bind.apply", 'load.bind.apply(load,[null])("electron")'],
] as const;

describe.each([
  "require.bind(null)",
  "module.require.bind(module)",
  "require.bind(null).bind(null)",
])("nested helpers on %s", (initializer) => {
  it.each(HELPERS)("rejects an overwritten %s helper", (helper, load) => {
    expect(
      analyzeJavaScriptStaticSource(
        `const load=${initializer};Function.prototype.${helper}=other;new (${load}.BrowserWindow)({});`,
      ).electron.browser_windows,
    ).toEqual([]);
  });

  it.each(HELPERS)("preserves an earlier %s invocation", (helper, load) => {
    expect(
      analyzeJavaScriptStaticSource(
        `const load=${initializer};new (${load}.BrowserWindow)({});load.${helper}=other;new (${load}.BrowserWindow)({});`,
      ).electron.browser_windows,
    ).toHaveLength(1);
  });

  it.each(HELPERS)("preserves an intact %s invocation", (_helper, load) => {
    expect(
      analyzeJavaScriptStaticSource(
        `const load=${initializer};load.call.unrelated=other;new (${load}.BrowserWindow)({});`,
      ).electron.browser_windows,
    ).toHaveLength(1);
  });
});

it.each([
  ["call.call", "create.call.call(create,null,module)"],
  ["call.apply", "create.call.apply(create,[null,module])"],
])("shares nested %s proof with allocator calls", (helper, create) => {
  for (const write of ["", `Function.prototype.${helper}=other;`]) {
    expect(
      analyzeJavaScriptStaticSource(
        `const create=Object.create.bind(null);${write}Reflect.set(module,"require",other,${create});new(require("electron").BrowserWindow)({});`,
      ).electron.browser_windows,
    ).toHaveLength(write === "" ? 1 : 0);
  }
});

it.each(["get p(){return 42}", "set p(value){}"])(
  "retains a nested helper write through an accessor prototype: %s",
  (property) => {
    expect(
      analyzeJavaScriptStaticSource(
        `const load=require.bind(null);const h={${property}};const o={__proto__:h.p};o.toString.call.call=other;new(load.call.call(load,null,"electron").BrowserWindow)({});`,
      ).electron.browser_windows,
    ).toEqual([]);
  },
);

it("uses the selected callable receiver of a nested helper", () => {
  expect(
    analyzeJavaScriptStaticSource(
      'const load=require.bind(null);const other=()=>({BrowserWindow:class{}});new(load.call.call(other,null,"electron").BrowserWindow)({});',
    ).electron.browser_windows,
  ).toEqual([]);
});

describe.each([
  ["require", "null"],
  ["module.require", "module"],
])("generic binding of %s", (target, receiver) => {
  const bind = `const bind=Function.prototype.bind;`;
  const allocate = `const load=Reflect.apply(bind,${target},[${receiver}]);`;
  const write = `Object.setPrototypeOf(${target},{call:other});`;
  const load = 'new(load.call(null,"electron").BrowserWindow)({});';

  it("rejects a prototype changed before bound allocation", () => {
    expect(
      analyzeJavaScriptStaticSource(`${bind}${write}${allocate}${load}`)
        .electron.browser_windows,
    ).toEqual([]);
  });

  it("preserves the prototype captured before a later change", () => {
    expect(
      analyzeJavaScriptStaticSource(`${bind}${allocate}${write}${load}`)
        .electron.browser_windows,
    ).toHaveLength(1);
  });

  it("does not copy the target's own helper slots", () => {
    expect(
      analyzeJavaScriptStaticSource(
        `${bind}${target}.call=other;${allocate}${load}`,
      ).electron.browser_windows,
    ).toHaveLength(1);
  });
});
