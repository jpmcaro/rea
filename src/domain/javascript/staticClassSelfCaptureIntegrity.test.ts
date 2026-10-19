import { runInNewContext } from "node:vm";

import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';
const USE = 'new(Q("electron").BrowserWindow)({});';
const PREFIX =
  "class A{static root=globalThis;static get value(){return this.root}}";
const RUNTIME =
  "let original=0,replacement=0;function require(){return{BrowserWindow:function(){original++}}}function other(){return{BrowserWindow:function(){replacement++}}}";

it.each([
  [
    "class name before the field initializes",
    "class B extends A{static early=B.result;static root={};static get result(){return super.value}}B.early.Q=other;",
    0,
  ],
  [
    "lexical this before the field initializes",
    "class B extends A{static early=this.result;static root={};static get result(){return super.value}}B.early.Q=other;",
    0,
  ],
  [
    "class name after the field initializes",
    "class B extends A{static root={};static early=B.result;static get result(){return super.value}}B.early.Q=other;",
    1,
  ],
  [
    "a named class expression before its field initializes",
    "const Outer=class B extends A{static early=B.result;static root={};static get result(){return super.value}};Outer.early.Q=other;",
    0,
  ],
  [
    "a computed member before its field initializes",
    'class B extends A{static early=B["result"];static root={};static get result(){return super.value}}B.early.Q=other;',
    0,
  ],
  [
    "a static block before its field initializes",
    "class B extends A{static{this.early=B.result}static root={};static get result(){return super.value}}B.early.Q=other;",
    0,
  ],
  [
    "an immediate arrow before its field initializes",
    "class B extends A{static early=(()=>B.result)();static root={};static get result(){return super.value}}B.early.Q=other;",
    0,
  ],
  [
    "the earlier capture when another field reads the same getter later",
    "class B extends A{static early=B.result;static root={};static late=B.result;static get result(){return super.value}}B.early.Q=other;",
    0,
  ],
  [
    "the captured value before a later replacement",
    "class B extends A{static early=B.result;static root={};static get result(){return super.value}}const early=B.early;B.early={};early.Q=other;",
    0,
  ],
  [
    "an unrelated class receiver",
    "class Local{static result={}}class B extends A{static early=Local.result;static root={};static get result(){return super.value}}B.early.Q=other;",
    1,
  ],
])("retains the initialization capture for %s", (_name, setup, count) => {
  expect(
    runInNewContext(
      `${RUNTIME}${SHIM}${PREFIX}${setup}${USE}({original,replacement});`,
    ),
  ).toEqual({ original: count, replacement: 1 - count });
  expect(
    analyzeJavaScriptStaticSource(SHIM + PREFIX + setup + USE).electron
      .browser_windows,
  ).toHaveLength(count);
});

it.each(["B", "this"])(
  "retains activation uncertainty when early and late reads use %s",
  (receiver) => {
    const setup = `class B extends A{static early=${receiver}.result;static root={};static late=${receiver}.result;static get result(){return super.value}}B.late.Q=other;`;
    expect(
      runInNewContext(
        `${RUNTIME}${SHIM}${PREFIX}${setup}${USE}({original,replacement});`,
      ),
    ).toEqual({ original: 1, replacement: 0 });
    // The shared getter receiver owner unions its early and late activations.
    // Keep that conservative precision limit explicit, unlike the exact
    // isolated-late and captured-early cases above.
    expect(
      analyzeJavaScriptStaticSource(SHIM + PREFIX + setup + USE).electron
        .browser_windows,
    ).toHaveLength(0);
  },
);
