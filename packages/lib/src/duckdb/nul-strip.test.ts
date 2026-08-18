/**
 * The pure half of the writer-side NUL guard. No database: this file pins the
 * decision (strip, not escape; count values, not bytes) and the fast path.
 */
import { describe, expect, test } from "bun:test";
import { NUL, hasNul, stripNul, stripNulParams } from "./nul-strip.ts";
import type { DuckDbParam } from "./types.ts";

describe("nul-strip", () => {
    test("NUL is exactly U+0000, and nothing that merely looks like it", () => {
        expect(NUL).toHaveLength(1);
        expect(NUL.charCodeAt(0)).toBe(0);
        // The six-character escape a JSON transcript actually carries is TEXT,
        // and must survive untouched - it is not a NUL byte.
        expect(hasNul("\\u0000")).toBe(false);
        expect(stripNul("\\u0000")).toBe("\\u0000");
    });

    test("strips every NUL and leaves every other control character alone", () => {
        expect(stripNul(`a${NUL}b${NUL}${NUL}c`)).toBe("abc");
        expect(stripNul(`${NUL}`)).toBe("");
        expect(stripNul("tab\there\nnewline\r")).toBe("tab\there\nnewline\r");
    });

    test("a clean parameter list is returned by REFERENCE, uncopied", () => {
        const params: ReadonlyArray<DuckDbParam> = ["a", 1n, null, new Date(0), true];
        const result = stripNulParams(params);
        expect(result.values).toBe(0);
        expect(result.params).toBe(params);
    });

    test("counts VALUES scrubbed, not NUL bytes, and copies without mutating the input", () => {
        const dirty = `x${NUL}y${NUL}z`;
        const params: ReadonlyArray<DuckDbParam> = ["clean", dirty, 7n, `${NUL}lead`, null];
        const result = stripNulParams(params);

        // Two values carried NULs; one of them carried two.
        expect(result.values).toBe(2);
        expect(result.params).not.toBe(params);
        expect(result.params).toEqual(["clean", "xyz", 7n, "lead", null]);
        // The caller's array is untouched - a writer may still need to report it.
        expect(params[1]).toBe(dirty);
    });

    test("an empty list is a no-op", () => {
        const result = stripNulParams([]);
        expect(result.values).toBe(0);
        expect(result.params).toEqual([]);
    });
});
