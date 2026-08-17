import { describe, expect, test } from "bun:test";
import {
    bareIntegerRefs,
    integerColumnsFromDdl,
    rawProjections,
} from "./check-raw-numeric-cast.ts";

const DDL = `
CREATE TABLE session_token_usage (
    id VARCHAR PRIMARY KEY,
    prompt_tokens BIGINT,
    completion_tokens BIGINT,
    cost_usd DOUBLE,
    model VARCHAR,
    "offset" BIGINT,
    turns INTEGER
);
-- bytes BIGINT   <- a comment, not a column
`;

describe("integerColumnsFromDdl", () => {
    test("collects BIGINT and INTEGER columns, including quoted names", () => {
        const cols = integerColumnsFromDdl(DDL);
        expect(cols.has("prompt_tokens")).toBe(true);
        expect(cols.has("completion_tokens")).toBe(true);
        expect(cols.has("offset")).toBe(true);
        expect(cols.has("turns")).toBe(true);
    });

    test("excludes DOUBLE and VARCHAR columns - they already decode to JS values", () => {
        const cols = integerColumnsFromDdl(DDL);
        expect(cols.has("cost_usd")).toBe(false);
        expect(cols.has("model")).toBe(false);
    });

    test("ignores commented-out declarations", () => {
        expect(integerColumnsFromDdl(DDL).has("bytes")).toBe(false);
    });

    test("parses the REAL schema, so a schema reformat cannot silently empty the guard", async () => {
        const ddl = await Bun.file("packages/schema/src/schema.duckdb.sql").text();
        const cols = integerColumnsFromDdl(ddl);
        expect(cols.size).toBeGreaterThan(50);
        expect(cols.has("prompt_tokens")).toBe(true);
    });
});

describe("rawProjections", () => {
    test("reads the projection of a write.raw call", () => {
        const src = `const r = yield* write.raw("SELECT prompt_tokens FROM session_token_usage WHERE id = ?", [k]);`;
        const projections = rawProjections(src);
        expect(projections).toHaveLength(1);
        expect(projections[0]!.text).toContain("prompt_tokens");
    });

    test("ignores the SAME statement passed to a decoded seam", () => {
        const src = `const r = yield* cacheRows(Schema, { sql: "SELECT prompt_tokens FROM session_token_usage" });`;
        expect(rawProjections(src)).toHaveLength(0);
    });

    test("handles a multi-line template literal with nested parens", () => {
        const src = [
            "const r = yield* write.raw(`",
            "    SELECT CAST(prompt_tokens AS DOUBLE) AS prompt_tokens, model",
            "    FROM session_token_usage WHERE id = ?`, [key]);",
        ].join("\n");
        const projections = rawProjections(src);
        expect(projections).toHaveLength(1);
        expect(projections[0]!.text).toContain("CAST(prompt_tokens AS DOUBLE)");
    });

    test("reports the line the call starts on", () => {
        const src = `a\nb\nconst r = yield* write.raw("SELECT turns FROM x");`;
        expect(rawProjections(src)[0]!.line).toBe(3);
    });
});

describe("bareIntegerRefs", () => {
    const cols = integerColumnsFromDdl(DDL);

    test("flags an uncast integer column", () => {
        expect(bareIntegerRefs(" prompt_tokens, model ", cols)).toEqual(["prompt_tokens"]);
    });

    test("accepts a CAST to DOUBLE, alias included", () => {
        expect(bareIntegerRefs(" CAST(prompt_tokens AS DOUBLE) AS prompt_tokens ", cols)).toEqual([]);
    });

    test("an alias that merely SHARES an integer column's name is not a read", () => {
        // `something AS turns` names the output; the cast type governs it.
        expect(bareIntegerRefs(" CAST(x AS DOUBLE) AS turns ", cols)).toEqual([]);
    });

    test("sees through a nested CAST", () => {
        expect(bareIntegerRefs(" CAST(COALESCE(turns, 0) AS DOUBLE) AS turns ", cols)).toEqual([]);
    });

    test("flags one uncast column beside a correctly cast sibling", () => {
        const refs = bareIntegerRefs(" CAST(prompt_tokens AS DOUBLE) AS prompt_tokens, completion_tokens ", cols);
        expect(refs).toEqual(["completion_tokens"]);
    });

    test("ignores DOUBLE and VARCHAR columns entirely", () => {
        expect(bareIntegerRefs(" cost_usd, model ", cols)).toEqual([]);
    });
});

describe("aggregates are not column reads", () => {
    const cols = integerColumnsFromDdl(DDL);

    test("count(*) AS count is not flagged, though `count` IS a real BIGINT column", () => {
        // Three tables in the real schema declare a `count BIGINT` column, so
        // the name is in the set. `count(` is still a function call.
        expect(integerColumnsFromDdl(" count BIGINT,").has("count")).toBe(true);
        expect(bareIntegerRefs(" count(*) AS count ", integerColumnsFromDdl(" count BIGINT,"))).toEqual([]);
    });

    test("a bare `count` COLUMN read is still flagged", () => {
        expect(bareIntegerRefs(" count ", integerColumnsFromDdl(" count BIGINT,"))).toEqual(["count"]);
    });

    test("sum(turns) IS flagged - the aggregate reads an integer column and yields one", () => {
        // Only the FUNCTION NAME is exempt. `turns` inside the parens is still a
        // column read, and SUM over an integer column produces an integer type,
        // so the result reaches JS as a bigint exactly as a bare read would.
        expect(bareIntegerRefs(" sum(turns) AS t ", cols)).toEqual(["turns"]);
        expect(bareIntegerRefs(" CAST(sum(turns) AS DOUBLE) AS t ", cols)).toEqual([]);
        expect(bareIntegerRefs(" turns ", cols)).toEqual(["turns"]);
    });

    test("count(*) is NOT flagged - a known gap, documented in the guard", () => {
        // `*` is not an identifier, so no column is referenced and there is
        // nothing for a name-based guard to match. count(*) does return BIGINT,
        // so this class escapes; both current call sites wrap it in Number().
        expect(bareIntegerRefs(" count(*) AS n ", cols)).toEqual([]);
    });
});
