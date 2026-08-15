/**
 * The recall SQL BUILDERS, in isolation.
 *
 * These are pure functions over strings, so they need no database - and the one
 * property worth proving here is the one a database test cannot show: that the
 * generated SQL carries NO literal values at all. The Surreal version was forced
 * to splice record-id literals into its query text because Surreal bindings
 * cannot carry record-id arrays; DuckDB row ids are plain strings, so every
 * filter is a bound parameter and the injection surface is gone. A regression
 * would put a quote character back into the SQL, which is exactly what the
 * assertions below watch for.
 *
 * The end-to-end behaviour (does this SQL return the right rows?) is proven
 * against a real DuckDB in `../dashboard/recall.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import {
    commitCountQuery,
    commitPageQuery,
    likePattern,
    sessionsForContentTypesQuery,
    skillCountQuery,
    skillPageQuery,
    truncate,
    turnCountQuery,
    turnPageQuery,
    type TurnFilters,
} from "./recall.ts";

const BASE: TurnFilters = { q: "duckdb" };

const ALL_FILTERS: TurnFilters = {
    q: "duckdb",
    project: "ax",
    since: "2026-08-01T00:00:00.000Z",
    sessionIds: ["session:a", "session:b"],
    repositoryId: "repository:ax",
};

// The clause builders themselves moved to `@ax/lib/duckdb/clause` (wave 2 needs
// them in every chunk) and are covered by `duckdb/clause.test.ts`. What stays
// here is what is specific to recall: that its QUERIES bind through them.

describe("no query carries a literal value", () => {
    const NASTY = "'; DROP TABLE turn; --";

    const queries = () => [
        turnPageQuery({ ...ALL_FILTERS, q: NASTY, project: NASTY }, 10, 20),
        turnCountQuery({ ...ALL_FILTERS, q: NASTY, project: NASTY }),
        commitPageQuery(NASTY, NASTY, 5),
        commitCountQuery(NASTY, NASTY),
        skillPageQuery(NASTY, 5),
        skillCountQuery(NASTY),
        sessionsForContentTypesQuery([NASTY, "image"]),
    ];

    test("no single quote appears in any generated SQL", () => {
        for (const q of queries()) {
            // The skill queries carry `ESCAPE '\'`, the one legitimate literal
            // in this family - it is part of the LIKE operator, not a value.
            const withoutEscape = q.sql.replaceAll("ESCAPE '\\'", "");
            expect(withoutEscape).not.toContain("'");
        }
    });

    test("the hostile string reaches every query only as a bound parameter", () => {
        for (const q of queries()) {
            expect(q.sql).not.toContain("DROP TABLE");
            expect(q.params.some((p) => typeof p === "string" && p.includes(NASTY))).toBe(true);
        }
    });
});

describe("page and count queries agree about what matches", () => {
    test("the count query binds the same filter params as the page query, minus limit/offset", () => {
        const page = turnPageQuery(ALL_FILTERS, 30, 10);
        const count = turnCountQuery(ALL_FILTERS);
        // Page params are [q, ...filters, limit, offset]; count is [q, ...filters].
        expect(page.params.slice(0, -2)).toEqual([...count.params]);
        expect(page.params.slice(-2)).toEqual([10, 30]);
    });

    test("query text is bound FIRST, once, in both", () => {
        expect(turnPageQuery(ALL_FILTERS, 0, 5).params[0]).toBe("duckdb");
        expect(turnCountQuery(ALL_FILTERS).params[0]).toBe("duckdb");
        // Scored once in the subquery, not repeated in SELECT and WHERE.
        expect(turnCountQuery(ALL_FILTERS).sql.match(/match_bm25/g)).toHaveLength(1);
    });

    test("an unfiltered query binds only the query text (plus pagination)", () => {
        expect(turnCountQuery(BASE).params).toEqual(["duckdb"]);
        expect(turnPageQuery(BASE, 0, 50).params).toEqual(["duckdb", 50, 0]);
    });

    test("the BM25 score is filtered outside the subquery, not used as a boolean", () => {
        // `match_bm25` returns a SCORE (NULL when the row does not match), so
        // using it directly in WHERE would filter on a number, not a match.
        for (const q of [turnPageQuery(BASE, 0, 5), turnCountQuery(BASE)]) {
            expect(q.sql).toContain("score IS NOT NULL");
        }
    });
});

describe("skill matching", () => {
    test("likePattern escapes LIKE's own wildcards so they are searched for", () => {
        expect(likePattern("100%")).toBe("%100\\%%");
        expect(likePattern("a_b")).toBe("%a\\_b%");
        expect(likePattern("c:\\d")).toBe("%c:\\\\d%");
        expect(likePattern("tdd")).toBe("%tdd%");
    });

    test("the page query binds the pattern three times: name, description, rank", () => {
        const page = skillPageQuery("tdd", 5);
        expect(page.params).toEqual(["%tdd%", "%tdd%", "%tdd%", 5]);
        expect(skillCountQuery("tdd").params).toEqual(["%tdd%", "%tdd%"]);
    });
});

describe("truncate", () => {
    test("leaves a short body alone and marks a long one", () => {
        expect(truncate("short")).toBe("short");
        const long = "x".repeat(500);
        expect(truncate(long)).toHaveLength(241);
        expect(truncate(long).endsWith("…")).toBe(true);
    });

    test("a body exactly at the limit is NOT marked", () => {
        const exact = "y".repeat(240);
        expect(truncate(exact)).toBe(exact);
    });
});
