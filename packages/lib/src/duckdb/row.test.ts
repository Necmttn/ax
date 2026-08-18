/**
 * The writer-side value contract.
 *
 * The pure cases are pure, but the two that matter most are claims about
 * DUCKDB, not about this code - that a `Date` bound as ISO-8601 text lands in a
 * TIMESTAMP column as the same instant, and that a JSON string written to a
 * VARCHAR reads back through the column codecs. Those are checked against a real
 * database, because a unit test of our own conversion would agree with itself
 * whatever DuckDB actually did.
 */
import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { publishCacheFixture, readFixture, runWithPlatform } from "../testing/cache-fixture.ts";
import { duckdbTestSetup } from "../testing/duckdb-dylib.ts";
import { JsonArrayColumn, TimestampColumn } from "./columns.ts";
import { cacheFirst } from "./query.ts";
import { boolParam, cacheRow, jsonParam, numParam, textParam, tsParam } from "./row.ts";
import { CacheRead } from "./seam.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("cache row values", {
    requireFts: true,
});

describe("jsonParam", () => {
    test("encodes arrays and objects as JSON text", () => {
        expect(jsonParam(["a", "b"])).toBe('["a","b"]');
        expect(jsonParam({ a: 1 })).toBe('{"a":1}');
        expect(jsonParam([])).toBe("[]");
    });

    test("maps null and undefined to NULL, not to the string \"null\"", () => {
        // `JSON.stringify(null)` is the four characters `null`, which a VARCHAR
        // column stores happily and every reader then has to defend against.
        expect(jsonParam(null)).toBeNull();
        expect(jsonParam(undefined)).toBeNull();
    });
});

describe("tsParam", () => {
    test("accepts a Date, an ISO string and an epoch number", () => {
        const when = new Date("2026-08-01T10:00:00.000Z");
        expect(tsParam(when)).toEqual(when);
        expect(tsParam("2026-08-01T10:00:00.000Z")).toEqual(when);
        expect(tsParam(when.getTime())).toEqual(when);
    });

    test("maps an absent or unparseable value to NULL", () => {
        expect(tsParam(null)).toBeNull();
        expect(tsParam(undefined)).toBeNull();
        expect(tsParam("")).toBeNull();
        // An unparseable string must not reach the binder as text: it would be
        // stored in a TIMESTAMP column only to fail the CAST, or worse, in a
        // VARCHAR column as garbage that reads back as a valid-looking value.
        expect(tsParam("not a date")).toBeNull();
        expect(tsParam(Number.NaN)).toBeNull();
    });
});

describe("textParam / numParam / boolParam", () => {
    test("text keeps a real string and nulls everything else", () => {
        expect(textParam("hello")).toBe("hello");
        expect(textParam("")).toBeNull();
        expect(textParam(null)).toBeNull();
        expect(textParam(undefined)).toBeNull();
        expect(textParam(42)).toBeNull();
    });

    test("num keeps finite numbers, including zero", () => {
        expect(numParam(0)).toBe(0);
        expect(numParam(1.5)).toBe(1.5);
        expect(numParam(Number.NaN)).toBeNull();
        expect(numParam(Number.POSITIVE_INFINITY)).toBeNull();
        expect(numParam("7")).toBe(7);
        expect(numParam("seven")).toBeNull();
        expect(numParam(null)).toBeNull();
    });

    test("bool keeps booleans and nulls everything else", () => {
        expect(boolParam(false)).toBe(false);
        expect(boolParam(true)).toBe(true);
        expect(boolParam("true")).toBeNull();
        expect(boolParam(undefined)).toBeNull();
    });
});

describe("cacheRow", () => {
    test("normalizes undefined to null and KEEPS the key", () => {
        // Dropping the key is what makes a batch ragged, and `putMany` refuses a
        // ragged batch - so a writer that omitted a column for one row would
        // fail the whole batch instead of writing a NULL.
        const row = cacheRow({ id: "a", project: undefined, cost: 0 });

        expect(Object.keys(row).sort()).toEqual(["cost", "id", "project"]);
        expect(row.project).toBeNull();
        expect(row.cost).toBe(0);
    });

    test("every row built from the same field list has the same column set", () => {
        const build = (project: string | undefined) => cacheRow({ id: "x", project });

        expect(Object.keys(build("ax")).sort()).toEqual(Object.keys(build(undefined)).sort());
    });
});

describe("against a real database", () => {
    const Row = Schema.Struct({
        id: Schema.String,
        started_at: TimestampColumn,
        labels: JsonArrayColumn(Schema.String),
    });

    const read = <A, E>(snapshotPath: string, effect: Effect.Effect<A, E, CacheRead>): Promise<A> =>
        Effect.runPromise(
            effect.pipe(Effect.provide(readFixture(snapshotPath, dylibPath))) as Effect.Effect<A, E>,
        );

    dtest("a tsParam Date round-trips as the SAME instant", async () => {
        // This is the claim about DuckDB the module rests on: the client binds a
        // Date as ISO-8601 TEXT, and the trailing `Z` has to survive the cast
        // into a naive TIMESTAMP column without shifting the instant.
        const when = "2026-08-01T10:00:00.000Z";
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-row-ts-"), dylibPath, (w) =>
                w.put(
                    "session",
                    cacheRow({
                        id: "session-ts",
                        started_at: tsParam(when),
                        labels: jsonParam(["spar", "dojo"]),
                    }),
                ),
            ),
        );

        const found = await read(
            fixture.snapshotPath,
            cacheFirst(
                Row,
                { sql: "SELECT id, started_at, labels FROM session WHERE id = ?", params: ["session-ts"] },
                "row test",
            ),
        );

        expect(found?.started_at.toISOString()).toBe(when);
        expect(found?.labels).toEqual(["spar", "dojo"]);
    });

    dtest("an ISO string and an equivalent Date store identically", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-row-ts2-"), dylibPath, (w) =>
                w.putMany("session", [
                    cacheRow({ id: "from-string", started_at: tsParam("2026-08-01T10:00:00.000Z") }),
                    cacheRow({
                        id: "from-date",
                        started_at: tsParam(new Date("2026-08-01T10:00:00.000Z")),
                    }),
                ]),
            ),
        );

        const Same = Schema.Struct({ same: Schema.Boolean });
        const found = await read(
            fixture.snapshotPath,
            cacheFirst(
                Same,
                {
                    sql: "SELECT (max(started_at) = min(started_at)) AS same FROM session WHERE id IN (?, ?)",
                    params: ["from-string", "from-date"],
                },
                "row test",
            ),
        );

        expect(found?.same).toBe(true);
    });

    dtest("a null from cacheRow lands as SQL NULL, not as the text 'null'", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-row-null-"), dylibPath, (w) =>
                w.put("session", cacheRow({ id: "session-null", project: undefined })),
            ),
        );

        const IsNull = Schema.Struct({ is_null: Schema.Boolean });
        const found = await read(
            fixture.snapshotPath,
            cacheFirst(
                IsNull,
                { sql: "SELECT (project IS NULL) AS is_null FROM session WHERE id = ?", params: ["session-null"] },
                "row test",
            ),
        );

        expect(found?.is_null).toBe(true);
    });
});
