import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { analyzeParsedJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';
const LOAD = 'new (Q("electron").BrowserWindow)({});';

/** Run the CommonJS source against a real module wrapper; only Electron is stubbed. */
const runtimeLoads = (source: string): "original" | "replacement" => {
  const calls = runInNewContext(`
    const calls=[];
    const electron={BrowserWindow:function(){calls.push('original')}};
    function other(){return {BrowserWindow:function(){calls.push('replacement')}}}
    class Module { require(){ return electron } }
    const module=new Module;
    const require=id=>module.require(id);
    (function(exports,require,module,__filename,__dirname){${source}})
      ({},require,module,'/tmp/bundle.cjs','/tmp');
    calls.join();
  `) as string;
  expect(calls === "original" || calls === "replacement").toBe(true);
  return calls === "original" ? "original" : "replacement";
};

const analyzedWindows = (source: string) => {
  const parsed = parseJavaScriptSource(source, "bundle.cjs");
  expect(parsed).not.toBeNull();
  return analyzeParsedJavaScriptStaticSource(source, parsed!).electron
    .browser_windows.length;
};

describe("require shim self-copy identity", () => {
  // `Q = Q` cannot introduce a value the binding does not already hold, so
  // the proven shim survives it. Any real reassignment still refuses the shim.
  it.each([
    ["Q=Q;", 1],
    ["Q=(Q);", 1],
    ["Q=Q;Q=Q;", 1],
    ["if(module)Q=Q;", 1],
    ["function copy(){Q=Q}copy();", 1],
    ["{let Q=other;Q=Q}", 1],
    ["Q=other;Q=Q;", 0],
    ["Q=Q;Q=other;", 0],
    ["if(module)Q=other;Q=Q;", 0],
    ["Q=Q;module.require=other;", 0],
  ] as const)("matches the runtime after %s", (setup, expected) => {
    const source = `${SHIM}${setup}${LOAD}`;
    expect(runtimeLoads(source)).toBe(expected ? "original" : "replacement");
    expect(analyzedWindows(source)).toBe(expected);
  });

  // These copies also keep the host loader at runtime, but they read it
  // through another binding, a bound helper or a `with` environment. The
  // owner refuses them rather than follow a value it has not proven.
  it.each([
    "const alias=Q;Q=alias;",
    "var copy=Q;Q=copy;",
    "Q=Q.bind(null);",
    "Q=Q;Q=Q.bind(null,'electron');",
    "with({}){Q=Q}",
  ])("stays conservative for an unproven copy %s", (setup) => {
    const source = `${SHIM}${setup}${LOAD}`;
    expect(runtimeLoads(source)).toBe("original");
    expect(analyzedWindows(source)).toBe(0);
  });
});
