type SemanticStoredProjection = readonly (string | null)[] | undefined;

/** First-slot keys one store can write: its path's own first key, every key,
 * or the static key set a bulk copy's literal source supplies. */
export type SemanticStoreKeys = "first" | "all" | readonly string[];

interface StoredReference<Source> {
  readonly source: Source;
  readonly order: number;
  path: SemanticStoredProjection;
  keys: readonly string[] | undefined;
}

const sameKeys = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean =>
  left === undefined || right === undefined
    ? left === right
    : left.length === right.length &&
      left.every((key, index) => key === right[index]);

/**
 * One heap owner's possible stores, updated by its publishing producer. Exact
 * first-slot reads skip unrelated stores; semantic matching and capture proofs
 * remain with the consumer. Unknown projections and prototype-changing stores
 * stay candidates for every key, while a bulk copy from a static literal is a
 * candidate only for the keys that literal supplies. No query result or
 * readiness fact is cached.
 */
export class SemanticReferenceStoreIndex<Source> {
  readonly #entries = new Map<Source, StoredReference<Source>>();
  readonly #exact = new Map<string, Set<StoredReference<Source>>>();
  readonly #unknown = new Set<StoredReference<Source>>();

  has(source: Source): boolean {
    return this.#entries.has(source);
  }

  get(source: Source): SemanticStoredProjection {
    return this.#entries.get(source)?.path;
  }

  set(
    source: Source,
    path: SemanticStoredProjection,
    keys: SemanticStoreKeys = "first",
  ): void {
    const first = path?.[0];
    const selected =
      keys === "all"
        ? undefined
        : keys === "first"
          ? typeof first === "string"
            ? [first]
            : undefined
          : keys;
    let entry = this.#entries.get(source);
    if (entry === undefined) {
      entry = { source, path, keys: selected, order: this.#entries.size };
      this.#entries.set(source, entry);
    } else {
      entry.path = path;
      if (sameKeys(entry.keys, selected)) return;
      this.#unlist(entry);
      entry.keys = selected;
    }
    this.#list(entry);
  }

  #list(entry: StoredReference<Source>): void {
    if (entry.keys === undefined) {
      this.#unknown.add(entry);
      return;
    }
    for (const key of entry.keys) {
      let selected = this.#exact.get(key);
      if (selected === undefined) {
        selected = new Set();
        this.#exact.set(key, selected);
      }
      selected.add(entry);
    }
  }

  #unlist(entry: StoredReference<Source>): void {
    if (entry.keys === undefined) {
      this.#unknown.delete(entry);
      return;
    }
    for (const key of entry.keys) {
      const selected = this.#exact.get(key);
      selected?.delete(entry);
      if (selected?.size === 0) this.#exact.delete(key);
    }
  }

  *[Symbol.iterator](): IterableIterator<[Source, SemanticStoredProjection]> {
    for (const entry of this.#entries.values())
      yield [entry.source, entry.path];
  }

  *candidates(
    key: string | null | undefined,
  ): IterableIterator<[Source, SemanticStoredProjection]> {
    if (typeof key !== "string") {
      yield* this;
      return;
    }
    // Widening moves an existing source between buckets. Its publication order
    // still precedes later sources, even when it entered this bucket last.
    const selected = [...this.#unknown, ...(this.#exact.get(key) ?? [])];
    selected.sort((left, right) => left.order - right.order);
    for (const entry of selected) yield [entry.source, entry.path];
  }
}
