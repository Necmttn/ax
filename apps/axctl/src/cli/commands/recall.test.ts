/**
 * Unit tests for recall command helpers.
 *
 * parseTypeFlag is not directly testable because fail() calls process.exit(2).
 * We export validateTypes as a pure function and test that instead, then test
 * the null-input branch of parseTypeFlag (which is safe - it never calls fail).
 */
import { describe, expect, test } from "bun:test";
import { validateTypes, parseTypeFlag } from "./recall.ts";

describe("validateTypes", () => {
    test("accepts valid known categories", () => {
        expect(validateTypes(["code", "json"])).toEqual({ ok: true, types: ["code", "json"] });
    });

    test("rejects unknown categories", () => {
        expect(validateTypes(["code", "bogus"])).toEqual({ ok: false, invalid: ["bogus"] });
    });

    test("rejects multiple unknown categories", () => {
        const result = validateTypes(["code", "bogus", "nope"]);
        expect(result).toEqual({ ok: false, invalid: ["bogus", "nope"] });
    });

    test("accepts empty array", () => {
        expect(validateTypes([])).toEqual({ ok: true, types: [] });
    });

    test("accepts all valid categories", () => {
        const allValid = ["json", "code", "diff", "markdown", "yaml", "config",
            "log", "filelist", "text", "binary", "empty", "unknown"];
        const result = validateTypes(allValid);
        expect(result).toEqual({ ok: true, types: allValid });
    });
});

describe("parseTypeFlag", () => {
    test("returns null for null input", () => {
        expect(parseTypeFlag(null)).toBeNull();
    });

    test("returns null for empty string", () => {
        expect(parseTypeFlag("")).toBeNull();
    });
});
