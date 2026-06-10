import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient } from "@ax/lib/db";
import {
    ESTIMATED_PRICING_PREFIX,
    fillEstimatedCost,
    isEstimatedPricingSource,
    loadPricingCatalogForModels,
    type UsageCostFields,
} from "./cost-estimate.ts";
import { builtInPricingCatalog, type ModelPricing } from "../ingest/model-pricing.ts";

const usage = (over: Partial<UsageCostFields> = {}): UsageCostFields => ({
    model: "claude-haiku-4-5-20251001",
    prompt_tokens: null,
    completion_tokens: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    estimated_tokens: 1_000_000,
    estimated_cost_usd: null,
    pricing_source: null,
    ...over,
});

const haikuPricing: ModelPricing = {
    provider: "anthropic",
    inputPerMillionUsd: 1,
    outputPerMillionUsd: 5,
    cacheCreationPerMillionUsd: 1.25,
    cacheReadPerMillionUsd: 0.1,
    fastMultiplier: 1,
    pricingSource: "litellm",
};

const catalog = new Map<string, ModelPricing>([
    ["claude-haiku-4-5-20251001", haikuPricing],
]);

describe("fillEstimatedCost", () => {
    test("keeps a stored cost untouched (estimated=false, source preserved)", () => {
        const out = fillEstimatedCost(
            usage({ estimated_cost_usd: 50.5, pricing_source: "built_in_catalog_2026-05-29" }),
            catalog,
        );
        expect(out).toEqual({
            estimatedCostUsd: 50.5,
            pricingSource: "built_in_catalog_2026-05-29",
            estimated: false,
        });
    });

    test("byte-estimate row (no prompt/completion split) prices estimated_tokens at the input rate", () => {
        const out = fillEstimatedCost(usage(), catalog);
        // 1M tokens × $1/M input = $1.00 (output unknown → not priced)
        expect(out.estimatedCostUsd).toBeCloseTo(1.0, 8);
        expect(out.pricingSource).toBe(`${ESTIMATED_PRICING_PREFIX}litellm`);
        expect(out.estimated).toBe(true);
    });

    test("full token split prices input/output/cache components", () => {
        const out = fillEstimatedCost(
            usage({
                prompt_tokens: 1_000_000,
                completion_tokens: 200_000,
                cache_read_input_tokens: 500_000,
            }),
            catalog,
        );
        // fresh input 500k×$1/M + output 200k×$5/M + cache_read 500k×$0.1/M
        expect(out.estimatedCostUsd).toBeCloseTo(0.5 + 1.0 + 0.05, 8);
        expect(out.estimated).toBe(true);
    });

    test("unknown model stays null (unknown ≠ $0)", () => {
        const out = fillEstimatedCost(usage({ model: "mystery-model-9000" }), catalog);
        expect(out.estimatedCostUsd).toBeNull();
        expect(out.estimated).toBe(false);
    });

    test("<synthetic> model stays null", () => {
        const out = fillEstimatedCost(usage({ model: "<synthetic>" }), catalog);
        expect(out.estimatedCostUsd).toBeNull();
    });

    test("claude-opus variants fall back to the claude-opus-4 family pricing", () => {
        const out = fillEstimatedCost(
            usage({ model: "claude-opus-4-99", estimated_tokens: 1_000_000 }),
            builtInPricingCatalog(),
        );
        // built-in claude-opus-4 input = $15/M
        expect(out.estimatedCostUsd).toBeCloseTo(15, 6);
        expect(isEstimatedPricingSource(out.pricingSource)).toBe(true);
    });
});

describe("isEstimatedPricingSource", () => {
    test("true only for estimated: prefixed sources", () => {
        expect(isEstimatedPricingSource("estimated:litellm")).toBe(true);
        expect(isEstimatedPricingSource("litellm")).toBe(false);
        expect(isEstimatedPricingSource(null)).toBe(false);
        expect(isEstimatedPricingSource(undefined)).toBe(false);
    });
});

describe("loadPricingCatalogForModels", () => {
    const db = (rows: Array<Record<string, unknown>>, capture?: { sql?: string }) =>
        Layer.succeed(SurrealClient, {
            query: <T>(sql: string) => {
                if (capture) capture.sql = sql;
                return Effect.succeed([rows] as unknown as T);
            },
        } as never);

    test("DB rows override the built-in catalog; built-ins remain as fallback", async () => {
        const rows = [{
            name: "claude-opus-4-8",
            provider: "anthropic",
            input_per_million_usd: 99,
            output_per_million_usd: 199,
            pricing_source: "litellm",
        }];
        const out = await Effect.runPromise(
            loadPricingCatalogForModels(["claude-opus-4-8"]).pipe(Effect.provide(db(rows))),
        );
        expect(out.get("claude-opus-4-8")?.inputPerMillionUsd).toBe(99);
        // built-in fallback entries still present
        expect(out.get("claude-opus-4")?.inputPerMillionUsd).toBe(15);
    });

    test("queries by direct agent_model record ids incl. family fallback keys", async () => {
        const capture: { sql?: string } = {};
        await Effect.runPromise(
            loadPricingCatalogForModels(["Claude-Haiku-4-5-20251001", null, "<synthetic>"]).pipe(
                Effect.provide(db([], capture)),
            ),
        );
        expect(capture.sql).toContain("agent_model:`claude-haiku-4-5-20251001`");
        expect(capture.sql).toContain("agent_model:`claude-opus-4`");
        expect(capture.sql).not.toContain("synthetic");
    });
});
