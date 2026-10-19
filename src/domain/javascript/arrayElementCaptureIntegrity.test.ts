import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const LOAD =
  'new(require.call.call(require,null,"electron").BrowserWindow)({});';
const INITIAL = "const holder=[()=>({__proto__:null})];";
const USE = "const o={__proto__:holder[0]?.()};o.toString.call.call=other;";
const windows = (source: string) =>
  analyzeJavaScriptStaticSource(`${source}${LOAD}`).electron.browser_windows;

describe("array element capture integrity", () => {
  it.each([
    "holder.length=0;",
    "const alias=holder;alias.length=0;",
    'Reflect.set(holder,"length",0);',
    'Object.defineProperty(holder,"length",{value:0});',
    'Reflect.defineProperty(holder,"length",{value:0});',
    "Object.defineProperties(holder,{length:{value:0}});",
    "Object.assign(holder,{length:0});",
    "holder.length-=1;",
    "holder.length--;",
    'Object.prototype.value=0;Object.defineProperty(holder,"length",{writable:false});',
    'Object.defineProperty(Object.prototype,"value",{value:0,writable:true});Object.defineProperty(holder,"length",{writable:false});',
    'Reflect.defineProperty(Object.prototype,"value",{value:0,writable:true});Object.defineProperty(holder,"length",{writable:false});',
    'const descriptor={value:1};descriptor.value=0;Object.defineProperty(holder,"length",descriptor);',
    'const key="length";holder[key]=0;',
    "holder[unknown]=0;",
  ])("retains uncertainty after element deletion through %s", (mutation) => {
    expect(windows(`${INITIAL}${mutation}${USE}`)).toEqual([]);
  });

  it.each([
    "holder.length=1;",
    "holder.length=2;",
    'Object.defineProperty(holder,"length",{value:1});',
    'Object.defineProperty(holder,"length",{writable:false});',
    'Object.defineProperty(Object.prototype,"unrelated",{value:0,writable:true});Object.defineProperty(holder,"length",{writable:false});',
    'Object.defineProperty(Object.prototype,"value",{value:0,writable:true});Object.defineProperty(holder,"length",{value:1,writable:false});',
    "holder.unrelated=0;",
  ])("preserves an element after a nontruncating mutation: %s", (mutation) => {
    expect(windows(`${INITIAL}${mutation}${USE}`)).toHaveLength(1);
  });

  it("preserves an element read before a later truncation", () => {
    expect(windows(`${INITIAL}${USE}holder.length=0;`)).toHaveLength(1);
  });

  it("preserves a function captured before truncation", () => {
    expect(
      windows(
        `${INITIAL}const saved=holder[0];holder.length=0;const o={__proto__:saved()};o.toString.call.call=other;`,
      ),
    ).toHaveLength(1);
  });

  it("retains an earlier truncation after a later length extension", () => {
    expect(windows(`${INITIAL}holder.length=0;holder.length=2;${USE}`)).toEqual(
      [],
    );
  });

  it("keeps non-array numeric properties independent of length", () => {
    expect(
      windows(`const holder={0:()=>({__proto__:null})};holder.length=0;${USE}`),
    ).toHaveLength(1);
  });

  it("preserves lower indices when a later element is removed", () => {
    expect(
      windows(
        `const holder=[()=>({__proto__:null}),()=>({__proto__:null})];holder.length=1;${USE}`,
      ),
    ).toHaveLength(1);
  });

  it("invalidates an index at the new length", () => {
    expect(
      windows(
        "const holder=[()=>({__proto__:null}),()=>({__proto__:null})];holder.length=1;const o={__proto__:holder[1]?.()};o.toString.call.call=other;",
      ),
    ).toEqual([]);
  });

  it.each([
    ["values.length=0;", 0],
    ['Object.defineProperty(values,"length",{value:0});', 0],
    ["values.length=1;", 1],
    ["values.length=2;", 1],
  ] as const)(
    "keeps array store receiver presence current after %s",
    (mutation, expected) => {
      expect(
        windows(
          `Object.defineProperty(Array.prototype,"0",{set(value){value.call=other},configurable:true});const values=[null];${mutation}values[0]=Function.prototype.call;`,
        ),
      ).toHaveLength(expected);
    },
  );

  it("preserves a retained own index when truncating a later element", () => {
    expect(
      windows(
        'Object.defineProperty(Array.prototype,"0",{set(value){value.call=other},configurable:true});const values=[null,null];values.length=1;values[0]=Function.prototype.call;',
      ),
    ).toHaveLength(1);
  });

  it("preserves an own-element store before a later truncation", () => {
    expect(
      windows(
        'Object.defineProperty(Array.prototype,"0",{set(value){value.call=other},configurable:true});const values=[null];values[0]=Function.prototype.call;values.length=0;',
      ),
    ).toHaveLength(1);
  });
});
