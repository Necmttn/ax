// packages/lib/src/sqlite/index.ts
/** The judgment sidecar's public surface. Import from `@ax/lib/sqlite`; the
 *  modules behind it are an implementation detail, exactly as `@ax/lib/duckdb`
 *  fronts the cache seam. */
export {
    BooleanColumn,
    JsonArrayColumn,
    JsonObjectColumn,
    NumberColumn,
    TextColumn,
    TimestampColumn,
} from "./columns.ts";
export {
    SidecarDecodeError,
    SidecarQueryError,
    SidecarUnavailableError,
    type JudgmentError,
} from "./errors.ts";
export {
    checkSidecarRefs,
    collectSidecarRefs,
    fetchCacheIds,
    SIDECAR_CACHE_REFS,
    SIDECAR_REF_TARGET_TABLES,
    type CacheIdReader,
    type SidecarCacheRefSpec,
} from "./integrity.ts";
export {
    Judgment,
    JudgmentLayer,
    sidecarPath,
    type JudgmentLayerOptions,
    type JudgmentService,
    type JudgmentTransaction,
    type SidecarParam,
    type SidecarRow,
    type SidecarValue,
} from "./sidecar.ts";
