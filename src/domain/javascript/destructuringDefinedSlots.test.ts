import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

describe("destructuring defined source slots", () => {
  it.each([
    [
      "own static method",
      "const {helper:target=globalThis}=class{static helper(){}};",
    ],
    [
      "literal computed static method",
      'const {helper:target=globalThis}=class{static ["helper"](){}};',
    ],
    [
      "inherited static method from a literal prototype",
      "const {helper:target=globalThis}={__proto__:class{static helper(){}}};",
    ],
    [
      "nested static method",
      "const {value:{helper:target=globalThis}}={value:class{static helper(){}}};",
    ],
    ["string length", 'const {length:target=globalThis}="x";'],
    ["empty string length", 'const {length:target=globalThis}="";'],
    ["string index", 'const {0:target=globalThis}="x";'],
    ["fresh RegExp lastIndex", "const {lastIndex:target=globalThis}=/x/;"],
    [
      "computed RegExp lastIndex",
      'const {["lastIndex"]:target=globalThis}=/x/g;',
    ],
    [
      "nested RegExp lastIndex",
      "const {value:{lastIndex:target=globalThis}}={value:/x/};",
    ],
    [
      "RegExp lastIndex inherited from a literal prototype",
      "const {lastIndex:target=globalThis}={__proto__:/x/};",
    ],
    [
      "own RegExp lastIndex over a prototype accessor",
      "Object.defineProperty(RegExp.prototype,'lastIndex',{get(){return undefined}});const {lastIndex:target=globalThis}=/x/;",
    ],
    [
      "RegExp slot captured before a later default mutates it",
      "const {value:saved,value:{lastIndex:target=globalThis},unused=(saved.lastIndex=undefined)}={value:/x/};",
    ],
    [
      "RegExp slot captured before a later prototype getter mutates it",
      "Object.defineProperty(RegExp.prototype,'source',{get(){this.lastIndex=undefined}});const {lastIndex:target=globalThis,source:ignored}=/x/;",
    ],
    [
      "nested string length",
      'const {value:{length:target=globalThis}}={value:"x"};',
    ],
  ])("excludes the fallback for %s", (_name, setup) => {
    expect(
      runInNewContext(
        `const original=fetch;${setup}target.fetch=other;fetch===original;`,
        { fetch() {}, other() {} },
      ),
    ).toBe(true);
    expect(
      analyzeJavaScriptStaticSource(
        `${setup}target.fetch=other;fetch('/local');`,
      ).endpoints.filter(({ mechanism }) => mechanism === "call:fetch"),
    ).toMatchObject([{ value: "/local" }]);
  });
});

describe("destructuring missing or mutable source slots", () => {
  it.each([
    [
      "unknown computed static method",
      'const key="other";const {helper:target=globalThis}=class{static [key](){}};',
    ],
    [
      "static accessor",
      "const {helper:target=globalThis}=class{static get helper(){return undefined}};",
    ],
    [
      "static accessor replacing a method",
      "const {helper:target=globalThis}=class{static helper(){}static get helper(){return undefined}};",
    ],
    ["instance method", "const {helper:target=globalThis}=class{helper(){}};"],
    [
      "static field replacing a method",
      "const {helper:target=globalThis}=class{static helper(){}static helper=undefined};",
    ],
    [
      "static block removing a method",
      "const {helper:target=globalThis}=class{static helper(){}static{delete this.helper}};",
    ],
    [
      "named class mutation",
      "const source=class{static helper(){}};source.helper=undefined;const {helper:target=globalThis}=source;",
    ],
    [
      "earlier default mutating the class",
      "const {prototype:{constructor:saved},unused=(saved.helper=undefined),helper:target=globalThis}=class{static helper(){}};",
    ],
    ["missing string index", 'const {1:target=globalThis}="x";'],
    ["missing RegExp property", "const {missing:target=globalThis}=/x/;"],
    [
      "property below RegExp lastIndex",
      "const {lastIndex:{missing:target=globalThis}}=/x/;",
    ],
    [
      "RegExp lastIndex changed through an alias",
      "const source=/x/,alias=source;alias.lastIndex=undefined;const {lastIndex:target=globalThis}=source;",
    ],
    [
      "RegExp lastIndex redefined as undefined",
      "const source=/x/;Object.defineProperty(source,'lastIndex',{value:undefined});const {lastIndex:target=globalThis}=source;",
    ],
    [
      "earlier default mutating RegExp lastIndex",
      "const {value:saved,unused=(saved.lastIndex=undefined),value:{lastIndex:target=globalThis}}={value:/x/};",
    ],
    [
      "earlier prototype getter mutating RegExp lastIndex",
      "Object.defineProperty(RegExp.prototype,'source',{get(){this.lastIndex=undefined}});const {source:ignored,lastIndex:target=globalThis}=/x/;",
    ],
    [
      "earlier physical prototype getter mutating RegExp lastIndex",
      "Object.defineProperty(Object.getPrototypeOf(/x/),'source',{get(){this.lastIndex=undefined}});const {source:ignored,lastIndex:target=globalThis}=/y/;",
    ],
    [
      "earlier Reflect prototype getter mutating RegExp lastIndex",
      "Object.defineProperty(Reflect.getPrototypeOf(/x/),'source',{get(){this.lastIndex=undefined}});const {source:ignored,lastIndex:target=globalThis}=/y/;",
    ],
    [
      "earlier aliased prototype getter mutating RegExp lastIndex",
      "const getPrototype=Reflect.getPrototypeOf;const prototype=getPrototype(/x/);Object.defineProperty(prototype,'source',{get(){this.lastIndex=undefined}});const {source:ignored,lastIndex:target=globalThis}=/y/;",
    ],
    [
      "earlier legacy prototype getter mutating RegExp lastIndex",
      "Object.defineProperty(/x/.__proto__,'source',{get(){this.lastIndex=undefined}});const {source:ignored,lastIndex:target=globalThis}=/y/;",
    ],
    [
      "accessor replacing a RegExp container value",
      "const source={value:/x/};Object.defineProperty(source,'value',{get(){return {lastIndex:undefined}}});const {value:{lastIndex:target=globalThis}}=source;",
    ],
    [
      "RegExp rest omitting nonenumerable lastIndex",
      "const {...copy}=/x/;const {lastIndex:target=globalThis}=copy;",
    ],
    [
      "RegExp spread omitting nonenumerable lastIndex",
      "const {lastIndex:target=globalThis}={.../x/};",
    ],
    ["noncanonical string index", 'const {"00":target=globalThis}="x";'],
    [
      "ignored string prototype length",
      'const {length:target=globalThis}={__proto__:"x"};',
    ],
    [
      "ignored string prototype index",
      'const {0:target=globalThis}={__proto__:"x"};',
    ],
  ])("retains the fallback for %s", (_name, setup) => {
    expect(
      runInNewContext(
        `const original=fetch;${setup}target.fetch=other;fetch===original;`,
        { fetch() {}, other() {} },
      ),
    ).toBe(false);
    expect(
      analyzeJavaScriptStaticSource(
        `${setup}target.fetch=other;fetch('/local');`,
      ).endpoints.filter(({ mechanism }) => mechanism === "call:fetch"),
    ).toEqual([]);
  });
});
