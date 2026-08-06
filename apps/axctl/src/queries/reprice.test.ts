import { describe, expect, it } from "bun:test";
import { MODEL_ALIASES, reprice, type RepriceUsage } from "./reprice.ts";

const usage: RepriceUsage = {
    prompt_tokens: 1_000_000,
    completion_tokens: 200_000,
    cache_read_tokens: 0,
    cache_create_tokens: 0,
    cost_usd: 5,
};

describe("MODEL_ALIASES", () => {
    it("resolves sonnet and haiku to full ids", () => {
        expect(MODEL_ALIASES.sonnet).toBe("claude-sonnet-4-6");
        expect(MODEL_ALIASES.haiku).toBe("claude-haiku-4-5-20251001");
    });
});

describe("reprice", () => {
    it("returns a positive cost cheaper than a frontier original for a known tier", () => {
        const catalog = new Map([
            ["claude-sonnet-4-6", {
                provider: "anthropic",
                inputPerMillionUsd: 3,
                outputPerMillionUsd: 15,
                cacheReadPerMillionUsd: 0.3,
                cacheCreationPerMillionUsd: 3.75,
                fastMultiplier: 1,
                pricingSource: "test",
            }],
        ]);
        const cost = reprice(usage, "claude-sonnet-4-6", catalog);
        expect(cost).toBeGreaterThan(0);
        expect(cost).toBeLessThan(20);
    });

    it("falls back to usage.cost_usd when the target model is unknown to the catalog", () => {
        const cost = reprice(usage, "unknown-model", new Map());
        expect(cost).toBe(5);
    });

    // `usage` is a dispatch's SUMMED token buckets, not one request's context.
    // A tiered catalog + >200k prompt tokens proves the long-context tier
    // stays suppressed (plan 003 fix round 1: the `aggregated: true` marking
    // at the `reprice` call site).
    it("never triggers the long-context tier on a dispatch's summed tokens above 200k", () => {
        const catalog = new Map([
            ["tiered-model", {
                provider: "test",
                inputPerMillionUsd: 1,
                outputPerMillionUsd: 10,
                cacheReadPerMillionUsd: null,
                cacheCreationPerMillionUsd: null,
                inputAbove200kPerMillionUsd: 2,
                outputAbove200kPerMillionUsd: 20,
                fastMultiplier: 1,
                pricingSource: "test",
            }],
        ]);
        const tieredUsage: RepriceUsage = {
            prompt_tokens: 300_000,
            completion_tokens: 0,
            cache_read_tokens: 0,
            cache_create_tokens: 0,
            cost_usd: 999,
        };
        const cost = reprice(tieredUsage, "tiered-model", catalog);
        // Base rate only: 300k @ $1/M = $0.30. The tiered rate ($2/M) would
        // give $0.60 - if this ever regresses to $0.60, the `aggregated:
        // true` marking was lost.
        expect(cost).toBeCloseTo(0.3, 6);
    });
});
