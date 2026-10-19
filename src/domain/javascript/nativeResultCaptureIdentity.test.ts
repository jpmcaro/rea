import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const LOAD =
  'new(require.call.call(require,null,"electron").BrowserWindow)({});';
const RUNTIME = `
  let original=0,replacement=0;
  function require(){return{BrowserWindow:function(){original++}}}
  function other(){return{BrowserWindow:function(){replacement++}}}
`;

const expectWindows = (setup: string, count: number) => {
  expect(
    runInNewContext(`${RUNTIME}${setup}${LOAD}({original,replacement});`),
  ).toEqual({ original: count, replacement: 1 - count });
  expect(
    analyzeJavaScriptStaticSource(`${setup}${LOAD}`).electron.browser_windows,
  ).toHaveLength(count);
};

describe("native result capture identities", () => {
  it.each([
    [
      "assign returns the target holding copied references",
      "const target=Object.assign({},{x:Function.prototype.call});target.x.call=other;",
    ],
    [
      "assign reads source properties after later arguments",
      "const source={x:{}};const target=Object.assign({},source,(source.x=Function.prototype.call,{}));target.x.call=other;",
    ],
    [
      "assign captures the source before later binding replacement",
      "let source={x:Function.prototype.call};const target=Object.assign({},source,(source={x:{}},{}));target.x.call=other;",
    ],
    [
      "assign captures the source before later member replacement",
      "const holder={value:{x:Function.prototype.call}};const target=Object.assign({},holder.value,(holder.value={x:{}},{}));target.x.call=other;",
    ],
    [
      "assign returns its captured target after later binding replacement",
      "let target={x:Function.prototype.call};const captured=Object.assign(target,(target={},{}));captured.x.call=other;",
    ],
    [
      "assign apply normalization retains the returned target",
      "const target=Reflect.apply(Object.assign,null,[{},{x:Function.prototype.call}]);target.x.call=other;",
    ],
    [
      "assign returns its earlier bound target",
      "let target={x:Function.prototype.call};const assign=Object.assign.bind(null,target);target={};assign({}).x.call=other;",
    ],
    [
      "Object descriptor reads the slot after all arguments",
      'const target={x:{}};Object.getOwnPropertyDescriptor(target,"x",target.x=Function.prototype.call).value.call=other;',
    ],
    [
      "Reflect descriptor reads the slot after all arguments",
      'const target={x:{}};Reflect.getOwnPropertyDescriptor(target,"x",target.x=Function.prototype.call).value.call=other;',
    ],
    [
      "bulk descriptors read slots after all arguments",
      "const target={x:{}};Object.getOwnPropertyDescriptors(target,target.x=Function.prototype.call).x.value.call=other;",
    ],
    [
      "a conditional slot replacement remains a possible captured value",
      'const target={x:{}};const flag=true;if(flag)target.x=Function.prototype.call;Object.getOwnPropertyDescriptor(target,"x").value.call=other;',
    ],
  ])("retains mutations: %s", (_name, setup) => {
    expectWindows(setup, 0);
  });

  it.each([
    [
      "assign preserves a separate copied object",
      "const target=Object.assign({},{x:{}});target.x.call=other;",
    ],
    [
      "assign preserves the selected copied key",
      "const target=Object.assign({},{x:{},other:Function.prototype.call});target.x.call=other;",
    ],
    [
      "a descriptor retains its earlier value",
      'const target={x:{}};const descriptor=Object.getOwnPropertyDescriptor(target,"x");target.x=Function.prototype.call;descriptor.value.call=other;',
    ],
    [
      "a descriptor retains its earlier target binding",
      'let target={x:{}};Object.getOwnPropertyDescriptor(target,"x",target={x:Function.prototype.call}).value.call=other;',
    ],
    [
      "an unrelated argument write preserves the selected descriptor",
      'const target={x:{}};Object.getOwnPropertyDescriptor(target,"x",target.other=Function.prototype.call).value.call=other;',
    ],
    [
      "a prior definite replacement supplies the descriptor value",
      'const target={x:Function.prototype.call};target.x={};Object.getOwnPropertyDescriptor(target,"x").value.call=other;',
    ],
  ])("preserves distinct captured values: %s", (_name, setup) => {
    expectWindows(setup, 1);
  });
});
