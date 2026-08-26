import { describe, expect, test } from "bun:test";
import { deriveTastePatterns, parseConfidence, slugify } from "./taste.ts";
import type { ProposalRow } from "./queries.ts";

const row = (over: Partial<ProposalRow>): ProposalRow => ({
    form: "guidance",
    title: "Stop edit loops early",
    hypothesis: "3+ edits to same file means requirements drift",
    confidence: "high",
    frequency: 12,
    updated_at: "2026-06-10T08:00:00Z",
    created_at: "2026-06-01T08:00:00Z",
    ...over,
});

describe("parseConfidence", () => {
    test("maps labels", () => {
        expect(parseConfidence("high")).toBe(0.9);
        expect(parseConfidence("medium")).toBe(0.7);
        expect(parseConfidence("low")).toBe(0.5);
    });
    test("numeric strings pass through clamped to [0,1]", () => {
        expect(parseConfidence("0.85")).toBe(0.85);
        expect(parseConfidence("7")).toBe(1);
    });
    test("garbage -> 0.5", () => {
        expect(parseConfidence("???")).toBe(0.5);
    });
});

describe("slugify", () => {
    test("kebab-cases titles", () => {
        expect(slugify("Stop edit loops early!")).toBe("stop-edit-loops-early");
    });
});

describe("deriveTastePatterns", () => {
    test("maps a proposal to an evidence-grounded pattern", () => {
        const [p] = deriveTastePatterns([row({})]);
        expect(p).toEqual({
            category: "workflow",
            name: "stop-edit-loops-early",
            summary: "3+ edits to same file means requirements drift",
            evidence: {
                sessions: 12,
                confidence: 0.9,
                last_reinforced: "2026-06-10",
                trend: "stable",
            },
        });
    });

    test("falls back to created_at when updated_at missing", () => {
        const [p] = deriveTastePatterns([row({ updated_at: null })]);
        expect(p!.evidence.last_reinforced).toBe("2026-06-01");
    });

    test("drops rows without hypothesis (no derived pattern without evidence/summary)", () => {
        expect(deriveTastePatterns([row({ hypothesis: "" })])).toHaveLength(0);
    });

    test("dedupes by derived name, keeping the higher-frequency row", () => {
        const out = deriveTastePatterns([
            row({ frequency: 3 }),
            row({ frequency: 9 }),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0]!.evidence.sessions).toBe(9);
    });
});
