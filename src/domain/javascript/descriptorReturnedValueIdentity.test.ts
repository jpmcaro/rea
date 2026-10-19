import { describe, expect, it } from "vitest";

import { analyzeParsedJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const LOAD = 'new(require("electron").BrowserWindow)({});';
const HELPERS =
  'new(require.call.call(require,null,"electron").BrowserWindow)({});';

const windows = (source: string) => {
  const parsed = parseJavaScriptSource(source, "bundle.cjs");
  expect(parsed).not.toBeNull();
  return analyzeParsedJavaScriptStaticSource(source, parsed!).electron
    .browser_windows;
};

describe("references captured in own property descriptors", () => {
  it.each([
    'Object.getOwnPropertyDescriptor(module.constructor,"prototype").value.require=other;',
    'Reflect.getOwnPropertyDescriptor(module.constructor,"prototype").value.require=other;',
    "Object.getOwnPropertyDescriptors(module.constructor).prototype.value.require=other;",
    'const descriptor=Object.getOwnPropertyDescriptor(module.constructor,"prototype");descriptor.value.require=other;',
    'module.constructor.prototype.extra=module;Object.getOwnPropertyDescriptor(module.constructor.prototype,"extra").value.require=other;',
    'Object.getOwnPropertyDescriptor(module.constructor,"prototype")[field].require=other;',
    "Object.getOwnPropertyDescriptor(module.constructor,key).value.require=other;",
    'const local={value:module};Object.getOwnPropertyDescriptor(local,"value").value.require=other;',
    'const local={value:module};const descriptor=Object.getOwnPropertyDescriptor(local,"value");local.value={};descriptor.value.require=other;',
    'Object.getOwnPropertyDescriptor(process,"mainModule").value.require=other;',
    'Object.getOwnPropertyDescriptor(require,"main").value.require=other;',
    'Object.getOwnPropertyDescriptor(module,"children").value[0].constructor.prototype.require=other;',
    "Object.getOwnPropertyDescriptor(require.cache,key).value.constructor.prototype.require=other;",
  ])("retains a captured module prototype mutation: %s", (mutation) => {
    expect(windows(`${mutation}${LOAD}`)).toEqual([]);
  });

  it.each([
    'Object.getOwnPropertyDescriptor(Function.prototype,"call").value.call=other;',
    'Reflect.getOwnPropertyDescriptor(Function.prototype,"call").value.call=other;',
    "Object.getOwnPropertyDescriptors(Function.prototype).call.value.call=other;",
    'Object.getOwnPropertyDescriptor(Object.prototype,"__proto__").get.__proto__.call.call=other;',
  ])("retains a captured shared callable mutation: %s", (mutation) => {
    expect(windows(`${mutation}${HELPERS}`)).toEqual([]);
  });

  it.each([
    'Object.getOwnPropertyDescriptor(Math,"max").value.call.call=other;',
    'Object.getOwnPropertyDescriptor(external,"method").value.call.call=other;',
    'const local={get p(){},set p(value){}};Object.getOwnPropertyDescriptor(local,"p").get.call.call=other;',
    "const local={set p(value){},get p(){}};Object.getOwnPropertyDescriptors(local).p.set.call.call=other;",
    'const local=[Function.prototype.call];Object.getOwnPropertyDescriptor(local,"0").value.call=other;',
    'class C{method(){}}Object.getOwnPropertyDescriptor(C.prototype,"method").value.call.call=other;',
    'class C{static value=Function.prototype.call}Object.getOwnPropertyDescriptor(C,"value").value.call=other;',
    'Object.getOwnPropertyDescriptor(module,"exports").value.toString.call.call=other;',
  ])(
    "retains unresolved or captured callable descriptor contents: %s",
    (setup) => {
      expect(windows(`${setup}${HELPERS}`)).toEqual([]);
    },
  );

  it.each([
    'const local={method:{call:{}}};Object.getOwnPropertyDescriptor(local,"method").value.call.call=other;',
    'const descriptor=Object.getOwnPropertyDescriptor(module.constructor,"prototype");descriptor.value={require:other};',
    'const descriptor=Object.getOwnPropertyDescriptor(Function.prototype,"call");descriptor.value={call:other};',
    'const descriptor=Object.getOwnPropertyDescriptor(module.constructor,"prototype");descriptor.value={};descriptor.value.require=other;',
    'const local={value:module};local.value={};Object.getOwnPropertyDescriptor(local,"value").value.require=other;',
    'const local={get method(){return Function.prototype.call}};const descriptor=Object.getOwnPropertyDescriptor(local,"method");if(descriptor.value)descriptor.value.call=other;',
    'const local=Object.create(Function.prototype);const descriptor=Object.getOwnPropertyDescriptor(local,"call");if(descriptor)descriptor.value.call=other;',
  ])(
    "preserves distinct descriptor fields and own-only lookup: %s",
    (setup) => {
      expect(windows(`${setup}${HELPERS}`)).toHaveLength(1);
    },
  );
});

describe("array descriptor slot captures", () => {
  const electron = (source: string) => {
    const parsed = parseJavaScriptSource(source, "bundle.cjs");
    expect(parsed).not.toBeNull();
    return analyzeParsedJavaScriptStaticSource(source, parsed!).electron;
  };
  const consume =
    'const E=require("electron");new E.BrowserWindow({});E.ipcMain.handle("capture",()=>1);';

  it.each([
    'const local=[{}];local[0]=module;Object.getOwnPropertyDescriptor(local,"0").value.require=other;',
    "const local=[];local[0]=module;Object.getOwnPropertyDescriptors(local)[0].value.require=other;",
    'const local=[{}];Reflect.set(local,"0",module);Reflect.getOwnPropertyDescriptor(local,"0").value.require=other;',
    'const local=[{}];Object.defineProperty(local,"0",{value:module,writable:true});Object.getOwnPropertyDescriptor(local,"0").value.require=other;',
    'const local=[module];const descriptor=Object.getOwnPropertyDescriptor(local,"0");local[0]={};descriptor.value.require=other;',
    'const local=[{}];local.length=0;local[0]=module;Object.getOwnPropertyDescriptor(local,"0").value.require=other;',
  ])(
    "retains the stored reference selected when the descriptor is captured: %s",
    (setup) => {
      const result = electron(`${setup}${consume}`);
      expect(result.browser_windows).toEqual([]);
      expect(result.ipc).toEqual([]);
    },
  );

  it.each([
    'const local=[{}];const descriptor=Object.getOwnPropertyDescriptor(local,"0");local[0]=module;descriptor.value.require=other;',
    'const local=[module];local[0]={};Object.getOwnPropertyDescriptor(local,"0").value.require=other;',
    'const local=[module];const descriptor=Object.getOwnPropertyDescriptor(local,"0");descriptor.value={};descriptor.value.require=other;',
    'const local=[{}];Object.getOwnPropertyDescriptor(local,"length").value.require=other;',
  ])("keeps a distinct captured data value: %s", (setup) => {
    const result = electron(`${setup}${consume}`);
    expect(result.browser_windows).toHaveLength(1);
    expect(result.ipc).toHaveLength(1);
  });
});
