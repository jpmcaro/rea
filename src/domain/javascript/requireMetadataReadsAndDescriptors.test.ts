import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { analyzeParsedJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';

const verify = (setup: string, expected: number): void => {
  for (const loader of ["require", "Q"]) {
    const source = `${setup}${SHIM}new (${loader}("electron").BrowserWindow)({});`;
    const runtime = runInNewContext(`
      const calls = [];
      const electron = {BrowserWindow:function(){calls.push('original')}};
      function other(){return {BrowserWindow:function(){calls.push('replacement')}}}
      class Module { require(){return electron} }
      const module = new Module;
      const require = id => module.require(id);
      (function(exports,require,module,__filename,__dirname){${source}})
        ({},require,module,'/tmp/bundle.cjs','/tmp');
      calls;
    `);
    expect(runtime).toEqual([expected ? "original" : "replacement"]);
    const parsed = parseJavaScriptSource(source, "bundle.cjs");
    expect(parsed).not.toBeNull();
    expect(
      analyzeParsedJavaScriptStaticSource(source, parsed!).electron
        .browser_windows,
    ).toHaveLength(expected);
  }
};

describe("discarded wrapper argument metadata", () => {
  it.each([
    "arguments.length;",
    "arguments[3];",
    "arguments[4];",
    "arguments['length'];",
    "(arguments.length);",
    "arguments?.length;",
    "arguments.length,0;",
    "if(arguments.length){}",
    "for(arguments.length;false;arguments[3]){}",
  ])("does not expose the mapped require slot through %s", (setup) =>
    verify(setup, 1),
  );

  it.each([
    "arguments.length;arguments[1]=other;",
    "arguments[3];arguments[2].require=other;",
    "Object.defineProperty(arguments,'length',{get:()=>{arguments[1]=other;return 0}});arguments.length;",
    "Object.defineProperty(arguments,'3',{get(){module.require=other;return ''}});arguments[3];",
    "arguments[(arguments[1]=other,'length')];",
    "const saved=arguments;saved[1]=other;arguments.length;",
  ])("retains evaluated effects and real exposure in %s", (setup) =>
    verify(setup, 0),
  );
});

describe("captured delegate values in descriptors", () => {
  it.each([
    "Object.defineProperty(module.__proto__,'require',{value:module.require});",
    "Reflect.defineProperty(module.__proto__,'require',{value:module.require});",
    "Object.defineProperties(module.__proto__,{require:{value:module.require}});",
    "Object.defineProperty(module.constructor.prototype,'require',{value:module.require});",
    "const descriptor={value:module.require};Object.defineProperty(module.__proto__,'require',descriptor);",
    "const saved=module.require;Object.defineProperty(module.__proto__,'require',{value:saved,enumerable:false});",
    "Object.defineProperty(module.__proto__,'require',{__proto__:null,value:module.require});",
    "Object.defineProperty(module,'require',{value:module.require});",
    "const define=Object.defineProperty;define(module.__proto__,'require',{value:module.require});",
    "Object.defineProperty.call(Object,module.__proto__,'require',{value:module.require});",
    "Reflect.apply(Object.defineProperty,Object,[module.__proto__,'require',{value:module.require}]);",
    "const target=module.__proto__;Object.defineProperty(target,'require',{value:module.require});",
  ])("preserves the initial delegate through %s", (setup) => verify(setup, 1));

  it.each([
    "Object.defineProperty(module.__proto__,'require',{value:other});",
    "module.require=other;Object.defineProperty(module.__proto__,'require',{value:module.require});",
    "const descriptor={value:module.require};descriptor.value=other;Object.defineProperty(module.__proto__,'require',descriptor);",
    "Object.defineProperty(module.__proto__,'require',{get value(){return other}});",
    "Object.defineProperty(module.__proto__,'require',{value:module.require,enumerable:(module.require=other,false)});",
    "Object.defineProperties(module.__proto__,{require:{value:module.require},other:{get value(){module.require=other;return 0}}});",
    "Object.defineProperty(module.__proto__,'require',{__proto__:{value:other},enumerable:false});",
    "Object.defineProperty=(target,key,descriptor)=>{module.require=other;return target};Object.defineProperty(module.__proto__,'require',{value:module.require});",
    "const descriptor={value:module.require};Object.defineProperty(module.__proto__,'require',descriptor,descriptor.value=other);",
    "const descriptor={value:module.require};Reflect.apply(Object.defineProperty,Object,[module.__proto__,'require',descriptor,descriptor.value=other]);",
    "const proto=Object.getPrototypeOf(module);Object.defineProperty(module,'__proto__',{get(){module.require=other;return proto}});Object.defineProperty(module.__proto__,'require',{value:module.require});",
    "const proto=Object.getPrototypeOf(module);Object.defineProperty(Object.prototype,'__proto__',{get(){module.require=other;return proto}});Object.defineProperty(module.__proto__,'require',{value:module.require});",
    "const descriptor={value:module.require};Object.defineProperties(module.__proto__,{get require(){descriptor.value=other;return descriptor}});",
  ])("retains changed or effectful descriptor values in %s", (setup) =>
    verify(setup, 0),
  );
});
