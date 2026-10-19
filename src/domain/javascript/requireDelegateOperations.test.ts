import { describe, expect, it } from "vitest";

import {
  analyzeJavaScriptStaticSource,
  analyzeParsedJavaScriptStaticSource,
} from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';
const READ = 'new (Q("electron").BrowserWindow)({});';

const commonJsWindows = (source: string): number => {
  const file = parseJavaScriptSource(source, "bundle.cjs");
  expect(file).not.toBeNull();
  return analyzeParsedJavaScriptStaticSource(source, file!).electron
    .browser_windows.length;
};

const windows = (setup: string, read = READ): number =>
  commonJsWindows(`${SHIM}${setup}${read}`);

describe("possible entry module identity", () => {
  it.each([
    "require.main.require=other;",
    "process.mainModule.require=other;",
    "const main=require.main;main.require=other;",
    "const {main}=require;main.require=other;",
    "const box={main:require.main};box.main.require=other;",
    "const main=require.main;require.main={};main.require=other;",
    'Reflect.set(require.main,"require",other);',
    'Object.defineProperty(process.mainModule,"require",{value:other});',
    "Object.setPrototypeOf(require.main,{require:other});",
  ])("rejects a possible wrapper delegate replacement: %s", (setup) => {
    expect(windows(setup)).toBe(0);
  });

  it.each([
    "{const require={main:{}};require.main.require=other;}",
    "let main=require.main;main={};main.require=other;",
    "require.main.unrelated=other;",
    "process.mainModule.unrelated=other;",
    "require.main={};require.main.require=other;",
    "process.mainModule={};process.mainModule.require=other;",
    "const load=require;load.main={};load.main.require=other;",
    "require.main={};const main=require.main;main.require=other;",
  ])("preserves a proven distinct write: %s", (setup) => {
    expect(windows(setup)).toBe(1);
  });

  it("preserves a load before a main module replacement", () => {
    expect(windows(`${READ}require.main.require=other;`, "")).toBe(1);
  });
});

describe("initial module delegate operations", () => {
  it.each([
    "module.require ||= other;",
    "module.require ??= other;",
    "module.__proto__.require ||= other;",
    "module.constructor._load ??= other;",
    "const alias=module;alias.require ||= other;",
    "module.require ||= other;module.require ??= other;",
    "delete module.require;module.require ||= other;",
    "Object.assign(module,null);",
    "Object.assign(module,void 0);",
    "Object.assign(module,undefined);",
    "Object.assign(module,null,{},void 0);",
    "const assign=Object.assign;assign(module,null);",
    "Object.assign.call(null,module,null);",
    "Reflect.apply(Object.assign,null,[module,null]);",
    "const holder={};Object.assign(holder,{target:{}});holder.target.require=other;",
  ])("preserves an intact delegate after an inert operation: %s", (setup) => {
    expect(windows(setup)).toBe(1);
    expect(windows(setup, 'new (require("electron").BrowserWindow)({});')).toBe(
      1,
    );
  });

  it.each([
    "module.require &&= other;",
    "module.require=undefined;module.require ||= other;",
    "module.__proto__.require=null;module.require ??= other;",
    "module.constructor._load=undefined;module.constructor._load ||= other;",
    "patch(module);module.require ||= other;",
    "Object.assign(module,null,{require:other});",
    "const undefined={require:other};Object.assign(module,undefined);",
    "Object.assign(module,void(module.require=other));",
    "Object.assign(module,void patch(module));",
    "Object.assign(module,{get unrelated(){module.require=other;return 1}});",
    "Object.assign(module,unknown);",
    "const holder={};Object.assign(holder,{target:module});holder.target.require=other;",
  ])("retains actual or uncertain replacements: %s", (setup) => {
    expect(windows(setup)).toBe(0);
  });
});

describe("inert require shim selection", () => {
  it.each([
    'var Q=(e=>typeof require<"u"?require:e)(function(){return require.main});',
    'var Q=(e=>typeof require<"u"?require:e)(function(){module.require=other});',
    'var Q=(e=>typeof require<"u"?require:(module.require=other,e))(function(){});',
    'var Q=(e=>typeof require<"u"?require:new Proxy(e,{get:(t,n)=>require[n]}))(function(){});',
  ])("keeps unselected fallback effects inactive: %s", (shim) => {
    expect(commonJsWindows(`${shim}delete module.require;${READ}`)).toBe(1);
  });

  it.each([
    "var Q=(e=>false?require:new Proxy(e,{get:()=>module}))(function(){});",
    'var Q=(e=>typeof require<"u"?require:e)(external(module));',
    "var Q=(e=>{external(module);return require})(function(){});",
  ])("keeps effects from an unproven initializer: %s", (shim) => {
    expect(
      analyzeJavaScriptStaticSource(
        `${shim}delete module.require;new(require("electron").BrowserWindow)({});`,
      ).electron.browser_windows,
    ).toEqual([]);
  });

  it.each([
    'import Module from "node:module";',
    'const Module=await import("node:module");',
  ])(
    "retains a possibly selected fallback without a CommonJS host: %s",
    (setup) => {
      expect(
        analyzeJavaScriptStaticSource(
          `${setup}var Q=(e=>typeof require<"u"?require:(Module._load=other,e))(function(){});const load=Module.createRequire(import.meta.url);new(load("electron").BrowserWindow)({});`,
        ).electron.browser_windows,
      ).toEqual([]);
    },
  );

  it.each([
    "arguments[1]=undefined;",
    "const args=arguments;args[1]=undefined;",
    'Object.defineProperty(arguments,"1",{value:undefined});',
    "external(arguments);",
    "(()=>{arguments[1]=undefined;})();",
    "const object={ [arguments[1]=undefined](){} };",
    "class C { [arguments[1]=undefined](){} }",
  ])(
    "retains fallback effects after wrapper arguments exposure: %s",
    (setup) => {
      expect(
        commonJsWindows(
          `const Module=require("node:module");const load=Module.createRequire(__filename);${setup}var Q=(e=>typeof require<"u"?require:(Module._load=other,e))(function(){});new(load("electron").BrowserWindow)({});`,
        ),
      ).toBe(0);
    },
  );

  it("keeps ordinary function arguments separate from the wrapper", () => {
    expect(
      commonJsWindows(
        `function unrelated(){arguments[1]=undefined;}unrelated();${SHIM}delete module.require;${READ}`,
      ),
    ).toBe(1);
  });
});

describe("copying the initial module delegate", () => {
  it.each([
    "module.require=module.require;",
    "const alias=module;alias.require=module.require;",
    "const alias=module;module.require=alias.require;",
    "const saved=module.require;module.require=saved;",
    "const {require:saved}=module;module.require=saved;",
    "module.require=module.require;module.require=module.require;",
    "delete module.require;module.require=module.require;",
  ])("preserves an exact initial delegate value: %s", (setup) => {
    expect(windows(setup)).toBe(1);
    expect(windows(setup, 'new(require("electron").BrowserWindow)({});')).toBe(
      1,
    );
  });

  it.each([
    "module.require=other;module.require=module.require;",
    "module.__proto__.require=other;module.require=module.require;",
    "patch(module);module.require=module.require;",
    "const saved=module.require;patch(module);module.require=saved;",
    "const saved=module.require;module.require=other;module.require=saved;",
    "let saved=module.require;if(flag)saved=other;module.require=saved;",
    "const source={require:other};module.require=source.require;",
    "module.require=require;",
    "module.require=flag?module.require:other;",
    "let target=module;if(flag)target=unknown;target.require=module.require;",
    "const target=new Proxy(module,{set(){module.require=other;return true}});target.require=module.require;",
  ])("retains changed or uncertain delegate values: %s", (setup) => {
    expect(windows(setup)).toBe(0);
  });

  it("retains the existing conservative escape policy after a descriptor call", () => {
    // The descriptor metadata itself preserves the value. Its intrinsic call
    // still exposes the target in the generic escape inventory, so a later
    // copy cannot yet prove that its source retains the initial delegate.
    expect(
      windows(
        'Object.defineProperty(module.__proto__,"require",{enumerable:false});module.require=module.require;',
      ),
    ).toBe(0);
  });
});

describe("Object.assign copies of the initial module delegate", () => {
  it.each([
    "Object.assign(module,{require:module.require});",
    "Object.assign(module,{unrelated:0,require:module.require});",
    "Object.assign(module,{require:other,require:module.require});",
    'Object.assign(module,{["require"]:module.require});',
    "const target=module;Object.assign(target,{require:module.require});",
    "const saved=module.require;Object.assign(module,{require:saved});",
    "const {require:saved}=module;Object.assign(module,{require:saved});",
    "const assign=Object.assign;assign(module,{require:module.require});",
    "Object.assign.call(null,module,{require:module.require});",
    "Reflect.apply(Object.assign,null,[module,{require:module.require}]);",
    "Object.assign(module,{require:module.require},{require:module.require});",
    "Object.assign(module,{},null,{require:module.require},{unrelated:1});",
    "let target=module;Object.assign(target,{require:module.require},{unrelated:(target={},0)});",
    "let saved=module.require;Object.assign(module,{require:saved},{unrelated:(saved=other,0)});",
    "const assign=Object.assign;patch(Object);assign(module,{require:module.require});",
    "const apply=Reflect.apply;patch(Reflect);apply(Object.assign,null,[module,{require:module.require}]);",
    "const assign=Object.assign;Object.assign=other;assign(module,{require:module.require});",
    "const assign=Object.assign;patch(assign);assign(module,{require:module.require});",
  ])("preserves captured initial values through %s", (setup) => {
    expect(windows(setup)).toBe(1);
    expect(windows(setup, 'new(require("electron").BrowserWindow)({});')).toBe(
      1,
    );
  });

  it.each([
    "Object.assign(module,{require:module.require},{require:other});",
    "Object.assign(module,{require:module.require},{require});",
    "Object.assign(module,{require:module.require},unknown);",
    "Object.assign(module,{require:module.require},{...unknown});",
    "Object.assign(module,{get require(){return module.require}});",
    "Object.assign(module,{require:module.require},{get unrelated(){module.require=other;return 0}});",
    "module.require=other;Object.assign(module,{require:module.require});",
    "patch(module);Object.assign(module,{require:module.require});",
    "Object.assign(module,{require:module.require},(patch(module),{}));",
    "let target=module;if(flag)target=unknown;Object.assign(target,{require:module.require});",
    "const target=new Proxy(module,{set(){module.require=other;return true}});Object.assign(target,{require:module.require});",
    'Object.assign(module,{require:module.require,["__proto__"]:other});',
    "patch(Object);Object.assign(module,{require:module.require});",
    "patch(Reflect);Reflect.apply(Object.assign,null,[module,{require:module.require}]);",
    "patch(Object.assign);Object.assign.call(null,module,{require:module.require});",
    "const assign=Object.assign;patch(assign);assign.call(null,module,{require:module.require});",
    "Object.assign=other;Object.assign(module,{require:module.require});",
    "Object.assign(module,{[key]:other,require:module.require});",
    "Object.assign(module,{get unrelated(){module.constructor._load=other;return 0}},{require:module.require});",
    'Object.defineProperty(module,"unrelated",{set(){module.require=other}});Object.assign(module,{require:module.require,unrelated:0});',
  ])("retains changed or unresolved assignment effects through %s", (setup) => {
    expect(windows(setup)).toBe(0);
  });
});
