// packages/lib/src/cache-integrity.ts
/**
 * Dangling-reference check between the SQLite judgment sidecar and the
 * rebuildable DuckDB cache (v2 architecture).
 *
 * The cache is re-derivable, the sidecar is not. A re-derive that drops a row
 * leaves sidecar rows pointing at an id that no longer exists. This module
 * counts those, given the sidecar's refs and the cache's live ids. It takes
 * plain data (not a DB handle) so it is testable with no DuckDB running and
 * callable from both ingest and `ax doctor`.
 */
export interface SidecarRef {
    readonly sidecarTable: string;
    readonly sidecarId: string;
    readonly column: string;
    readonly targetTable: string;
    readonly targetId: string;
}

export type CacheIdIndex = ReadonlyMap<string, ReadonlySet<string>>;

export function buildCacheIdIndex(
    rows: Iterable<{ readonly table: string; readonly id: string }>,
): CacheIdIndex {
    const index = new Map<string, Set<string>>();
    for (const row of rows) {
        let set = index.get(row.table);
        if (set === undefined) {
            set = new Set<string>();
            index.set(row.table, set);
        }
        set.add(row.id);
    }
    return index;
}

export interface DanglingRef extends SidecarRef {
    readonly reason: "missing_id" | "unknown_table";
}

export interface IntegrityReport {
    readonly checked: number;
    readonly dangling: number;
    readonly byTargetTable: Readonly<Record<string, number>>;
    readonly samples: readonly DanglingRef[];
    readonly ok: boolean;
}

const DEFAULT_SAMPLE_LIMIT = 20;

export function checkCacheIntegrity(
    refs: Iterable<SidecarRef>,
    cacheIds: CacheIdIndex,
    options?: {
        readonly sampleLimit?: number;
        /** Tables that are known to exist in the cache schema even when they
         *  currently hold zero rows (so `cacheIds` carries no entry for
         *  them). Without this, a ref into a real-but-empty table is
         *  indistinguishable from a ref into a table that was renamed or
         *  dropped, and both report `unknown_table` - which is the wrong
         *  diagnosis for the empty-table case (the row is genuinely
         *  `missing_id`, not pointed at a table ax no longer knows about). */
        readonly knownTables?: ReadonlySet<string>;
    },
): IntegrityReport {
    const sampleLimit = options?.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
    const knownTables = options?.knownTables;
    // A plain object literal corrupts on table names like "__proto__" (silently
    // routes through the prototype chain instead of becoming an own key) or
    // "constructor" (overwrites a non-numeric built-in). A Map has no such
    // collisions; Object.fromEntries below defines real own properties for
    // every key, "__proto__" and "constructor" included.
    const byTargetTable = new Map<string, number>();
    const samples: DanglingRef[] = [];
    let checked = 0;
    let dangling = 0;

    for (const ref of refs) {
        checked += 1;
        const live = cacheIds.get(ref.targetTable);
        const tableIsKnown = live !== undefined || (knownTables?.has(ref.targetTable) ?? false);
        const reason: DanglingRef["reason"] | null = !tableIsKnown
            ? "unknown_table"
            : (live?.has(ref.targetId) ?? false)
              ? null
              : "missing_id";
        if (reason === null) continue;
        dangling += 1;
        byTargetTable.set(ref.targetTable, (byTargetTable.get(ref.targetTable) ?? 0) + 1);
        if (samples.length < sampleLimit) samples.push({ ...ref, reason });
    }

    return { checked, dangling, byTargetTable: Object.fromEntries(byTargetTable), samples, ok: dangling === 0 };
}
