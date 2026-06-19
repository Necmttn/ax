import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    buildCostProgressIndex,
    CostRail,
    costProgressThrough,
    estimateCharWeightedCost,
    inspectTurnWindowEnd,
    mergedInspectTurnWindow,
    rawBlockTextStyle,
    remainingInspectTurns,
} from "./session-inspect.tsx";

const tone = {
    bg: "#fce7f3",
    fg: "#9d174d",
    bar: "#ec4899",
    label: "plugins",
};

const usage = (
    seq: number,
    estimatedTokens: number,
    costUsd: number,
    freshInputCostUsd: number,
    outputCostUsd: number,
) => ({
    seq,
    model: "gpt-5.5",
    prompt_tokens: estimatedTokens - 10,
    completion_tokens: 10,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: 20,
    fresh_input_tokens: estimatedTokens - 30,
    estimated_tokens: estimatedTokens,
    estimated_input_cost_usd: freshInputCostUsd,
    estimated_output_cost_usd: outputCostUsd,
    estimated_cache_creation_cost_usd: 0,
    estimated_cache_read_cost_usd: costUsd - freshInputCostUsd - outputCostUsd,
    estimated_cost_usd: costUsd,
    pricing_source: "test",
    usage_source: "provider",
    usage_quality: "provider_turn",
});

describe("rawBlockTextStyle", () => {
    test("does not flood-fill selected transcript blocks", () => {
        const style = rawBlockTextStyle({ tone, active: true, hovered: false, mismatch: false });

        expect(style.background).toBe("transparent");
        expect(style.outline).toBe("none");
        expect(style.borderBottom).toBe(`1px solid ${tone.bar}`);
        expect(style.boxShadow).toBe(`inset 0 -2px 0 ${tone.bar}`);
    });

    test("keeps hover and mismatch cues visible", () => {
        const hovered = rawBlockTextStyle({ tone, active: false, hovered: true, mismatch: false });
        const mismatch = rawBlockTextStyle({ tone, active: false, hovered: false, mismatch: true });

        expect(hovered.background).toBe(`color-mix(in srgb, ${tone.bar} 18%, var(--term-bg))`);
        expect(hovered.borderBottom).toBe(`1px solid ${tone.bar}`);
        expect(mismatch.background).toBe("transparent");
        expect(mismatch.borderBottom).toBe("1px dotted var(--gold)");
    });

    test("uses dark-surface foreground for emphasized transcript blocks", () => {
        const active = rawBlockTextStyle({ tone, active: true, hovered: false, mismatch: false });

        expect(active.color).toBe(`color-mix(in srgb, ${tone.bar} 28%, var(--term-fg))`);
    });
});

describe("estimateCharWeightedCost", () => {
    test("allocates a session cost by character share", () => {
        expect(estimateCharWeightedCost(2, 1000, 250)).toBe(0.5);
    });

    test("returns null when attribution inputs are missing", () => {
        expect(estimateCharWeightedCost(null, 1000, 250)).toBeNull();
        expect(estimateCharWeightedCost(2, 0, 250)).toBeNull();
        expect(estimateCharWeightedCost(2, 1000, 0)).toBeNull();
    });
});

describe("costProgressThrough", () => {
    test("sums exact provider usage through the current visible turn", () => {
        const progress = costProgressThrough([
            {
                seq: 1,
                token_usage: usage(1, 110, 0.11, 0.08, 0.02),
            },
            { seq: 2, token_usage: null },
            {
                seq: 3,
                token_usage: usage(3, 220, 0.22, 0.13, 0.04),
            },
        ], 2);

        expect(progress.exactTurns).toBe(1);
        expect(progress.estimatedTokens).toBe(110);
        expect(progress.totalCostUsd).toBe(0.11);
        expect(progress.cacheReadCostUsd).toBeCloseTo(0.01);
    });

    test("returns empty progress before any turn is visible", () => {
        expect(costProgressThrough([], null)).toEqual({
            seq: null,
            exactTurns: 0,
            estimatedTokens: 0,
            totalCostUsd: 0,
            freshInputCostUsd: 0,
            cacheWriteCostUsd: 0,
            cacheReadCostUsd: 0,
            outputCostUsd: 0,
        });
    });

    test("buildCostProgressIndex precomputes cumulative rows for fast scroll lookups", () => {
        const index = buildCostProgressIndex([
            { seq: 1, token_usage: usage(1, 100, 0.1, 0.07, 0.02) },
            { seq: 2, token_usage: null },
            { seq: 5, token_usage: usage(5, 50, 0.05, 0.03, 0.01) },
        ]);

        expect(index.exactTurnCount).toBe(2);
        expect(index.through(2)).toMatchObject({
            seq: 2,
            exactTurns: 1,
            estimatedTokens: 100,
            totalCostUsd: 0.1,
        });
        expect(index.through(4)).toMatchObject({
            seq: 4,
            exactTurns: 1,
            estimatedTokens: 100,
            totalCostUsd: 0.1,
        });
        expect(index.through(5)).toMatchObject({
            seq: 5,
            exactTurns: 2,
            estimatedTokens: 150,
        });
        expect(index.through(5).totalCostUsd).toBeCloseTo(0.15);
    });
});

describe("inspect pagination", () => {
    test("uses the server turn window as the next offset", () => {
        const payload = {
            total_turns: 260,
            turn_window: { offset: 0, limit: 100 },
            turns: Array.from({ length: 84 }, (_, seq) => ({ seq, token_usage: null })),
        };

        expect(inspectTurnWindowEnd(payload)).toBe(100);
        expect(remainingInspectTurns(payload)).toBe(160);
    });

    test("merges pages by window bounds, not rendered turn count", () => {
        const prev = {
            turn_window: { offset: 0, limit: 100 },
            turns: Array.from({ length: 84 }, (_, seq) => ({ seq, token_usage: null })),
        };
        const page = {
            turn_window: { offset: 100, limit: 100 },
            turns: Array.from({ length: 91 }, (_, index) => ({ seq: 100 + index, token_usage: null })),
        };

        expect(mergedInspectTurnWindow(prev, page)).toEqual({ offset: 0, limit: 200 });
    });
});

describe("CostRail", () => {
    test("renders changing metrics in tabular fixed-width slots", () => {
        const data = {
            total_turns: 2,
            token_usage: {
                model: "gpt-5.5",
                prompt_tokens: 100,
                completion_tokens: 10,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: 20,
                estimated_tokens: 110,
                estimated_input_cost_usd: 0.07,
                estimated_output_cost_usd: 0.02,
                estimated_cache_creation_cost_usd: 0,
                estimated_cache_read_cost_usd: 0.01,
                estimated_cost_usd: 0.1,
                pricing_source: "test",
            },
            turns: [
                { seq: 1, token_usage: usage(1, 110, 0.1, 0.07, 0.02) },
                { seq: 2, token_usage: null },
            ],
        };

        const html = renderToStaticMarkup(createElement(CostRail, { data, currentSeq: 1 }));

        expect(html).toContain("cost so far");
        expect(html).toContain("$0.10");
        expect(html).toContain("font-variant-numeric:tabular-nums");
        expect(html).toContain("min-width:8ch");
    });
});
