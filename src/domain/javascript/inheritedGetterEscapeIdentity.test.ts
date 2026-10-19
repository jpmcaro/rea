import { expect, it } from "vitest";

import { analyzeParsedJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';
const windows = (setup: string) => {
  const source = `${SHIM}${setup}new(Q("electron").BrowserWindow)({});`;
  const parsed = parseJavaScriptSource(source, "bundle.js");
  if (parsed === null) throw new Error("Expected parsed source");
  return analyzeParsedJavaScriptStaticSource(source, parsed).electron
    .browser_windows;
};

it.each([
  "const base={get value(){return this}};const child={__proto__:base,set(){this.Q=other}};base.value;child.set();external(child.value);",
  "const base={get value(){return this}};const middle={__proto__:base};const child={__proto__:middle,set(){this.Q=other}};base.value;child.set();external(child.value);",
  "const base={get value(){return this}};const outer={child:{__proto__:base,set(){this.Q=other}}};base.value;outer.child.set();external(outer.child.value);",
  "const base={get value(){return this.target}};const child={__proto__:base,target:{set(){this.Q=other}}};base.value;child.target.set();external(child.value);",
  "class Base{static get value(){return this}}const child={__proto__:Base,set(){this.Q=other}};Base.value;child.set();external(child.value);",
  "const base={get __proto__(){return this}};const child={__proto__:base,set(){this.Q=other}};base.__proto__;child.set();external(child.__proto__);",
  "const base={set(){this.Q=other}};const child={__proto__:base};base.set();external(child.__proto__);",
  "const base={set(){this.Q=other}};const child={__proto__:base};base.set();external(child);",
])("retains inherited getter receivers and prototype contents: %s", (setup) => {
  expect(windows(setup)).toEqual([]);
});

it.each([
  "const base={get value(){return this}};const child={__proto__:base,value:{},set(){this.Q=other}};base.value;child.set();external(child.value);",
  "const base={get value(){return this}};const child={__proto__:base,set value(v){},set(){this.Q=other}};base.value;child.set();external(child.value);",
  'const base={get value(){return this}};const child={["__proto__"]:base,set(){this.Q=other}};base.value;child.set();external(child.value);',
  "const base={get value(){return this}};const child={__proto__:base,set(){this.Q=other}};const otherChild={__proto__:base};base.value;child.set();external(otherChild.value);",
  "const outer={value:{get self(){return this}},set(){this.Q=other}};outer.set();external(outer.value.self);",
  "const source={get value(){return this}};source.value;const base={...source};const child={__proto__:base,set(){this.Q=other}};child.set();external(child.value);",
])(
  "preserves shadowed descriptors and distinct copied receivers: %s",
  (setup) => {
    expect(windows(setup)).toHaveLength(1);
  },
);

it.each([
  "const source={get value(){return this},set(){this.Q=other}};source.value;source.set();external({...source}.value);",
  "const source={get value(){return this},set(){this.Q=other}};source.value;source.set();const base={...source};const child={__proto__:base};external(child.value);",
  "const parent={get value(){return this}};const holder={__proto__:parent,source:{get self(){return this},set(){this.Q=other}}};holder.source.self;holder.source.set();const source=holder.value.source;external({...source}.self);",
])(
  "retains own getter results copied through projected aliases: %s",
  (setup) => {
    expect(windows(setup)).toEqual([]);
  },
);

it("retains independent findings while widening inherited getter chains", () => {
  const count = 520;
  const getters = Array.from(
    { length: count },
    (_, index) =>
      `get value${index}(){return ${index + 1 === count ? "this" : `this.value${index + 1}`}}`,
  ).join(",");
  const source = `${SHIM}const base={${getters}};const child={__proto__:base,set(){this.Q=other}};base.value${count - 1};child.set();external(child.value0);new(Q("electron").BrowserWindow)({});fetch('/independent');`;
  const parsed = parseJavaScriptSource(source, "bundle.js");
  if (parsed === null) throw new Error("Expected parsed source");
  const result = analyzeParsedJavaScriptStaticSource(source, parsed);
  expect(result.electron.browser_windows).toEqual([]);
  expect(
    result.endpoints.filter(({ mechanism }) => mechanism === "call:fetch"),
  ).toHaveLength(1);
});
