import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';
const USE = 'new(Q("electron").BrowserWindow)({});';

it.each([
  [
    "object method",
    "const base={set(){this.Q=other}};const child={__proto__:base,go(){super.set()}};child.go();",
  ],
  [
    "instance method",
    "class B{set(){this.Q=other}}class C extends B{go(){super.set()}}new C().go();",
  ],
  [
    "static method",
    "class B{static set(){this.Q=other}}class C extends B{static go(){super.set()}}C.go();",
  ],
  [
    "nested method chain",
    "class A{set(){this.Q=other}}class B extends A{go(){super.set()}}class C extends B{go(){super.go()}}new C().go();",
  ],
  [
    "static block",
    "class B{static set(){this.Q=other}}class C extends B{static{super.set()}}",
  ],
  [
    "static field",
    "class B{static set(){this.Q=other}}class C extends B{static value=super.set()}",
  ],
  [
    "instance field",
    "class B{set(){this.Q=other}}class C extends B{value=super.set()}new C();",
  ],
  [
    "constructor member",
    "class B{set(){this.Q=other}}class C extends B{constructor(){super();super.set()}}new C();",
  ],
  [
    "constructed local field",
    "class B{set(){this.root.Q=other}}class C extends B{root={};value=super.set()}new C();",
  ],
  [
    "object setter",
    "const base={set value(v){this.Q=other}};const child={__proto__:base,go(){super.value=1}};child.go();",
  ],
  [
    "instance setter",
    "class B{set value(v){this.Q=other}}class C extends B{go(){super.value=1}}new C().go();",
  ],
  [
    "static getter",
    "class B{static get value(){this.Q=other}}class C extends B{static go(){return super.value}}C.go();",
  ],
  [
    "bound owner",
    "class B{set(){this.Q=other}}class C extends B{go(){super.set()}}C.prototype.go.bind({})();",
  ],
  [
    "object getter",
    "const base={get value(){this.Q=other}};const child={__proto__:base,go(){return super.value}};child.go();",
  ],
  [
    "instance getter",
    "class B{get value(){this.Q=other}}class C extends B{go(){return super.value}}new C().go();",
  ],
  [
    "lexical arrow and computed tag",
    "const base={set(){this.Q=other}};const child={__proto__:base,go(){(()=>super['set']``)()}};child.go();",
  ],
])("keeps the enclosing receiver local for a super %s", (_name, setup) => {
  expect(
    analyzeJavaScriptStaticSource(SHIM + setup + USE).electron.browser_windows,
  ).toHaveLength(1);
});

it.each([
  "class B{set(){this.root.Q=other}}class C extends B{root=globalThis;value=super.set()}new C();",
  "class B{static set(){this.root.Q=other}}class C extends B{static root=globalThis;static{super.set()}}",
  "class B{}class G{constructor(){return globalThis}}class C extends B{field=super.set()}B.prototype.set=function(){this.Q=other};Object.setPrototypeOf(C,G);new C();",
  "const base={get self(){return this}};const child={__proto__:base,set(){this.Q=other},go(){external(super.self.set)}};child.set();child.go();",
  "const base={get self(){return this}};const child={__proto__:base,set(){this.Q=other},go(){external(super.self)}};child.set();child.go();",
  "class B{get self(){return this}}class C extends B{set(){this.Q=other}go(){external(super.self.set)}}const child=new C();child.set();child.go();",
  "class B{set(){this.Q=other}}class C extends B{go(){super.set()}}C.prototype.go.apply(globalThis,[]);",
  "class B{set(){this.Q=other}}class C extends B{go(){super.set()}}C.prototype.go.bind(globalThis)();",
  "class B{set(){this.Q=other}}class C extends B{go(){super.set()}}",
  "class B{set(){this.Q=other}}class C extends B{go(){super.set()}}new C().go();external(C.prototype.go);",
  "class B{constructor(){return globalThis}set(){this.Q=other}}class C extends B{constructor(){super();super.set()}}new C();",
  "class B{constructor(){return globalThis}set(){this.Q=other}}class C extends B{value=super.set()}new C();",
  "const base={set value(v){this.Q=other}};const child={__proto__:base,go(){super.value=1}};child.go.call(globalThis);",
  "class B{set(){this.Q=other}}class C extends B{go(){super.set.apply(globalThis,[])}}new C().go();",
  "class B{set(){this.Q=other}}class C extends B{go(){super.set.bind(globalThis)()}}new C().go();",
  "const base={set(){this.Q=other}};const child={__proto__:base,go(){super.set()}};child.go.call(globalThis);",
  "class B{set(){this.Q=other}}class C extends B{go(){super.set()}}C.prototype.go.call(globalThis);",
  "class B{static set(){this.Q=other}}class C extends B{static go(){super.set()}}C.go.call(globalThis);",
  "const base={get value(){this.Q=other}};const child={__proto__:base,go(){return super.value}};child.go.call(globalThis);",
  "class B{set(){this.Q=other}}class C extends B{go(){super.set.call(globalThis)}}new C().go();",
  "const base={set(){this.Q=other}};const child={__proto__:base,go(){super.set()}};child.go();external(child.go);",
])("retains global receiver alternatives for %s", (setup) => {
  expect(
    analyzeJavaScriptStaticSource(SHIM + setup + USE).electron.browser_windows,
  ).toHaveLength(0);
});

it("leaves bare super construction with the constructor-stage owner", () => {
  const setup =
    "function B(){this.Q=other}class C extends B{constructor(){super()}}new B();new C();";
  expect(
    analyzeJavaScriptStaticSource(SHIM + setup + USE).electron.browser_windows,
  ).toHaveLength(1);
});

it.each([
  'const base={set(){this.Q=other}};const child={__proto__:base,go(){"use strict";super.set()}};const go=child.go;go();',
  'const base={set(){this.Q=other}};const child={__proto__:base,go(){"use strict";super.set()}};child.go.call(undefined);',
  'const base={set(){this.Q=other}};const child={__proto__:base,go(){"use strict";super.set()}};child.go.call(null);',
  'const base={set(){this.Q=other}};const child={__proto__:base,go(){"use strict";super.set()}};child.go.call(maybe);',
  'const base={get value(){this.Q=other}};const child={__proto__:base,go(){"use strict";return super.value}};const go=child.go;go();',
  'const a={set(){this.Q=other}};const b={__proto__:a,set(){"use strict";super.set()}};const c={__proto__:b,go(){"use strict";super.set()}};const go=c.go;go();',
])(
  "applies sloppy substitution after forwarding the lexical receiver: %s",
  (setup) => {
    expect(
      analyzeJavaScriptStaticSource(SHIM + setup + USE).electron
        .browser_windows,
    ).toHaveLength(0);
  },
);

it("preserves undefined when the super target is strict", () => {
  const setup =
    'const base={set(){"use strict";this.Q=other}};const child={__proto__:base,go(){"use strict";super.set()}};const go=child.go;go();';
  expect(
    analyzeJavaScriptStaticSource(SHIM + setup + USE).electron.browser_windows,
  ).toHaveLength(1);
});

it.each([
  "class A{root=globalThis;get value(){return this.root}}new A().value.Q=other;",
  "const base={get value(){return this.root}};const child={__proto__:base,root:globalThis,get result(){return super.value}};child.result.Q=other;",
  "class A{static self=this;static get value(){return this.root}}class B extends A{static root=globalThis;static get result(){return super.value}}external(B.self);B.result.Q=other;",
  "class A{static get value(){this.root=globalThis;return this.root}}class B extends A{static root={};static get result(){return super.value}}B.result.Q=other;",
  "class A{static root=globalThis;static get value(){return this.root}}class B extends A{static early=this.result;static root={};static get result(){return super.value}}B.early.Q=other;",
  "class A{static root=globalThis;static get value(){return this.root}}class B extends A{static early=this.result;static root={};static late=this.result;static get result(){return super.value}}B.early.Q=other;",
  "class A{static get value(){return this.root}}class B extends A{static root=globalThis;static get result(){return super.value}}const saved=B.result;B.root={};saved.Q=other;",
  "class A{static get value(){return this.root}}class B extends A{static root=globalThis;static get result(){return super.value}}const Alias=B;Alias.result.Q=other;",
  "class A{get value(){return this.root}}class B extends A{root=globalThis}new B().value.Q=other;",
  "class A{get value(){return this.root}}class B extends A{root=globalThis;get result(){return super.value}}new B().result.Q=other;",
  "class A{static get value(){return this.root}}class B extends A{static root=globalThis;static get result(){return super.value}}B.result.Q=other;",
  "class A{get value(){return this.root}}class B extends A{root=globalThis;get result(){return super['value']}}new B().result.Q=other;",
  "class A{get value(){return this.root}}class B extends A{root=globalThis;get result(){return (()=>super.value)()}}new B().result.Q=other;",
])("retains shared fields returned through a super getter: %s", (setup) => {
  expect(
    analyzeJavaScriptStaticSource(SHIM + setup + USE).electron.browser_windows,
  ).toHaveLength(0);
});

it.each([
  "class A{static self=this;static get value(){return this.root}}class B extends A{static root={};static get result(){return super.value}}B.result.Q=other;",
  "const base={get value(){return this.root}};const child={__proto__:base,root:{},get result(){return super.value}};child.result.Q=other;",
  "class A{static root=globalThis;static get value(){return this.root}}class B extends A{static root={};static early=this.result;static get result(){return super.value}}B.early.Q=other;",
  "class A{get value(){return this.root}}class B extends A{root={};get result(){return super.value}}new B().result.Q=other;",
  "class A{root=globalThis;get value(){return this.root}}class B extends A{root={};get result(){return super.value}}new B().result.Q=other;",
  "class A{static root=globalThis;static get value(){return this.root}}class B extends A{static root={};static get result(){return super.value}}B.result.Q=other;",
  "class A{get value(){return globalThis}}class B extends A{get value(){return {}}}class C extends B{get result(){return super.value}}new C().result.Q=other;",
  "class A{get value(){return globalThis}}class B extends A{get result(){const value={};return value}}new B().result.Q=other;",
])(
  "preserves the actual receiver and selected super descriptor: %s",
  (setup) => {
    expect(
      analyzeJavaScriptStaticSource(SHIM + setup + USE).electron
        .browser_windows,
    ).toHaveLength(1);
  },
);
