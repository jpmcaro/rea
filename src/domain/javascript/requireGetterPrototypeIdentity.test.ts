import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const LOAD =
  'new (require.call.call(require,null,"electron").BrowserWindow)({});';

it.each([
  ["number", "return 42;"],
  ["string", 'return "value";'],
  ["boolean", "return false;"],
  ["undefined", "return;"],
  ["fallthrough", ""],
  ["ordinary object", "return {};"],
  ["mixed result", "return condition ? 42 : {toString:{call:{}}};"],
])(
  "retains a shared helper reached through a %s getter prototype",
  (_name, body) => {
    expect(
      analyzeJavaScriptStaticSource(
        `const h={get p(){${body}}};const o={__proto__:h.p};o.toString.call.call=other;${LOAD}`,
      ).electron.browser_windows,
    ).toEqual([]);
  },
);

it.each([
  [
    "inherited getter",
    "const base={get p(){return 42}};const h={__proto__:base};const o={__proto__:h.p};",
  ],
  [
    "getter result captured before replacement",
    "const h={get p(){return 42}};const proto=h.p;Object.defineProperty(h,'p',{value:{toString:{call:{}}}});const o={__proto__:proto};",
  ],
  [
    "copied getter result",
    "const h={get p(){return 42}};const copy={...h};const o={__proto__:copy.p};",
  ],
])("retains getter value semantics through %s", (_name, setup) => {
  expect(
    analyzeJavaScriptStaticSource(`${setup}o.toString.call.call=other;${LOAD}`)
      .electron.browser_windows,
  ).toEqual([]);
});

it.each([
  "const h={p:{toString:{call:{}}}};const o={__proto__:h.p};o.toString.call.call=other;",
  "const h={p:null};const o={__proto__:h.p,toString:{call:{}}};o.toString.call.call=other;",
  "const h={get p(){return 42}};const o={__proto__:h.p,toString:{call:{}}};o.toString.call.call=other;",
  "const h={get p(){return {toString:{call:{}}}}};h.p.toString.call.call=other;",
])("preserves direct source and own-property controls: %s", (setup) => {
  expect(
    analyzeJavaScriptStaticSource(`${setup}${LOAD}`).electron.browser_windows,
  ).toHaveLength(1);
});

it("preserves a helper captured before a getter prototype reaches it", () => {
  expect(
    analyzeJavaScriptStaticSource(
      'const invoke=require.call.call;const h={get p(){return 42}};const o={__proto__:h.p};o.toString.call.call=other;new (Reflect.apply(invoke,require,[null,"electron"]).BrowserWindow)({});',
    ).electron.browser_windows,
  ).toHaveLength(1);
});
