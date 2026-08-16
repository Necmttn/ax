import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { CacheRead } from "./seam.ts";
import { publishCacheFixture, readFixture, runWithPlatform } from "../testing/cache-fixture.ts";
import { duckdbTestSetup } from "../testing/duckdb-dylib.ts";
import {
    andAll,
    daysAgoExpr,
    eqClause,
    hoursAgoExpr,
    inClause,
    limitOffset,
    NO_CLAUSE,
    sinceClause,
    untilClause,
    withinDaysClause,
    withinHoursClause,
} from "./clause.ts";

// `requireFts: true` because the real-DuckDB case below goes through
// `publishCacheFixture`, which builds the FTS indexes for EVERY fixture it
// publishes - so this suite needs an FTS-capable libduckdb even though it
// never searches. Declaring `false` would let the suite skip silently in CI
// instead of failing once, actionably, on a broken dylib (the anti-drift
// gate in scripts/check-ci-duckdb.test.ts enforces this pairing).
const { dylibPath, dtest, tempDir } = await duckdbTestSetup("clause ago-expressions", {
    requireFts: true,
});

/** Every clause builder must be injection-proof by construction: values are
 *  BOUND, never spelled. A quote character anywhere in generated SQL means a
 *  value leaked into the statement text. */
const HOSTILE = "o'brien\"; DROP TABLE session; --";

describe("eqClause", () => {
    test("binds the value and never spells it", () => {
        const clause = eqClause("s.project", HOSTILE);
        expect(clause.sql).toBe("AND s.project = ?");
        expect(clause.params).toEqual([HOSTILE]);
    });

    test("omits itself for null, undefined and the empty string", () => {
        expect(eqClause("c", null)).toEqual(NO_CLAUSE);
        expect(eqClause("c", undefined)).toEqual(NO_CLAUSE);
        expect(eqClause("c", "")).toEqual(NO_CLAUSE);
    });

    test("keeps a numeric zero - it is a value, not an absence", () => {
        expect(eqClause("c", 0)).toEqual({ sql: "AND c = ?", params: [0] });
    });
});

describe("inClause", () => {
    test("emits one placeholder per value, in order", () => {
        const clause = inClause("t.session", ["a", "b", "c"]);
        expect(clause.sql).toBe("AND t.session IN (?, ?, ?)");
        expect(clause.params).toEqual(["a", "b", "c"]);
    });

    test("omits itself entirely for an empty set", () => {
        // Callers treat an empty id set as "no possible hits" and short-circuit
        // before reaching SQL; emitting `IN ()` here would be a syntax error.
        expect(inClause("t.session", [])).toEqual(NO_CLAUSE);
    });
});

describe("sinceClause / untilClause", () => {
    test("bind an ISO string as given", () => {
        expect(sinceClause("t.ts", "2026-08-01T00:00:00.000Z")).toEqual({
            sql: "AND t.ts >= ?",
            params: ["2026-08-01T00:00:00.000Z"],
        });
    });

    test("bind a Date as a Date - the client encodes it, we do not", () => {
        const when = new Date("2026-08-01T00:00:00.000Z");
        expect(untilClause("t.ts", when)).toEqual({ sql: "AND t.ts <= ?", params: [when] });
    });

    test("omit themselves when there is no bound", () => {
        expect(sinceClause("t.ts", null)).toEqual(NO_CLAUSE);
        expect(untilClause("t.ts", undefined)).toEqual(NO_CLAUSE);
        expect(sinceClause("t.ts", "")).toEqual(NO_CLAUSE);
    });
});

describe("limitOffset", () => {
    test("binds both bounds", () => {
        expect(limitOffset(20, 40)).toEqual({ sql: "LIMIT ? OFFSET ?", params: [20, 40] });
    });

    test("omits the offset when it is zero", () => {
        expect(limitOffset(20)).toEqual({ sql: "LIMIT ?", params: [20] });
        expect(limitOffset(20, 0)).toEqual({ sql: "LIMIT ?", params: [20] });
    });

    test("refuses a bound that is not a non-negative integer", () => {
        // A NaN or fractional bound binds as a DOUBLE and DuckDB rejects it far
        // from the caller that produced it, so it is refused here instead.
        expect(() => limitOffset(-1)).toThrow();
        expect(() => limitOffset(1.5)).toThrow();
        expect(() => limitOffset(Number.NaN)).toThrow();
        expect(() => limitOffset(10, -1)).toThrow();
    });
});

describe("andAll", () => {
    test("joins only the live clauses and flattens params in clause order", () => {
        const combined = andAll([
            eqClause("s.project", "ax"),
            eqClause("s.source", null),
            inClause("t.session", ["s1", "s2"]),
            sinceClause("t.ts", "2026-08-01"),
        ]);
        expect(combined.sql).toBe(
            "AND s.project = ? AND t.session IN (?, ?) AND t.ts >= ?",
        );
        expect(combined.params).toEqual(["ax", "s1", "s2", "2026-08-01"]);
    });

    test("collapses to NO_CLAUSE when every clause is absent", () => {
        expect(andAll([eqClause("a", null), inClause("b", [])])).toEqual(NO_CLAUSE);
    });

    test("never emits a quote character, whatever the values", () => {
        const combined = andAll([
            eqClause("a", HOSTILE),
            inClause("b", [HOSTILE, "'"]),
            sinceClause("c", HOSTILE),
        ]);
        expect(combined.sql).not.toContain("'");
        expect(combined.sql).not.toContain('"');
        expect(combined.params).toHaveLength(4);
    });
});

describe("daysAgoExpr / hoursAgoExpr / withinDaysClause / withinHoursClause", () => {
    test("daysAgoExpr double-casts: TIMESTAMPTZ->TIMESTAMP and the placeholder->INTEGER", () => {
        expect(daysAgoExpr()).toBe(
            "CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - (CAST(? AS INTEGER) * INTERVAL '1 day')",
        );
    });

    test("hoursAgoExpr is the same shape with the hour unit", () => {
        expect(hoursAgoExpr()).toBe(
            "CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - (CAST(? AS INTEGER) * INTERVAL '1 hour')",
        );
    });

    test("withinDaysClause binds the count and embeds daysAgoExpr", () => {
        const clause = withinDaysClause("t.ts", 7);
        expect(clause.sql).toBe(`AND t.ts >= ${daysAgoExpr()}`);
        expect(clause.params).toEqual([7]);
    });

    test("withinHoursClause binds the count and embeds hoursAgoExpr", () => {
        const clause = withinHoursClause("t.ts", 12);
        expect(clause.sql).toBe(`AND t.ts >= ${hoursAgoExpr()}`);
        expect(clause.params).toEqual([12]);
    });

    test("refuse a bound that is not a non-negative integer", () => {
        expect(() => withinDaysClause("t.ts", -1)).toThrow();
        expect(() => withinDaysClause("t.ts", 1.5)).toThrow();
        expect(() => withinHoursClause("t.ts", Number.NaN)).toThrow();
    });

    // The naive spelling - `CURRENT_TIMESTAMP - (? * INTERVAL '1 day')`, no
    // casts - is SQL text that looks identical in a diff and never binds
    // against a real DuckDB connection: `CURRENT_TIMESTAMP` is a TIMESTAMPTZ,
    // and TIMESTAMPTZ-minus-INTERVAL has no overload without the ICU
    // extension, which this project's static build does not link. The three
    // string-equality tests above cannot tell that apart from a working
    // expression - only executing it against a real connection can, which is
    // the whole reason this suite exists.
    dtest("daysAgoExpr and hoursAgoExpr actually execute against a real DuckDB", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-clause-ago-"), dylibPath, () => Effect.void),
        );

        const Row = Schema.Struct({ cutoff: Schema.Unknown });
        const run = <A>(sql: string, params: ReadonlyArray<number>) =>
            Effect.runPromise(
                Effect.gen(function* () {
                    const cache = yield* CacheRead;
                    return (yield* cache.rows(Row, `SELECT ${sql} AS cutoff`, params))[0]! as A;
                }).pipe(Effect.provide(readFixture(fixture.snapshotPath, dylibPath)), Effect.scoped),
            );

        const daysRow = await run<{ cutoff: unknown }>(daysAgoExpr(), [7]);
        const hoursRow = await run<{ cutoff: unknown }>(hoursAgoExpr(), [12]);

        // Both must resolve to a value strictly before now (an executable
        // expression that silently no-ops would pass a "did it throw" check
        // but fail this one).
        const now = Date.now();
        expect(new Date(daysRow.cutoff as string).getTime()).toBeLessThan(now);
        expect(new Date(hoursRow.cutoff as string).getTime()).toBeLessThan(now);
        // 7 days ago is earlier than 12 hours ago.
        expect(new Date(daysRow.cutoff as string).getTime()).toBeLessThan(
            new Date(hoursRow.cutoff as string).getTime(),
        );
    });
});
