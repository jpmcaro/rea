import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { analyzeParsedJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

/**
 * Seeded differential fuzzing of the CommonJS loader delegate.
 *
 * Random compositions of mutation fragments run in an isolated Node realm
 * with a real module wrapper and through the production analyzer. The only
 * hard requirement is soundness: a reported window needs the original
 * Electron API to have run. Precision misses are counted and reported, not
 * failed, because the analyzer is allowed to stay conservative.
 *
 * The run is deterministic for a seed. REA_LOADER_FUZZ_CASES scales the
 * number of compositions and REA_LOADER_FUZZ_SEED selects another seed, so a
 * reported counterexample reproduces from its printed source.
 */

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';
const LOAD = 'new (Q("electron").BrowserWindow)({});';

/** Statement fragments; `$n` is replaced by a fresh suffix per use. */
const FRAGMENTS = [
  // shim binding
  "Q=Q;",
  "Q=(Q);",
  "Q=other;",
  "Q ||= other;",
  "Q ??= other;",
  "Q &&= Q;",
  "var saved$n=Q;",
  // direct delegate writes and harmless copies
  "module.require=other;",
  "module.require=module.require;",
  "module.require &&= module.require;",
  "delete module.require;",
  "Object.assign(module,{require:other});",
  "Object.assign(module,{require:module.require});",
  "Object.assign(module,[]);",
  "Object.assign(module,/x/);",
  "Object.assign(module,{extra:1});",
  "Reflect.set(module,'require',other);",
  "Reflect.set(module,'require',module.require);",
  "Reflect.set({__proto__:null},'require',module.require,module);",
  "Reflect.set({},'require',other,module);",
  "Reflect.set(module,'require',other,{});",
  "Reflect.set(module,'extra',other);",
  // unknown recipients
  "Reflect.set(...[module,'require',other]);",
  "Reflect.set(...[{},'x',module.require]);",
  "Reflect.apply(Reflect.set,Reflect,[module,'require',other]);",
  "Reflect.apply(Reflect.set,Reflect,[{},'x',0]);",
  "const args$n=[module,'require',other];Reflect.set(...args$n);",
  "const args$n=[{},'x',0];Reflect.set(...args$n);",
  "Object.assign(...[module,{require:other}]);",
  "Object.assign(...[{},{require:other}]);",
  // helpers that forward their whole argument list
  "function h$n(){Object.assign.apply(null,arguments)}h$n(module,{require:other});",
  "function h$n(){Object.assign.apply(null,arguments)}h$n({},{});",
  "function h$n(...a){Reflect.set(...a)}h$n(module,'require',other);",
  "function h$n(...a){Reflect.set(...a)}h$n({},'x',0);",
  "function h$n(){Object.assign.apply(null,arguments)}",
  // aliases of the module object
  "const owner$n=module;owner$n.require=other;",
  "const owner$n={m:module};owner$n.m.require=other;",
  "const owner$n={m:{}};owner$n.m.require=other;",
  "[module][0].require=other;",
  "[{}][0].require=other;",
  "[module].at(0).require=other;",
  "Object.values({owner:module})[0].require=other;",
  "Reflect.get({owner:module},'owner').require=other;",
  "const list$n={0:module,at(){return {}}};list$n.at(0).require=other;",
  // accessors and keyed stores
  "const box$n={get v(){module.require=other;return 0}};box$n.v;",
  "const box$n={get v(){return 0}};box$n.v;",
  "const key$n={toString(){module.require=other;return 'require'}};Reflect.set(module,key$n,other);",
  "const key$n={toString(){return 'extra'}};Reflect.set(module,key$n,other);",
  // prototype stores
  "Object.setPrototypeOf(module,{require:other});",
  "Object.setPrototypeOf(module,Object.getPrototypeOf(module));",
  "Object.defineProperty(Object.prototype,'extra',{value:1,configurable:true});",
] as const;

type Loads = "original" | "replacement" | "throws";

const runtimeLoads = (source: string): Loads => {
  const outcome = runInNewContext(
    `
    const calls=[];
    const electron={BrowserWindow:function(){calls.push('original')}};
    function other(){return {BrowserWindow:function(){calls.push('replacement')}}}
    class Module { require(){ return electron } }
    const module=new Module;
    const require=id=>module.require(id);
    let failure='';
    try {
      (function(exports,require,module,__filename,__dirname){${source}})
        ({},require,module,'/tmp/bundle.cjs','/tmp');
    } catch (error) { failure=String(error); }
    failure===''?calls.join():'throws:'+failure;
  `,
    {},
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

/** mulberry32: small, deterministic, good enough for composition sampling. */
const createRandom = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const compose = (random: () => number, index: number): string => {
  const count = 1 + Math.floor(random() * 4);
  const parts: string[] = [];
  for (let position = 0; position < count; position += 1) {
    const fragment = FRAGMENTS[Math.floor(random() * FRAGMENTS.length)]!;
    parts.push(fragment.replaceAll("$n", `${index}_${position}`));
  }
  return parts.join("");
};

const CASES = Number(process.env.REA_LOADER_FUZZ_CASES ?? "150");
const SEED = Number(process.env.REA_LOADER_FUZZ_SEED ?? "20261019");

describe("loader delegate differential fuzz", () => {
  it(
    `reports no false window over ${CASES} seeded compositions`,
    () => {
      const random = createRandom(SEED);
      const falseFindings: string[] = [];
      let agreed = 0;
      let conservative = 0;
      let skipped = 0;
      for (let index = 0; index < CASES; index += 1) {
        const source = `${SHIM}${compose(random, index)}${LOAD}`;
        const runtime = runtimeLoads(source);
        if (runtime === "throws") {
          skipped += 1;
          continue;
        }
        let analyzed: number;
        try {
          analyzed = analyzedWindows(source);
        } catch (cause) {
          throw new Error(
            `Analyzer failed on ${JSON.stringify(source)}: ${String(cause)}`,
          );
        }
        if (analyzed === 1 && runtime !== "original")
          falseFindings.push(source);
        else if (analyzed === 0 && runtime === "original") conservative += 1;
        else agreed += 1;
      }
      // Keep the numbers visible in the test log for later comparison.
      console.log(
        `loader fuzz seed=${SEED} cases=${CASES} agreed=${agreed} conservative=${conservative} skipped=${skipped} false=${falseFindings.length}`,
      );
      expect(falseFindings, falseFindings.slice(0, 5).join("\n")).toEqual([]);
      expect(agreed).toBeGreaterThan(0);
      // Each composition costs tens of milliseconds; scaled runs need more time.
    },
    Math.max(30_000, CASES * 120),
  );
});
