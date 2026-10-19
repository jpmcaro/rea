import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";

// Generated from CommonJS Electron calls with esbuild 0.28.2, bundle=true,
// platform=node, format=esm, minify=true, external=["electron"]. Kept as inert
// source so the regression does not depend on future bundler output changes.
const bundle = `var t=(e=>typeof require<"u"?require:typeof Proxy<"u"?new Proxy(e,{get:(o,r)=>(typeof require<"u"?require:o)[r]}):e)(function(e){if(typeof require<"u")return require.apply(this,arguments);throw Error('Dynamic require of "'+e+'" is not supported')});var n=t("electron");new n.BrowserWindow({webPreferences:{nodeIntegration:!0,contextIsolation:!1}});n.ipcMain.handle("get-version",()=>"1.0.0");`;

const helperMutationCases = [
  ["const list={0:module,at(){return {}}};list.at(0).require=other;", 1],
  ["const list={0:module,at(){return this[0]}};list.at().require=other;", 0],
  ["Reflect.set({__proto__:null},'require',module.require,module);", 1],
  [
    "Reflect.set({__proto__:{set require(value){this.require=other}}},'require',module.require,module);",
    0,
  ],
  ["class C{static{this.call.call=other}}", 0],
  ["class C{static{this.call=other}}", 1],
  ["const obj={__proto__:Function.prototype};obj.call.call=other;", 0],
  [
    "const obj={__proto__:Function.prototype};const copy={...obj};const value=copy.call??{};value.call=other;",
    1,
  ],
  ["class C{constructor(){this.constructor.call.call=other}}new C();", 0],
  ["class C{constructor(){this.call=other}}new C();", 1],
  ['"use strict";arguments[2].require=other;', 0],
  ['"use strict";arguments[2]={};arguments[2].require=other;', 1],
  ["arguments=arguments;arguments[2].require=other;", 0],
  ['Object.defineProperty(module.__proto__,"require",{enumerable:false});', 1],
  ["module.require=module.require;", 1],
  ["Object.assign(module,{require:module.require});", 1],
  ["module.require &&= module.require;", 1],
  ["Object.assign(module,0);", 1],
  ["Object.assign(module,[]);", 1],
  ["Object.assign(module,/x/);", 1],
  ["Reflect.set(module,'require',module.require);", 1],
  ["require(__filename);module.children.at(0).require=other;", 0],
  ["Object.values({owner:module})[0].require=other;", 0],
  ["require(__filename);module.children.slice().require=other;", 1],
  [
    'const {toReversed:target=globalThis}=[];var Q=(e=>typeof require<"u"?require:e)(function(){});target.Q=other;',
    0,
    'new(Q("electron").BrowserWindow)({});',
    "main.js",
  ],
  ['Object.assign(module,"abc");', 1],
  [
    'Object.defineProperty(module,"0",{set(value){this.require=other}});Object.assign(module,"abc");',
    0,
  ],
  [
    'var Q=(e=>typeof require<"u"?require:e)(function(){});const {missing,x:target=globalThis}={x:{},pattern:/x/};target.Q=other;',
    1,
    'new(Q("electron").BrowserWindow)({});',
    "main.js",
  ],
  [
    'var Q=(e=>typeof require<"u"?require:e)(function(){});const {prototype:{constructor:target=globalThis}}=function(){};target.Q=other;',
    1,
    'new(Q("electron").BrowserWindow)({});',
    "main.js",
  ],
  [
    'var Q=(e=>typeof require<"u"?require:e)(function(){});const {helper:target=globalThis}=class{static helper={}};target.Q=other;',
    1,
    'new(Q("electron").BrowserWindow)({});',
    "main.js",
  ],
  [
    'var Q=(e=>typeof require<"u"?require:e)(function(){});const {prototype:{mutate:ignored,constructor:target=globalThis}}=class{get mutate(){this.constructor=undefined;return 0}};target.Q=other;',
    0,
    'new(Q("electron").BrowserWindow)({});',
    "main.js",
  ],
  [
    'patch(Object.prototype);Object.defineProperty(module.__proto__,"require",{enumerable:false});',
    0,
  ],
  [
    "const target=Object.assign({},{helper:Function.prototype.call});target.helper.call=other;",
    0,
  ],
  [
    'const target={helper:{}};const descriptor=Object.getOwnPropertyDescriptor(target,"helper",target.helper=Function.prototype.call);descriptor.value.call=other;',
    0,
  ],
  [
    'var Q=(e=>typeof require<"u"?require:e)(function(){});Q ||= other;',
    1,
    'new(Q("electron").BrowserWindow)({});',
  ],
  [
    'var Q=(e=>typeof require<"u"?require:e)(function(){});Q ??= other;',
    1,
    'new(Q("electron").BrowserWindow)({});',
  ],
  [
    'var Q=(e=>typeof require<"u"?require:e)(function(){});const base={set value(v){this.Q=other}};base.value=0;const box={__proto__:base,set value(v){}};Reflect.set(box,"value",(delete box.value,0),globalThis);',
    0,
    'new(Q("electron").BrowserWindow)({});',
    "main.js",
  ],
  [
    'var Q=(e=>typeof require<"u"?require:e)(function(){});const box={set value(v){this.Q=other}};Object.assign(box,{value:0});',
    1,
    'new(Q("electron").BrowserWindow)({});',
    "main.js",
  ],
  [
    'var Q=(e=>typeof require<"u"?require:e)(function(){});patch(Object);const box={set value(v){this.Q=other}};Object.assign(box,{value:0});',
    0,
    'new(Q("electron").BrowserWindow)({});',
    "main.js",
  ],
  [
    'var Q=(e=>typeof require<"u"?require:e)(function(){});const {lastIndex:target=globalThis}=/x/;target.Q=other;',
    1,
    'new(Q("electron").BrowserWindow)({});',
    "main.js",
  ],
  [
    'var Q=(e=>typeof require<"u"?require:e)(function(){});class A{static root=globalThis;static get value(){return this.root}}class B extends A{static early=B.result;static root={};static get result(){return super.value}}B.early.Q=other;',
    0,
    'new(Q("electron").BrowserWindow)({});',
    "main.js",
  ],
  [
    'var Q=(e=>typeof require<"u"?require:e)(function(){});class A{static root=globalThis;static get value(){return this.root}}class B extends A{static root={};static late=B.result;static get result(){return super.value}}B.late.Q=other;',
    1,
    'new(Q("electron").BrowserWindow)({});',
    "main.js",
  ],
  [
    'var Q=(e=>typeof require<"u"?require:e)(function(){});const home={__proto__:{value:{}},get result(){return super.value}};Object.setPrototypeOf(home,{value:globalThis});home.result.Q=other;',
    0,
    'new(Q("electron").BrowserWindow)({});',
    "main.js",
  ],
  [
    'var Q=(e=>typeof require<"u"?require:e)(function(){});class A{}class B extends A{get result(){return super.value}}Reflect.setPrototypeOf(B.prototype,{value:globalThis});new B().result.Q=other;',
    0,
    'new(Q("electron").BrowserWindow)({});',
    "main.js",
  ],
  [
    'var Q=(e=>typeof require<"u"?require:e)(function(){});const home={__proto__:{value:{}},get result(){return super.value}};function get(){return home.result}const target=get();Object.setPrototypeOf(home,{value:globalThis});target.Q=other;',
    1,
    'new(Q("electron").BrowserWindow)({});',
    "main.js",
  ],
  [
    'var Q=(e=>typeof require<"u"?require:e)(function(){});const box={};function get(){return box}const obj=get();box.value=globalThis;obj.value.Q=other;',
    0,
    'new(Q("electron").BrowserWindow)({});',
    "main.js",
  ],
  [
    'var Q=(e=>typeof require<"u"?require:e)(function(){});const box={__proto__:{}};function get(){return Object.getPrototypeOf(box)}const target=get();Object.setPrototypeOf(box,globalThis);target.Q=other;',
    1,
    'new(Q("electron").BrowserWindow)({});',
    "main.js",
  ],
  [
    'var Q=(e=>typeof require<"u"?require:e)(function(){});const box={value:{}};function get(){const {value}=box;return value}const target=get();box.value=globalThis;target.Q=other;',
    1,
    'new(Q("electron").BrowserWindow)({});',
    "main.js",
  ],
  [
    'var Q=(e=>typeof require<"u"?require:e)(function(){});class A{get value(){return globalThis}}class B extends A{get result(){return super.value}}Object.setPrototypeOf(B.prototype,{value:{}});new B().result.Q=other;',
    1,
    'new(Q("electron").BrowserWindow)({});',
    "main.js",
  ],
  [
    'var Q=(e=>typeof require<"u"?require:e)(function(){});Function.prototype.value=globalThis;class B extends (0,null){static get result(){return super.value}}B.result.Q=other;',
    0,
    'new(Q("electron").BrowserWindow)({});',
    "main.js",
  ],
  [
    'var Q=(e=>typeof require<"u"?require:e)(function(){});const home={__proto__:{value:globalThis},get result(){return super.value}};Reflect.setPrototypeOf(home,{__proto__:home,value:{}});home.result.Q=other;',
    0,
    'new(Q("electron").BrowserWindow)({});',
    "main.js",
  ],
  [
    'var Q=(e=>typeof require<"u"?require:e)(function(){});const box={value:globalThis};let saved;function get(reuse){if(!reuse)saved=box.value;return saved}get(false);box.value={};get(true).Q=other;',
    0,
    'new(Q("electron").BrowserWindow)({});',
    "main.js",
  ],
  [
    'var Q=(e=>typeof require<"u"?require:e)(function(){});',
    1,
    'new(Q.call(null,"electron").BrowserWindow)({});',
  ],
  [
    'var Q=(e=>typeof require<"u"?require:e)(function(){});',
    1,
    'new(Q.apply(null,["electron"]).BrowserWindow)({});',
  ],
  [
    'var Q=(e=>typeof require<"u"?require:e)(function(){});',
    1,
    'const load=Q.bind(null,"electron");new(load().BrowserWindow)({});',
  ],
  [
    'Object.defineProperty(Array.prototype,"0",{set(value){value.call=other},configurable:true});const values=[null];values.length=0;values[0]=Function.prototype.call;',
    0,
  ],
  [
    "const holder=[()=>({__proto__:null})];holder.length=0;const o={__proto__:holder[0]?.()};o.toString.call.call=other;",
    0,
  ],
  [
    "function proto(flag){let value;if(flag)value={__proto__:null};return value}const o={__proto__:proto(false)};o.toString.call.call=other;",
    0,
  ],
  [
    "function proto(flag){if(flag)return {__proto__:null}}const o={__proto__:proto(false)};o.toString.call.call=other;",
    0,
  ],
  [
    "const holder={proto(){return {__proto__:null}}};holder.proto=()=>undefined;const o={__proto__:holder.proto()};o.toString.call.call=other;",
    0,
  ],
] as const;

cliTest(
  "recovers esbuild Electron windows and IPC through CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-electron-require-shim-");
    await writeFixtureFiles(root, {
      "package.json": JSON.stringify({
        name: "shim-fixture",
        main: "main.cjs",
      }),
      "main.cjs": `"use strict";(()=>{${bundle}})();`,
    });
    const connection = await connectLocalToolsMcp();
    for (const surface of ["CLI", "stdio MCP"] as const) {
      const result = await analyzeJavaScriptDirectory(
        surface,
        cli,
        root,
        connection.call,
      );
      expect(result.statistics).toMatchObject({
        parsed_javascript_files: 1,
        parse_failures: 0,
      });
      expect(result.summary).toMatchObject({
        browser_windows: 1,
        explicit_web_preferences: 2,
        ipc: { operations: 1, main_handlers: 1 },
      });
      const observations = result.graph.nodes.flatMap(
        ({ observations }) => observations,
      );
      expect(observations).toContainEqual(
        expect.objectContaining({
          properties: expect.objectContaining({ channel: "get-version" }),
        }),
      );
    }
  },
);

cliTest(
  "distinguishes shared helper mutations from owned properties through CLI and MCP",
  async ({ cli }) => {
    const load =
      'new (require.call.call(require,null,"electron").BrowserWindow)({});';
    const connection = await connectLocalToolsMcp();
    for (const [
      setup,
      windows,
      loader = load,
      filename = "main.cjs",
    ] of helperMutationCases) {
      const root = await createTestTempDirectory(
        "rea-electron-class-receiver-",
      );
      await writeFixtureFiles(root, {
        "package.json": JSON.stringify({
          name: "class-fixture",
          main: filename,
        }),
        [filename]: `${setup}${loader}`,
      });
      for (const surface of ["CLI", "stdio MCP"] as const) {
        const result = await analyzeJavaScriptDirectory(
          surface,
          cli,
          root,
          connection.call,
        );
        expect(result.statistics).toMatchObject({
          parsed_javascript_files: 1,
          parse_failures: 0,
        });
        expect(result.summary.browser_windows, `${surface}: ${setup}`).toBe(
          windows,
        );
      }
    }
  },
  // Every fixture runs through the compiled CLI and the stdio MCP server, so
  // the whole matrix needs more than the default per-test budget.
  300_000,
);
