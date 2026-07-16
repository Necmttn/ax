import { describe, expect, test } from "bun:test";
import { nonNegativeNumberEnv } from "./env-number.ts";

describe("nonNegativeNumberEnv", () => {
    test("unset -> fallback", () => {
        expect(nonNegativeNumberEnv(undefined, 300)).toBe(300);
    });

    // #697 finding 1: a blank value must read as UNSET, not as an explicit
    // "0" - `Number("")` and `Number("   ")` are both `0`, which is finite
    // and `>= 0`, so without the trim+empty-check this silently disables
    // whatever the caller's "0" means (stale-warning off, no derive reserve).
    test("empty string -> fallback", () => {
        expect(nonNegativeNumberEnv("", 300)).toBe(300);
    });

    test("whitespace-only -> fallback", () => {
        expect(nonNegativeNumberEnv("   ", 300)).toBe(300);
    });

    test("explicit \"0\" is honored, not treated as unset", () => {
        expect(nonNegativeNumberEnv("0", 300)).toBe(0);
    });

    test("a valid value overrides the fallback", () => {
        expect(nonNegativeNumberEnv("42", 300)).toBe(42);
    });

    test("unparseable garbage -> fallback", () => {
        expect(nonNegativeNumberEnv("nonsense", 300)).toBe(300);
    });

    test("negative -> fallback (this parser is non-negative only)", () => {
        expect(nonNegativeNumberEnv("-5", 300)).toBe(300);
    });
});
