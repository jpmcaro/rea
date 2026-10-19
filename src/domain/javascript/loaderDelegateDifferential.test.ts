import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { analyzeParsedJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

/**
 * Differential corpus for the CommonJS loader delegate.
 *
 * Every case runs twice: once in an isolated Node realm with a real module
 * wrapper (only Electron is stubbed), and once through the production parser
 * and analyzer. The runtime says whether the original Electron API ran; the
 * analyzer says whether it reports the window. The two must agree, with two
 * explicit exceptions that this file owns:
 *
 * - KNOWN_PRECISION_LIMITS: the runtime keeps the original API but the
 *   analyzer stays conservative. Each entry is a documented precision gap.
 *   An entry that starts matching again must be removed, so a fix is visible.
 * - KNOWN_FALSE_FINDINGS: the runtime replaces the loader but the analyzer
 *   still reports the window. These are open soundness gaps. An entry that
 *   starts matching must be removed too. New false findings fail this file.
 *
 * Adding a case means adding one line; the harness decides which list it
 * belongs to by running it, and complains when the lists are stale.
 */

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';
const LOAD = 'new (Q("electron").BrowserWindow)({});';

type Loads = "original" | "replacement" | "throws";

const runtimeLoads = (source: string): Loads => {
  const outcome = runInNewContext(
    `
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
    let failure='';
    try {
      (function(exports,require,module,__filename,__dirname){${source}})
        ({},require,module,'/tmp/bundle.cjs','/tmp');
    } catch (error) { failure=String(error); }
    failure===''?calls.join():'throws:'+failure;
  `,
    {
      unknownReceiver: undefined,
      flag: true,
      unknown: () => {},
      external: () => () => {},
    },
    { timeout: 2000 },
  ) as string;
  if (outcome.startsWith("throws:")) return "throws";
  if (outcome === "original") return "original";
  if (outcome === "replacement") return "replacement";
  throw new Error(`Unexpected runtime outcome ${JSON.stringify(outcome)}`);
};

const analyzedWindows = (source: string): number => {
  const parsed = parseJavaScriptSource(source, "bundle.cjs");
  if (parsed === null) throw new Error("Expected parsed CommonJS source");
  return analyzeParsedJavaScriptStaticSource(source, parsed).electron
    .browser_windows.length;
};

/** Setup fragments that run before the load. Each must execute without throwing. */
const CORPUS = [
  // --- binding identity of the shim ---
  "",
  "Q=Q;",
  "Q=(Q);",
  "Q=other;",
  "Q=other;Q=Q;",
  "Q ||= other;",
  "Q ??= other;",
  "Q &&= other;",
  "const alias=Q;Q=alias;",
  "var copy=Q;Q=copy;",
  "{let Q=other;Q=Q}",
  "function copy(){Q=Q}copy();",
  "function change(){Q=other}change();",
  "function change(){Q=other}",
  // --- direct delegate writes ---
  "module.require=other;",
  "module.require=module.require;",
  "delete module.require;",
  "Object.assign(module,{require:other});",
  "Object.assign(module,{require:module.require});",
  "Object.assign(module,[]);",
  "Object.assign(module,/x/);",
  "Object.assign(module,'abc');",
  "Object.defineProperty(module,'require',{value:other});",
  "Object.defineProperty(module,'require',{value:module.require});",
  "Reflect.set(module,'require',other);",
  "Reflect.set(module,'require',module.require);",
  "Reflect.set({__proto__:null},'require',module.require,module);",
  "Reflect.set({},'require',other,module);",
  "Reflect.set(module,'require',other,{});",
  // --- unknown recipients ---
  "Reflect.set(...[module,'require',other]);",
  "Reflect.set(...[{},'x',module.require]);",
  "Array.prototype[Symbol.iterator]=function*(){yield module;yield 'require';yield other};Reflect.set(...[{},'x',module.require]);",
  "Object.prototype.extra=1;Reflect.set(...[{},'x',module.require]);",
  "Reflect.apply(Reflect.set,Reflect,[module,'require',other]);",
  "Reflect.apply(Reflect.set,Reflect,[{},'x',0]);",
  "const args=[module,'require',other];Reflect.set(...args);",
  "const args=[{},'x',0];Reflect.set(...args);",
  "const args=[module,'require',other];Reflect.apply(Reflect.set,Reflect,args);",
  "Object.assign(...[module,{require:other}]);",
  "Object.assign(...[{},{require:other}]);",
  // --- helpers that mutate through parameters ---
  "function F(a){a.require=other}F(module);",
  "function F(a){a.require=other}F({});",
  "function F(a){a.require=other}",
  "function F(a,b,c){Reflect.set(a,b,c)}F(module,'require',other);",
  "function F(a,b,c){Reflect.set(a,b,c)}F({},'x',0);",
  "function F(a,b,c){Object.defineProperty(a,b,{value:c})}F(module,'require',other);",
  "function F(){Object.assign.apply(null,arguments)}F(module,{require:other});",
  "function F(){Object.assign.apply(null,arguments)}F({},{});",
  "function F(){Object.assign.apply(null,arguments)}",
  "function F(...args){Reflect.set(...args)}F(module,'require',other);",
  "function F(...args){Reflect.set(...args)}F({},'x',0);",
  "const F=(...a)=>Reflect.apply(Reflect.set,Reflect,a);F(module,'require',other);",
  "[[module,'require',other]].forEach(args=>Reflect.set(...args));",
  "[[{},'x',0]].forEach(args=>Reflect.set(...args));",
  // --- aliases of the module object ---
  "const owner=module;owner.require=other;",
  "const owner={m:module};owner.m.require=other;",
  "[module][0].require=other;",
  "[module].at(0).require=other;",
  "Object.values({owner:module})[0].require=other;",
  "Reflect.get({owner:module},'owner').require=other;",
  "const list={0:module,at(){return {}}};list.at(0).require=other;",
  "require(__filename);module.children.at(0).require=other;",
  "require(__filename);module.children.slice().require=other;",
  // --- prototype and shared-slot stores ---
  "Object.prototype.require=other;",
  "Object.defineProperty(Object.prototype,'require',{get(){return other}});",
  "Object.setPrototypeOf(module,{require:other});",
  "Object.setPrototypeOf(module,Object.getPrototypeOf(module));",
  // --- escapes to foreign callables ---
  "unknown(module);",
  "const f=external();f(module);",
] as const;

/** Runtime keeps the original API; the analyzer refuses to prove it. */
const KNOWN_PRECISION_LIMITS = new Set<string>([
  // A write inside a function counts whether or not the function runs.
  "function change(){Q=other}",
  "const alias=Q;Q=alias;",
  "var copy=Q;Q=copy;",
  // A spread of a binding, unlike a literal array, stays an unknown list, and
  // a literal spread stays opaque once the source touches any prototype.
  "const args=[{},'x',0];Reflect.set(...args);",
  "Object.prototype.extra=1;Reflect.set(...[{},'x',module.require]);",
  "function F(){Object.assign.apply(null,arguments)}F({},{});",
  "function F(...args){Reflect.set(...args)}F({},'x',0);",
  "[[{},'x',0]].forEach(args=>Reflect.set(...args));",
  "Object.setPrototypeOf(module,Object.getPrototypeOf(module));",
]);

/** Runtime replaces the loader; the analyzer still reports the window.
 * These are open soundness gaps: writes that reach the module object through
 * a helper parameter or a foreign callable are not connected to their call
 * sites yet. Each entry is a bug, listed so that it is visible and so that
 * fixing it is noticed. */
const KNOWN_FALSE_FINDINGS = new Set<string>([
  "function F(a){a.require=other}F(module);",
  "function F(a,b,c){Reflect.set(a,b,c)}F(module,'require',other);",
  "function F(a,b,c){Object.defineProperty(a,b,{value:c})}F(module,'require',other);",
]);

// `unknown(module)` and `external()(module)` hand the module object to code
// outside this source. The analyzer scopes its claims to this source, so those
// are reported as findings; the runtime stubs leave the loader intact as well.

describe("loader delegate differential corpus", () => {
  it("lists every corpus case in at most one exception list", () => {
    const corpus = new Set<string>(CORPUS);
    for (const setup of KNOWN_PRECISION_LIMITS) expect(corpus).toContain(setup);
    for (const setup of KNOWN_FALSE_FINDINGS) {
      expect(corpus).toContain(setup);
      expect(KNOWN_PRECISION_LIMITS).not.toContain(setup);
    }
  });

  it.each(CORPUS)("agrees with the runtime after %s", (setup) => {
    const source = `${SHIM}${setup}${LOAD}`;
    const runtime = runtimeLoads(source);
    expect(runtime).not.toBe("throws");
    const analyzed = analyzedWindows(source);
    if (KNOWN_FALSE_FINDINGS.has(setup)) {
      // Still a false finding; remove the entry once this starts agreeing.
      expect(runtime).toBe("replacement");
      expect(analyzed).toBe(1);
      return;
    }
    if (KNOWN_PRECISION_LIMITS.has(setup)) {
      // Still conservative; remove the entry once this starts agreeing.
      expect(runtime).toBe("original");
      expect(analyzed).toBe(0);
      return;
    }
    // A reported window needs the original API to have run: no false findings.
    if (analyzed === 1) expect(runtime).toBe("original");
    // A kept API must be reported, or the case belongs in the precision list.
    if (runtime === "original") expect(analyzed).toBe(1);
    else expect(analyzed).toBe(0);
  });
});
