import { describe, expect, test } from "bun:test";
import { AX_ATTRIBUTION_MD, AX_ATTRIBUTION_TEXT, AX_URL, withAxAttribution } from "./attribution.ts";

describe("attribution constants", () => {
    test("text + markdown forms both carry the canonical url", () => {
        expect(AX_ATTRIBUTION_TEXT).toContain(AX_URL);
        expect(AX_ATTRIBUTION_MD).toContain(AX_URL);
        expect(AX_ATTRIBUTION_MD).toBe(`_Generated with [ax](${AX_URL})._`);
    });
});

describe("withAxAttribution", () => {
    test("appends a horizontal rule + attribution line", () => {
        const out = withAxAttribution("# Report\n\nbody");
        expect(out).toBe(`# Report\n\nbody\n\n---\n\n${AX_ATTRIBUTION_MD}\n`);
    });

    test("normalizes trailing whitespace before the footer", () => {
        const out = withAxAttribution("body\n\n\n");
        expect(out).toBe(`body\n\n---\n\n${AX_ATTRIBUTION_MD}\n`);
    });

    test("is idempotent - re-applying does not stack footers", () => {
        const once = withAxAttribution("body");
        const twice = withAxAttribution(once);
        expect(twice).toBe(once);
    });
});
