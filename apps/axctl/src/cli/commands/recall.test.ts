/**
 * Unit tests for recall command helpers.
 *
 * parseTypeFlag is not directly testable because fail() calls process.exit(2).
 * We export validateTypes as a pure function and test that instead, then test
 * the null-input branch of parseTypeFlag (which is safe - it never calls fail).
 */
import { describe, expect, test } from "bun:test";
import { matchPicker, validateTypes, parseTypeFlag } from "./recall.ts";

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

describe("matchPicker", () => {
    const PROJECTS = [
        { value: "-Users-necmttn-Projects-ax", uses: 120 },
        { value: "-Users-necmttn-Projects-axolotl", uses: 4 },
        { value: "-Users-necmttn-Projects-quera", uses: 30 },
    ];

    test("an exact value wins even when it is also a substring of others", () => {
        // "…-ax" is a substring of "…-axolotl", so substring matching alone
        // would report two candidates and prompt for a filter the user
        // already spelled out in full.
        expect(matchPicker("-Users-necmttn-Projects-ax", PROJECTS)).toEqual({
            kind: "exact",
            value: "-Users-necmttn-Projects-ax",
        });
    });

    test("a substring matching exactly one candidate auto-selects it", () => {
        expect(matchPicker("quera", PROJECTS)).toEqual({
            kind: "one",
            value: "-Users-necmttn-Projects-quera",
        });
    });

    test("a substring matching several candidates hands them all back", () => {
        const result = matchPicker("ax", PROJECTS);
        expect(result.kind).toBe("many");
        expect(result.kind === "many" ? result.candidates.map((c) => c.value) : []).toEqual([
            "-Users-necmttn-Projects-ax",
            "-Users-necmttn-Projects-axolotl",
        ]);
    });

    test("no match at all is distinct from an ambiguous match", () => {
        expect(matchPicker("pancakes", PROJECTS)).toEqual({ kind: "none" });
    });

    test("`?` and an empty value ask for the FULL list, not a match", () => {
        for (const ask of ["?", "", "  "]) {
            const result = matchPicker(ask, PROJECTS);
            expect(result.kind).toBe("many");
            expect(result.kind === "many" ? result.candidates.length : 0).toBe(3);
        }
    });

    test("the alias gives a second searchable form of each value", () => {
        // Projects are stored as mangled directory slugs; a user types the
        // readable name. Without the alias this is `none`.
        const pretty = (v: string) => v.split("-").slice(-1)[0] ?? v;
        expect(matchPicker("quera", PROJECTS, pretty)).toEqual({
            kind: "one",
            value: "-Users-necmttn-Projects-quera",
        });
    });

    test("matching is case-insensitive", () => {
        expect(matchPicker("QUERA", PROJECTS)).toEqual({
            kind: "one",
            value: "-Users-necmttn-Projects-quera",
        });
    });
});
