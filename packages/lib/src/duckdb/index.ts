/**
 * `@ax/lib/duckdb` - the typed DuckDB client the v2 architecture stands on.
 *
 * Reads go through a read-only handle on the published snapshot
 * (`openSnapshot`); writes only happen inside ingest, under the ingest lock
 * (`IngestLock`), against the live database; `publishSnapshot` is how the two
 * meet - CHECKPOINT, copy to a sibling temp file, atomic rename.
 */
export * from "./errors.ts";
export * from "./types.ts";
export * from "./row-decode.ts";
export * from "./dylib.ts";
export * from "./lock-state.ts";

// `client.ts` and `lock.ts` each keep one internal test-only seam private to
// this barrel - `makeConnection`/`readResult` (client.ts) and `base`
// (lock.ts). Their own tests still import them directly by relative path;
// only the PUBLIC surface is re-exported here, as an explicit named list so
// it can never silently drift back to `export *` (see index.test.ts's
// closed-set assertion).
export type { DuckDbConnection, DuckDbLiveOptions, DuckDbService } from "./client.ts";
export { DuckDb, DuckDbLayer, DuckDbLive, DuckDbLiveWith, snapshotPath } from "./client.ts";

export type { AcquireOptions, IngestLockHandle, IngestLockService } from "./lock.ts";
export { IngestLock, IngestLockLayer, IngestLockLive, ingestLockPath } from "./lock.ts";
