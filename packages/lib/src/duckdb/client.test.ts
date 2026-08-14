import { ptr } from "bun:ffi";
import { afterAll, describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noteSkippedDylib, resolveTestDylib } from "../testing/duckdb-dylib.ts";
import { DuckDb, DuckDbLayer, makeConnection, readResult } from "./client.ts";
import type { DuckDbService } from "./client.ts";
import type { LibDuckDb } from "./ffi.ts";
import { DuckDbTypeId } from "./types.ts";

// Resolved at module load (top-level await), not in `beforeAll`, so
// `test.skipIf` below sees a real boolean at test-registration time and bun
// reports a SKIP status - distinct from a PASS - when no dylib is available.
// Finding 3 (final fix round): the previous `beforeAll` + runtime
// `expect(skipReason.length).toBeGreaterThan(0)` guard reported PASS for
// every one of these tests on a dylib-less box, with only a console.warn as
// the signal - mirrors ffi.test.ts's convention exactly.
const found = await resolveTestDylib();
const dylibPath = found.ok ? found.path : null;
if (!found.ok) noteSkippedDylib("duckdb client", found.reason);
const layer = dylibPath !== null ? DuckDbLayer(dylibPath) : null;

/** `test`, bound to skip (not pass) every dylib-dependent case below when no
 *  dylib is available. */
const dtest = test.skipIf(dylibPath === null);

// Finding 4 (final fix round): every dir this suite creates is collected
// here and removed in one afterAll - see dylib.test.ts for the measured
// leak this closes.
const createdTempDirs: string[] = [];
const tempDb = (name = "test.db") => {
    const dir = mkdtempSync(join(tmpdir(), "ax-duckdb-client-"));
    createdTempDirs.push(dir);
    return join(dir, name);
};

afterAll(() => {
    for (const dir of createdTempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Runs `body` with the DuckDb service. Only ever invoked via `dtest`, which
 *  skips registration entirely when `layer` is null - the non-null assertion
 *  is safe by construction. */
const withDuckDb = <A>(body: (db: DuckDbService) => Effect.Effect<A, unknown>) => async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const db = yield* DuckDb;
            yield* body(db);
        }).pipe(Effect.provide(layer as NonNullable<typeof layer>)) as Effect.Effect<void>,
    );
};

describe("DuckDb", () => {
    dtest(
        "creates a database file and round-trips a typed row",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const path = tempDb();
                const conn = yield* db.open(path);
                yield* conn.exec("CREATE TABLE t (id BIGINT, note VARCHAR, ok BOOLEAN, score DOUBLE)");
                const changed = yield* conn.exec(
                    "INSERT INTO t VALUES (1, 'hello', true, 1.5), (2, NULL, false, 2.5)",
                );
                expect(changed).toBe(2);

                const result = yield* conn.query("SELECT id, note, ok, score FROM t ORDER BY id");
                expect(result.columns.map((c) => c.name)).toEqual(["id", "note", "ok", "score"]);
                expect(result.columns[0]!.typeId).toBe(DuckDbTypeId.BIGINT);
                expect(result.rows).toEqual([
                    { id: 1n, note: "hello", ok: true, score: 1.5 },
                    { id: 2n, note: null, ok: false, score: 2.5 },
                ]);

                yield* conn.close;
                expect(existsSync(path)).toBe(true);
            }),
        ),
    );

    dtest(
        "binds prepared-statement parameters instead of interpolating them",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const conn = yield* db.open(tempDb());
                yield* conn.exec("CREATE TABLE t (id INTEGER, note VARCHAR)");
                yield* conn.exec("INSERT INTO t VALUES (?, ?)", [1, "o'brien; DROP TABLE t;--"]);
                const result = yield* conn.query("SELECT note FROM t WHERE id = ?", [1]);
                expect(result.rows).toEqual([{ note: "o'brien; DROP TABLE t;--" }]);
                yield* conn.close;
            }),
        ),
    );

    dtest(
        "decodes rows through an Effect schema with queryAs",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const conn = yield* db.open(tempDb());
                yield* conn.exec("CREATE TABLE t (id INTEGER, note VARCHAR)");
                yield* conn.exec("INSERT INTO t VALUES (7, 'seven')");
                const Row = Schema.Struct({ id: Schema.Number, note: Schema.String });
                const rows = yield* conn.queryAs(Row, "SELECT id, note FROM t");
                expect(rows).toEqual([{ id: 7, note: "seven" }]);
                yield* conn.close;
            }),
        ),
    );

    dtest(
        "fails with DuckDbDecodeError when rows do not match the schema",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const conn = yield* db.open(tempDb());
                yield* conn.exec("CREATE TABLE t (note VARCHAR)");
                yield* conn.exec("INSERT INTO t VALUES ('not a number')");
                const Row = Schema.Struct({ note: Schema.Number });
                const result = yield* Effect.result(conn.queryAs(Row, "SELECT note FROM t"));
                expect(result._tag).toBe("Failure");
                if (result._tag === "Failure") expect(result.failure._tag).toBe("DuckDbDecodeError");
                yield* conn.close;
            }),
        ),
    );

    dtest(
        "surfaces a SQL error as DuckDbQueryError carrying duckdb's message",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const conn = yield* db.open(tempDb());
                const result = yield* Effect.result(conn.query("SELECT * FROM nope"));
                expect(result._tag).toBe("Failure");
                if (result._tag === "Failure") {
                    expect(result.failure._tag).toBe("DuckDbQueryError");
                    expect((result.failure as { message: string }).message).toContain("nope");
                }
                yield* conn.close;
            }),
        ),
    );

    dtest(
        "refuses to decode a BLOB column instead of returning garbage",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const conn = yield* db.open(tempDb());
                const result = yield* Effect.result(conn.query("SELECT 'abc'::BLOB AS payload"));
                expect(result._tag).toBe("Failure");
                if (result._tag === "Failure") {
                    expect(result.failure._tag).toBe("DuckDbUnsupportedTypeError");
                }
                // the documented workaround works
                const ok = yield* conn.query("SELECT hex('abc'::BLOB) AS payload");
                expect(ok.rows[0]!.payload).toBe("616263");
                yield* conn.close;
            }),
        ),
    );

    dtest(
        "reads timestamps back as Date",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const conn = yield* db.open(tempDb());
                const result = yield* conn.query(
                    "SELECT TIMESTAMP '2026-08-14 10:11:12' AS ts, DATE '2026-08-14' AS d",
                );
                expect(result.rows[0]!.ts).toBeInstanceOf(Date);
                expect((result.rows[0]!.ts as Date).toISOString()).toBe("2026-08-14T10:11:12.000Z");
                expect(result.rows[0]!.d).toBe("2026-08-14");
                yield* conn.close;
            }),
        ),
    );

    // Fix round 1 (ruling R10), Part A: duckdb_value_varchar returns a NULL
    // pointer for TIMESTAMP WITH TIME ZONE (verified against libduckdb
    // v1.5.5 directly, on both a literal and a real table column), so it is
    // now excluded from row-decode.ts's VARCHAR_TYPES - querying it raises
    // DuckDbUnsupportedTypeError naming the column instead of silently
    // decoding to "". The documented workaround (CAST ... AS VARCHAR) works.
    dtest(
        "refuses to decode TIMESTAMP WITH TIME ZONE instead of returning an empty string",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const conn = yield* db.open(tempDb());
                const result = yield* Effect.result(
                    conn.query("SELECT TIMESTAMP WITH TIME ZONE '2026-08-14 10:11:12+02' AS ts_tz"),
                );
                expect(result._tag).toBe("Failure");
                if (result._tag === "Failure") {
                    expect(result.failure._tag).toBe("DuckDbUnsupportedTypeError");
                    expect((result.failure as { message: string }).message).toContain(
                        "CAST(ts_tz AS VARCHAR)",
                    );
                }
                // the documented workaround works
                const ok = yield* conn.query(
                    "SELECT CAST(TIMESTAMP WITH TIME ZONE '2026-08-14 10:11:12+02' AS VARCHAR) AS ts_tz",
                );
                expect(typeof ok.rows[0]!.ts_tz).toBe("string");
                yield* conn.close;
            }),
        ),
    );

    // Fix round 1 (ruling R10): UUID showed the exact same accessor failure
    // as TIMESTAMP_TZ during the investigation (duckdb_value_varchar -> NULL
    // for a real, non-SQL-NULL value) and is excluded from VARCHAR_TYPES the
    // same way - confirmed structurally here, mirroring the TZ test above.
    dtest(
        "refuses to decode UUID instead of returning an empty string",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const conn = yield* db.open(tempDb());
                yield* conn.exec("CREATE TABLE u (id UUID)");
                yield* conn.exec("INSERT INTO u VALUES ('11111111-1111-1111-1111-111111111111')");
                const result = yield* Effect.result(conn.query("SELECT id FROM u"));
                expect(result._tag).toBe("Failure");
                if (result._tag === "Failure") {
                    expect(result.failure._tag).toBe("DuckDbUnsupportedTypeError");
                    expect((result.failure as { message: string }).message).toContain("CAST(id AS VARCHAR)");
                }
                // the documented workaround works, including for a NULL row
                yield* conn.exec("INSERT INTO u VALUES (NULL)");
                const ok = yield* conn.query("SELECT CAST(id AS VARCHAR) AS id FROM u ORDER BY id");
                expect(ok.rows).toEqual([
                    { id: "11111111-1111-1111-1111-111111111111" },
                    { id: null },
                ]);
                yield* conn.close;
            }),
        ),
    );

    dtest(
        "a read-only open cannot write, and refuses a database that does not exist",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const path = tempDb();
                const rw = yield* db.open(path);
                yield* rw.exec("CREATE TABLE t (id INTEGER)");
                yield* rw.close;

                const ro = yield* db.open(path, { readOnly: true });
                expect(ro.readOnly).toBe(true);
                expect((yield* ro.query("SELECT count(*) AS n FROM t")).rows[0]!.n).toBe(0n);
                const result = yield* Effect.result(ro.exec("INSERT INTO t VALUES (1)"));
                expect(result._tag).toBe("Failure");
                if (result._tag === "Failure") {
                    // Assert the specific tag and a read-only-mode message,
                    // not just "some failure" - a differently-broken INSERT
                    // (e.g. a typo'd table name) would also satisfy a bare
                    // _tag === "Failure" check without proving read-only
                    // actually blocked the write.
                    expect(result.failure._tag).toBe("DuckDbQueryError");
                    expect((result.failure as { message: string }).message.toLowerCase()).toContain(
                        "read-only",
                    );
                }
                yield* ro.close;

                const missingPath = join(tempDb(), "..", "absent.db");
                const missing = yield* Effect.result(db.open(missingPath, { readOnly: true }));
                expect(missing._tag).toBe("Failure");
                if (missing._tag === "Failure") expect(missing.failure._tag).toBe("DuckDbOpenError");
                // The guarantee under test is "fails rather than silently
                // creating an empty database" - assert the file was in fact
                // never created, not just that open() reported failure.
                expect(existsSync(missingPath)).toBe(false);
            }),
        ),
    );

    // Fix round 2 (ruling R11): this test previously "proved" close ran by
    // reopening the path read-only afterward. The reviewer disproved that as
    // evidence - opening the same dylib read-only WHILE a write handle is
    // still open on the same path SUCCEEDS, so the reopen would pass whether
    // or not close ever ran. This is now a light integration smoke test only
    // (scoped composes correctly and the scope exits without throwing); the
    // actual guarantee - close disconnects/closes exactly once, and a second
    // close is a no-op - is unit-tested directly below against a fake
    // LibDuckDb, where the FFI calls can be counted.
    dtest(
        "scoped opens a usable connection and the scope exits cleanly",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const path = tempDb();
                yield* Effect.scoped(
                    Effect.gen(function* () {
                        const conn = yield* db.scoped(path);
                        yield* conn.exec("CREATE TABLE t (id INTEGER)");
                        const result = yield* conn.query("SELECT count(*) AS n FROM t");
                        expect(result.rows[0]!.n).toBe(0n);
                    }),
                );
            }),
        ),
    );

    dtest(
        "round-trips 2000 varchar rows correctly",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const conn = yield* db.open(tempDb());
                yield* conn.exec("CREATE TABLE t (note VARCHAR)");
                // Volume evidence that decoding stays correct at scale; this
                // is NOT leak-detection instrumentation (no RSS/heap
                // measurement here) - see the task report for the reviewer's
                // independent RSS measurement proving duckdb_free is
                // load-bearing (101->198MB with the free vs 109->411MB
                // without it, over 400k cells in two fresh processes).
                yield* conn.exec(
                    `INSERT INTO t SELECT 'row-' || i FROM range(2000) t(i)`,
                );
                const result = yield* conn.query("SELECT note FROM t ORDER BY note");
                expect(result.rows.length).toBe(2000);
                expect(result.rows[0]!.note).toBe("row-0");
                yield* conn.close;
            }),
        ),
    );
});

// Fix round 1 (ruling R10), Part B: direct unit test of readResult's general
// accessor-failure guard (duckdb_value_is_null false + a NULL varchar
// pointer -> DuckDbUnsupportedTypeError). Part A now excludes every
// currently-known trigger of this guard from VARCHAR_TYPES structurally, so
// no real SQL type reaches it any more via the client.open()/query() path
// above - this is the "unit-test the read helper directly" fallback,
// exercising readResult with a hand-built fake LibDuckDb instead of a
// vacuous SQL assertion that could never fail. DATE is used as the column's
// reported type (still a real "varchar"-accessor type) purely so the
// structural unsupportedColumns() pre-check does not reject the column
// before the per-cell guard even runs - the fake's duckdb_value_varchar is
// what actually returns NULL, standing in for the accessor failure.
describe("readResult (Part B unit test)", () => {
    test("a not-null cell with a NULL duckdb_value_varchar pointer raises DuckDbUnsupportedTypeError, not an empty string", () => {
        const resultPtr = ptr(new Uint8Array(8));
        const fakeLib = {
            symbols: {
                duckdb_column_count: () => 1n,
                duckdb_column_name: () => null, // -> readResult falls back to "column_0"
                duckdb_column_type: () => DuckDbTypeId.DATE,
                duckdb_row_count: () => 1n,
                duckdb_rows_changed: () => 0n,
                duckdb_value_is_null: () => false, // the cell is NOT SQL NULL
                duckdb_value_varchar: () => null, // ...yet the accessor returns NULL anyway
                duckdb_value_boolean: () => {
                    throw new Error("not expected to be called for a DATE column");
                },
                duckdb_value_int64: () => {
                    throw new Error("not expected to be called for a DATE column");
                },
                duckdb_value_uint64: () => {
                    throw new Error("not expected to be called for a DATE column");
                },
                duckdb_value_double: () => {
                    throw new Error("not expected to be called for a DATE column");
                },
                duckdb_free: () => {
                    throw new Error("must not be called - there is no pointer to free");
                },
            },
        } as unknown as LibDuckDb;

        expect(() => readResult(fakeLib, resultPtr)).toThrow();
        try {
            readResult(fakeLib, resultPtr);
            throw new Error("expected readResult to throw");
        } catch (err) {
            expect((err as { _tag?: string })._tag).toBe("DuckDbUnsupportedTypeError");
            expect((err as { message: string }).message).toContain("column_0");
        }
    });
});

// Fix round 2 (ruling R11), IMPORTANT 1 + 2: direct unit test of
// makeConnection's `close`. The previous "scoped" test's evidence for
// "close actually releases the file" was a read-only reopen of the same
// path - disproved as evidence (opening read-only while a write handle is
// still open on the same path SUCCEEDS against this dylib, so that
// assertion was true whether or not close ever ran). This counts the
// duckdb_disconnect/duckdb_close calls directly against a fake LibDuckDb,
// which is the only reliable way to prove (a) close actually calls them and
// (b) a second close does not call them again - the `closed` flag guard is
// the only thing standing between an idempotent close and a double-free of
// the same handle buffers.
// Final fix round, finding 1: `baseLayer` used to call `openLibDuckDb`
// bare inside `Effect.gen`, so a bad dylib path threw a raw, unhandled
// defect straight through `DuckDbLayer` - which is declared
// `Layer.Layer<DuckDb, DuckDbDylibError>` and is the seam the w0-dylib-ci
// chunk consumes directly. This never touches a real dylib (the path does
// not exist), so it runs unconditionally - no `withDuckDb`/skip needed.
describe("DuckDbLayer (finding 1)", () => {
    test("a bad dylib path surfaces DuckDbDylibError through Effect.result, not a rejected promise", async () => {
        const layer = DuckDbLayer("/definitely/not/a/dylib.so");
        const prog = Effect.asVoid(DuckDb).pipe(Effect.provide(layer)) as Effect.Effect<void, unknown>;

        const result = await Effect.runPromise(Effect.result(prog));
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
            expect((result.failure as { _tag?: string })._tag).toBe("DuckDbDylibError");
        }
    });
});

describe("makeConnection.close (Part B-style unit test)", () => {
    test("close disconnects and closes exactly once; a second close is a no-op", () => {
        let disconnectCalls = 0;
        let closeCalls = 0;
        const fakeLib = {
            symbols: {
                duckdb_disconnect: () => {
                    disconnectCalls += 1;
                },
                duckdb_close: () => {
                    closeCalls += 1;
                },
            },
        } as unknown as LibDuckDb;

        const conn = makeConnection(
            fakeLib,
            "/fake/path.db",
            false,
            new BigUint64Array(1),
            new BigUint64Array(1),
        );

        Effect.runSync(conn.close);
        expect(disconnectCalls).toBe(1);
        expect(closeCalls).toBe(1);

        // Idempotency: the second close must not re-invoke either FFI call.
        Effect.runSync(conn.close);
        Effect.runSync(conn.close);
        expect(disconnectCalls).toBe(1);
        expect(closeCalls).toBe(1);
    });
});
