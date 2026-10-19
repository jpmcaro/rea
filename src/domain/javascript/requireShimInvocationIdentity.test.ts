import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import { analyzeParsedJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const SHIM_VALUE = '(e=>typeof require<"u"?require:e)(function(){})';
const SHIM = `var Q=${SHIM_VALUE};`;

const windows = (source: string, path = "bundle.cjs") => {
  const file = parseJavaScriptSource(source, path);
  expect(file).not.toBeNull();
  return analyzeParsedJavaScriptStaticSource(source, file!).electron
    .browser_windows;
};

describe("require shim logical assignment identity", () => {
  it.each(["||=", "??="])(
    "retains a proven callable shim across %s",
    (operator) => {
      expect(
        windows(
          `${SHIM}Q ${operator} other;new (Q("electron").BrowserWindow)({});`,
        ),
      ).toHaveLength(1);
    },
  );

  it.each([
    ["Q ||= other;Q ??= fallback;", 'Q("electron")'],
    ["Q ||= other;", 'Q.call(null,"electron")'],
    ["Q ??= other;const saved=Q;", 'saved("electron")'],
    ["const saved=Q;Q=other;", 'saved("electron")'],
    ["Q ||= other;globalThis.Q=other;", 'Q("electron")'],
  ])("retains an ordered callable capture: %s %s", (setup, load) => {
    expect(
      windows(`${SHIM}${setup}new (${load}.BrowserWindow)({});`),
    ).toHaveLength(1);
  });

  it("selects logical writes before a consumer in the same expression", () => {
    expect(
      windows(
        `${SHIM}(Q ||= other,Q ??= fallback,new (Q("electron").BrowserWindow)({}));`,
      ),
    ).toHaveLength(1);
  });

  it("selects a definite initialization before a logical write in one expression", () => {
    expect(
      windows(
        `var Q;(Q=${SHIM_VALUE},Q ||= other);new (Q("electron").BrowserWindow)({});`,
      ),
    ).toHaveLength(1);
  });

  it.each([
    "Q &&= other;",
    "Q &&= other;Q ||= fallback;",
    "Q=null;Q ||= other;",
    "Q=0;Q ??= other;",
    "if(flag)Q=other;Q ||= fallback;",
    "Q ||= other;function change(){Q=other}change();",
    "Q ||= other;external(()=>{Q=other});",
    "for(const value of values){Q ||= other;Q=value;}",
    "Q &&= box.value;",
    "const box={get value(){module.require=other;return Q}};Q &&= box.value;",
    "Q ||= other;module.require=other;",
    'eval("Q=other");Q ||= other;',
  ])("does not erase preceding or deferred replacements: %s", (setup) => {
    expect(
      windows(`${SHIM}${setup}new (Q("electron").BrowserWindow)({});`),
    ).toEqual([]);
  });

  it.each([
    `var Q;if(flag){${SHIM.replace("var Q", "Q")}}Q ||= other;new (Q("electron").BrowserWindow)({});`,
    `new (Q("electron").BrowserWindow)({});${SHIM}Q ||= other;`,
  ])(
    "does not infer an initialized entry from conditional or later syntax: %s",
    (source) => {
      expect(windows(source)).toEqual([]);
    },
  );

  it.each([
    "globalThis.Q=other;Q ||= fallback;",
    "Q ||= fallback;globalThis.Q=other;",
    "const target=globalThis;target.Q=other;Q ??= fallback;",
  ])("retains global slot invalidation around skipped writes: %s", (setup) => {
    expect(
      windows(
        `${SHIM}${setup}new (Q("electron").BrowserWindow)({});`,
        "bundle.js",
      ),
    ).toEqual([]);
  });

  it("proves local callable retention at runtime without evaluating the RHS getter", () => {
    const source = `function run(){${SHIM}Q ||= box.value;Q ??= box.value;new (Q("electron").BrowserWindow)({});}run();`;
    let constructed = 0;
    let getterReads = 0;
    runInNewContext(source, {
      require: () => ({
        BrowserWindow: class {
          constructor() {
            constructed++;
          }
        },
      }),
      box: {
        get value() {
          getterReads++;
          return () => undefined;
        },
      },
    });
    expect([constructed, getterReads]).toEqual([1, 0]);
    expect(windows(source)).toHaveLength(1);
  });

  it("keeps independently indexed RHS effects separate from the retained value", () => {
    expect(
      windows(
        `${SHIM}const box={get value(){module.require=other;return Q}};Q ||= box.value;new (Q("electron").BrowserWindow)({});`,
      ),
    ).toEqual([]);
  });
});

describe("require shim host loader helper identity", () => {
  it.each([
    'Q.call(null,"electron")',
    'Q.apply(null,["electron"])',
    'Q.bind(null)("electron")',
    'Reflect.apply(Q,null,["electron"])',
    'Function.prototype.call.call(Q,null,"electron")',
    'Function.prototype.apply.call(Q,null,["electron"])',
    'Function.prototype.bind.call(Q,null)("electron")',
    'Q.bind(null,"electron").bind(null)()',
  ])("follows the captured host loader through %s", (load) => {
    expect(windows(`${SHIM}new (${load}.BrowserWindow)({});`)).toHaveLength(1);
  });

  it.each([
    ["const saved=Q;require=other;", 'saved.call(null,"electron")'],
    ["const saved=Q.bind(null);require=other;", 'saved("electron")'],
    ["const saved=Q.bind(null);Q.bind=other;", 'saved("electron")'],
    ["const saved=Q.call;Q.call=other;", 'saved.call(Q,null,"electron")'],
    ["const saved=Q.apply;Q.apply=other;", 'saved.call(Q,null,["electron"])'],
    ["const saved=Q.call;", 'saved.call(Q,null,"electron")'],
  ])("retains an earlier callable capture: %s %s", (setup, load) => {
    expect(
      windows(`${SHIM}${setup}new (${load}.BrowserWindow)({});`),
    ).toHaveLength(1);
  });

  it.each([
    ["Q.call=other;", 'Q.call(null,"electron")'],
    ["Q.apply=other;", 'Q.apply(null,["electron"])'],
    ["Q.bind=other;", 'Q.bind(null)("electron")'],
    ["require.call=other;", 'Q.call(null,"electron")'],
    ["require.apply=other;", 'Q.apply(null,["electron"])'],
    ["require.bind=other;", 'Q.bind(null)("electron")'],
    ["const alias=Q;alias.call=other;", 'Q.call(null,"electron")'],
    ["const alias=Q;alias.apply=other;", 'Q.apply(null,["electron"])'],
    ["const alias=Q;alias.bind=other;", 'Q.bind(null)("electron")'],
    [
      'Object.defineProperty(Q,"call",{get(){return other}});',
      'Q.call(null,"electron")',
    ],
    ["Object.setPrototypeOf(Q,{call:other});", 'Q.call(null,"electron")'],
    ["Function.prototype.call=other;", 'Q.call(null,"electron")'],
    ["Function.prototype.apply=other;", 'Q.apply(null,["electron"])'],
    ["Function.prototype.bind=other;", 'Q.bind(null)("electron")'],
    ["Reflect.apply=other;", 'Reflect.apply(Q,null,["electron"])'],
    ["module.require=other;", 'Q.call(null,"electron")'],
    ["const saved=Q.bind(null);module.require=other;", 'saved("electron")'],
    ["Q=other;", 'Q.call(null,"electron")'],
    ['eval("Q=other");', 'Q.apply(null,["electron"])'],
    ["", "Q.apply(null,args)"],
    [
      'Object.defineProperty(Q,"name",{get(){module.require=other;return "x"}});',
      'Q.bind(null)("electron")',
    ],
    [
      'Object.defineProperty(Q,"length",{get(){module.require=other;return 1}});',
      'Q.bind(null)("electron")',
    ],
    [
      "const saved=Q.bind(null);external(saved);",
      'saved.call(null,"electron")',
    ],
  ])("keeps changed or unproven helpers unresolved: %s %s", (setup, load) => {
    expect(windows(`${SHIM}${setup}new (${load}.BrowserWindow)({});`)).toEqual(
      [],
    );
  });
});

describe("require shim source and module-family policy", () => {
  it.each([
    `const require=other;${SHIM}`,
    "var Q=(e=>false?require:e)(function(){});",
    'const {Q}=(e=>typeof require<"u"?require:e)(function(){});',
    'import require from "foreign";var Q=(e=>typeof require<"u"?require:e)(function(){});',
  ])("does not promote an unproven source: %s", (source) => {
    expect(
      windows(
        `${source}new (Q.call(null,"electron").BrowserWindow)({});`,
        "bundle.mjs",
      ),
    ).toEqual([]);
  });

  it("preserves the existing module-local shim interpretation", () => {
    expect(
      windows(
        `${SHIM}globalThis.Q=other;new (Q.call(null,"electron").BrowserWindow)({});`,
        "bundle.mjs",
      ),
    ).toHaveLength(1);
  });

  it.each([
    'Q.call(null,"node:fs")',
    'Q.apply(null,["node:fs"])',
    'Q.bind(null)("node:fs")',
  ])("retains the existing unsupported module-family policy: %s", (load) => {
    const analysis = analyzeJavaScriptSemantics(
      `${SHIM}const a=require("node:fs");a.readFileSync=other;const b=${load};b.readFileSync("wrong");`,
    );
    expect(analysis.configurationOperations).toEqual([]);
  });
});
