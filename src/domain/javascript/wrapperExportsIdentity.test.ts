import { describe, expect, it } from "vitest";

import { analyzeParsedJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const load = (helper: string) => {
  const invocation =
    helper === "call"
      ? 'require.call(null,"electron")'
      : helper === "apply"
        ? 'require.apply(null,["electron"])'
        : 'require.bind(null,"electron")()';
  return `new (${invocation}.BrowserWindow)({});`;
};

const windowsOf = (source: string, path = "bundle.cjs") => {
  const parsed = parseJavaScriptSource(source, path);
  expect(parsed).not.toBeNull();
  return analyzeParsedJavaScriptStaticSource(source, parsed!).electron
    .browser_windows;
};

describe("CommonJS initial exports object identity", () => {
  it.each(["this", "module.exports", "exports"])(
    "retains the Object constructor selected through %s",
    (receiver) => {
      expect(
        windowsOf(
          `${receiver}.constructor.__proto__.call=other;${load("call")}`,
        ),
      ).toEqual([]);
    },
  );

  it.each([
    ["exports", "this"],
    ["this", "exports"],
    ["exports", "module.exports"],
    ["module.exports", "exports"],
  ])("shares stored module values from %s to %s", (source, receiver) => {
    expect(
      windowsOf(
        `${source}.wrapper=module;${receiver}.wrapper.require=other;${load("call")}`,
      ),
    ).toEqual([]);
  });

  it.each(["call", "apply", "bind"])(
    "retains shared %s mutations through lexical arrows and aliases",
    (helper) => {
      expect(
        windowsOf(
          `"use strict";const saved=this;(()=>{saved.constructor.__proto__.${helper}=other})();${load(helper)}`,
        ),
      ).toEqual([]);
    },
  );

  it.each(["this", "module.exports", "exports"])(
    "retains shared callable members inherited by %s",
    (receiver) => {
      expect(
        windowsOf(
          `${receiver}.toString.call.call=other;new (require.call.call(require,null,"electron").BrowserWindow)({});`,
        ),
      ).toEqual([]);
    },
  );

  it("preserves a helper captured before initial exports reaches it", () => {
    expect(
      windowsOf(
        'const invoke=require.call;this.constructor.__proto__.call=other;new (Reflect.apply(invoke,require,[null,"electron"]).BrowserWindow)({});',
      ),
    ).toHaveLength(1);
  });

  it.each([
    "module.exports={toString:{call:{}}};module.exports.toString.call.call=other;",
    "const local={constructor:{__proto__:{call:null}}};local.constructor.__proto__.call=other;",
    "this.call=other;",
  ])("preserves unrelated replacement and own-slot mutations: %s", (setup) => {
    expect(windowsOf(`${setup}${load("call")}`)).toHaveLength(1);
  });

  it("keeps explicit module top-level this separate from CommonJS exports", () => {
    expect(
      windowsOf(
        `this.constructor.__proto__.call=other;${load("call")}`,
        "bundle.mjs",
      ),
    ).toHaveLength(1);
  });

  it("retains the original top-level receiver after module.exports replacement", () => {
    expect(
      windowsOf(
        `module.exports={};this.constructor.__proto__.call=other;${load("call")}`,
      ),
    ).toEqual([]);
  });

  it.each(["this", "module.exports", "exports"])(
    "shares stored values from %s with the initial top-level receiver",
    (receiver) => {
      expect(
        windowsOf(
          `${receiver}.extra=Function.prototype;this.extra.call=other;${load("call")}`,
        ),
      ).toEqual([]);
    },
  );
});
