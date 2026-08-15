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
    Judgment,
    JudgmentLayer,
    sidecarPath,
    type JudgmentLayerOptions,
    type JudgmentService,
    type SidecarParam,
    type SidecarRow,
    type SidecarValue,
} from "./sidecar.ts";
