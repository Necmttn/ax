import { describe, expect, test } from "bun:test";
import {
    andAll,
    eqClause,
    inClause,
    limitOffset,
    NO_CLAUSE,
    sinceClause,
    untilClause,
} from "./clause.ts";

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
