import { expect, it } from "vitest";

import { SemanticReferenceStoreIndex } from "./javascriptSemanticReferenceStoreIndex.js";

it("visits only the selected store across repeated independent property reads", () => {
  const stores = new SemanticReferenceStoreIndex<number>();
  for (let index = 0; index < 300; index += 1) stores.set(index, [`k${index}`]);
  let visits = 0;
  for (let index = 0; index < 300; index += 1)
    for (const [source, path] of stores.candidates(`k${index}`)) {
      visits += 1;
      if (path?.[0] === `k${index}`) expect(source).toBe(index);
    }
  expect(visits).toBe(300);
});

it("keeps unknown, whole-owner, wildcard, and prototype alternatives in publication order", () => {
  const stores = new SemanticReferenceStoreIndex<string>();
  stores.set("exact", ["selected", "nested"]);
  stores.set("unknown", undefined);
  stores.set("other", ["other"]);
  stores.set("whole", []);
  stores.set("wildcard", [null, "nested"]);
  stores.set("prototype", ["__proto__"], "all");
  stores.set("later", ["selected"]);
  expect([...stores.candidates("selected")].map(([source]) => source)).toEqual([
    "exact",
    "unknown",
    "whole",
    "wildcard",
    "prototype",
    "later",
  ]);
  expect([...stores.candidates("absent")].map(([source]) => source)).toEqual([
    "unknown",
    "whole",
    "wildcard",
    "prototype",
  ]);
});

it("updates exclusions when a projection widens without adding a source", () => {
  const stores = new SemanticReferenceStoreIndex<string>();
  stores.set("first", ["other", "nested"]);
  stores.set("selected", ["selected"]);
  stores.set("last", [null]);
  expect([...stores.candidates("selected")].map(([source]) => source)).toEqual([
    "selected",
    "last",
  ]);
  stores.set("first", [null, "nested"]);
  expect([...stores.candidates("selected")].map(([source]) => source)).toEqual([
    "first",
    "selected",
    "last",
  ]);
  stores.set("first", undefined);
  expect(stores.has("first")).toBe(true);
  expect(stores.get("first")).toBeUndefined();
  expect([...stores]).toHaveLength(3);
  expect([...stores.candidates("selected")][0]).toEqual(["first", undefined]);
});

it("keeps replacement paths current without duplicating or reordering a source", () => {
  const stores = new SemanticReferenceStoreIndex<string>();
  stores.set("first", ["x"]);
  stores.set("second", [null]);
  stores.set("first", ["y"]);
  expect([...stores.candidates("x")]).toEqual([["second", [null]]]);
  expect([...stores.candidates("y")]).toEqual([
    ["first", ["y"]],
    ["second", [null]],
  ]);
  stores.set("second", ["z"], "all");
  expect([...stores.candidates("x")]).toEqual([["second", ["z"]]]);
  stores.set("second", ["z"]);
  expect([...stores.candidates("x")]).toEqual([]);
});

it("selects a bulk copy only for the keys its static literal supplies", () => {
  const stores = new SemanticReferenceStoreIndex<string>();
  stores.set("copy", [null], ["a", "b"]);
  stores.set("empty", [null], []);
  stores.set("unknown", [null]);
  const sources = (key: string | null) =>
    [...stores.candidates(key)].map(([source]) => source);
  expect(sources("a")).toEqual(["copy", "unknown"]);
  expect(sources("b")).toEqual(["copy", "unknown"]);
  expect(sources("c")).toEqual(["unknown"]);
  expect(sources(null)).toEqual(["copy", "empty", "unknown"]);
  stores.set("copy", [null]);
  expect(sources("c")).toEqual(["copy", "unknown"]);
  stores.set("copy", [null], ["c"]);
  expect(sources("a")).toEqual(["unknown"]);
  expect(sources("c")).toEqual(["copy", "unknown"]);
  expect([...stores]).toHaveLength(3);
});

it.each([null, undefined])(
  "retains every alternative for selector %s",
  (key) => {
    const stores = new SemanticReferenceStoreIndex<string>();
    stores.set("first", ["x"]);
    stores.set("second", ["y", "nested"]);
    stores.set("third", undefined);
    expect([...stores.candidates(key)]).toEqual([...stores]);
  },
);

it("keeps heap owners and analysis lifetimes independent", () => {
  const left = new SemanticReferenceStoreIndex<object>();
  const right = new SemanticReferenceStoreIndex<object>();
  const source = {};
  left.set(source, ["x"]);
  right.set(source, ["y"]);
  left.set(source, undefined);
  expect([...right.candidates("x")]).toEqual([]);
  expect([...right.candidates("y")]).toEqual([[source, ["y"]]]);
});
