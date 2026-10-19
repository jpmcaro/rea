import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import { analyzeParsedJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const analyze = (source: string) => {
  const parsed = parseJavaScriptSource(source, "bundle.js");
  if (parsed === null) throw new Error("Expected parsed source");
  return analyzeParsedJavaScriptStaticSource(source, parsed);
};

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';
const USE = 'Q("electron").ipcRenderer.send("kept");';

describe("native accessor invocation integrity", () => {
  it("retains effects when an exposed intrinsic owner replaces assignment", () => {
    const source = `${SHIM}patch(Object);const box={set value(v){this.Q=other}};Object.assign(box,{value:0});${USE}`;
    let actual = 0;
    let replacement = 0;
    runInNewContext(
      `function patch(owner){owner.assign=function(target){Object.getOwnPropertyDescriptor(target,"value").set.call(globalThis,0)}}${source}`,
      {
        require: () => ({ ipcRenderer: { send: () => actual++ } }),
        other: () => ({ ipcRenderer: { send: () => replacement++ } }),
      },
    );
    expect([actual, replacement]).toEqual([0, 1]);
    expect(analyze(source).electron.ipc).toEqual([]);
  });
});

describe("native accessor owner capture", () => {
  it.each([
    "patch(Object);Object.assign(box,{value:0});",
    "const owner=Object;patch(owner);Object.assign(box,{value:0});",
    'patch(Reflect);Reflect.set(box,"value",0);',
    "patch(Object.assign);Object.assign.call(null,box,{value:0});",
    "patch(Function.prototype);Object.assign.call(null,box,{value:0});",
    "patch(Reflect);Reflect.apply(Object.assign,null,[box,{value:0}]);",
  ])("retains calls through exposed helper owners: %s", (call) => {
    expect(
      analyze(`${SHIM}const box={set value(v){this.Q=other}};${call}${USE}`)
        .electron.ipc,
    ).toEqual([]);
  });

  it.each([
    "const assign=Object.assign;patch(Object);assign(box,{value:0});",
    "const assign=Object.assign.bind(null);patch(Object);assign(box,{value:0});",
    "Object.assign(box,{value:(patch(Object),0)});",
    "patch(Object.assign);Object.assign(box,{value:0});",
    'const set=Reflect.set;patch(Reflect);set(box,"value",0);',
  ])(
    "preserves helper identity captured before an owner escape: %s",
    (call) => {
      expect(
        analyze(`${SHIM}const box={set value(v){this.Q=other}};${call}${USE}`)
          .electron.ipc,
      ).toMatchObject([{ channel: "kept" }]);
    },
  );
});
