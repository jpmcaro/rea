import { createContext, runInContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

describe("prototype slots without target runtime version evidence", () => {
  it.each([
    "copyWithin",
    "entries",
    "fill",
    "find",
    "findIndex",
    "keys",
    "values",
    "at",
    "findLast",
    "findLastIndex",
    "flat",
    "flatMap",
    "includes",
    "toReversed",
    "toSorted",
    "toSpliced",
    "with",
  ])(
    "keeps the default when the target does not provide Array.prototype.%s",
    (key) => {
      const source = `const {${key}:target=globalThis}=[];target.fetch=other;fetch('/local');`;
      const calls: string[] = [];
      const context = createContext({
        fetch: () => calls.push("original"),
        other: () => calls.push("replacement"),
      });
      runInContext(source, context);
      expect(calls).toEqual(["original"]);
      calls.length = 0;
      // A separate realm models an older target inventory; it is not a Node 18 run.
      const older = createContext({
        fetch: () => calls.push("original"),
        other: () => calls.push("replacement"),
      });
      // Model the target's initial intrinsic inventory, outside analyzed source.
      runInContext(`delete Array.prototype.${key};`, older);
      runInContext(source, older);
      expect(calls).toEqual(["replacement"]);
      expect(
        analyzeJavaScriptStaticSource(source).endpoints.filter(
          ({ mechanism }) => mechanism === "call:fetch",
        ),
      ).toHaveLength(0);
    },
  );
});
