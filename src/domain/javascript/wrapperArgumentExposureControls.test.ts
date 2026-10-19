import { describe, expect, it } from "vitest";

import { analyzeParsedJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';
const consumer = (loader: string) =>
  `new (${loader}("electron").BrowserWindow)({});${loader}("electron").ipcMain.handle("version",()=>1);`;

const electronOf = (source: string) => {
  const parsed = parseJavaScriptSource(source, "bundle.cjs");
  expect(parsed).not.toBeNull();
  return analyzeParsedJavaScriptStaticSource(source, parsed!).electron;
};

describe("CommonJS wrapper arguments loader integrity", () => {
  it.each([
    "arguments[1]=()=>({BrowserWindow:class Fake{},ipcMain:{handle(){}}});",
    "const saved=arguments;saved[1]=other;",
    "(()=>{arguments[1]=other})();",
    "patch(arguments);",
    "const box={[void(arguments[1]=other)](){}};",
    "var arguments;arguments[1]=other;",
  ])("rejects a shim captured after wrapper argument exposure: %s", (setup) => {
    const electron = electronOf(`${setup}${SHIM}${consumer("Q")}`);
    expect(electron.browser_windows).toEqual([]);
    expect(electron.ipc).toEqual([]);
  });

  it.each([
    `${SHIM}arguments[1]=other;${consumer("Q")}`,
    `"use strict";arguments[1]=other;${SHIM}${consumer("Q")}`,
    `function f(){arguments[1]=other}f();${SHIM}${consumer("Q")}`,
    `(function(arguments){arguments[1]=other})({});${SHIM}${consumer("Q")}`,
    `const box={arguments:other};${SHIM}${consumer("Q")}`,
    `const arguments={};arguments[1]=other;${SHIM}${consumer("Q")}`,
    `void arguments.length;${SHIM}${consumer("Q")}`,
    `void arguments[3];${SHIM}${consumer("Q")}`,
    `void arguments[4];${SHIM}${consumer("Q")}`,
    `${SHIM}void arguments[3];${consumer("Q")}`,
    `${SHIM}void arguments[4];${consumer("Q")}`,
    `var arguments={};arguments[2]={};arguments[2].require=other;${SHIM}${consumer("Q")}`,
  ])("preserves an unaffected captured host loader: %s", (source) => {
    const electron = electronOf(source);
    expect(electron.browser_windows).toHaveLength(1);
    expect(electron.ipc).toMatchObject([{ channel: "version" }]);
  });

  it("rejects a direct host load after mapped parameter replacement", () => {
    const electron = electronOf(`arguments[1]=other;${consumer("require")}`);
    expect(electron.browser_windows).toEqual([]);
    expect(electron.ipc).toEqual([]);
  });

  it.each([
    "arguments[2].require=other;",
    '"use strict";arguments[2].require=other;',
    "const saved=arguments[2];saved.require=other;",
    "arguments[index].require=other;",
    "arguments[1].main.require=other;",
    "arguments.length=module;arguments.length.require=other;",
    "({x:arguments.length}={x:module});arguments.length.require=other;",
  ])(
    "rejects a live delegate exposed through wrapper arguments: %s",
    (setup) => {
      for (const loader of ["require", "Q"]) {
        const electron = electronOf(`${SHIM}${setup}${consumer(loader)}`);
        expect(electron.browser_windows).toEqual([]);
        expect(electron.ipc).toEqual([]);
      }
    },
  );
});
