import { runInNewContext } from "node:vm";

import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';
const USE =
  "target.fetch=other;target.Q=other;fetch('/kept');new(Q('electron').BrowserWindow)({});";

const changedHomes = [
  [
    "object setter call",
    "const a={get value(){return {}}};const b={get value(){return globalThis}};const c={__proto__:a,get result(){return super.value}};Object.setPrototypeOf(c,b);const target=c.result;",
  ],
  [
    "object legacy setter",
    "const a={get value(){return {}}};const b={get value(){return globalThis}};const c={__proto__:a,get result(){return super.value}};c.__proto__=b;const target=c.result;",
  ],
  [
    "object Reflect setter",
    "const a={get value(){return {}}};const b={get value(){return globalThis}};const c={__proto__:a,get result(){return super.value}};Reflect.setPrototypeOf(c,b);const target=c.result;",
  ],
  [
    "object without a literal prototype",
    "const b={get value(){return globalThis}};const c={get result(){return super.value}};Object.setPrototypeOf(c,b);const target=c.result;",
  ],
  [
    "class instance",
    "class A{get value(){return {}}}class B extends A{get result(){return super.value}}const p={get value(){return globalThis}};Object.setPrototypeOf(B.prototype,p);const target=new B().result;",
  ],
  [
    "class static",
    "class A{static get value(){return {}}}class B extends A{static get result(){return super.value}}class P{static get value(){return globalThis}}Object.setPrototypeOf(B,P);const target=B.result;",
  ],
  [
    "class instance data slot",
    "class A{}class B extends A{get result(){return super.value}}Object.setPrototypeOf(B.prototype,{value:globalThis});const target=new B().result;",
  ],
  [
    "class static data slot",
    "class A{}class B extends A{static get result(){return super.value}}Object.setPrototypeOf(B,{value:globalThis});const target=B.result;",
  ],
] as const;

const verify = (setup: string, expected: number): void => {
  const calls: string[] = [];
  const original = function () {
    calls.push("original");
  };
  const replacement = function () {
    calls.push("replacement");
  };
  const source = SHIM + setup + USE;
  runInNewContext(
    source,
    {
      require: () => ({ BrowserWindow: original }),
      fetch: original,
      other: () => {
        replacement();
        return { BrowserWindow: replacement };
      },
    },
    { timeout: 1000 },
  );
  expect(calls).toEqual(
    expected === 1
      ? ["original", "original"]
      : ["replacement", "replacement", "replacement"],
  );
  const result = analyzeJavaScriptStaticSource(source);
  expect(
    result.endpoints.filter(({ mechanism }) => mechanism === "call:fetch"),
  ).toHaveLength(expected);
  expect(result.electron.browser_windows).toHaveLength(expected);
};

it.each(changedHomes)(
  "follows the current super home prototype for %s",
  (_name, setup) => verify(setup, 0),
);

it.each([
  "const box={};function get(){return box}const obj=get();box.value=globalThis;const target=obj.value;",
  "const box={};function get(){return box}const obj=get();const holder={};holder.p={value:globalThis};Object.setPrototypeOf(box,holder.p);const target=obj.value;",
  "const box={};function get(){return box}const obj=get();const holder={};holder.p={value:globalThis};box.__proto__=holder.p;const target=obj.value;",
  "const box={};function get(){return box}const obj=get();Object.prototype.bridge={value:globalThis};Object.setPrototypeOf(box,({}).bridge);const target=obj.value;",

  "const box={};const obj={get result(){return box}}.result;Object.setPrototypeOf(box,{value:globalThis});const target=obj.value;",
  "const box={};const a={value:box};const c={__proto__:a,get result(){return super.value}};const obj=c.result;box.value=globalThis;const target=obj.value;",
  "const holder={};const box={get value(){return holder.x}};function get(){return box}const obj=get();holder.x=globalThis;const target=obj.value;",
  "const holder={};const box={get value(){return holder.x}};const obj={get result(){return box}}.result;holder.x=globalThis;const target=obj.value;",
  "const holder={};class C{static get value(){return holder.x}}function get(){return C}const obj=get();holder.x=globalThis;const target=obj.value;",
  "const a={value:{}};const b={value:globalThis};const c={__proto__:a,get result(){Object.setPrototypeOf(c,b);return super.value}};const target=c.result;",
  "const a={value:{}};const b={value:globalThis};const c={__proto__:a,get result(){return ()=>super.value}};const get=c.result;Object.setPrototypeOf(c,b);const target=get();",
])("retains writes before a later consumer reads %s", (setup) =>
  verify(setup, 0),
);

it.each([
  "class A{get value(){return {}}}class B extends A{set __proto__(v){}get result(){return super.value}}B.prototype.__proto__={value:globalThis};const target=new B().result;",
  "class A{get value(){return {}}}class B extends A{get result(){return super.value}}Object.defineProperty(B.prototype,'__proto__',{value:null,writable:true});B.prototype.__proto__={value:globalThis};const target=new B().result;",
  "class A{get value(){return {}}set __proto__(v){}}class B extends A{get result(){return super.value}}B.prototype.__proto__={value:globalThis};const target=new B().result;",
  "class A{}class B extends A{}Object.setPrototypeOf(B.prototype,{value:globalThis});const target=({...B.prototype}).value??{};",
  "class A{}class B extends A{}Object.setPrototypeOf(B.prototype,{value:globalThis});const holder={p:B.prototype};const target=({...holder.p}).value??{};",
  "Object.prototype.value={};const c={get result(){return super.value}};const target=c.result;Object.prototype.value=globalThis;",
  "Object.prototype.value={};class B{get result(){return super.value}}const target=new B().result;Object.prototype.value=globalThis;",
  "Function.prototype.value={};class B{static get result(){return super.value}}const target=B.result;Function.prototype.value=globalThis;",
  "const a={value:{}};const b={value:globalThis};const c={__proto__:a,get result(){return super.value}};function get(){return c.result}const target=get();Object.setPrototypeOf(c,b);",
  "const a={value:{}};const b={value:globalThis};const c={__proto__:a,get result(){return super.value}};const d={get value(){return c.result}};const target=d.value;Object.setPrototypeOf(c,b);",
  "const a={get value(){return {}}};const b={get value(){return {}}};const c={__proto__:a,get result(){return super.value}};Object.setPrototypeOf(c,b);const target=c.result;",
  "class A{get value(){return {}}}class B extends A{get result(){return super.value}}const p={get value(){return {}}};Object.setPrototypeOf(B.prototype,p);const target=new B().result;",
  "const a={value:{}};const b={value:globalThis};const c={__proto__:a,get result(){return super.value}};const target=c.result;Object.setPrototypeOf(c,b);",
])("preserves local selections and earlier captures for %s", (setup) =>
  verify(setup, 1),
);

it.each([
  ["Object prototype", "Object.getPrototypeOf(box)"],
  ["Reflect prototype", "Reflect.getPrototypeOf(box)"],
  ["prototype through call", "Object.getPrototypeOf.call(Object,box)"],
  [
    "prototype through apply",
    "Reflect.apply(Object.getPrototypeOf,Object,[box])",
  ],
])("captures %s during the producing invocation", (_name, read) => {
  verify(
    `const box={__proto__:{}};function get(){return ${read}}const target=get();Object.setPrototypeOf(box,globalThis);`,
    1,
  );
  verify(
    `const box={__proto__:globalThis};function get(){return ${read}}const target=get();Object.setPrototypeOf(box,{});`,
    0,
  );
});

it.each([
  ["object", "{value:{}}", "const {value}=box", "box.value=globalThis"],
  ["array", "[{}]", "const [value]=box", "box[0]=globalThis"],
])(
  "captures a destructured %s slot inside its helper",
  (_name, box, read, mutation) =>
    verify(
      `const box=${box};function get(){${read};return value}const target=get();${mutation};`,
      1,
    ),
);

it.each([
  "const old={value:globalThis};const home={__proto__:old,get result(){return super.value}};Object.setPrototypeOf(home,{value:{}});const target=home.result;",
  "class A{static get value(){return globalThis}}class B extends A{static get result(){return super.value}}Object.setPrototypeOf(B,{value:{}});const target=B.result;",
  "class A{get value(){return globalThis}}class B extends A{get result(){return super.value}}Object.setPrototypeOf(B.prototype,{value:{}});const target=new B().result;",
  "Function.prototype.value=globalThis;class B extends null{static get result(){return super.value}}Object.setPrototypeOf(B,{value:{}});const target=B.result;",
])("selects a prototype replacement made before the invocation: %s", (setup) =>
  verify(setup, 1),
);

it.each([
  "const box={value:globalThis};function make(){const value=box.value;return()=>value}const fn=make();box.value={};const target=fn();",
  "const box={value:globalThis};function make(){const {value}=box;return()=>value}const fn=make();box.value={};const target=fn();",
  "const box={value:globalThis};function make(){const value=box.value;return {get result(){return value}}}const obj=make();box.value={};const target=obj.result;",
])("does not retime a closed-over initializer to its consumer: %s", (setup) =>
  verify(setup, 0),
);

it.each([
  "const box={value:globalThis};let saved;function get(reuse){if(!reuse)saved=box.value;return saved}get(false);box.value={};const target=get(true);",
  "const box={value:globalThis};let saved;function get(reuse){if(!reuse){const {value}=box;saved=value}return saved}get(false);box.value={};const target=get(true);",
  "const box={value:globalThis};let saved;function read(){return box.value}function get(reuse){if(!reuse)saved=read();return saved}get(false);box.value={};const target=get(true);",
  "const box={value:globalThis};let saved;const c={get result(){return box.value}};function get(reuse){if(!reuse)saved=c.result;return saved}get(false);box.value={};const target=get(true);",
  "const box={value:globalThis};let saved;let first=true;const c={get result(){if(first){saved=box.value;first=false}return saved}};c.result;box.value={};const target=c.result;",
  "const box={value:globalThis};const cache={};function get(reuse){if(!reuse)cache.saved=box.value;return cache.saved}get(false);box.value={};const target=get(true);",
])("preserves a capture saved during an earlier activation: %s", (setup) =>
  verify(setup, 0),
);

it.each([
  "class A{get value(){return globalThis}}class B extends A{get result(){return super.value}}Object.preventExtensions(B.prototype);Reflect.setPrototypeOf(B.prototype,{value:{}});const target=new B().result;",
  "class A{get value(){return globalThis}}class B extends A{get result(){return super.value}}class C{}const flag=false;const selected=flag?B:C;Object.setPrototypeOf(selected.prototype,{value:{}});const target=new B().result;",
  "class A{get value(){return globalThis}}class B extends A{get result(){return super.value}}class C{}let selected=B;selected=C;Object.setPrototypeOf(selected.prototype,{value:{}});const target=new B().result;",
  "class A{get value(){return globalThis}}class B extends A{get result(){return super.value}}Object.setPrototypeOf=()=>0;Object.setPrototypeOf(B.prototype,{value:{}});const target=new B().result;",
  "class A{get value(){return globalThis}}class B extends A{get result(){return super.value}}if(false)Object.setPrototypeOf(B.prototype,{value:{}});const target=new B().result;",
  "class A{get value(){return globalThis}}class B extends A{get result(){return super.value}}class C extends A{}let selected=C;Object.setPrototypeOf(selected.prototype,(selected=B,{value:{}}));const target=new B().result;",
  "class A{get value(){return globalThis}}class B extends A{get result(){return super.value}}class C extends A{}let selected=C;Reflect.setPrototypeOf(selected.prototype,{value:{}},selected=B);const target=new B().result;",
])("requires a completed class prototype replacement proof: %s", (setup) =>
  verify(setup, 0),
);

it.each([
  "const base=null;Function.prototype.value=globalThis;class B extends base{static get result(){return super.value}}const target=B.result;",
  "Function.prototype.value=globalThis;class B extends (0,null){static get result(){return super.value}}const target=B.result;",
  "const base=null;Function.prototype.value=globalThis;class B extends base{}const target=Object.getPrototypeOf(B).value;",
  "const base=null;Function.prototype.value=globalThis;class B extends base{}const target=B.__proto__.value;",
  "const base=null;Function.prototype.value=globalThis;class B extends base{}const Bound=B.bind(null);const target=Object.getPrototypeOf(Bound).value;",
])("retains Function.prototype for a resolved null superclass: %s", (setup) =>
  verify(setup, 0),
);

it.each([
  "const home={__proto__:{value:globalThis},get result(){return super.value}};Reflect.setPrototypeOf(home,{__proto__:home,value:{}});const target=home.result;",
  "const home={__proto__:{value:globalThis},get result(){return super.value}};Object.preventExtensions(home);Reflect.setPrototypeOf(home,{value:{}});const target=home.result;",
  "class A{get value(){return globalThis}}class B extends A{get result(){return super.value}}Reflect.setPrototypeOf(B.prototype,{__proto__:B.prototype,value:{}});const target=new B().result;",
  "const home={__proto__:{value:globalThis},get result(){return super.value}};const p={value:{}};Reflect.setPrototypeOf(home,p,Object.setPrototypeOf(p,home));const target=home.result;",
  "const home={__proto__:{value:globalThis},get result(){return super.value}};const bad={__proto__:home,value:{}};let p=bad;Reflect.setPrototypeOf(home,p,(p={value:{}}));const target=home.result;",
])("does not certify a failed Reflect prototype change: %s", (setup) =>
  verify(setup, 0),
);
