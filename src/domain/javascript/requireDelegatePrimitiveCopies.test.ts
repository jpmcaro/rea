import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { analyzeParsedJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';
const READ = 'new(Q("electron").BrowserWindow)({});';
const RUNTIME = `let original=0,replacement=0;const electron={BrowserWindow:function(){original++}};function other(){return{BrowserWindow:function(){replacement++}}}class Module{require(){return electron}}const module=new Module;function require(id){return module.require(id)}`;

const verify = (setup: string, expected: number): void => {
  const source = SHIM + setup + READ;
  expect(
    runInNewContext(`${RUNTIME}${source}({original,replacement});`),
  ).toEqual({
    original: expected,
    replacement: 1 - expected,
  });
  const file = parseJavaScriptSource(source, "bundle.cjs");
  expect(file).not.toBeNull();
  expect(
    analyzeParsedJavaScriptStaticSource(source, file!).electron.browser_windows,
  ).toHaveLength(expected);
};

describe("same-value executing delegate copies", () => {
  it.each([
    "module.require &&= module.require;",
    "const saved=module.require;module.require &&= saved;",
    "const target=module;target.require &&= target.require;",
    "module.require &&= module.require;module.require &&= module.require;",
    "delete module.require;module.require &&= module.require;",
  ])("keeps the initial delegate through %s", (setup) => verify(setup, 1));

  it.each([
    "module.require &&= other;",
    "module.require=other;module.require &&= module.require;",
    "module.require &&= (module.require=other,module.require);",
  ])("retains a changed delegate through %s", (setup) => verify(setup, 0));
});

describe("primitive native assignment sources", () => {
  it.each([
    "0",
    "-1",
    "false",
    "true",
    "1n",
    "-1n",
    "''",
    "'abc'",
    "`abc`",
    "null",
    "void 0",
  ])("preserves the loader for an inert source %s", (value) =>
    verify(`Object.assign(module,${value});`, 1),
  );

  it.each([
    'Object.defineProperty(module,"0",{set(value){this.require=other}});Object.assign(module,"x");',
    'Object.defineProperty(module.__proto__,"0",{set(value){this.require=other}});Object.assign(module,"x");',
    'Object.defineProperty(Object.prototype,"0",{set(value){this.require=other}});Object.assign(module,"x");',
    'const base=Object.getPrototypeOf(module);Object.defineProperty(base,"0",{set(value){this.require=other}});Object.assign(module,"x");',
    'Object.setPrototypeOf(module,{set 0(value){this.require=other}});Object.assign(module,"x");',
    'Object.assign(module,(Object.defineProperty(module,"0",{set(value){this.require=other}}),0),"x");',
    'Object.defineProperty(module,"0",{set(value){this.require=other}});Reflect.apply(Object.assign,null,[module,"x"]);',
    "Object.assign(module,(module.require=other,0));",
    "Object.assign(module,void(module.require=other));",
    "Object.assign(module,{require:other},0);",
    "Object.assign(module,0,{require:other});",
  ])("retains primitive-source side effects in %s", (setup) =>
    verify(setup, 0),
  );
});
