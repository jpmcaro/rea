import { describe, expect, it } from "vitest";

import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { analyzeParsedJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';
const USE = 'Q("electron").ipcRenderer.send("kept");';
const analyze = (setup: string) => {
  const source = `${SHIM}${setup}${USE}`;
  const parsed = parseJavaScriptSource(source, "bundle.js");
  if (parsed === null) throw new Error("Expected parsed source");
  return analyzeParsedJavaScriptStaticSource(source, parsed).electron.ipc;
};

describe("mutated class constructor parents", () => {
  it.each([
    "Object.setPrototypeOf(C,G);",
    "Reflect.setPrototypeOf(C,G);",
    "C.__proto__=G;",
    "const Alias=C;Object.setPrototypeOf(Alias,G);",
  ])("retains receiver uncertainty after %s", (mutation) => {
    expect(
      analyze(
        `class B{}class G{constructor(){return globalThis}}class C extends B{field=(this.Q=other)}${mutation}new C();`,
      ),
    ).toEqual([]);
  });

  it.each([
    "new C().run();Object.setPrototypeOf(C,G);",
    "const c=new C();Object.setPrototypeOf(C,G);c.run();",
  ])(
    "preserves a private receiver captured before a parent change: %s",
    (use) => {
      expect(
        analyze(
          `class B{}class G{constructor(){return globalThis}}class C extends B{#set(){this.Q=other}run(){this.#set()}}${use}`,
        ),
      ).toMatchObject([{ channel: "kept" }]);
    },
  );

  it.each(["consume(C);", "function consume(C){new C()}consume(C);"])(
    "retains unknown receivers when the changed constructor escapes: %s",
    (use) => {
      expect(
        analyze(
          `class B{}class G{constructor(){return globalThis}}class C extends B{field=(this.Q=other)}Object.setPrototypeOf(C,G);${use}`,
        ),
      ).toEqual([]);
    },
  );

  it("retains changed parent receivers through a bound constructor", () => {
    expect(
      analyze(
        "class B{}class G{constructor(){return globalThis}}class C extends B{field=(this.Q=other)}const Make=C.bind(null);Object.setPrototypeOf(C,G);new Make();",
      ),
    ).toEqual([]);
  });

  it.each([
    ["class C extends B{constructor(){super();this.Q=other}}", "new C();"],
    [
      "class C extends B{#set(){this.Q=other}static run(c){c.#set()}}",
      "C.run(new C());",
    ],
  ])("retains other inherited receiver consumers: %s", (declaration, use) => {
    expect(
      analyze(
        `class B{}class G{constructor(){return globalThis}}${declaration};Object.setPrototypeOf(C,G);${use}`,
      ),
    ).toEqual([]);
  });

  it("propagates a changed intermediate parent to derived fields", () => {
    expect(
      analyze(
        "class A{}class B extends A{}class G{constructor(){return globalThis}}class C extends B{field=(this.Q=other)}Object.setPrototypeOf(B,G);new C();",
      ),
    ).toEqual([]);
  });

  it.each([
    "Object.getPrototypeOf=target=>Object.setPrototypeOf(target,G);Object.getPrototypeOf(C);",
    "Reflect.getPrototypeOf=target=>Object.setPrototypeOf(target,G);Reflect.getPrototypeOf(C);",
    "const query=Object.getPrototypeOf;query.call=(_this,target)=>Object.setPrototypeOf(target,G);query.call(null,C);",
    "const Alias=C;external(Alias);Object.getPrototypeOf(Alias);",
  ])("retains uncertain prototype inquiry effects: %s", (inquiry) => {
    expect(
      analyze(
        `class B{}class G{constructor(){return globalThis}}class C extends B{field=(this.Q=other)}${inquiry}new C();`,
      ),
    ).toEqual([]);
  });

  it("keeps base construction independent of its constructor parent", () => {
    expect(
      analyze(
        "class G{constructor(){return globalThis}}class C{field=(this.Q=other)}Object.setPrototypeOf(C,G);new C();",
      ),
    ).toMatchObject([{ channel: "kept" }]);
  });

  it.each([
    "new C();",
    "const otherClass=class extends B{};Object.setPrototypeOf(otherClass,G);new C();",
    "const parent=Object.getPrototypeOf(C);new C();",
    "const query=Object.getPrototypeOf;const parent=query(C);new C();",
    "const Alias=C;const parent=Reflect.getPrototypeOf(Alias);new C();",
    "const parent=Reflect.apply(Object.getPrototypeOf,Object,[C]);new C();",
    "new C();Object.setPrototypeOf(C,G);",
  ])("preserves unchanged constructor receiver separation: %s", (use) => {
    expect(
      analyze(
        `class B{}class G{constructor(){return globalThis}}class C extends B{field=(this.Q=other)}${use}`,
      ),
    ).toMatchObject([{ channel: "kept" }]);
  });
});
