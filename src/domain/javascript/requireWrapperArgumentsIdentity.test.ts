import { describe, expect, it } from "vitest";

import { analyzeParsedJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const windows = (source: string) => {
  const parsed = parseJavaScriptSource(source, "entry.cjs");
  expect(parsed).not.toBeNull();
  return analyzeParsedJavaScriptStaticSource(source, parsed!).electron
    .browser_windows;
};
const loadWindow = 'new(load("electron").BrowserWindow)({});';
const callWindow = 'new(load.call(null,"electron").BrowserWindow)({});';

describe("wrapper exports parameter mapping", () => {
  it.each([
    "arguments[0]=module;exports.require=other;",
    "const args=arguments;args[0]=module;exports.require=other;",
    "const args=arguments;arguments={};args[0]=module;exports.require=other;",
    "(()=>{arguments[0]=module})();exports.require=other;",
    "arguments[0]=module;delete arguments[0];arguments[0]={};exports.require=other;",
    'Object.defineProperty(arguments,"0",{value:module,writable:false});exports.require=other;',
  ])("retains a value written through a mapped slot: %s", (setup) => {
    expect(windows(`const load=require;${setup}${loadWindow}`)).toEqual([]);
  });

  it.each([
    '"use strict";const load=require;arguments[0]=module;exports.require=other;',
    "const load=require;delete arguments[0];arguments[0]=module;exports.require=other;",
    'const load=require;Object.defineProperty(arguments,"0",{get(){return module}});exports.require=other;',
    'const load=require;Object.defineProperty(arguments,"0",{value:{},writable:false});arguments[0]=module;exports.require=other;',
    "const load=require;arguments[0].safe={};exports.require=other;",
    "const load=require;const initial=exports;arguments[0]=module;initial.require=other;",
  ])("preserves an exports value outside the mapping: %s", (source) => {
    expect(windows(`${source}${loadWindow}`)).toHaveLength(1);
  });
});

it.each([
  "var exports;const saved=exports;exports={};",
  "var module;const saved=module.exports;module={};",
  "var exports=(exports.toString.call.call=other,{});const saved={toString:{call:{}}};",
  "var module=(module.exports.toString.call.call=other,{});const saved={toString:{call:{}}};",
  "var exports=exports;const saved=exports;",
])(
  "retains an initial wrapper object before later var rebinding: %s",
  (setup) => {
    expect(
      windows(
        `${setup}saved.toString.call.call=other;new(require.call.call(require,null,"electron").BrowserWindow)({});`,
      ),
    ).toEqual([]);
  },
);

it.each([
  "arguments[3]={valueOf(){module.require=other;return 0}};+arguments[3];",
  'Object.defineProperty(arguments,"length",{get(){module.require=other;return 0}});void arguments.length;',
])("retains mutations caused by changed scalar slots: %s", (setup) => {
  expect(windows(`const load=require;${setup}${loadWindow}`)).toEqual([]);
});

it.each([
  "var exports={run(){exports.value.require=other},value:module};exports.run();",
  "var exports={run:()=>{exports.value.require=other},value:module};exports.run();",
  "var exports={run:(value=exports.value)=>{value.require=other},value:module};exports.run();",
  "var exports={Factory:class{field=(exports.value.require=other)},value:module};new exports.Factory();",
])(
  "selects the rebound wrapper value in deferred initializer regions: %s",
  (setup) => {
    expect(
      windows(`${setup}new(require("electron").BrowserWindow)({});`),
    ).toEqual([]);
  },
);

it.each([
  'var exports={[(exports.toString.call.call=other,"run")](){}};',
  'var module=class{[(module.exports.toString.call.call=other,"run")](){}};',
  "var exports=({value=(exports.toString.call.call=other)}={});",
  "var exports=(()=>{exports.toString.call.call=other;return {}})();",
  "var module=(()=>{module.exports.toString.call.call=other;return {}})();",
])(
  "retains immediate key and default evaluation before wrapper initialization: %s",
  (setup) => {
    expect(
      windows(
        `${setup}new(require.call.call(require,null,"electron").BrowserWindow)({});`,
      ),
    ).toEqual([]);
  },
);

it.each([
  "var exports;exports={toString:{call:{}}};const saved=exports;",
  "var module;module={exports:{toString:{call:{}}}};const saved=module.exports;",
])("selects a var replacement captured before mutation: %s", (setup) => {
  expect(
    windows(
      `${setup}saved.toString.call.call=other;new(require.call.call(require,null,"electron").BrowserWindow)({});`,
    ),
  ).toHaveLength(1);
});

describe.each(["", '"use strict";'])(
  "wrapper argument values: %s",
  (directive) => {
    it.each([
      "const load=require;",
      "const load=require.bind(null);",
      'var load=(e=>typeof require<"u"?require:e)(function(){});',
    ])("retains the module object after loader capture: %s", (capture) => {
      expect(
        windows(
          `${directive}${capture}arguments[2].require=other;${loadWindow}`,
        ),
      ).toEqual([]);
    });

    it.each([
      "arguments[1].call=other;",
      "const args=arguments;args[1].call=other;",
      'Object.defineProperty(arguments[1],"call",{value:other});',
      "arguments[1].call.call=other;",
    ])("retains callable helper identity: %s", (write) => {
      const call = write.includes("call.call")
        ? 'new(load.call.call(load,null,"electron").BrowserWindow)({});'
        : callWindow;
      expect(windows(`${directive}const load=require;${write}${call}`)).toEqual(
        [],
      );
    });

    it("preserves a load before a later argument-object mutation", () => {
      expect(
        windows(
          `${directive}const load=require;${loadWindow}arguments[2].require=other;${loadWindow}`,
        ),
      ).toHaveLength(1);
    });

    it.each([
      ["arguments[2]={};arguments[2].require=other;", loadWindow],
      ["arguments[1]={};arguments[1].call=other;", callWindow],
      ["arguments[0]={};arguments[0].require=other;", loadWindow],
      [
        'Object.defineProperty(arguments,"2",{value:{}});arguments[2].require=other;',
        loadWindow,
      ],
      [
        'Object.defineProperty(arguments,"1",{value:{}});arguments[1].call=other;',
        callWindow,
      ],
      ["const args=arguments;args[2]={};args[2].require=other;", loadWindow],
      [
        "arguments[2]={};const target=arguments[2];target.require=other;",
        loadWindow,
      ],
    ])("selects a definite argument-slot replacement: %s", (setup, use) => {
      expect(
        windows(`${directive}const load=require;${setup}${use}`),
      ).toHaveLength(1);
    });

    it.each([
      "const target=arguments[2];arguments[2]={};target.require=other;",
      "exports.target=module;arguments[0].target.require=other;",
      "arguments[3]=module;arguments[3].require=other;",
      "const args=arguments;args.target=module;args.target.require=other;",
      'Object.defineProperty(arguments,"2",{get(){return module}});arguments[2]={};arguments[2].require=other;',
      'Object.defineProperty(arguments,"2",{set(value){module.require=other}});arguments[2]={};',
    ])("retains captures and unproven descriptor replacements: %s", (setup) => {
      expect(
        windows(`${directive}const load=require;${setup}${loadWindow}`),
      ).toEqual([]);
    });

    it("keeps an ordinary function's own arguments separate", () => {
      expect(
        windows(
          `${directive}const load=require;function patch(){arguments[2].require=other}patch(null,null,{});${loadWindow}`,
        ),
      ).toHaveLength(1);
    });

    it.each([0, 3, 4])(
      "retains shared helpers from initial argument %s",
      (index) => {
        expect(
          windows(
            `${directive}const load=require;arguments[${index}].toString.call.call=other;new(load.call.call(load,null,"electron").BrowserWindow)({});`,
          ),
        ).toEqual([]);
      },
    );

    it.each([
      "arguments.callee",
      "arguments.toString",
      "arguments.__proto__.toString",
      "arguments.length.toString",
    ])(
      "retains shared helpers from unmodeled arguments members: %s",
      (member) => {
        expect(
          windows(
            `${directive}const load=require;${member}.call.call=other;new(load.call.call(load,null,"electron").BrowserWindow)({});`,
          ),
        ).toEqual([]);
      },
    );

    it("preserves primitive length reads and definite unmodeled-member replacements", () => {
      expect(
        windows(
          `${directive}const load=require;void arguments.length;arguments.extra={};arguments.extra.require=other;${loadWindow}`,
        ),
      ).toHaveLength(1);
    });
  },
);

it.each([
  "const args=arguments;arguments={};args[2].require=other;",
  "var arguments;const args=arguments;arguments={};args[2].require=other;",
  "const args=arguments;var arguments={};args[2].require=other;",
])(
  "retains a wrapper object captured before binding replacement: %s",
  (setup) => {
    expect(windows(`const load=require;${setup}${loadWindow}`)).toEqual([]);
  },
);

it.each([
  "var arguments={};arguments[2]={};arguments[2].require=other;",
  "let arguments={};arguments[2]={};arguments[2].require=other;",
  "const arguments={2:{}};arguments[2].require=other;",
  "arguments={2:{}};const args=arguments;args[2].require=other;",
])(
  "preserves host identity after arguments binding replacement: %s",
  (setup) => {
    expect(windows(`const load=require;${setup}${loadWindow}`)).toHaveLength(1);
  },
);

it.each([
  "arguments[1].call=other;new(require.call(null,'electron').BrowserWindow)({});",
  "arguments[2].require=other;new(require('electron').BrowserWindow)({});",
])("retains unmapped argument values in strict wrappers: %s", (source) => {
  expect(windows(`"use strict";${source}`)).toEqual([]);
});

it.each([
  ["require=module;arguments[1].require=other;", loadWindow],
  ["module=require;arguments[2].call=other;", callWindow],
  ["exports=module;arguments[0].require=other;", loadWindow],
  ["__filename=module;arguments[3].require=other;", loadWindow],
  ["__dirname=require;arguments[4].call=other;", callWindow],
])("retains mapped parameter replacements: %s", (setup, use) => {
  expect(windows(`const load=require;${setup}${use}`)).toEqual([]);
});

it.each([
  ["require=module;arguments[1].require=other;", loadWindow],
  ["module=require;arguments[2].call=other;", callWindow],
])(
  "keeps strict parameter writes separate from argument values: %s",
  (setup, use) => {
    expect(
      windows(`"use strict";const load=require;${setup}${use}`),
    ).toHaveLength(1);
  },
);

describe("possible original wrapper arguments", () => {
  it.each([
    "if(flag)arguments={};",
    "var arguments;if(flag)arguments={};",
    "function replace(){arguments={}}",
    "var arguments;(function(){arguments={}})();",
    "(function(){arguments={}})();",
  ])(
    "retains the original value beside conditional or other-scope writes: %s",
    (setup) => {
      expect(
        windows(
          `const load=require;${setup}arguments[2].require=other;${loadWindow}`,
        ),
      ).toEqual([]);
    },
  );

  it("retains an alternate value selected by conditional rebinding", () => {
    expect(
      windows(
        `const load=require;if(flag)arguments={2:require};arguments[2].call=other;${callWindow}`,
      ),
    ).toEqual([]);
  });

  it.each(["", "var arguments;"])(
    "preserves a definite replacement after uncertainty: %s",
    (declaration) => {
      expect(
        windows(
          `const load=require;${declaration}if(flag)arguments={};arguments={2:{}};arguments[2].require=other;${loadWindow}`,
        ),
      ).toHaveLength(1);
    },
  );
});

describe.each(["", '"use strict";'])(
  "wrapper argument descriptor presence: %s",
  (directive) => {
    it.each([
      ["1", "module", "require", loadWindow],
      ["2", "require", "call", callWindow],
      ["length", "module", "require", loadWindow],
    ])(
      "retains inherited getter identity after deleting %s",
      (key, value, member, use) => {
        expect(
          windows(
            `${directive}const load=require;delete arguments["${key}"];Object.defineProperty(Object.prototype,"${key}",{get(){return ${value}},configurable:true});arguments["${key}"].${member}=other;${use}`,
          ),
        ).toEqual([]);
      },
    );

    it("preserves the original own value beside an inherited getter", () => {
      expect(
        windows(
          `${directive}const load=require;Object.defineProperty(Object.prototype,"1",{get(){return module},configurable:true});arguments[1].require=other;${loadWindow}`,
        ),
      ).toHaveLength(1);
    });

    it("preserves a load before the slot is deleted and inherited", () => {
      expect(
        windows(
          `${directive}const load=require;${loadWindow}delete arguments[1];Object.defineProperty(Object.prototype,"1",{get(){return module},configurable:true});arguments[1].require=other;`,
        ),
      ).toHaveLength(1);
    });
  },
);

describe("wrapper binding replacement sources", () => {
  it.each([
    "arguments=arguments;",
    "arguments=flag?arguments:{};",
    "var arguments;arguments ||= {};",
    "var arguments;arguments ??= {};",
    "const saved=arguments;arguments=saved;",
    "let saved=arguments;if(flag)saved={};arguments=saved;",
    "var arguments;arguments ||= {};const saved=arguments;arguments=saved;",
    "const saved=arguments;arguments={};arguments=saved;",
    "arguments={2:module};",
    "arguments=[null,null,module];",
    "const alias={2:module};arguments=alias;",
    "arguments={...arguments};",
    "arguments=[...arguments];",
    "var arguments;arguments=[...arguments];",
  ])("retains selected original or replacement contents: %s", (setup) => {
    expect(
      windows(
        `const load=require;${setup}arguments[2].require=other;${loadWindow}`,
      ),
    ).toEqual([]);
  });

  it.each([
    "arguments=arguments;arguments={2:{}};",
    "var arguments;arguments ||= {};arguments={2:{}};",
    "const saved=arguments;arguments={2:{}};arguments=arguments;",
    "var arguments={2:{}};const saved=arguments;arguments=saved;",
    "let separate=arguments;separate={2:{}};arguments=separate;",
    "arguments={2:module};arguments={2:{}};",
    "var arguments;const contaminated={2:module};arguments=contaminated;arguments={2:{}};",
  ])("preserves a proven distinct value through later aliases: %s", (setup) => {
    expect(
      windows(
        `const load=require;${setup}arguments[2].require=other;${loadWindow}`,
      ),
    ).toHaveLength(1);
  });

  it("preserves a captured earlier replacement after a later replacement", () => {
    expect(
      windows(
        `const load=require;arguments={2:module};const saved=arguments;arguments={2:{}};saved[2].require=other;${loadWindow}`,
      ),
    ).toEqual([]);
  });

  it.each(["", '"use strict";'])(
    "retains an inherited module after deleting a replacement slot: %s",
    (directive) => {
      expect(
        windows(
          `${directive}const load=require;const original=module;arguments[2]={};delete arguments[2];Object.defineProperty(Object.prototype,"2",{get(){return original}});arguments[2].require=other;${loadWindow}`,
        ),
      ).toEqual([]);
    },
  );
});

describe("copied container mutation identity", () => {
  it.each(["[...arguments]", "{...arguments}"])(
    "preserves possible existing attributes through failed descriptor changes: %s",
    (copy) => {
      expect(
        windows(
          `const load=require;const copy=${copy};Object.defineProperty(copy,"2",{value:module,writable:true,configurable:false});Reflect.defineProperty(copy,"2",{value:{},enumerable:false});copy[2].require=other;${loadWindow}`,
        ),
      ).toEqual([]);
    },
  );
  it.each(["[...arguments]", "{...arguments}"])(
    "retains a selected copied module: %s",
    (copy) => {
      expect(
        windows(
          `const load=require;const copy=${copy};copy[2].require=other;${loadWindow}`,
        ),
      ).toEqual([]);
    },
  );

  it.each([
    "const copy={...arguments};copy[2]={};arguments=copy;arguments[2].require=other;",
    "arguments=[...arguments];arguments[2]={};arguments[2].require=other;",
    "var arguments=[...arguments];arguments[2]={};arguments[2].require=other;",
    "arguments={...arguments};arguments[2]={};arguments[2].require=other;",
    'arguments=[...arguments];Object.defineProperty(arguments,"2",{value:{}});arguments[2].require=other;',
    'const copy={...arguments};Object.defineProperty(copy,"2",{value:{}});copy[2].require=other;',
    "const copy=[{},...arguments];copy[0].require=other;",
  ])("preserves data replacements and fixed array prefixes: %s", (setup) => {
    expect(windows(`const load=require;${setup}${loadWindow}`)).toHaveLength(1);
  });

  it.each([
    'const copy=[...arguments];delete copy[2];Object.defineProperty(Array.prototype,"2",{get(){return module},set(value){module.require=other}});copy[2]={};copy[2].require=other;',
    'const copy={...arguments};delete copy[2];Object.defineProperty(Object.prototype,"2",{get(){return module},set(value){module.require=other}});copy[2]={};copy[2].require=other;',
    'const copy=[...arguments];Object.defineProperty(copy,"2",{get(){return module}});copy[2]={};copy[2].require=other;',
    "const copy={...arguments,get 2(){return module}};copy[2]={};copy[2].require=other;",
    "const copy=[...arguments];Object.freeze(copy);copy[2]={};copy[2].require=other;",
    "const copy={...arguments};Object.freeze(copy);copy[2]={};copy[2].require=other;",
  ])(
    "retains accessor, inherited setter, and integrity guards: %s",
    (setup) => {
      expect(windows(`const load=require;${setup}${loadWindow}`)).toEqual([]);
    },
  );
});
