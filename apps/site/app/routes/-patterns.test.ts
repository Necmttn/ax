import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("./patterns.tsx", import.meta.url)).text();
const headerSrc = await Bun.file(new URL("../components/landing-sections/site-header.tsx", import.meta.url)).text();

describe("patterns route", () => {
    test("uses the validated app/lib fetch layer", () => {
        expect(src).toContain("fetchCommunityPatterns");
        expect(src).toContain("groupPatternsByCategory");
    });

    test("renders category counts, relationship anchors, and author profile links", () => {
        expect(src).toContain("PatternCategorySection");
        expect(src).toContain("patternAnchorId");
        expect(src).toContain("relLabel");
        expect(src).toContain('to="/u/$login"');
    });

    test("empty state is a contribution CTA", () => {
        expect(src).toContain("ax contribute pattern");
    });

    test("top navigation exposes the existing patterns route", () => {
        expect(headerSrc).toContain('to="/patterns"');
        expect(headerSrc).toContain("Patterns");
    });
});
