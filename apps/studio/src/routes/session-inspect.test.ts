import { describe, expect, test } from "bun:test";
import { costProgressThrough, estimateCharWeightedCost, rawBlockTextStyle } from "./session-inspect.tsx";

const tone = {
    bg: "#fce7f3",
    fg: "#9d174d",
    bar: "#ec4899",
    label: "plugins",
};

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

        expect(hovered.background).toBe(tone.bg);
        expect(hovered.borderBottom).toBe(`1px solid ${tone.bar}`);
        expect(mismatch.background).toBe("transparent");
        expect(mismatch.borderBottom).toBe("1px dotted var(--gold)");
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
                token_usage: {
                    seq: 1,
                    model: "gpt-5.5",
                    prompt_tokens: 100,
                    completion_tokens: 10,
                    cache_creation_input_tokens: null,
                    cache_read_input_tokens: 20,
                    fresh_input_tokens: 80,
                    estimated_tokens: 110,
                    estimated_input_cost_usd: 0.08,
                    estimated_output_cost_usd: 0.02,
                    estimated_cache_creation_cost_usd: 0,
                    estimated_cache_read_cost_usd: 0.01,
                    estimated_cost_usd: 0.11,
                    pricing_source: "test",
                    usage_source: "provider",
                    usage_quality: "provider_turn",
                },
            },
            { seq: 2, token_usage: null },
            {
                seq: 3,
                token_usage: {
                    seq: 3,
                    model: "gpt-5.5",
                    prompt_tokens: 200,
                    completion_tokens: 20,
                    cache_creation_input_tokens: 30,
                    cache_read_input_tokens: 40,
                    fresh_input_tokens: 130,
                    estimated_tokens: 220,
                    estimated_input_cost_usd: 0.13,
                    estimated_output_cost_usd: 0.04,
                    estimated_cache_creation_cost_usd: 0.03,
                    estimated_cache_read_cost_usd: 0.02,
                    estimated_cost_usd: 0.22,
                    pricing_source: "test",
                    usage_source: "provider",
                    usage_quality: "provider_turn",
                },
            },
        ], 2);

        expect(progress.exactTurns).toBe(1);
        expect(progress.estimatedTokens).toBe(110);
        expect(progress.totalCostUsd).toBe(0.11);
        expect(progress.cacheReadCostUsd).toBe(0.01);
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
});
