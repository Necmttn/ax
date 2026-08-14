import { describe, expect, test } from "bun:test";
import * as duckdb from "./index.ts";

describe("@ax/lib/duckdb public surface", () => {
    // Finding 5 (final fix round): the barrel used to be five blind
    // `export *`s, three names too many - `base` (lock.ts, a test-only
    // decorated-FileSystem seam), `makeConnection`, and `readResult`
    // (client.ts) leaked through even though `client.ts` deliberately keeps
    // its own equivalent seam (`baseLayer`) private. A closed-set assertion
    // pins the surface so it cannot silently regrow those three, or drift in
    // either direction, without this test failing. This subsumes the two
    // former per-group "exports X" tests (services/layers/helpers, tagged
    // errors) - every name they checked is a member of this exact set.
    test("the runtime surface is exactly this closed set of 29 names", () => {
        const names = Object.keys(duckdb as Record<string, unknown>).sort();
        expect(names).toEqual(
            [
                "DuckDb",
                "DuckDbDecodeError",
                "DuckDbDylibError",
                "DuckDbLayer",
                "DuckDbLive",
                "DuckDbLiveWith",
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
