import { BunFileSystem } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";
import { Effect, Fiber, FileSystem, Schema } from "effect";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { duckdbTestSetup } from "../testing/duckdb-dylib.ts";
import { loadNodeApiOver } from "./binding.ts";
import { DuckDb, DuckDbLayer, DuckDbLiveWith, decodeCell } from "./client.ts";
import { NumberFromBigIntColumn } from "./bigint-column.ts";
import { DuckDbTypeId } from "./types.ts";

const { dtest, tempDir, withDuckDb } = await duckdbTestSetup("duckdb client");
const tempDb = () => join(tempDir("ax-duckdb-client-"), "test.db");

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
    // evidence - opening the same engine read-only WHILE a write handle is
    // still open on the same path SUCCEEDS, so the reopen would pass whether
    // or not close ever ran. This is a light integration smoke test only
    // (scoped composes correctly and the scope exits without throwing);
    // close idempotency and the after-close refusal are pinned by "a query
    // after close fails with a typed error" below, and close-under-load by
    // "close while a statement is in flight drains cleanly".
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

    // Cross-review P1-1: `makeConnection` captured the connection pointer up
    // front and no operation re-checked `closed`, so a query issued after
    // `close` handed a freed pointer to `duckdb_query` - reproduced as a Bun
    // SEGMENTATION FAULT, i.e. a process kill with no catchable error at all.
    // Every operation now fails with a typed `DuckDbQueryError` instead.
    dtest(
        "a query after close fails with a typed error instead of segfaulting",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const conn = yield* db.open(tempDb());
                yield* conn.exec("CREATE TABLE t (id INTEGER)");
                yield* conn.close;

                const queried = yield* Effect.result(conn.query("SELECT 1 AS n"));
                expect(queried._tag).toBe("Failure");
                if (queried._tag === "Failure") {
                    expect(queried.failure._tag).toBe("DuckDbQueryError");
                    expect((queried.failure as { message: string }).message.toLowerCase()).toContain(
                        "closed",
                    );
                }

                const executed = yield* Effect.result(conn.exec("INSERT INTO t VALUES (1)"));
                expect(executed._tag).toBe("Failure");
                if (executed._tag === "Failure") expect(executed.failure._tag).toBe("DuckDbQueryError");

                // close itself stays idempotent (no double free).
                yield* conn.close;
            }),
        ),
    );

    // Cross-review P1-2: every `bigint` parameter went through
    // `duckdb_bind_int64`, which SILENTLY WRAPS - `2n**63n` was reproduced
    // arriving as `-2n**63n`, and `2n**100n` as `0n`. Corrupt data with no
    // signal is the worst possible outcome for a store, so out-of-range
    // values are now a typed failure naming the value and the i64 limit.
    dtest(
        "refuses a bigint parameter outside the signed 64-bit range instead of wrapping it",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const conn = yield* db.open(tempDb());

                for (const value of [2n ** 63n, 2n ** 100n, -(2n ** 63n) - 1n]) {
                    const result = yield* Effect.result(
                        conn.query("SELECT CAST(? AS BIGINT) AS v", [value]),
                    );
                    expect(result._tag).toBe("Failure");
                    if (result._tag === "Failure") {
                        expect(result.failure._tag).toBe("DuckDbQueryError");
                        const message = (result.failure as { message: string }).message;
                        expect(message).toContain(value.toString());
                        expect(message).toContain("9223372036854775807");
                    }
                }

                // ... while both boundary values still bind exactly.
                const max = yield* conn.query("SELECT CAST(? AS BIGINT) AS v", [2n ** 63n - 1n]);
                expect(max.rows[0]!.v).toBe(9223372036854775807n);
                const min = yield* conn.query("SELECT CAST(? AS BIGINT) AS v", [-(2n ** 63n)]);
                expect(min.rows[0]!.v).toBe(-9223372036854775808n);

                yield* conn.close;
            }),
        ),
    );

    // Wave-0 finding P1/P2: a VARCHAR bind goes through a NUL-terminated C
    // string, which silently TRUNCATES at an embedded NUL - and the length-less
    // read accessor cannot detect it on the way back out. The write side now
    // makes that a loud typed failure instead of silent data loss.
    dtest(
        "refuses a VARCHAR parameter containing a NUL byte instead of silently truncating",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const conn = yield* db.open(tempDb());
                yield* conn.exec("CREATE TABLE t (note VARCHAR)");

                const result = yield* Effect.result(conn.exec("INSERT INTO t VALUES (?)", ["a\0b"]));
                expect(result._tag).toBe("Failure");
                if (result._tag === "Failure") {
                    expect(result.failure._tag).toBe("DuckDbQueryError");
                    expect((result.failure as { message: string }).message).toMatch(/NUL byte/i);
                }
                // Nothing was written - the guard fired before the bind.
                const count = yield* conn.query("SELECT count(*) AS n FROM t");
                expect(count.rows[0]!.n).toBe(0n);

                // A NUL-free string still binds fine.
                yield* conn.exec("INSERT INTO t VALUES (?)", ["clean"]);
                const ok = yield* conn.query("SELECT note FROM t");
                expect(ok.rows).toEqual([{ note: "clean" }]);
                yield* conn.close;
            }),
        ),
    );

    // Wave-0 finding P2: a BIGINT column decodes to `bigint`, so `queryAs` with
    // a `Schema.Number` field must FAIL (typed), never silently lossy-convert -
    // and `NumberFromBigIntColumn` is the sanctioned coercion for a small BIGINT.
    dtest(
        "queryAs over a BIGINT column: Schema.Number fails, NumberFromBigIntColumn coerces",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const conn = yield* db.open(tempDb());
                // A real production BIGINT column, not the INTEGER the old test used.
                yield* conn.exec("CREATE TABLE t (n BIGINT)");
                yield* conn.exec("INSERT INTO t VALUES (42)");

                // A number-typed field against a BIGINT column: typed failure.
                const AsNumber = Schema.Struct({ n: Schema.Number });
                const failed = yield* Effect.result(conn.queryAs(AsNumber, "SELECT n FROM t"));
                expect(failed._tag).toBe("Failure");
                if (failed._tag === "Failure") expect(failed.failure._tag).toBe("DuckDbDecodeError");

                // Schema.BigInt keeps full precision.
                const AsBigInt = Schema.Struct({ n: Schema.BigInt });
                expect(yield* conn.queryAs(AsBigInt, "SELECT n FROM t")).toEqual([{ n: 42n }]);

                // The coercion schema yields a number for an in-range value...
                const AsCoerced = Schema.Struct({ n: NumberFromBigIntColumn });
                expect(yield* conn.queryAs(AsCoerced, "SELECT n FROM t")).toEqual([{ n: 42 }]);

                // ... and FAILS (not truncates) when the BIGINT exceeds a JS number.
                yield* conn.exec("INSERT INTO t VALUES (9007199254740993)"); // MAX_SAFE_INTEGER + 2
                const overflow = yield* Effect.result(
                    conn.queryAs(AsCoerced, "SELECT n FROM t ORDER BY n"),
                );
                expect(overflow._tag).toBe("Failure");
                if (overflow._tag === "Failure") expect(overflow.failure._tag).toBe("DuckDbDecodeError");
                yield* conn.close;
            }),
        ),
    );

    // Cross-review P2-1: rows were built on a normal `{}`, so a `__proto__`
    // column vanished (the setter swallows the assignment) and a duplicate
    // column name silently overwrote the earlier value - data loss with no
    // signal either way.
    dtest(
        "a __proto__ column round-trips instead of vanishing into the prototype setter",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const conn = yield* db.open(tempDb());
                const result = yield* conn.query(`SELECT 42 AS "__proto__"`);
                const row = result.rows[0]!;
                expect(Object.getPrototypeOf(row)).toBe(null);
                // 42 (not 42n): an untyped integer literal is INTEGER, which
                // row-decode narrows to a JS number - the point here is that
                // the KEY survives at all.
                expect(row["__proto__"]).toBe(42);
                yield* conn.close;
            }),
        ),
    );

    dtest(
        "duplicate column names fail loudly instead of silently overwriting",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const conn = yield* db.open(tempDb());
                yield* conn.exec("CREATE TABLE a (v INTEGER)");
                yield* conn.exec("CREATE TABLE b (v INTEGER)");
                yield* conn.exec("INSERT INTO a VALUES (1)");
                yield* conn.exec("INSERT INTO b VALUES (2)");
                const result = yield* Effect.result(conn.query("SELECT a.v, b.v FROM a, b"));
                expect(result._tag).toBe("Failure");
                if (result._tag === "Failure") {
                    expect(result.failure._tag).toBe("DuckDbQueryError");
                    expect((result.failure as { message: string }).message).toContain("alias");
                }
                // the documented workaround works
                const ok = yield* conn.query("SELECT a.v AS av, b.v AS bv FROM a, b");
                expect(ok.rows).toEqual([{ av: 1, bv: 2 }]);
                yield* conn.close;
            }),
        ),
    );

    // Cross-review P2-2: DuckDB stores TIMESTAMP at MICROSECOND grain; a JS
    // `Date` is millisecond-grain, so the last three digits are dropped. ax
    // data is millisecond-grain, so this is the accepted trade - PINNED here
    // so it stays a documented contract rather than an accident.
    dtest(
        "TIMESTAMP microseconds truncate to milliseconds (documented, pinned)",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const conn = yield* db.open(tempDb());
                const result = yield* conn.query(
                    "SELECT TIMESTAMP '2026-08-14 10:11:12.999999' AS ts",
                );
                expect((result.rows[0]!.ts as Date).toISOString()).toBe("2026-08-14T10:11:12.999Z");
                yield* conn.close;
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

// ---------------------------------------------------------------------------
// napi driver contracts (#880) - what the swap must NOT have changed
// ---------------------------------------------------------------------------

describe("napi binding semantics", () => {
    // The FFI client bound every integer through duckdb_bind_int64 and every
    // non-integer number through duckdb_bind_double; napi's OWN inference
    // would bind a JS bigint as HUGEINT and a safe integer as INTEGER. The
    // explicit types in encodeParams pin the FFI behavior - proven end-to-end
    // here by asking the engine what type each parameter arrived as.
    dtest(
        "parameters arrive with the same SQL types the FFI client bound",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const conn = yield* db.open(tempDb());
                const typeOf = (param: unknown) =>
                    Effect.map(
                        conn.query("SELECT typeof(?) AS t", [param as never]),
                        (r) => r.rows[0]!.t,
                    );
                expect(yield* typeOf(5)).toBe("BIGINT");
                expect(yield* typeOf(12n)).toBe("BIGINT");
                expect(yield* typeOf(5.5)).toBe("DOUBLE");
                expect(yield* typeOf("x")).toBe("VARCHAR");
                expect(yield* typeOf(true)).toBe("BOOLEAN");
                expect(yield* typeOf(new Date("2026-08-14T10:11:12Z"))).toBe("VARCHAR");
                yield* conn.close;
            }),
        ),
    );

    // `sum(BIGINT)` is HUGEINT by TYPE (not by magnitude), and the FFI client
    // decoded it to a JS bigint via the varchar accessor + parseHugeint. The
    // napi driver hands HUGEINT over as a bigint directly - same caller-visible
    // value, pinned so `ax cost models`-style aggregates keep decoding.
    dtest(
        "sum over a BIGINT column decodes to bigint (HUGEINT promotion)",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const conn = yield* db.open(tempDb());
                yield* conn.exec("CREATE TABLE t (n BIGINT)");
                yield* conn.exec("INSERT INTO t VALUES (40), (2)");
                const result = yield* conn.query("SELECT sum(n) AS s FROM t");
                expect(result.rows[0]!.s).toBe(42n);
                yield* conn.close;
            }),
        ),
    );

    // The FFI client serialized calls by construction (a synchronous FFI call
    // blocks the thread). The napi driver serializes per connection through
    // its promise chain - concurrent fibers on one connection must all
    // complete, in order, without corrupting each other.
    dtest(
        "concurrent queries on one connection all complete",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const conn = yield* db.open(tempDb());
                yield* conn.exec("CREATE TABLE t (id INTEGER)");
                const inserts = Array.from({ length: 8 }, (_, i) =>
                    conn.exec("INSERT INTO t VALUES (?)", [i]),
                );
                yield* Effect.all(inserts, { concurrency: "unbounded" });
                const count = yield* conn.query("SELECT count(*) AS n, sum(id) AS s FROM t");
                expect(count.rows[0]!.n).toBe(8n);
                expect(count.rows[0]!.s).toBe(28n);
                yield* conn.close;
            }),
        ),
    );

    // THE reason for the swap (#880): a running statement no longer blocks
    // the JS thread, and an interrupted fiber cancels it natively via
    // connection.interrupt(). Under the FFI client this test was impossible -
    // the timeout could not even fire until the statement returned.
    dtest(
        "a timed-out statement is preempted natively, and the connection stays usable",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const conn = yield* db.open(tempDb());
                // ~20M md5 calls: several seconds of engine work if left alone.
                const slow = conn.query(
                    "SELECT max(md5(i::VARCHAR)) AS m FROM range(20000000) t(i)",
                );
                const startedAt = performance.now();
                const raced = yield* Effect.result(slow.pipe(Effect.timeout("250 millis")));
                const elapsed = performance.now() - startedAt;
                expect(raced._tag).toBe("Failure");
                // Preemption must be REAL: the fiber came back long before the
                // statement's natural run time (generous 5s bound vs ~250ms
                // expected, so a slow CI box cannot flake this).
                expect(elapsed).toBeLessThan(5000);
                // ... and the interrupt poisoned nothing: the connection
                // serves the next statement normally.
                const after = yield* conn.query("SELECT 1 AS ok");
                expect(after.rows[0]!.ok).toBe(1);
                yield* conn.close;
            }),
        ),
        15000,
    );

    // Close drains: `close` waits for in-flight/queued statements to settle
    // before tearing down the native handles, so a racing statement can never
    // observe a torn-down connection mid-run.
    dtest(
        "close while a statement is in flight drains cleanly",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const conn = yield* db.open(tempDb());
                const fiber = yield* Effect.forkChild(
                    Effect.result(conn.query("SELECT max(md5(i::VARCHAR)) AS m FROM range(200000) t(i)")),
                );
                yield* conn.close;
                // Whatever the in-flight statement's outcome (finished before
                // the teardown, or refused at its turn), the process survives
                // and the fiber settles.
                yield* Fiber.await(fiber);
                const again = yield* Effect.result(conn.query("SELECT 1"));
                expect(again._tag).toBe("Failure");
                yield* conn.close; // idempotent
            }),
        ),
        15000,
    );
});

// decodeCell is the pure napi-value -> DuckDbValue rule; the primitive
// branches are testable without a database.
describe("decodeCell", () => {
    test("keeps bigint for 64/128-bit integer columns, narrows the rest", () => {
        expect(decodeCell(DuckDbTypeId.BIGINT, 42n)).toBe(42n);
        expect(decodeCell(DuckDbTypeId.UBIGINT, 42n)).toBe(42n);
        expect(decodeCell(DuckDbTypeId.HUGEINT, 2n ** 100n)).toBe(2n ** 100n);
        expect(decodeCell(DuckDbTypeId.UHUGEINT, 7n)).toBe(7n);
        expect(decodeCell(DuckDbTypeId.INTEGER, 7)).toBe(7);
    });

    test("routes a TIMESTAMP text rendering through the Date coercion", () => {
        const decoded = decodeCell(DuckDbTypeId.TIMESTAMP, "2026-08-14 10:11:12.999999");
        expect(decoded).toBeInstanceOf(Date);
        expect((decoded as Date).toISOString()).toBe("2026-08-14T10:11:12.999Z");
    });

    test("null, boolean, number and varchar pass through", () => {
        expect(decodeCell(DuckDbTypeId.VARCHAR, null)).toBe(null);
        expect(decodeCell(DuckDbTypeId.BOOLEAN, true)).toBe(true);
        expect(decodeCell(DuckDbTypeId.DOUBLE, 1.5)).toBe(1.5);
        expect(decodeCell(DuckDbTypeId.VARCHAR, "x")).toBe("x");
    });
});

// Final fix round, finding 1 (kept across the driver swap): a bad dylib path
// must surface as a typed DuckDbDylibError through the layer, never a raw
// defect. Under the napi driver the failure comes from the binding loader's
// read of the dylib bytes. This never touches a real dylib (the path does not
// exist), so it runs unconditionally - no withDuckDb/skip needed.
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

// A8: `DuckDbLiveWith`'s `options.assetPath` must thread through to
// `resolveDylibPath` as its `assetPath` fallback - this is the seam an
// apps-side consumer (e.g. an embedded-binary build) will use to hand in a
// bundled dylib without `packages/lib` importing anything from `apps/*`.
// Neither of these ever touches a real dylib (the paths do not exist), so
// they run unconditionally - no `withDuckDb`/skip needed. `AX_DUCKDB_DYLIB`
// is saved/restored around each test in case the harness (or a developer's
// shell) already has it set, mirroring dylib.test.ts's convention.
describe("DuckDbLiveWith (A8)", () => {
    test("threads options.assetPath through to resolveDylibPath", async () => {
        const prev = process.env.AX_DUCKDB_DYLIB;
        delete process.env.AX_DUCKDB_DYLIB;
        try {
            const assetPath = "/definitely/not/a/bundled-dylib.so";
            const layer = DuckDbLiveWith({ assetPath });
            const prog = Effect.asVoid(DuckDb).pipe(Effect.provide(layer)) as Effect.Effect<void, unknown>;

            const result = await Effect.runPromise(Effect.result(prog));
            expect(result._tag).toBe("Failure");
            if (result._tag === "Failure") {
                const failure = result.failure as { _tag?: string; message?: string };
                expect(failure._tag).toBe("DuckDbDylibError");
                // Proves the CONFIGURED path was the one resolveDylibPath
                // tried (not the "no options" no-asset-path failure), i.e.
                // that assetPath genuinely reached it.
                expect(failure.message).toContain(assetPath);
            }
        } finally {
            if (prev !== undefined) process.env.AX_DUCKDB_DYLIB = prev;
        }
    });

    test("with no options at all, fails with the no-asset-available message (same as DuckDbLive)", async () => {
        const prev = process.env.AX_DUCKDB_DYLIB;
        delete process.env.AX_DUCKDB_DYLIB;
        try {
            const layer = DuckDbLiveWith();
            const prog = Effect.asVoid(DuckDb).pipe(Effect.provide(layer)) as Effect.Effect<void, unknown>;

            const result = await Effect.runPromise(Effect.result(prog));
            expect(result._tag).toBe("Failure");
            if (result._tag === "Failure") {
                const failure = result.failure as { _tag?: string; message?: string };
                expect(failure._tag).toBe("DuckDbDylibError");
                expect(failure.message).toContain("no libduckdb available");
            }
        } finally {
            if (prev !== undefined) process.env.AX_DUCKDB_DYLIB = prev;
        }
    });
});

// ONE ENGINE PER PROCESS (binding.ts): the napi addon and its dylib are
// process-global once loaded; asking for a DIFFERENT dylib afterwards must be
// a typed refusal, never a silent answer from the previously-loaded engine.
describe("binding one-engine-per-process", () => {
    dtest(
        "a second load with a different dylib path is refused, not silently served",
        withDuckDb((db) =>
            Effect.gen(function* () {
                // Ensure the engine is genuinely loaded in this process.
                const conn = yield* db.open(tempDb());
                yield* conn.exec("SELECT 1");
                yield* conn.close;

                const fs = yield* FileSystem.FileSystem;
                const result = yield* Effect.result(
                    loadNodeApiOver(fs, { dylibPath: "/some/other/libduckdb.dylib" }),
                );
                expect(result._tag).toBe("Failure");
                if (result._tag === "Failure") {
                    const failure = result.failure as { _tag?: string; message?: string };
                    expect(failure._tag).toBe("DuckDbDylibError");
                    expect(failure.message).toContain("already loaded");
                }
            }).pipe(Effect.provide(BunFileSystem.layer)),
        ),
    );

    // #884: a RELATIVE spelling of the loaded engine is the same engine, not a
    // conflict - and, on the first load, must never become the staged
    // symlink's target verbatim (a stage-dir-relative target dangles, which is
    // exactly how main CI's linux smoke broke). Canonicalization covers both.
    dtest(
        "a relative spelling of the same dylib resolves to the loaded engine",
        withDuckDb(() =>
            Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem;
                const absolute = process.env.AX_DUCKDB_DYLIB!;
                const rel = relative(process.cwd(), absolute);
                expect(rel.startsWith("/")).toBe(false);
                const api = yield* loadNodeApiOver(fs, { dylibPath: rel });
                expect(typeof api.DuckDBInstance.create).toBe("function");
            }).pipe(Effect.provide(BunFileSystem.layer)),
        ),
    );
});
