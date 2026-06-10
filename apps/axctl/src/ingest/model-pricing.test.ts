import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import {
    builtInPricingCatalog,
    estimateCost,
    loadPricingCatalog as loadPricingCatalogEffect,
    mergePricingCatalogs,
    normalizeModelName,
    parseLiteLlmPricingCatalog,
    parseModelsDevPricingCatalog,
    pricingForModel,
} from "./model-pricing.ts";
import type { PricingCatalogLoadResult } from "./model-pricing.ts";

const BunFsLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);

// Forced-dependency edit: `loadPricingCatalog` is now Effect-native; run it
// against the REAL Bun-backed FileSystem + Path layers over the tmp cache dir.
const loadPricingCatalog = (
    dataDir: string,
    env?: Record<string, string | undefined>,
): Promise<PricingCatalogLoadResult> =>
    Effect.runPromise(loadPricingCatalogEffect(dataDir, env).pipe(Effect.provide(BunFsLayer)));

describe("model pricing", () => {
    it("parses LiteLLM per-token prices into per-million prices", () => {
        const catalog = parseLiteLlmPricingCatalog({
            "vendor/model-a": {
                litellm_provider: "vendor",
                input_cost_per_token: 0.000001,
                output_cost_per_token: 0.000003,
                cache_creation_input_token_cost: 0.00000125,
                cache_read_input_token_cost: 0.0000001,
                max_input_tokens: 128000,
            },
        });

        const pricing = catalog.get("vendor/model-a");
        expect(pricing).toMatchObject({
            provider: "vendor",
            inputPerMillionUsd: 1,
            outputPerMillionUsd: 3,
            cacheCreationPerMillionUsd: 1.25,
            contextWindow: 128000,
            pricingSource: "litellm",
        });
        expect(pricing?.cacheReadPerMillionUsd).toBeCloseTo(0.1);
    });

    it("defaults missing cache write/read prices like ccusage", () => {
        const catalog = parseLiteLlmPricingCatalog({
            "vendor/model-b": {
                input_cost_per_token: 0.000002,
                output_cost_per_token: 0.000008,
            },
        });

        expect(catalog.get("vendor/model-b")).toMatchObject({
            inputPerMillionUsd: 2,
            outputPerMillionUsd: 8,
            cacheCreationPerMillionUsd: 2.5,
            cacheReadPerMillionUsd: 0.2,
        });
    });

    it("parses models.dev per-million prices", () => {
        const catalog = parseModelsDevPricingCatalog({
            openai: {
                models: {
                    "gpt-example": {
                        id: "gpt-example",
                        cost: { input: 1.25, output: 10, cache_read: 0.125, cache_write: 1.25 },
                        limit: { context: 200000 },
                    },
                },
            },
        });

        expect(catalog.get("gpt-example")).toMatchObject({
            provider: "openai",
            inputPerMillionUsd: 1.25,
            outputPerMillionUsd: 10,
            cacheCreationPerMillionUsd: 1.25,
            cacheReadPerMillionUsd: 0.125,
            contextWindow: 200000,
            pricingSource: "models.dev",
        });
    });

    it("lets built-in aliases override fetched catalogs", () => {
        const fetched = parseLiteLlmPricingCatalog({
            "gpt-5.5": {
                input_cost_per_token: 0.000001,
                output_cost_per_token: 0.000002,
            },
        });
        const merged = mergePricingCatalogs(fetched, builtInPricingCatalog());

        expect(pricingForModel("gpt-5.5", merged)).toMatchObject({
            inputPerMillionUsd: 5,
            outputPerMillionUsd: 30,
            fastMultiplier: 2.5,
        });
    });

    it("does not normalize provider names into model IDs", () => {
        expect(normalizeModelName("openai")).toBeNull();
        expect(normalizeModelName("anthropic")).toBeNull();
        expect(normalizeModelName("gpt-5.5")).toBe("gpt-5.5");
    });

    it("uses above-200k tier fields when present", () => {
        const catalog = new Map([
            ["tiered-model", {
                provider: "test",
                inputPerMillionUsd: 1,
                outputPerMillionUsd: 10,
                cacheCreationPerMillionUsd: null,
                cacheReadPerMillionUsd: null,
                inputAbove200kPerMillionUsd: 2,
                outputAbove200kPerMillionUsd: 20,
                fastMultiplier: 1,
                pricingSource: "test",
            }],
        ]);

        const cost = estimateCost({
            modelKey: "tiered-model",
            promptTokens: 300000,
            completionTokens: 250000,
            cacheCreationInputTokens: null,
            cacheReadInputTokens: null,
            estimatedTokens: 550000,
            pricingCatalog: catalog,
        });

        expect(cost.inputUsd).toBe(0.4);
        expect(cost.outputUsd).toBe(3);
        expect(cost.totalUsd).toBe(3.4);
    });

    it("prices fresh input separately from cache reads", () => {
        const cost = estimateCost({
            modelKey: "gpt-5",
            promptTokens: 1000,
            completionTokens: 100,
            cacheCreationInputTokens: null,
            cacheReadInputTokens: 800,
            estimatedTokens: 1100,
        });

        expect(cost.inputUsd).toBeCloseTo(0.00025);
        expect(cost.cacheReadUsd).toBeCloseTo(0.0001);
        expect(cost.outputUsd).toBeCloseTo(0.001);
    });

    it("prices claude-fable-5 turns instead of leaving them null", () => {
        const cost = estimateCost({
            modelKey: "claude-fable-5",
            promptTokens: 1_000_000,
            completionTokens: 100_000,
            cacheCreationInputTokens: 200_000,
            cacheReadInputTokens: 700_000,
            estimatedTokens: 1_100_000,
        });

        expect(cost.inputUsd).toBeCloseTo(1); // 100k fresh @ $10/M
        expect(cost.outputUsd).toBeCloseTo(5); // 100k @ $50/M
        expect(cost.cacheCreationUsd).toBeCloseTo(2.5); // 200k @ $12.5/M
        expect(cost.cacheReadUsd).toBeCloseTo(0.7); // 700k @ $1/M
        expect(cost.pricingSource).not.toBeNull();
    });

    it("falls back fable and dated haiku ids to their base entries", () => {
        const catalog = builtInPricingCatalog();

        expect(pricingForModel("claude-fable-5[1m]", catalog)).toMatchObject({
            inputPerMillionUsd: 10,
            outputPerMillionUsd: 50,
        });
        expect(pricingForModel("claude-haiku-4-5-20251001", catalog)).toMatchObject({
            inputPerMillionUsd: 1,
            outputPerMillionUsd: 5,
        });
    });

    it("falls back gpt-5 point releases to gpt-5 pricing when no exact row exists", () => {
        const catalog = new Map([["gpt-5", builtInPricingCatalog().get("gpt-5")!]]);

        expect(pricingForModel("gpt-5.9", catalog)).toMatchObject({
            inputPerMillionUsd: 1.25,
            outputPerMillionUsd: 10,
        });
    });

    it("loads cached pricing locally when refresh is not requested", async () => {
        const root = mkdtempSync(join(tmpdir(), "ax-pricing-"));
        const cache = join(root, "pricing");
        mkdirSync(cache, { recursive: true });
        writeFileSync(join(cache, "litellm-model-prices.json"), JSON.stringify({
            "cached/model": {
                litellm_provider: "cached",
                input_cost_per_token: 0.000001,
                output_cost_per_token: 0.000002,
            },
        }));
        writeFileSync(join(cache, "models-dev-api.json"), JSON.stringify({}));

        const result = await loadPricingCatalog(root, { AX_PRICING_OFFLINE: "1" });

        expect(result.litellmSource).toBe("cache");
        expect(result.catalog.get("cached/model")).toMatchObject({
            provider: "cached",
            inputPerMillionUsd: 1,
            outputPerMillionUsd: 2,
        });
    });
});
