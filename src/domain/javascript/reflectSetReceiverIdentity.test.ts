import { describe, expect, it } from "vitest";

import { analyzeParsedJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const ipcAfter = (setup: string) => {
  const source =
    'var Q=(e=>typeof require<"u"?require:e)(function(){});' +
    setup +
    'Q("electron").ipcRenderer.send("kept");';
  const parsed = parseJavaScriptSource(source, "bundle.js");
  if (parsed === null) throw new Error("Expected parsed source");
  return analyzeParsedJavaScriptStaticSource(source, parsed).electron.ipc;
};

describe("Reflect.set accessor receivers", () => {
  it.each([
    'Reflect.set(box,"value",0);',
    'Reflect.set(box,"value",0,box);',
    'Reflect.set(box,"value",0,{});',
    'Reflect.set(box,"value",0,1);',
    'const set=Reflect.set;set(box,"value",0);',
    'Reflect.set.call(null,box,"value",0);',
    'Reflect.set.apply(null,[box,"value",0]);',
    'Reflect.apply(Reflect.set,null,[box,"value",0,{}]);',
    'const set=Reflect.set.bind(null);set(box,"value",0);',
  ])("retains a local receiver for %s", (call) => {
    expect(
      ipcAfter(`const box={set value(v){this.Q=other}};${call}`),
    ).toMatchObject([{ channel: "kept" }]);
  });

  it.each([
    'Reflect.set(box,"value",0,globalThis);',
    'Reflect.set(box,"value",0,undefined);',
    'Reflect.set(box,"value",0,null);',
    'Reflect.set(box,"value",0,receiver);',
    'Reflect.apply(Reflect.set,null,[box,"value",0,globalThis]);',
    'Reflect.set=other;Reflect.set(box,"value",0);',
    'Reflect.set.call=other;Reflect.set.call(null,box,"value",0);',
    "Reflect.set(box,...args);",
    'external(box);Reflect.set(box,"value",0);',
    'Object.defineProperty(box,"value",{set:other});Reflect.set(box,"value",0);',
    'const set=Reflect.set.bind(null,box,"value");external(set);',
    'const set=Reflect.set.bind(null,box,"value");set(0,globalThis);',
  ])("retains uncertain or global receiver effects for %s", (call) => {
    expect(ipcAfter(`const box={set value(v){this.Q=other}};${call}`)).toEqual(
      [],
    );
  });

  it.each([
    'const base={set value(v){this.Q=other}},box={__proto__:base};Reflect.set(box,"value",0);',
    'const base={set value(v){this.Q=other}},box={__proto__:base};Reflect.set(box,"value",0,{});',
    'const box={get value(){this.Q=other;return 0}};Reflect.set(box,"value",0);',
    'const base={get value(){this.Q=other;return 0}},box={__proto__:base};Reflect.set(box,"value",0);',
  ])("keeps descriptor lookup separate from invocation: %s", (setup) => {
    expect(ipcAfter(setup)).toMatchObject([{ channel: "kept" }]);
  });
});
