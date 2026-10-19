import { createContext, runInContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const verify = (setup: string, expected: number): void => {
  const source = `${setup}if(target)target.fetch=other;fetch('/kept');`;
  const calls: string[] = [];
  const patchPrototype = (value: object): void => {
    let current: object | null = value;
    while (current !== null) {
      Reflect.deleteProperty(current, "toString");
      Reflect.deleteProperty(current, "map");
      current = Object.getPrototypeOf(current) as object | null;
    }
  };
  const context = createContext({
    fetch: () => calls.push("original"),
    other: () => calls.push("replacement"),
    patch: (root: { Object: ObjectConstructor }) => {
      Reflect.deleteProperty(root.Object.prototype, "toString");
    },
    patchPrototype,
  });
  context.external = {
    get value() {
      patchPrototype(runInContext("({})", context) as object);
      return 0;
    },
  };
  runInContext(source, context);
  expect(calls).toEqual([expected ? "original" : "replacement"]);
  expect(
    analyzeJavaScriptStaticSource(source).endpoints.filter(
      ({ mechanism }) => mechanism === "call:fetch",
    ),
  ).toHaveLength(expected);
};

describe("initial inherited literal data slots", () => {
  it.each([
    "const {toString:target=globalThis}={};",
    "const {valueOf:target=globalThis}={};",
    "const {hasOwnProperty:target=globalThis}={};",
    "const {isPrototypeOf:target=globalThis}={};",
    "const {propertyIsEnumerable:target=globalThis}={};",
    "const {toLocaleString:target=globalThis}={};",
    "const {toString:target=globalThis}=[];",
    "const {map:target=globalThis}=[];",
    "const {slice:target=globalThis}=[];",
    "const {hasOwnProperty:target=globalThis}=[];",
    "const {nested:{toString:target=globalThis}}={nested:{}};",
    "const {toString:target=globalThis}={__proto__:{}};",
    "const {toString:target=globalThis}={__proto__:0};",
  ])("excludes the unused fallback in %s", (setup) => verify(setup, 1));

  it.each([
    "const {toString:target=globalThis}={__proto__:null};",
    "const {toString:target=globalThis}={toString:void 0};",
    "const {map:target=globalThis}={};",
    "delete Object.prototype.toString;const {toString:target=globalThis}={};",
    "Object.prototype.toString=undefined;const {toString:target=globalThis}={};",
    "Array.prototype.map=undefined;const {map:target=globalThis}=[];",
    "const base=Object.getPrototypeOf({});base.toString=undefined;const {toString:target=globalThis}={};",
    "const {getPrototypeOf:get}=Reflect;get([]).map=undefined;const {map:target=globalThis}=[];",
    "Object.defineProperty(Object.prototype,'toString',{get(){return undefined}});const {toString:target=globalThis}={};",
    "Object.defineProperty(Function.prototype,'mutate',{get(){saved.x=undefined;return 0}});const {box:saved,toString:{mutate:ignored},box:{x:target=globalThis}}={box:{x:{}}};",
    "patch(globalThis);const {toString:target=globalThis}={};",
    "const root=globalThis;patch(root);const {toString:target=globalThis}={};",
    "const box={root:globalThis};patch(box.root);const {toString:target=globalThis}={};",
    "const get=()=>globalThis;patch(get());const {toString:target=globalThis}={};",
    "eval('delete Object.prototype.toString');const {toString:target=globalThis}={};",
    "(0,eval)('delete Object.prototype.toString');const {toString:target=globalThis}={};",
    "const run=eval;run('delete Object.prototype.toString');const {toString:target=globalThis}={};",
    "const {x=(patch(globalThis),0),toString:target=globalThis}={};",
    "const get=()=>{patch(globalThis);const {toString:target=globalThis}={};return target};const target=get();",
    "patchPrototype({});const {toString:target=globalThis}={};",
    "patchPrototype([]);const {map:target=globalThis}=[];",
    "patchPrototype(function(){});const {toString:target=globalThis}={};",
    "patchPrototype(()=>{});const {toString:target=globalThis}={};",
    "const {toString:fn}={};patchPrototype(fn);const {toString:target=globalThis}={};",
    "external.value;const {toString:target=globalThis}={};",
    "const key={toString(){patchPrototype({});return 'x'}};const prior={[key]:0};const {toString:target=globalThis}={};",
  ])("retains absent, changed or effectful reads in %s", (setup) =>
    verify(setup, 0),
  );
});
