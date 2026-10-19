import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { onlyCallable } from "./javascriptSemanticAnalysis.fixture.js";

const verify = (setup: string, expected: number): void => {
  const source = `${setup}if(target)target.fetch=other;fetch('/kept');`;
  const calls: string[] = [];
  runInNewContext(source, {
    fetch: () => calls.push("original"),
    other: () => calls.push("replacement"),
  });
  expect(calls).toEqual([expected === 1 ? "original" : "replacement"]);
  expect(
    analyzeJavaScriptStaticSource(source).endpoints.filter(
      ({ mechanism }) => mechanism === "call:fetch",
    ),
  ).toHaveLength(expected);
};

describe("default proof preserves the selected read path", () => {
  it.each([
    "const {missing,x:target=globalThis}={x:{},pattern:/x/};",
    "const {missing,x:target=globalThis}={x:{},nested:{pattern:/x/}};",
    "const {missing,x:target=globalThis}={x:{},patterns:[/x/]};",
    "const {pattern,missing,x:target=globalThis}={x:{},pattern:/x/};",
    "const {missing,nested:{x:target=globalThis}}={nested:{x:{}},pattern:/x/};",
    "const {missing,x:target=globalThis}={x:class{},pattern:/x/};",
    "const {missing,x:target=globalThis}={x:{},callable:function(){}};",
    "const {missing,x:target=globalThis}={x:{},callable:class{}};",
  ])("does not let an unread RegExp invalidate %s", (setup) =>
    verify(setup, 1),
  );

  it.each([
    "Object.defineProperty(Object.getPrototypeOf(/x/),'source',{get(){this.lastIndex=undefined}});const {source:ignored,lastIndex:target=globalThis}=/y/;",
    "Object.defineProperty(Object.getPrototypeOf(/x/),'source',{get(){this.lastIndex=undefined}});const {pattern:{source:ignored,lastIndex:target=globalThis}}={pattern:/y/};",
    "Object.defineProperty(Object.getPrototypeOf(/x/),'source',{get(){this.lastIndex=undefined}});const {source:ignored,lastIndex:target=globalThis}={__proto__:/y/};",
  ])("retains effects through a read RegExp in %s", (setup) =>
    verify(setup, 0),
  );
});

describe("inherited callable reads before a default selection", () => {
  it.each(["function(){}", "class{}", "{__proto__:function(){}}"])(
    "retains effects from Function.prototype for %s",
    (value) =>
      verify(
        `Object.defineProperty(Function.prototype,'touch',{get(){this.prototype.constructor=undefined;return 0}});const {touch:ignored,prototype:{constructor:target=globalThis}}=${value};`,
        0,
      ),
  );
});

describe("boxed primitive reads before a default selection", () => {
  it.each([
    ["Number", "1"],
    ["Boolean", "true"],
    ["BigInt", "1n"],
  ])("retains effects from %s.prototype", (owner, value) =>
    verify(
      `Object.defineProperty(${owner}.prototype,'mutate',{get(){saved.value=undefined;return 0}});const {helper:saved,number:{mutate:ignored},helper:{value:target=globalThis}}=class{static helper={value:{}};static number=${value}};`,
      0,
    ),
  );
});

describe("unmodeled prototype reads in otherwise inert sources", () => {
  it.each([
    "Object.defineProperty(Function.prototype,'mutate',{get(){Object.defineProperty(this,'name',{value:undefined});return 0}});const {f:{mutate:ignored,name:target=globalThis}}={f:function(){},pattern:/x/};",
    "Object.defineProperty(Number.prototype,'mutate',{get(){saved.value=undefined;return 0}});const {helper:saved,number:{mutate:ignored},helper:{value:target=globalThis}}={helper:{value:{}},number:1,pattern:/x/};",
    "Object.defineProperty(Object.getPrototypeOf(function*(){}.prototype),'mutate',{get(){saved.value=undefined;return 0}});const {helper:saved,fn:{prototype:{mutate:ignored}},helper:{value:target=globalThis}}={helper:{value:{}},fn:function*(){},pattern:/x/};",
    "Object.defineProperty(Object.getPrototypeOf(async function*(){}.prototype),'mutate',{get(){saved.value=undefined;return 0}});const {helper:saved,fn:{prototype:{mutate:ignored}},helper:{value:target=globalThis}}={helper:{value:{}},fn:async function*(){},pattern:/x/};",
  ])("preserves a mutation before the selected read in %s", (setup) =>
    verify(setup, 0),
  );
});

describe("fresh callable prototype constructor projections", () => {
  it.each([
    "const {prototype:{constructor:target=globalThis}}=function(){};",
    "const {prototype:{constructor:target=globalThis}}=class{};",
    "const {value:{prototype:{constructor:target=globalThis}}}={value:function(){}};",
    "const {prototype:{constructor:{prototype:{constructor:target=globalThis}}}}=function(){};",
    "const {prototype:{constructor:target=globalThis}}=class{['constructor'](){}};",
  ])("continues the own constructor path in %s", (setup) => verify(setup, 1));

  it.each([
    "const {prototype:{constructor:target=globalThis}}=class{get ['constructor'](){return undefined}};",
    "const {prototype:{mutate:ignored,constructor:target=globalThis}}=class{get mutate(){this.constructor=undefined;return 0}};",
    "const {prototype:saved,unused=(saved.constructor=undefined),prototype:{constructor:target=globalThis}}=function(){};",
    "const source=function(){};source.prototype.constructor=undefined;const {prototype:{constructor:target=globalThis}}=source;",
  ])("retains changed constructor slots in %s", (setup) => verify(setup, 0));
});

describe("physical prototype and boxed metadata reads", () => {
  it.each([
    "Object.defineProperty(Object.getPrototypeOf({}),'mutate',{get(){this.constructor=undefined;return 0}});const {prototype:{mutate:ignored,constructor:target=globalThis}}=function(){};",
    "Object.defineProperty(Object.getPrototypeOf({}),'mutate',{get(){this.constructor=undefined;return 0}});const {prototype:{mutate:ignored,constructor:target=globalThis}}=class{};",
    "const getPrototype=Reflect.getPrototypeOf;Object.defineProperty(getPrototype({}),'missing',{get(){this.x=undefined;return 0}});const {missing,x:target=globalThis}={x:{},pattern:/x/};",
    "Object.defineProperty(({}).__proto__,'missing',{get(){this.x=undefined;return 0}});const {missing,x:target=globalThis}={x:{},pattern:/x/};",
    "Object.defineProperty(Number.prototype,'mutate',{get(){saved.constructor=undefined;return 0}});const {prototype:saved,length:{mutate:ignored},prototype:{constructor:target=globalThis}}=function(){};",
    "Object.defineProperty(Number.prototype,'mutate',{get(){saved.value=undefined;return 0}});const {helper:saved,list:{length:{mutate:ignored}},helper:{value:target=globalThis}}=class{static helper={value:{}};static list=[]};",
    "Object.defineProperty(Number.prototype,'mutate',{get(){saved.value=undefined;return 0}});const {helper:saved,regex:{lastIndex:{mutate:ignored}},helper:{value:target=globalThis}}=class{static helper={value:{}};static regex=/x/};",
    "Function.prototype[Symbol.iterator]=function*(){yield undefined};const [target=globalThis]=class{static[0]={}};",
  ])("keeps an earlier effect reachable in %s", (setup) => verify(setup, 0));

  it.each(["{}", "0", "1n"])(
    "preserves known literal array iteration over %s",
    (value) => verify(`const [target=globalThis]=[${value}];`, 1),
  );
});

describe("prototype captures before a default selection", () => {
  it.each([
    "[].constructor.prototype[Symbol.iterator]=function*(){yield undefined};const [target=globalThis]=[/x/];",
    "const {__proto__:p}=[];p[Symbol.iterator]=function*(){yield undefined};const [target=globalThis]=[/x/];",
    "const {constructor:{prototype:p}}=[];p[Symbol.iterator]=function*(){yield undefined};const [target=globalThis]=[/x/];",
    "const key='__proto__';const p=[][key];p[Symbol.iterator]=function*(){yield undefined};const [target=globalThis]=[/x/];",
    "Object.getPrototypeOf([][Symbol.iterator]()).next=function(){return {done:false,value:undefined}};const [target=globalThis]=[/x/];",
    "Object.defineProperty(({}).constructor.prototype,'mutate',{get(){this.x=undefined;return 0}});const {mutate:ignored,x:target=globalThis}={x:{},pattern:/x/};",
    "const {__proto__:p}={};Object.defineProperty(p,'mutate',{get(){this.x=undefined;return 0}});const {mutate:ignored,x:target=globalThis}={x:{},pattern:/x/};",
    "const key='__proto__';const p={}[key];Object.defineProperty(p,'mutate',{get(){this.x=undefined;return 0}});const {mutate:ignored,x:target=globalThis}={x:{},pattern:/x/};",
    "const {getPrototypeOf:get}=Reflect;const p=get({});Object.defineProperty(p,'mutate',{get(){this.x=undefined;return 0}});const {mutate:ignored,x:target=globalThis}={x:{},pattern:/x/};",
    "const R=Reflect;const p=R.getPrototypeOf({});Object.defineProperty(p,'mutate',{get(){this.x=undefined;return 0}});const {mutate:ignored,x:target=globalThis}={x:{},pattern:/x/};",
  ])("retains effects through %s", (setup) => verify(setup, 0));
});

describe("iteration inputs own their nested default selections", () => {
  it.each([
    [
      "Array.prototype[Symbol.iterator]=function*(){yield {nested:undefined}};for(const {nested:[copy]=source} of [{nested:[]}]){}",
      false,
      "changed",
    ],
    [
      "for await(const {nested:[copy]=source} of [{nested:[],pattern:/x/,then(resolve){resolve({nested:undefined})}}]){}",
      true,
      "changed",
    ],
    [
      "for(const {nested:[copy]=source} of [{nested:[]},{nested:[]}]){}",
      false,
      "TOKEN",
    ],
    [
      "for(const {nested:[copy]=source} of [{nested:[]},{nested:undefined}]){}",
      false,
      "changed",
    ],
  ] as const)(
    "preserves runtime selection in %s",
    async (iteration, isAsync, expected) => {
      const body = `const source={*[Symbol.iterator](){this.value='changed';yield 0},value:'TOKEN'};${iteration}return source.value;`;
      const prefix = isAsync ? "async " : "";
      const runtime: unknown = await runInNewContext(
        `(${prefix}function(){${body}})()`,
      );
      expect(runtime).toBe(expected);
      const ir = analyzeJavaScriptSemantics(
        `export ${prefix}function result(){${body}}`,
      );
      const value = onlyCallable(ir, "result").returnSites[0]?.value;
      if (expected === "TOKEN")
        expect(value).toEqual({ status: "literal", value: "TOKEN" });
      else expect(value?.status).toBe("unknown");
    },
  );
});

describe("inert static data initialization", () => {
  it.each([
    "const {helper:target=globalThis}=class{static helper={}};",
    "const {helper:target=globalThis}=class{static helper=[]};",
    "const {helper:target=globalThis}=class{static helper=-1};",
    "const {helper:target=globalThis}=class{static helper=-1n};",
    "const {helper:target=globalThis}=class{static helper=function(){}};",
    "const {helper:target=globalThis}=class{static ['helper']={}};",
    "const {name:target=globalThis}=class{static name={}};",
    "const {helper:target=globalThis}=class{static helper;static helper={}};",
    "const {helper:target=globalThis}=class{static helper={};static helper(){}};",
    "const {helper:{value:target=globalThis}}=class{static helper={value:{}}};",
  ])("keeps an initialized own data field in %s", (setup) => verify(setup, 1));

  it.each([
    "const {helper:target=globalThis}=class{static helper={};static helper};",
    "const {helper:target=globalThis}=class{static helper(){};static helper=void 0};",
    "const {name:target=globalThis}=class{static name};",
    "const {helper:target=globalThis}=class{static helper={};static effect=(globalThis.fetch=other)};",
    "const {helper:target=globalThis}=class{static get helper(){return undefined}};",
  ])("retains absent or effectful initialization in %s", (setup) =>
    verify(setup, 0),
  );
});
