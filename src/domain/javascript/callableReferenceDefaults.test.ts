import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';
const READ = 'new (Q("electron").BrowserWindow)({});';

describe("callable own slots in destructuring defaults", () => {
  it.each([
    "const {prototype:target=globalThis}=function(){};",
    "const {prototype:target=globalThis}=function*(){};",
    "const {prototype:target=globalThis}=async function*(){};",
    "const {nested:{prototype:target=globalThis}}={nested:function(){}};",
    "const {prototype:target=globalThis}={__proto__:function(){}};",
    "const {name:target=globalThis}=function(){};",
    "const {length:target=globalThis}=function(){};",
    "const {name:target=globalThis}=()=>{};",
    "const {length:target=globalThis}=async()=>{};",
    "const {name:target=globalThis}=async function(){};",
    "const {length:target=globalThis}=function*(){};",
    "const {method:{name:target=globalThis}}={method(){}};",
    "const {method:{length:target=globalThis}}={async method(){}};",
    "const {method:{prototype:target=globalThis}}={*method(){}};",
    "const {method:{prototype:target=globalThis}}={async *method(){}};",
    "const {prototype:target=globalThis,prototype:saved,t:unused=(saved.constructor.prototype=undefined)}=function(){};",
    "const {prototype:target=globalThis}=class {};",
    "const {name:target=globalThis}=class Named {};",
    "const {length:target=globalThis}=class {};",
    "const {nested:{prototype:target=globalThis}}={nested:class {}};",
    "const {prototype:target=globalThis}={__proto__:class {}};",
  ])(
    "excludes a fallback after selecting a guaranteed own slot: %s",
    (setup) => {
      expect(
        analyzeJavaScriptStaticSource(`${SHIM}${setup}target.Q=other;${READ}`)
          .electron.browser_windows,
      ).toHaveLength(1);
    },
  );

  it.each([
    "const {prototype:target=globalThis}=()=>{};",
    "const {prototype:target=globalThis}=async()=>{};",
    "const {prototype:target=globalThis}=async function(){};",
    "const {method:{prototype:target=globalThis}}={method(){}};",
    "const {method:{prototype:target=globalThis}}={async method(){}};",
    "const {prototype:{missing:target=globalThis}}=function(){};",
    "const {name:{missing:target=globalThis}}=function(){};",
    "const {method:{name:target=globalThis}}={get method(){return unknown}};",
    "const source=function(){};source.prototype=undefined;const {prototype:target=globalThis}=source;",
    "const {prototype:saved,t:unused=(saved.constructor.prototype=undefined),prototype:target=globalThis}=function(){};",
    "const {prototype:saved,[(saved.constructor.prototype=undefined,'unused')]:unused,prototype:target=globalThis}=function(){};",
    "const {prototype:{missing:target=globalThis}}=class {};",
    "const {name:target=globalThis}=class {static name};",
    "const {length:target=globalThis}=class {static length=undefined};",
    "const {name:target=globalThis}=class {static get name(){return undefined}};",
    "const {length:target=globalThis}=class {static set length(value){}};",
    "const {prototype:target=globalThis}=class {static {globalThis.Q=other}};",
    "const {prototype:target=globalThis}=class extends (globalThis.Q=other,class {}) {};",
    'const {prototype:target=globalThis}=class {[(globalThis.Q=other,"method")](){}};',
    "const {prototype:target=globalThis}=class {static field=(globalThis.Q=other)};",
  ])(
    "retains a possible fallback for an absent or changed slot: %s",
    (setup) => {
      expect(
        analyzeJavaScriptStaticSource(`${SHIM}${setup}target.Q=other;${READ}`)
          .electron.browser_windows,
      ).toEqual([]);
    },
  );
});

describe("array length in destructuring defaults", () => {
  it.each([
    "const {length:target=globalThis}=[];",
    "const {length:target=globalThis}=[,,];",
    "const {nested:{length:target=globalThis}}={nested:[]};",
    "const {0:{length:target=globalThis}}=[[]];",
    "const {length:target=globalThis}={__proto__:[]};",
  ])("excludes a fallback for a defined length: %s", (setup) => {
    expect(
      analyzeJavaScriptStaticSource(
        `${SHIM}${setup}if(typeof target==="object")target.Q=other;${READ}`,
      ).electron.browser_windows,
    ).toHaveLength(1);
  });

  it.each([
    "const {0:target=globalThis}=[,];",
    "const {0:target=globalThis}=[...unknown];",
    "const {length:{missing:target=globalThis}}=[];",
    "const {length:target=globalThis}={__proto__:{}};",
    "const {length:target=globalThis}=[...(globalThis.Q=other,[])];",
  ])("retains missing slots and evaluated source effects: %s", (setup) => {
    expect(
      analyzeJavaScriptStaticSource(
        `${SHIM}${setup}if(typeof target==="object")target.Q=other;${READ}`,
      ).electron.browser_windows,
    ).toEqual([]);
  });
});

describe("eager keys before destructuring defaults", () => {
  const commonJsRead = 'new(require("electron").BrowserWindow)({});';

  it.each([
    "{[void(saved.x=undefined)](){}}",
    "{[void(saved.x=undefined)]:0}",
    '{[(saved.x=undefined,"key")](){}}',
    "class {[void(saved.x=undefined)](){}}",
    "class {static [void(saved.x=undefined)](){}}",
    "class {[void(saved.x=undefined)]=0}",
    'class {[(saved.x=undefined,"key")](){}}',
  ])(
    "retains a fallback after an evaluated key changes its input: %s",
    (earlier) => {
      expect(
        analyzeJavaScriptStaticSource(
          `const {a:saved,t:unused=${earlier},a:{x:target=module}}={a:{x:{}}};target.require=other;${commonJsRead}`,
        ).electron.browser_windows,
      ).toEqual([]);
    },
  );

  it.each([
    '{["key"](){saved.x=undefined}}',
    "{[void 0](){saved.x=undefined}}",
    'class {["key"](){saved.x=undefined}}',
    "class {[void 0](){saved.x=undefined}}",
    "class {constructor(){saved.x=undefined} field=(saved.x=undefined)}",
    "class {static method(){saved.x=undefined}}",
  ])(
    "excludes a fallback after inert keys and deferred bodies: %s",
    (earlier) => {
      expect(
        analyzeJavaScriptStaticSource(
          `const {a:saved,t:unused=${earlier},a:{x:target=module}}={a:{x:{}}};target.require=other;${commonJsRead}`,
        ).electron.browser_windows,
      ).toHaveLength(1);
    },
  );
});
