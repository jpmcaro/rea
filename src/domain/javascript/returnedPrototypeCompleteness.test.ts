import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const LOAD =
  'new (require.call.call(require,null,"electron").BrowserWindow)({});';

it.each([
  "function proto(flag){if(flag)return {__proto__:null}}const value=proto(false);",
  "function proto(flag){if(flag)return;return {__proto__:null}}const value=proto(true);",
  "function proto(flag){switch(flag){case true:return {__proto__:null}}}const value=proto(false);",
  "async function proto(){return {__proto__:null}}const value=proto();",
  "function* proto(){return {__proto__:null}}const value=proto();",
  "const holder={get proto(){if(flag)return {__proto__:null}}};const value=holder.proto;",
  "const proto=flag?()=>({__proto__:null}):external;const value=proto();",
  "let proto=()=>({__proto__:null});unknown(()=>{proto=external});const value=proto();",
])(
  "keeps unproved normal factory results able to use ordinary prototypes: %s",
  (setup) => {
    expect(
      analyzeJavaScriptStaticSource(
        `${setup}const object={__proto__:value};object.toString.call.call=other;${LOAD}`,
      ).electron.browser_windows,
    ).toEqual([]);
  },
);

it.each([
  "function proto(){return {__proto__:null}}const value=proto();",
  "const proto=()=>({__proto__:null});const value=proto();",
  "function proto(flag){if(flag)return {__proto__:null};return {__proto__:null}}const value=proto(flag);",
  "function proto(flag){if(flag){return {__proto__:null}}else{return {__proto__:null}}}const value=proto(flag);",
  "function proto(flag){if(flag)return {__proto__:null};throw Error()}const value=proto(flag);",
])("preserves complete synchronous factory results: %s", (setup) => {
  expect(
    analyzeJavaScriptStaticSource(
      `${setup}const object={__proto__:value};object.toString.call.call=other;${LOAD}`,
    ).electron.browser_windows,
  ).toHaveLength(1);
});
