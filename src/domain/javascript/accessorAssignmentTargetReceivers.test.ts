import { describe, expect, it } from "vitest";

import { analyzeParsedJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';
const USE = 'Q("electron").ipcRenderer.send("kept");';
const ipcAfter = (setup: string) => {
  const source = `${SHIM}${setup}${USE}`;
  const parsed = parseJavaScriptSource(source, "bundle.js");
  if (parsed === null) throw new Error("Expected parsed source");
  return analyzeParsedJavaScriptStaticSource(source, parsed).electron.ipc;
};

const TARGETS = [
  "({x:box.value}={x:0});",
  "[box.value]=[0];",
  "({outer:{x:box.value}}={outer:{x:0}});",
  "[[box.value]]=[[0]];",
  "({...box.value}={x:0});",
  "[...box.value]=[0];",
  "({x:box.value=0}={});",
  "[box.value=0]=[];",
  "for(box.value of [0]){}",
  "for(box.value in {x:0}){}",
  "for({x:box.value} of [{x:0}]){}",
  "for([box.value] of [[0]]){}",
  "for({...box.value} of [{x:0}]){}",
  "for([...box.value] of [[0]]){}",
  "for({x:box.value=0} of [{}]){}",
  "for([box.value=0] of [[]]){}",
  "for({x:box.value} in {x:0}){}",
  "for([box.value] in {x:0}){}",
  "for({...box.value} in {x:0}){}",
];

describe("accessor assignment target receivers", () => {
  it.each(TARGETS)("keeps a local setter receiver for %s", (target) => {
    expect(
      ipcAfter(`const box={set value(v){this.Q=other}};${target}`),
    ).toMatchObject([{ channel: "kept" }]);
  });

  it.each(TARGETS)(
    "retains an explicit global setter write for %s",
    (target) => {
      expect(
        ipcAfter(`const box={set value(v){globalThis.Q=other}};${target}`),
      ).toEqual([]);
    },
  );

  it.each([
    "const box={set value(v){this.Q=other}};({x:box.value}={x:0});external(box);",
    "const box={set value(v){this.Q=other}};[box.value]=[0];Object.getOwnPropertyDescriptor(box,'value').set.call(globalThis,0);",
    "const box={set value(v){this.Q=other}};({[globalThis.Q=other]:box.value}={x:0});",
    "const box={set value(v){this.Q=other}};({x:box.value=(globalThis.Q=other)}={});",
    "const box={set value(v){this.Q=other}};[box.value]=[(globalThis.Q=other)];",
    "const holder={get box(){globalThis.Q=other;return {set value(v){this.Q=other}}}};({x:holder.box.value}={x:0});",
  ])("retains independent escapes and evaluated expressions: %s", (setup) => {
    expect(ipcAfter(setup)).toEqual([]);
  });

  it.each([
    "class Box{set value(v){this.Q=other}}const box=new Box();({x:box.value}={x:0});",
    "class Base{set value(v){this.Q=other}}class Box extends Base{}const box=new Box();[box.value]=[0];",
    "class Box{static set value(v){this.Q=other}}const box=Box;for(box.value of [0]){}",
    "const holder={box:{set value(v){this.Q=other}}};const {box}=holder;for({x:box.value} of [{x:0}]){}",
  ])("shares target selection with other local receivers: %s", (setup) => {
    expect(ipcAfter(setup)).toMatchObject([{ channel: "kept" }]);
  });
});
