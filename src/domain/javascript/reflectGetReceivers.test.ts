import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { analyzeParsedJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';
const BOX = "const box={get value(){this.Q=other;return 0}};";
const USE = 'Q("electron").ipcRenderer.send("kept");';

const analyze = (source: string) => {
  const parsed = parseJavaScriptSource(source, "bundle.js");
  if (parsed === null) throw new Error("Expected parsed source");
  return analyzeParsedJavaScriptStaticSource(source, parsed);
};

/** Run the classic script with only Electron stubbed; the global Q is live. */
const runtimeSends = (source: string): "kept" | "replaced" => {
  let actual = 0;
  let replacement = 0;
  runInNewContext(`unknownReceiver=globalThis;flag=true;${source}`, {
    require: () => ({ ipcRenderer: { send: () => actual++ } }),
    other: () => ({ ipcRenderer: { send: () => replacement++ } }),
  });
  expect(actual + replacement).toBe(1);
  return actual === 1 ? "kept" : "replaced";
};

describe("Reflect.get getter receivers", () => {
  // Native [[Get]] runs the selected getter with the explicit receiver, or the
  // target when it is omitted. A local receiver keeps the global loader intact.
  it.each([
    'Reflect.get(box,"value");',
    'Reflect.get(box,"value",box);',
    'Reflect.get({__proto__:box},"value");',
    'const get=Reflect.get;get(box,"value");',
    'Reflect.get.call(Reflect,box,"value");',
    'Reflect.apply(Reflect.get,Reflect,[box,"value"]);',
    'Reflect.get(box,"value",{});',
  ])("keeps the endpoint when the getter receiver is local: %s", (read) => {
    const source = `${SHIM}${BOX}${read}${USE}`;
    expect(runtimeSends(source)).toBe("kept");
    expect(analyze(source).electron.ipc).toMatchObject([{ channel: "kept" }]);
  });

  it.each([
    'Reflect.get(box,"value",globalThis);',
    'Reflect.get(box,"value",unknownReceiver);',
    'Reflect.get(box,flag?"value":"other",globalThis);',
    'Reflect.get=(target,key)=>Object.getOwnPropertyDescriptor(target,key).get.call(globalThis);Reflect.get(box,"value");',
    'Object.getOwnPropertyDescriptor(box,"value").get.call(globalThis);',
  ])("drops the endpoint when the getter can run globally: %s", (read) => {
    const source = `${SHIM}${BOX}${read}${USE}`;
    expect(runtimeSends(source)).toBe("replaced");
    expect(analyze(source).electron.ipc).toEqual([]);
  });

  it("does not run a setter for a native get", () => {
    const source = `${SHIM}const box={set value(v){this.Q=other},get value(){return 0}};Reflect.get(box,"value",globalThis);${USE}`;
    expect(runtimeSends(source)).toBe("kept");
    expect(analyze(source).electron.ipc).toMatchObject([{ channel: "kept" }]);
  });
});
