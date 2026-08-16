import { describe, expect, test } from "bun:test";
import { isUncastTimestampArithmetic, stripComments } from "./check-timestamp-cast.ts";

describe("isUncastTimestampArithmetic", () => {
    test("flags the lowercase literal-interval form (the spelling every site used)", () => {
        expect(
            isUncastTimestampArithmetic(
                "`SELECT count(*) FROM t WHERE observed_at < current_timestamp - INTERVAL '30 days'`",
            ),
        ).toBe(true);
    });

    test("flags the uppercase spelling too - SQL keywords are case-insensitive", () => {
        expect(isUncastTimestampArithmetic("WHERE ts < CURRENT_TIMESTAMP - INTERVAL '1 day'")).toBe(true);
    });

    test("flags the parameterized form", () => {
        expect(
            isUncastTimestampArithmetic(`"WHERE ts >= current_timestamp - (? * INTERVAL '1 day')"`),
        ).toBe(true);
    });

    test("flags CURRENT_TIMESTAMP on the right of the operator", () => {
        expect(isUncastTimestampArithmetic("SELECT ts - current_timestamp AS delta FROM turn")).toBe(true);
    });

    test("accepts the cast literal-interval form", () => {
        expect(
            isUncastTimestampArithmetic(
                "WHERE observed_at < CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - INTERVAL '30 days'",
            ),
        ).toBe(false);
    });

    test("accepts the cast parameterized form", () => {
        expect(
            isUncastTimestampArithmetic(
                "WHERE ts >= CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - (CAST(? AS INTEGER) * INTERVAL '1 day')",
            ),
        ).toBe(false);
    });

    test("accepts DEFAULT CURRENT_TIMESTAMP in DDL - an assignment, not arithmetic", () => {
        expect(isUncastTimestampArithmetic("    ts TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP")).toBe(false);
    });

    test("accepts a bare CURRENT_TIMESTAMP bound as an INSERT value", () => {
        expect(isUncastTimestampArithmetic("`(${placeholders}, CURRENT_TIMESTAMP)`")).toBe(false);
    });

    test("does not flag prose that merely discusses the banned shape", () => {
        // Both comment styles, including the SQL `--` marker that would
        // otherwise look like the operator in the right-hand rule.
        expect(isUncastTimestampArithmetic("-- CURRENT_TIMESTAMP - INTERVAL needs ICU")).toBe(false);
        expect(isUncastTimestampArithmetic("// current_timestamp - INTERVAL '1 day' is banned")).toBe(false);
        expect(isUncastTimestampArithmetic(" * `CURRENT_TIMESTAMP` is a TIMESTAMPTZ")).toBe(false);
    });
});

describe("stripComments", () => {
    test("drops the commented tail but keeps preceding code", () => {
        expect(stripComments("SELECT 1 -- current_timestamp - INTERVAL")).toBe("SELECT 1 ");
    });

    test("drops whole jsdoc continuation lines", () => {
        expect(stripComments(" * current_timestamp - INTERVAL")).toBe("");
    });
});
