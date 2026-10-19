import * as t from "@babel/types";
import { readExactJavaScriptLiteral } from "./javascriptAstValues.js";

import {
  semanticDefiniteMutationPrecedesRead,
  semanticEffectTiming,
} from "./javascriptSemanticMutationInitializers.js";
import type { SemanticGlobalBindingFacts } from "./javascriptSemanticOpaqueEffects.js";
import type { JavaScriptSemanticAnalysisState } from "./javascriptSemanticState.js";
import type { SemanticIterationSource } from "./javascriptSemanticIterationSources.js";
import { semanticPropertyPathKeyMatches } from "./javascriptSemanticPropertyPaths.js";

/** Standard writable own data bindings represented by the builtin value owner.
 * Host wrapper bindings and host accessors cannot acquire this proof. */
const OWN_DATA_ROOTS = new Set([
  "Object",
  "Function",
  "Array",
  "String",
  "Number",
  "Reflect",
  "Math",
  "JSON",
  "Atomics",
  "Intl",
  "WebAssembly",
  "globalThis",
]);

export const semanticGlobalRootHasDataDescriptor = (name: string): boolean =>
  OWN_DATA_ROOTS.has(name);

/** Mutable builtin slots and captured values have different owners. Only a
 * completed, inert assignment to an initially writable data slot cuts a seed. */
export const createSemanticBuiltinDataReplacementQuery =
  (
    state: JavaScriptSemanticAnalysisState,
    facts: SemanticGlobalBindingFacts,
    sources: ReadonlyMap<string, readonly SemanticIterationSource[]>,
    proof: {
      readonly opaqueSites: readonly t.Node[];
      readonly freshObject: (node: t.Node) => boolean;
      readonly owner?: readonly string[];
    },
  ) =>
  (name: string, read: t.Node): SemanticIterationSource | undefined => {
    const owner = proof.owner ?? ["global"];
    const location = [...owner, name];
    const knownDataSlot =
      location.join(".") === "commonjs-module.exports" ||
      (owner.length === 1
        ? semanticGlobalRootHasDataDescriptor(name)
        : location.join(".") === "global.require.main" ||
          location.join(".") === "global.process.mainModule");
    if (!facts.complete || !knownDataSlot) return undefined;
    const candidates = sources.get(name) ?? [];
    let replacement: SemanticIterationSource | undefined;
    for (const source of candidates)
      if (
        source.projection.length === 0 &&
        (readExactJavaScriptLiteral(source.node).found ||
          proof.freshObject(source.node)) &&
        semanticDefiniteMutationPrecedesRead(
          source.mutation,
          read,
          state.parentsByNode,
        ) &&
        (replacement === undefined ||
          semanticEffectTiming(source.mutation, replacement.mutation, state) ===
            "before")
      )
        replacement = source;
    if (replacement === undefined) return undefined;
    if (
      proof.opaqueSites.some(
        (site) => semanticEffectTiming(read, site, state) !== "after",
      )
    )
      return undefined;
    const assignments = new Set(
      candidates
        .filter(
          (source) =>
            source.projection.length === 0 &&
            (readExactJavaScriptLiteral(source.node).found ||
              proof.freshObject(source.node)),
        )
        .map((source) => source.mutation),
    );
    for (const { path, node } of facts.ambientWriteEffects) {
      if (
        node === replacement.mutation ||
        semanticEffectTiming(read, node, state) === "after"
      )
        continue;
      const changesLocation =
        path.length <= location.length &&
        path.every((key, index) =>
          semanticPropertyPathKeyMatches(key, location[index]!),
        );
      // Rebinding a global-object alias also makes weak namespace candidates
      // uncertain. It cannot justify a strong cut through that alias.
      const namespace = path[1];
      const changesNamespace =
        path.length === 2 &&
        path[0] !== undefined &&
        semanticPropertyPathKeyMatches(path[0], "global") &&
        namespace !== undefined &&
        ["globalThis", "global", "window", "self"].some((alias) =>
          semanticPropertyPathKeyMatches(namespace, alias),
        );
      if (!changesLocation && !changesNamespace) continue;
      if (
        changesLocation &&
        node !== undefined &&
        assignments.has(node) &&
        semanticEffectTiming(replacement.mutation, node, state) === "before"
      )
        continue;
      return undefined;
    }
    return replacement;
  };
