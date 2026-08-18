/**
 * `@ax/lib/duckdb` - the SEAM the rest of ax reads and writes the cache through.
 *
 * Reads open the published snapshot read-only (`CacheRead`); writes happen only
 * inside ingest, under the ingest lock (`withCacheWrite`), against the live
 * database; publishing is how the two meet - CHECKPOINT, copy to a sibling temp
 * file, atomic rename. A query names its column contracts from `./columns.ts`,
 * so what a TIMESTAMP or a JSON column MEANS in TypeScript is stated at the call
 * site rather than guessed.
 *
 * WHAT IS NOT HERE, deliberately:
 *
 *  - The RAW client (`DuckDb`, `DuckDbLayer`, `openDuckDbService`) and the
 *    row-decode/dylib internals live at `@ax/lib/duckdb/internal`. They exist to
 *    build the seam and to test it; a query that reaches for them is either
 *    doing something the seam should learn to do, or bypassing the read-only /
 *    lock-held guarantees the seam is there to enforce. The import path says so.
 *  - The ingest lock. It lives at `@ax/lib/ingest-lock`, because it is not a
 *    DuckDB concept - it is the single-flight guarantee ax ingests have always
 *    had, which the CLI, the share recovery path and the dashboard's live ingest
 *    all take. This package DEPENDS on it (the write seam refuses to open the
 *    live database unless it is held); it does not own it.
 *
 * The surface below is an explicit named list, never `export *`, and
 * index.test.ts pins it as a closed set - a blind re-export is how the previous
 * barrel leaked three test-only seams.
 */

// The seam.
export {
    CacheRead,
    CacheReadLayer,
    CacheReadLive,
    CacheUnavailableError,
    CacheWriteUnlockedError,
    UTC_CLOCK_TOLERANCE_MS,
    WRITE_STAMPED_COLUMNS,
    utcClockOk,
    withCacheWrite,
} from "./seam.ts";
export type {
    CacheReadError,
    CacheReadOptions,
    CacheReadService,
    CacheWriteError,
    CacheWriteOptions,
    CacheWriteService,
    NulStripTotals,
} from "./seam.ts";

// The row-decode contract: what a column type MEANS to a caller.
export {
    JsonArrayColumn,
    JsonObjectColumn,
    NumberFromBigIntColumn,
    TextColumn,
    TimestampColumn,
} from "./columns.ts";

// Full-text search: a BUILD step at ingest, plus how a query names a match.
export { FTS_TARGETS, buildFtsIndexes, ftsSchemaName, matchBm25Sql } from "./fts.ts";
export type { FtsTarget } from "./fts.ts";

// Failure modes a caller can branch on.
export {
    DuckDbDecodeError,
    DuckDbDylibError,
    DuckDbOpenError,
    DuckDbQueryError,
    DuckDbUnsupportedTypeError,
    SnapshotPublishError,
} from "./errors.ts";

// Value shapes a query binds and receives.
export type { DuckDbColumn, DuckDbParam, DuckDbRow, DuckDbValue, QueryResult } from "./types.ts";

/** Where the published snapshot lives (`AX_DUCKDB_SNAPSHOT`, else the default). */
export { snapshotPath } from "./client.ts";
