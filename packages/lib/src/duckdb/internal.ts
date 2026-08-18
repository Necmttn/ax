/**
 * `@ax/lib/duckdb/internal` - the machinery UNDER the seam.
 *
 * Everything here is either how the seam is built or how it is tested: the raw
 * FFI client and its layers, dylib resolution, and the row-decode primitives
 * that turn a `duckdb_value_*` cell into a JS value. None of it enforces the
 * guarantees the seam exists for - reads are read-only, writes hold the ingest
 * lock, snapshots publish atomically - so reaching for it from a query is a way
 * to lose them silently.
 *
 * It is a SEPARATE ENTRY POINT rather than a private module because the
 * bench/smoke scripts and the seam's own tests genuinely need it, and a barrel
 * that mixed the two taught every reader that `DuckDbLayer` was an ordinary
 * thing to import. The import path is the warning.
 */
export { DuckDb, DuckDbLayer, DuckDbLive, DuckDbLiveWith, openDuckDbService, openDuckDbServiceAt } from "./client.ts";
export type { DuckDbConnection, DuckDbLiveOptions, DuckDbService, OpenedDuckDb } from "./client.ts";

export { accessorFor, coerceValue, unsupportedColumns } from "./row-decode.ts";
export type { AccessorKind } from "./row-decode.ts";

export { DuckDbTypeId, duckDbTypeName } from "./types.ts";

export { dylibCacheDir, extractDylib, isEmbeddedPath, resolveDylibPath } from "./dylib.ts";
export type { ResolveDylibOptions } from "./dylib.ts";
