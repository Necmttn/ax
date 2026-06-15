/**
 * Shared repricing utility for dispatch analytics and cost-routability queries.
 *
 * Delegates to `estimateCost` from the ingest layer, which recovers fresh
 * input tokens by subtracting the cache buckets before applying the input rate.
 */
import { estimateCost, type ModelPricing } from "../ingest/model-pricing.ts";

export type { ModelPricing };

/** Short aliases → canonical model ids used in repricing suggestions. */
export const MODEL_ALIASES: Record<string, string> = {
    sonnet: "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5-20251001",
};

/**
 * Token usage fields needed for repricing. Structurally compatible with
 * `UsageRow` in dispatch-analytics and with future cost-routability rows.
 */
export interface RepriceUsage {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly cache_read_tokens: number;
    readonly cache_create_tokens: number;
    readonly cost_usd: number;
}

/**
 * Reprice token buckets at a given model's rates.
 *
 * When `pricingCatalog` is non-empty it is forwarded to `estimateCost` so
 * DB-loaded rates take priority over the built-in catalog. Falls back to
 * `usage.cost_usd` when the target model is unknown to the catalog.
 */
export function reprice(
    usage: RepriceUsage,
    targetModelName: string,
    pricingCatalog: ReadonlyMap<string, ModelPricing>,
): number {
    const cost = estimateCost({
        modelKey: targetModelName,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        cacheCreationInputTokens: usage.cache_create_tokens,
        cacheReadInputTokens: usage.cache_read_tokens,
        estimatedTokens: usage.prompt_tokens + usage.completion_tokens,
        ...(pricingCatalog.size > 0 ? { pricingCatalog } : {}),
    });
    return cost.totalUsd ?? usage.cost_usd;
}
