import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { analyzeParsedJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';

const NATIVE_LOADER_CASES = [
  ["const saved=Object;globalThis.Object=module;saved.require=other;", 1],
  [
    "function get(){return Object}const saved=get();globalThis.Object=module;saved.require=other;",
    1,
  ],
  [
    "globalThis.owner={};function get(){return owner}const saved=get();globalThis.owner=module;saved.require=other;",
    1,
  ],
  [
    "globalThis.owner={};function get(){return owner}globalThis.owner=module;get().require=other;",
    0,
  ],
  [
    "const items=[{}];function get(){return items.at(0)}const saved=get();items[0]=module;saved.require=other;",
    1,
  ],
  [
    "const items=[module];function get(){return items.at(0)}const saved=get();items[0]={};saved.require=other;",
    0,
  ],
  [
    "globalThis.require={extra:Function.prototype.call};const saved=require.extra??{};saved.call=other;",
    1,
  ],
  ["globalThis.owner=module;globalThis.owner.require=other;", 0],
  ["globalThis.items=[module];globalThis.items[0].require=other;", 0],
  [
    "globalThis.items=[module];const items=globalThis.items;items[0].require=other;",
    0,
  ],
  ["globalThis.items=[{}];globalThis.items.at(0).require=other;", 1],
  ["Object.items=[module];Object.items.at(0).require=other;", 0],
  ["globalThis.items=[module];globalThis.items.at(0).require=other;", 0],
  [
    "globalThis.items=[module];const at=globalThis.items.at;at.call(globalThis.items,0).require=other;",
    0,
  ],
  ["Object.assign(module,[]);", 1],
  ["Object.assign(module,[,,]);", 1],
  ["Object.assign(module,/x/g);", 1],
  ["Object.assign(module,[],/x/,{require:module.require});", 1],
  ["Object.assign.call(Object,module,[]);", 1],
  ["Reflect.apply(Object.assign,Object,[module,/x/]);", 1],
  ["Object.assign(module,[],{require:other});", 0],
  ["const source=[];source.require=other;Object.assign(module,source);", 0],
  ["const source=/x/;source.require=other;Object.assign(module,source);", 0],
  ["Object.assign(module,[(module.require=other,0)]);", 0],
  [
    "Object.defineProperty(module,'0',{set(){this.require=other}});Object.assign(module,[0]);",
    0,
  ],
  [
    "Object.assign=(...args)=>{module.require=other;return args[0]};Object.assign(module,[]);",
    0,
  ],
  ["Reflect.set(module,'require',module.require);", 1],
  ["Reflect.set({__proto__:null},'require',module.require,module);", 1],
  ["Reflect.set({},'require',module.require,module);", 1],
  ["module.extra=0;Reflect.set({},'require',module.require,module);", 1],
  ["delete module.require;Reflect.set({},'require',module.require,module);", 1],
  [
    "const target={__proto__:null};Reflect.set(target,'require',module.require,module);",
    1,
  ],
  [
    "Reflect.set({__proto__:{__proto__:null}},'require',module.require,module);",
    1,
  ],
  ["Reflect.set({require:0},'require',module.require,module);", 1],
  [
    "Reflect.set({get require(){return other}},'require',module.require,module);",
    1,
  ],
  [
    "const set=Reflect.set;set({__proto__:null},'require',module.require,module);",
    1,
  ],
  [
    "Reflect.apply(Reflect.set,Reflect,[{__proto__:null},'require',module.require,module]);",
    1,
  ],
  [
    "const target={__proto__:null};Object.defineProperty(target,'require',{set(){this.require=other}});Reflect.set(target,'require',module.require,module);",
    0,
  ],
  [
    "const target={__proto__:null};Object.setPrototypeOf(target,{set require(value){this.require=other}});Reflect.set(target,'require',module.require,module);",
    0,
  ],
  [
    "Reflect.set({__proto__:{set require(value){this.require=other}}},'require',module.require,module);",
    0,
  ],
  [
    "const target={__proto__:null};Reflect.set(target,'require',module.require,module,Object.defineProperty(target,'require',{set(){this.require=other}}));",
    0,
  ],
  [
    "const target={__proto__:null};Reflect.set(target,'require',module.require,module,Object.setPrototypeOf(target,{set require(value){this.require=other}}));",
    0,
  ],
  [
    "let target={set require(value){this.require=other}};Reflect.set(target,'require',module.require,module,(target={__proto__:null}));",
    0,
  ],
  [
    "let base={set require(value){this.require=other}};const target={__proto__:base};base={__proto__:null};Reflect.set(target,'require',module.require,module);",
    0,
  ],
  [
    "let base={__proto__:null};const target={__proto__:base};base={set require(value){this.require=other}};Reflect.set(target,'require',module.require,module);",
    1,
  ],
  [
    "Object.defineProperty(Object.prototype,'require',{set(value){module.require=other},configurable:true});Reflect.set({},'require',module.require,module);",
    0,
  ],
  ["Reflect.set({__proto__:null},'require',other,module);", 0],
  ["const saved=module.require;Reflect.set(module,'require',saved);", 1],
  ["const set=Reflect.set;set(module,'require',module.require);", 1],
  ["Reflect.set.call(Reflect,module,'require',module.require);", 1],
  ["Reflect.apply(Reflect.set,Reflect,[module,'require',module.require]);", 1],
  ["Reflect.set(module.__proto__,'require',module.require);", 1],
  ["Reflect.set(module,'require',module.require,module);", 1],
  ["Reflect.set(module.__proto__,'require',module.require,module);", 1],
  ["Reflect.set(module,'require',other);", 0],
  ["module.require=other;Reflect.set(module,'require',module.require);", 0],
  [
    "Reflect.set=(...args)=>{module.require=other;return true};Reflect.set(module,'require',module.require);",
    0,
  ],
  ["Reflect.set(module,'require',(module.require=other,module.require));", 0],
  [
    "const key={toString(){module.require=other;return 'require'}};Reflect.set(module,key,other);",
    0,
  ],
  ["require(__filename);module.children.at(0).require=other;", 0],
  ["require(__filename);module.children.at(-1).require=other;", 0],
  [
    "require(__filename);const children=module.children;children.at(0).require=other;",
    0,
  ],
  [
    "require(__filename);Array.prototype.at.call(module.children,0).require=other;",
    0,
  ],
  [
    "require(__filename);Reflect.apply(Array.prototype.at,module.children,[0]).require=other;",
    0,
  ],
  [
    "require(__filename);const at=module.children.at.bind(module.children);at(0).require=other;",
    0,
  ],
  ["require(__filename);module.children.at(0);", 1],
  ["const children=[{}];children.at(0).require=other;", 1],
  ["require(__filename);module.children.slice().require=other;", 1],
  ["require(__filename);module.children.pop().require=other;", 0],
  ["require(__filename);module.children.shift().require=other;", 0],
  ["require(__filename);module.children.find(()=>true).require=other;", 0],
  ["require(__filename);module.children.findLast(()=>true).require=other;", 0],
  ["require(__filename);module.children.slice()[0].require=other;", 0],
  ["require(__filename);module.children.toReversed()[0].require=other;", 0],
  ["require(__filename);module.children.filter(()=>true)[0].require=other;", 0],
  ["require(__filename);module.children.splice(0)[0].require=other;", 0],
  ["[module].at(0).require=other;", 0],
  ["Array.prototype.at.call({0:module,length:1},0).require=other;", 0],
  ["const at=Array.prototype.at;at.call([module],0).require=other;", 0],
  ["[{},module].reverse()[0].require=other;", 0],
  ["[{}].fill(module)[0].require=other;", 0],
  ["[{}].concat(module)[1].require=other;", 0],
  ["[{}].concat([module])[1].require=other;", 0],
  ["[{}].with(0,module)[0].require=other;", 0],
  ["[{}].toSpliced(0,1,module)[0].require=other;", 0],
  ["Object.values({owner:module})[0].require=other;", 0],
  ["Object.entries({owner:module})[0][1].require=other;", 0],
  ["Reflect.get({owner:module},'owner').require=other;", 0],
  ["Object(module).require=other;", 0],
  [
    "Reflect.set({set require(value){module.require=other}},'require',module.require,module);",
    0,
  ],
  // Spreading even a literal array runs the array iterator, so the syntactic
  // elements are not the values the call receives once it is replaced.
  [
    "Array.prototype[Symbol.iterator]=function*(){yield module;yield 'require';yield other};Reflect.set(...[{},'x',module.require]);",
    0,
  ],
  [
    "Array.prototype[Symbol.iterator]=function*(){yield module;yield {require:other}};Object.assign(...[{},{}]);",
    0,
  ],
  [
    "const values=[module,'require',other];let index=0;Object.getPrototypeOf([][Symbol.iterator]()).next=function(){return index<values.length?{value:values[index++],done:false}:{done:true}};Reflect.set(...[{},'x',0]);",
    0,
  ],
  // A literal array spread expands to positions only while nothing in the
  // source can have replaced array iteration; these sources are inert.
  ["Reflect.set(...[module,'require',module.require]);", 1],
  ["Reflect.apply(Reflect.set,Reflect,[...[{},'x',0]]);", 1],
] as const;

describe("native operations on CommonJS loader owners", () => {
  it.each(NATIVE_LOADER_CASES)(
    "tracks the delegate after %s",
    (setup, expected) => {
      for (const loader of ["require", "Q"]) {
        const source = `${SHIM}${setup}new (${loader}("electron").BrowserWindow)({});`;
        const runtime = runInNewContext(`
        const calls=[];
        const electron={BrowserWindow:function(){calls.push('original')}};
        function other(){return {BrowserWindow:function(){calls.push('replacement')}}}
        class Module {
          children=[];
          require(id){
            if(id==='/tmp/bundle.cjs'){this.children.push(this);return {}}
            return electron;
          }
        }
        const module=new Module;
        const require=id=>module.require(id);
        (function(exports,require,module,__filename,__dirname){${source}})
          ({},require,module,'/tmp/bundle.cjs','/tmp');
        calls.join();
      `);
        expect(runtime).toBe(expected ? "original" : "replacement");
        const parsed = parseJavaScriptSource(source, "bundle.cjs");
        expect(parsed).not.toBeNull();
        expect(
          analyzeParsedJavaScriptStaticSource(source, parsed!).electron
            .browser_windows,
        ).toHaveLength(expected);
      }
    },
  );
});
