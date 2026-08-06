import { describe, expect, it } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import {
    builtInPricingCatalog,
    estimateCost,
    isSyntheticModel,
    loadPricingCatalog as loadPricingCatalogEffect,
    mergePricingCatalogs,
    normalizeModelName,
    parseLiteLlmPricingCatalog,
    parseModelsDevPricingCatalog,
    PRICING_CACHE_TTL_MS,
    pricingCacheTtlMs,
    pricingForModel,
    SYNTHETIC_MODEL_SENTINEL,
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

    it("prices claude-sonnet-5 and every GPT-5.6 tier from the built-in catalog", () => {
        const catalog = builtInPricingCatalog();

        expect(pricingForModel("claude-sonnet-5", catalog)).toMatchObject({
            inputPerMillionUsd: 3,
            outputPerMillionUsd: 15,
            cacheCreationPerMillionUsd: 3.75,
            cacheReadPerMillionUsd: 0.3,
        });
        // Rates below are models.dev verbatim, incl. each tier's >200k rates.
        // Built-in entries OVERRIDE the remote catalogs, so a wrong number here
        // silently wins over a correct upstream one (#751).
        expect(pricingForModel("gpt-5.6-sol", catalog)).toMatchObject({
            inputPerMillionUsd: 5,
            outputPerMillionUsd: 30,
            cacheCreationPerMillionUsd: 6.25,
            cacheReadPerMillionUsd: 0.5,
            inputAbove200kPerMillionUsd: 10,
            outputAbove200kPerMillionUsd: 45,
        });
        expect(pricingForModel("gpt-5.6-terra", catalog)).toMatchObject({
            inputPerMillionUsd: 2,
            outputPerMillionUsd: 12,
            cacheCreationPerMillionUsd: 2.5,
            cacheReadPerMillionUsd: 0.2,
            inputAbove200kPerMillionUsd: 4,
            outputAbove200kPerMillionUsd: 18,
        });
        expect(pricingForModel("gpt-5.6-luna", catalog)).toMatchObject({
            inputPerMillionUsd: 0.2,
            outputPerMillionUsd: 1.2,
            cacheCreationPerMillionUsd: 0.25,
            cacheReadPerMillionUsd: 0.02,
            inputAbove200kPerMillionUsd: 0.4,
            outputAbove200kPerMillionUsd: 1.8,
        });
    });

    it("bills at base rates by default and at the fast tier only when asked", () => {
        const catalog = builtInPricingCatalog();
        const usage = {
            modelKey: "gpt-5.5",
            promptTokens: 1_000_000,
            completionTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            estimatedTokens: 1_000_000,
            pricingCatalog: catalog,
        };

        // 1M fresh input tokens at $5/M.
        expect(estimateCost(usage).totalUsd).toBeCloseTo(5, 6);
        // Priority tier is 2.5x - opt-in only.
        expect(estimateCost({ ...usage, fastTier: true }).totalUsd).toBeCloseTo(12.5, 6);
    });

    it("prices claude-opus-5 and its dated variants from the built-in catalog", () => {
        const catalog = builtInPricingCatalog();

        for (const key of ["claude-opus-5", "claude-opus-5-20260401"]) {
            expect(pricingForModel(key, catalog)).toMatchObject({
                provider: "anthropic",
                inputPerMillionUsd: 5,
                outputPerMillionUsd: 25,
                cacheCreationPerMillionUsd: 6.25,
                cacheReadPerMillionUsd: 0.5,
            });
        }
        // opus-5 must NOT fall through to the opus-4 rule (15/75).
        expect(pricingForModel("claude-opus-5", catalog)?.outputPerMillionUsd).not.toBe(75);
    });

    it("routes dated GPT-5.6 tier variants to their own tier, not the gpt-5.5 approximation", () => {
        const catalog = builtInPricingCatalog();

        expect(pricingForModel("gpt-5.6-terra-2026-07-09", catalog)).toMatchObject({
            inputPerMillionUsd: 2,
            outputPerMillionUsd: 12,
        });
        expect(pricingForModel("gpt-5.6-luna-2026-07-09", catalog)).toMatchObject({
            inputPerMillionUsd: 0.2,
            outputPerMillionUsd: 1.2,
        });
        expect(pricingForModel("gpt-5.6-sol-2026-07-09", catalog)).toMatchObject({
            inputPerMillionUsd: 5,
            outputPerMillionUsd: 30,
        });
    });

    it("does not normalize provider names into model IDs", () => {
        expect(normalizeModelName("openai")).toBeNull();
        expect(normalizeModelName("anthropic")).toBeNull();
        expect(normalizeModelName("gpt-5.5")).toBe("gpt-5.5");
    });

    it("treats <synthetic> as a non-model everywhere", () => {
        expect(isSyntheticModel("<synthetic>")).toBe(true);
        expect(isSyntheticModel(" <synthetic> ")).toBe(true);
        expect(isSyntheticModel("claude-opus-5")).toBe(false);
        expect(isSyntheticModel(null)).toBe(false);
        expect(normalizeModelName(SYNTHETIC_MODEL_SENTINEL)).toBeNull();
    });

    it("uses above-200k tier fields when present, flat across the whole request", () => {
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

        // promptTokens (300k) exceeds the 200k threshold, so the WHOLE request
        // - input AND output - bills flat at the tier rate: 300k @ $2/M input,
        // 250k @ $20/M output. (Old marginal maths gave 0.4/3/3.4 - wrong per
        // plan 003.)
        expect(cost.inputUsd).toBe(0.6);
        expect(cost.outputUsd).toBe(5);
        expect(cost.totalUsd).toBe(5.6);
    });

    it("applies the long-context tier flat, per request, and only above the threshold", () => {
        const catalog = builtInPricingCatalog();
        const base = {
            modelKey: "gpt-5.6-terra",
            completionTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            pricingCatalog: catalog,
        };

        // Under the threshold: base rate ($2/M).
        expect(estimateCost({ ...base, promptTokens: 100_000, estimatedTokens: 100_000 }).totalUsd)
            .toBeCloseTo(0.2, 6);
        // Over the threshold: the WHOLE request at the tier rate ($4/M) - not
        // 200k at base plus the remainder at tier.
        expect(estimateCost({ ...base, promptTokens: 1_000_000, estimatedTokens: 1_000_000 }).totalUsd)
            .toBeCloseTo(4, 6);
    });

    it("never applies the long-context tier to aggregated token sums", () => {
        const catalog = builtInPricingCatalog();
        const summed = {
            modelKey: "gpt-5.6-terra",
            promptTokens: 28_000_000,
            completionTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            estimatedTokens: 28_000_000,
            pricingCatalog: catalog,
        };

        // A session row summing 28M tokens says nothing about any single
        // request's context - bill at base ($2/M), not the tier rate.
        expect(estimateCost({ ...summed, aggregated: true }).totalUsd).toBeCloseTo(56, 6);
    });

    it("reads models.dev context_over_200k tiers", () => {
        const catalog = parseModelsDevPricingCatalog({
            openai: { models: { "gpt-test": { id: "gpt-test", cost: {
                input: 2, output: 12, cache_read: 0.2, cache_write: 2.5,
                context_over_200k: { input: 4, output: 18, cache_read: 0.4, cache_write: 5 },
            } } } },
        });
        expect(catalog.get("gpt-test")).toMatchObject({
            inputPerMillionUsd: 2,
            inputAbove200kPerMillionUsd: 4,
            outputAbove200kPerMillionUsd: 18,
        });
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

    it("prices claude-sonnet-5 and its suffixed ids", () => {
        const catalog = builtInPricingCatalog();

        expect(pricingForModel("claude-sonnet-5", catalog)).toMatchObject({
            inputPerMillionUsd: 3,
            outputPerMillionUsd: 15,
        });
        expect(pricingForModel("claude-sonnet-5[1m]", catalog)).toMatchObject({
            inputPerMillionUsd: 3,
            outputPerMillionUsd: 15,
        });
    });

    it("approximates gpt-5.6 variants WITHOUT an exact row at the gpt-5.5 tier", () => {
        const catalog = builtInPricingCatalog();

        // sol/terra/luna all carry exact verified rates (see the catalog test
        // above); the tier approximation only covers a variant with no entry.
        expect(pricingForModel("gpt-5.6-nova", catalog)).toMatchObject({
            inputPerMillionUsd: 5,
            outputPerMillionUsd: 30,
        });
        expect(pricingForModel("gpt-5.6", catalog)).toMatchObject({
            inputPerMillionUsd: 5,
            outputPerMillionUsd: 30,
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

    it("expires the pricing cache after a week by default, honoring the day override", () => {
        const day = 24 * 60 * 60 * 1000;

        expect(PRICING_CACHE_TTL_MS).toBe(7 * day);
        expect(pricingCacheTtlMs({})).toBe(7 * day);
        expect(pricingCacheTtlMs({ AX_PRICING_MAX_AGE_DAYS: "1" })).toBe(day);
        // "0" opts OUT of expiry (always trust the cache).
        expect(pricingCacheTtlMs({ AX_PRICING_MAX_AGE_DAYS: "0" })).toBe(0);
        // Garbage/negative falls back to the default instead of never expiring.
        for (const raw of ["", "  ", "nonsense", "-3"]) {
            expect(pricingCacheTtlMs({ AX_PRICING_MAX_AGE_DAYS: raw })).toBe(7 * day);
        }
    });

    it("still uses an EXPIRED cache when the network is unavailable", async () => {
        const root = mkdtempSync(join(tmpdir(), "ax-pricing-stale-"));
        const cache = join(root, "pricing");
        mkdirSync(cache, { recursive: true });
        const litellmPath = join(cache, "litellm-model-prices.json");
        writeFileSync(litellmPath, JSON.stringify({
            "stale/model": {
                litellm_provider: "stale",
                input_cost_per_token: 0.000003,
                output_cost_per_token: 0.000004,
            },
        }));
        writeFileSync(join(cache, "models-dev-api.json"), JSON.stringify({}));
        // Age both snapshots well past the TTL.
        const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        utimesSync(litellmPath, old, old);
        utimesSync(join(cache, "models-dev-api.json"), old, old);

        const result = await loadPricingCatalog(root, { AX_PRICING_OFFLINE: "1" });

        // Expiry must only trigger a refresh ATTEMPT - never drop pricing.
        expect(result.litellmSource).toBe("cache");
        expect(result.catalog.get("stale/model")).toMatchObject({
            inputPerMillionUsd: 3,
            outputPerMillionUsd: 4,
        });
    });
});
