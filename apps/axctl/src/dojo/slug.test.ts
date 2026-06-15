// apps/axctl/src/dojo/slug.test.ts
import { describe, expect, test } from "bun:test";
import { shortHash, slugify } from "./slug.ts";

describe("slugify", () => {
    test("kebabs, lowercases, strips punctuation, collapses dashes", () => {
        expect(slugify("Dojo: Fix the Briefs Scanner!")).toBe("dojo-fix-the-briefs-scanner");
    });
    test("truncates to 50 chars without trailing dash", () => {
        const s = slugify("a".repeat(80));
        expect(s.length).toBeLessThanOrEqual(50);
        expect(s.endsWith("-")).toBe(false);
    });
    test("empty / punctuation-only -> 'draft'", () => {
        expect(slugify("")).toBe("draft");
        expect(slugify("!!!")).toBe("draft");
    });
});

describe("shortHash", () => {
    test("deterministic 8-hex for the same input", () => {
        expect(shortHash("hello")).toBe(shortHash("hello"));
        expect(shortHash("hello")).toMatch(/^[0-9a-f]{8}$/);
    });
    test("different inputs differ", () => {
        expect(shortHash("a")).not.toBe(shortHash("b"));
    });
});
