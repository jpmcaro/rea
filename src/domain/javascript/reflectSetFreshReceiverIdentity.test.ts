import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';
const CONSUMER = 'Q("electron").ipcRenderer.send("kept");';

const ipcAfter = (setup: string) =>
  analyzeJavaScriptStaticSource(`${SHIM}${setup}${CONSUMER}`).electron.ipc.map(
    ({ side, operation, channel }) => ({ side, operation, channel }),
  );

it.each([
  ["a direct allocation", "", "Object.create(module)"],
  ["a null prototype", "", "Object.create(null)"],
  [
    "a captured allocation",
    "const receiver=Object.create(module);",
    "receiver",
  ],
  ["a captured allocator", "const create=Object.create;", "create(module)"],
  [
    "an allocator captured before its owner escapes",
    "const create=Object.create;patch(Object);",
    "create(module)",
  ],
  [
    "a captured allocator whose own properties escape",
    "const create=Object.create;patch(create);",
    "create(module)",
  ],
  [
    "an allocator whose own properties escape",
    "patch(Object.create);",
    "Object.create(module)",
  ],
  [
    "an allocator owner captured before global replacement",
    "const owner=Object;Object=unknown;",
    "owner.create(module)",
  ],
  [
    "an allocator captured before replacement",
    "const create=Object.create;Object.create=()=>module;",
    "create(module)",
  ],
  ["a call helper", "", "Object.create.call(null,module)"],
  ["an apply helper", "", "Object.create.apply(null,[module])"],
  ["Reflect.apply", "", "Reflect.apply(Object.create,null,[module])"],
  [
    "a bound allocator",
    "const create=Object.create.bind(null,module);",
    "create()",
  ],
  [
    "a bound allocator captured before replacement",
    "const create=Object.create.bind(null,module);Object.create=()=>module;",
    "create()",
  ],
  [
    "a bound allocator captured before its owner escapes",
    "const create=Object.create.bind(null,module);patch(Object);",
    "create()",
  ],
  [
    "a bound helper separate from the target's own slot",
    "const create=Object.create.bind(null,module);Object.create.call=()=>module;",
    "create.call(null)",
  ],
])(
  "keeps a module loader beside Reflect.set with %s",
  (_name, setup, receiver) => {
    expect(
      ipcAfter(`${setup}Reflect.set(module,"require",other,${receiver});`),
    ).toEqual([{ side: "renderer", operation: "send", channel: "kept" }]);
  },
);

it.each([
  [
    "a replaced allocator",
    "Object.create=()=>module;",
    "Object.create(module)",
  ],
  [
    "an accessor replacing the allocator",
    'Object.defineProperty(Object,"create",{get(){return ()=>module;}});',
    "Object.create(module)",
  ],
  ["a replaced allocator owner", "Object=unknown;", "Object.create(module)"],
  ["an escaped allocator owner", "patch(Object);", "Object.create(module)"],
  [
    "an allocator captured after its owner escapes",
    "patch(Object);const create=Object.create;",
    "create(module)",
  ],
  [
    "a captured allocator owner that escapes",
    "const owner=Object;patch(owner);",
    "owner.create(module)",
  ],
  [
    "an allocator whose call helper may change after escape",
    "patch(Object.create);",
    "Object.create.call(null,module)",
  ],
  [
    "a bound allocator captured after its owner escapes",
    "patch(Object);const create=Object.create.bind(null,module);",
    "create()",
  ],
  ["an arbitrary call", "", "makeReceiver(module)"],
  ["an unknown receiver", "", "receiver"],
  [
    "a replaced call helper",
    "Object.create.call=()=>module;",
    "Object.create.call(null,module)",
  ],
  [
    "a replaced apply helper",
    "Function.prototype.apply=()=>module;",
    "Object.create.apply(null,[module])",
  ],
  [
    "a replaced bind helper",
    "Object.create.bind=()=>()=>module;const create=Object.create.bind(null,module);",
    "create()",
  ],
  [
    "a replaced bound call helper",
    "const create=Object.create.bind(null,module);create.call=()=>module;",
    "create.call(null)",
  ],
  [
    "a replaced helper prototype",
    "Object.setPrototypeOf(Object.create,{call(){return module;}});",
    "Object.create.call(null,module)",
  ],
])("retains possible module writes through %s", (_name, setup, receiver) => {
  expect(
    ipcAfter(`${setup}Reflect.set(module,"require",other,${receiver});`),
  ).toEqual([]);
});

it("keeps the reported escaped allocator receiver unresolved", () => {
  expect(
    analyzeJavaScriptStaticSource(
      'patch(Object);Reflect.set(module,"require",other,Object.create(module));new(require("electron").BrowserWindow)({});',
    ).electron.browser_windows,
  ).toEqual([]);
});

it("retains setter side effects with a fresh Reflect.set receiver", () => {
  expect(
    ipcAfter(`
    const target={set x(value){module.require=value;}};
    Reflect.set(target,"x",other,Object.create(module));
  `),
  ).toEqual([]);
});

it("retains descriptor getter side effects while allocating a receiver", () => {
  expect(
    ipcAfter(`
    const descriptors={get x(){module.require=other;return {value:1};}};
    Reflect.set(module,"require",other,Object.create(module,descriptors));
  `),
  ).toEqual([]);
});
