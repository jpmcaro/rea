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

describe("native property setter receiver selection", () => {
  it.each([
    'Reflect.set(box,"value",(delete box.value,0),globalThis);',
    'Reflect.set(box,"value",0,(delete box.value,globalThis));',
    'Reflect.set.call(null,box,"value",(delete box.value,0),globalThis);',
    'Reflect.apply(Reflect.set,null,[box,"value",(delete box.value,0),globalThis]);',
  ])("checks the descriptor after argument evaluation: %s", (call) => {
    expect(
      ipcAfter(
        `const base={set value(v){this.Q=other}};base.value=0;const box={__proto__:base,set value(v){}};${call}`,
      ),
    ).toEqual([]);
  });

  it.each([
    'let box={set value(v){this.Q=other}};Reflect.set(box,"value",(box={},0),globalThis);',
    'const holder={box:{set value(v){this.Q=other}}};Reflect.set(holder.box,"value",(holder.box={},0),globalThis);',
    'const base={set value(v){this.Q=other}};base.value=0;const box={};Reflect.set(box,"value",(Object.setPrototypeOf(box,base),0),globalThis);',
    'const box={set value(v){}};Reflect.set(box,"value",(Object.defineProperty(box,"value",{set(v){this.Q=other}}),0),globalThis);',
  ])("retains captured targets and later descriptor changes: %s", (setup) => {
    expect(ipcAfter(setup)).toEqual([]);
  });

  it.each([
    "Object.assign(box,{value:0});",
    "const assign=Object.assign;assign(box,{value:0});",
    "Object.assign.call(null,box,{value:0});",
    "Object.assign.apply(null,[box,{value:0}]);",
    "Reflect.apply(Object.assign,null,[box,{value:0}]);",
    "const assign=Object.assign.bind(null);assign(box,{value:0});",
  ])("supplies the assignment target as setter receiver: %s", (call) => {
    expect(
      ipcAfter(`const box={set value(v){this.Q=other}};${call}`),
    ).toMatchObject([{ channel: "kept" }]);
  });

  it.each([
    "const base={set value(v){this.Q=other}},box={__proto__:base};Object.assign(box,{value:0});",
    "const box={get value(){this.Q=other;return 0}};Object.assign(box,{value:0});",
    "const box={set value(v){this.Q=other},other:0};Object.assign(box,{value:0,other:1});",
    "const box={set value(v){this.Q=other}};Object.assign(box,{value:0},{value:1});",
    "const box={set value(v){this.Q=other}};Object.assign(box,{__proto__:{extra:0},value:0});",
    "let box={set value(v){this.Q=other}};Object.assign(box,{value:(box={},0)});",
  ])("preserves local assignment descriptor semantics: %s", (setup) => {
    expect(ipcAfter(setup)).toMatchObject([{ channel: "kept" }]);
  });

  it.each([
    "Object.assign=other;Object.assign(box,{value:0});",
    "Object.assign.call=other;Object.assign.call(null,box,{value:0});",
    "external(box);Object.assign(box,{value:0});",
    "Object.assign(box,source);",
    "Object.assign(box,...sources);",
    "Object.assign(box,{...source});",
    "external(Object.assign(box,{value:0}));",
    "const assigned=Object.assign(box,{value:0});external(assigned);",
    "const assign=Object.assign.bind(null,box);external(assign({value:0}));",
    "external(Reflect.apply(Object.assign,null,[box,{value:0}]));",
    "function copy(){return Object.assign(box,{value:0})}external(copy());",
    'Object.assign(box,{get value(){Object.getOwnPropertyDescriptor(box,"value").set.call(globalThis,0);return 0}});',
    'Object.assign(box,{value:(Object.defineProperty(box,"value",{set:other}),0)});',
  ])("keeps unknown assignment effects: %s", (call) => {
    expect(ipcAfter(`const box={set value(v){this.Q=other}};${call}`)).toEqual(
      [],
    );
  });

  it.each([
    'const box={set first(v){Object.defineProperty(this,"second",{set:other})},set second(v){this.Q=other}};Object.assign(box,{first:0,second:0});',
    "class Box{static set value(v){this.Q=other}}external(Object.assign(Box,{value:0}));",
    'function Box(){}Object.defineProperty(Box,"value",{set(v){this.Q=other}});external(Object.assign(Box,{value:0}));',
    "external(Object.assign(1,{run(){this.Q=other}}));",
  ])(
    "retains uncertainty across writes and returned target kinds: %s",
    (setup) => {
      expect(ipcAfter(setup)).toEqual([]);
    },
  );
});
