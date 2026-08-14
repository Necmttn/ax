import { describe, expect, test } from "bun:test";
import * as duckdb from "./index.ts";

describe("@ax/lib/duckdb public surface", () => {
    test("exports the services, layers and helpers callers need", () => {
        for (const name of [
            "DuckDb",
            "DuckDbLayer",
            "DuckDbLive",
            "IngestLock",
            "IngestLockLayer",
            "IngestLockLive",
            "ingestLockPath",
            "snapshotPath",
            "resolveDylibPath",
            "dylibCacheDir",
            "DuckDbTypeId",
        ]) {
            expect((duckdb as Record<string, unknown>)[name]).toBeDefined();
        }
    });

    test("exports every tagged error so callers can catch by tag", () => {
        for (const name of [
            "DuckDbOpenError",
            "DuckDbQueryError",
            "DuckDbDecodeError",
            "DuckDbUnsupportedTypeError",
            "DuckDbDylibError",
            "IngestLockHeldError",
            "IngestLockError",
            "SnapshotPublishError",
        ]) {
            expect((duckdb as Record<string, unknown>)[name]).toBeDefined();
        }
    });

    // Finding 5 (final fix round): the barrel used to be five blind
    // `export *`s, three names too many - `base` (lock.ts, a test-only
    // decorated-FileSystem seam), `makeConnection`, and `readResult`
    // (client.ts) leaked through even though `client.ts` deliberately keeps
    // its own equivalent seam (`baseLayer`) private. A closed-set assertion
    // pins the surface so it cannot silently regrow those three, or drift in
    // either direction, without this test failing.
    test("the runtime surface is exactly this closed set of 28 names", () => {
        const names = Object.keys(duckdb as Record<string, unknown>).sort();
        expect(names).toEqual(
            [
                "DuckDb",
                "DuckDbDecodeError",
                "DuckDbDylibError",
                "DuckDbLayer",
                "DuckDbLive",
                "DuckDbOpenError",
                "DuckDbQueryError",
                "DuckDbTypeId",
                "DuckDbUnsupportedTypeError",
                "IngestLock",
                "IngestLockError",
                "IngestLockHeldError",
                "IngestLockLayer",
                "IngestLockLive",
                "SnapshotPublishError",
                "accessorFor",
                "coerceValue",
                "decideLock",
                "decodeLockPayload",
                "duckDbTypeName",
                "dylibCacheDir",
                "encodeLockPayload",
                "extractDylib",
                "ingestLockPath",
                "isEmbeddedPath",
                "resolveDylibPath",
                "snapshotPath",
                "unsupportedColumns",
            ].sort(),
        );
    });
});
