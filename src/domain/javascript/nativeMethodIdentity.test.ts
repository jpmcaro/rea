import { runInNewContext } from "node:vm";

import { expect, it } from "vitest";

import { analyzeParsedJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const CASES = [
  ["const list={0:module,at(){return {}}};list.at(0).require=other;", 1],
  ["const list={0:module,at:()=>({})};list.at(0).require=other;", 1],
  [
    "const list={0:module,at(){return {}}};const at=list.at;at(0).require=other;",
    1,
  ],
  [
    "const table={list:{0:module,at(){return {}}}};table.list.at(0).require=other;",
    1,
  ],
  ["const list={0:module,pop(){return {}}};list.pop().require=other;", 1],
  [
    "const list={0:module,slice(){return [{}]}};list.slice()[0].require=other;",
    1,
  ],
  [
    "const list={0:module,reverse(){return [{}]}};list.reverse()[0].require=other;",
    1,
  ],
  ["const list={at(){return module}};list.at().require=other;", 0],
  ["const list={0:module,at(){return this[0]}};list.at().require=other;", 0],
  [
    "const list={0:module,at(){return this[0]}};const at=list.at.bind(list);at().require=other;",
    0,
  ],
  [
    "const list={0:module,length:1,at(){return Array.prototype.at.call(this,0)}};list.at().require=other;",
    0,
  ],
  [
    "const list={0:module,at(){return {}}};list.at.apply=()=>module;list.at.apply(list,[0]).require=other;",
    0,
  ],
  ["const list={slice(){return [module]}};list.slice()[0].require=other;", 0],
  [
    "const list=[module];const at=list.at;list.at=()=>({});at.call(list,0).require=other;",
    0,
  ],
  [
    "const list={0:module,at(){return {}}};const at=list.at;list.at=Array.prototype.at;at(0).require=other;",
    1,
  ],
  [
    "const list={0:module,length:1,at(){return {}}};list.at=Array.prototype.at;list.at(0).require=other;",
    0,
  ],
  [
    "const list={0:module,length:1,at:true?Array.prototype.at:()=>({})};list.at(0).require=other;",
    0,
  ],
  [
    "const methods={at:Array.prototype.at};methods.at.call([module],0).require=other;",
    0,
  ],
  ["Array.prototype.at.call([module],0).require=other;", 0],
  ["[module].at(0).require=other;", 0],
] as const;

it.each(CASES)("selects the actual callable for %s", (setup, expected) => {
  for (const loader of ["require", "Q"]) {
    const source = `var Q=(e=>typeof require<"u"?require:e)(function(){});${setup}new (${loader}("electron").BrowserWindow)({});`;
    const calls = runInNewContext(`
      const calls=[];
      const electron={BrowserWindow:function(){calls.push('original')}};
      function other(){return {BrowserWindow:function(){calls.push('replacement')}}}
      const module={require(){return electron}};
      const require=id=>module.require(id);
      (function(exports,require,module,__filename,__dirname){${source}})
        ({},require,module,'/tmp/bundle.cjs','/tmp');
      calls;
    `);
    expect(calls).toEqual([expected ? "original" : "replacement"]);
    const parsed = parseJavaScriptSource(source, "bundle.cjs");
    expect(parsed).not.toBeNull();
    expect(
      analyzeParsedJavaScriptStaticSource(source, parsed!).electron
        .browser_windows,
    ).toHaveLength(expected);
  }
});
