import { describe, expect, test } from "bun:test";
import * as duckdb from "./index.ts";
import * as internal from "./internal.ts";

/**
 * The two entry points are pinned as CLOSED SETS, in both directions.
 *
 * The barrel was once five blind `export *`s and leaked three test-only seams
 * (`base`, `makeConnection`, `readResult`). A closed set catches a leak; pinning
 * BOTH sets also catches the opposite drift - a seam name quietly demoted to
 * `internal`, or a raw-client name promoted into the surface queries import.
 * The split is the point: `@ax/lib/duckdb` is what a query may use, and
 * `@ax/lib/duckdb/internal` is what only the seam and its tests may.
 */
describe("@ax/lib/duckdb public surface", () => {
    test("the seam surface is exactly this closed set", () => {
        expect(Object.keys(duckdb as Record<string, unknown>).sort()).toEqual(
            [
                // The seam itself.
                "CacheRead",
                "CacheReadLayer",
                "CacheReadLive",
                "CacheUnavailableError",
                "CacheWriteUnlockedError",
                "UTC_CLOCK_TOLERANCE_MS",
                "WRITE_STAMPED_COLUMNS",
                "utcClockOk",
                "withCacheWrite",
                // The row-decode contract.
                "JsonArrayColumn",
                "JsonObjectColumn",
                "NumberFromBigIntColumn",
                "TextColumn",
                "TimestampColumn",
                // Full-text search.
                "FTS_TARGETS",
                "buildFtsIndexes",
                "ftsSchemaName",
                "matchBm25Sql",
                // Failure modes.
                "DuckDbDecodeError",
                "DuckDbDylibError",
                "DuckDbOpenError",
                "DuckDbQueryError",
                "DuckDbUnsupportedTypeError",
                "SnapshotPublishError",
                // Where the snapshot lives.
                "snapshotPath",
            ].sort(),
        );
    });

    test("the raw client is NOT reachable from the seam barrel", () => {
        // Named individually rather than derived from `internal`: the assertion
        // is about these specific escape hatches, and deriving it would pass
        // vacuously if `internal` itself were ever emptied.
        for (const name of ["DuckDb", "DuckDbLayer", "openDuckDbService", "coerceValue", "resolveDylibPath"]) {
            expect(Object.keys(duckdb as Record<string, unknown>)).not.toContain(name);
        }
    });

    test("the internal surface is exactly this closed set", () => {
        expect(Object.keys(internal as Record<string, unknown>).sort()).toEqual(
            [
                "DuckDb",
                "DuckDbLayer",
                "DuckDbLive",
                "DuckDbLiveWith",
                "DuckDbTypeId",
                "accessorFor",
                "coerceValue",
                "duckDbTypeName",
                "dylibCacheDir",
                "extractDylib",
                "isEmbeddedPath",
                "openDuckDbService",
                "openDuckDbServiceAt",
                "resolveDylibPath",
                "unsupportedColumns",
            ].sort(),
        );
    });

    test("the two surfaces do not overlap", () => {
        const seam = new Set(Object.keys(duckdb as Record<string, unknown>));
        const shared = Object.keys(internal as Record<string, unknown>).filter((n) => seam.has(n));
        expect(shared).toEqual([]);
    });
});
