/**
 * Skill dedup helper - collapse plugin-namespace duplicate skill rows.
 *
 * The same physical SKILL.md is ingested as TWO `skill` rows: once at user
 * scope under its bare name (`plannotator-review`) and once at project/plugin
 * scope under a namespaced name (`necmttn:plannotator-review`). Both rows carry
 * the IDENTICAL `dir_path` + `content_hash` + `bytes` (verified 2026-06-16:
 * 98 such twin-pairs across 415 skill rows). Every skill query that lists or
 * counts skills double-counts as a result.
 *
 * Fixing this at ingest means re-keying skill record ids (migration risk) and is
 * parked as a follow-up. This is the query-layer collapse: group rows by
 * `content_hash` (same body = same skill), keep the canonical (bare, non-
 * namespaced) name, and merge any per-row numeric fields (e.g. invocations).
 *
 * Rows with a null/empty content_hash are never merged (treated as distinct) so
 * a missing hash can't accidentally collapse unrelated skills.
 */

/** A plugin-namespaced name carries a `:` (e.g. `necmttn:plannotator-review`). */
export const isPluginNamespaced = (name: string): boolean => name.includes(":");

/** Strip the leading `owner:` namespace, if any. `necmttn:foo` -> `foo`. */
export const bareSkillName = (name: string): string =>
    isPluginNamespaced(name) ? name.slice(name.indexOf(":") + 1) : name;

/**
 * Of two names for the same content, prefer the canonical one: the bare
 * (non-namespaced) name wins; on a tie, the shorter, then lexicographically
 * smaller, for determinism.
 */
export const preferCanonicalName = (a: string, b: string): string => {
    const an = isPluginNamespaced(a);
    const bn = isPluginNamespaced(b);
    if (an !== bn) return an ? b : a;            // bare beats namespaced
    if (a.length !== b.length) return a.length < b.length ? a : b;
    return a <= b ? a : b;
};

/**
 * Collapse rows that share a content hash into one, keeping the canonical name
 * and merging the rest. Order is preserved by first appearance. Rows whose hash
 * is null/empty pass through untouched (each stays distinct).
 *
 * @param rows      input rows (any order)
 * @param hashOf    extract the dedup key (content hash) from a row; null = distinct
 * @param nameOf    extract the display name (drives canonical-name choice)
 * @param merge     fold a duplicate into the kept row (e.g. sum invocations);
 *                  receives (kept, duplicate) and returns the merged row. The
 *                  kept row already carries the canonical name when this runs.
 */
export const dedupeByContentHash = <T>(
    rows: ReadonlyArray<T>,
    hashOf: (row: T) => string | null | undefined,
    nameOf: (row: T) => string,
    setName: (row: T, name: string) => T,
    merge: (kept: T, dup: T) => T,
): T[] => {
    const byHash = new Map<string, T>();
    const passthrough: T[] = [];
    const order: Array<{ hash: string | null; idx: number }> = [];

    for (const row of rows) {
        const hash = hashOf(row);
        if (!hash) {
            passthrough.push(row);
            order.push({ hash: null, idx: passthrough.length - 1 });
            continue;
        }
        const existing = byHash.get(hash);
        if (!existing) {
            byHash.set(hash, row);
            order.push({ hash, idx: -1 });
            continue;
        }
        // Merge: pick the canonical name, then fold the duplicate's fields in.
        const canonical = preferCanonicalName(nameOf(existing), nameOf(row));
        const kept = setName(existing, canonical);
        byHash.set(hash, merge(kept, row));
    }

    const out: T[] = [];
    const emitted = new Set<string>();
    for (const o of order) {
        if (o.hash === null) {
            out.push(passthrough[o.idx]);
        } else if (!emitted.has(o.hash)) {
            emitted.add(o.hash);
            out.push(byHash.get(o.hash)!);
        }
    }
    return out;
};
