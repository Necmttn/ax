import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { decodeJsonOrNull, encodeJson } from "@ax/lib/decode";
import { AxConfig } from "@ax/lib/config";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { executeStatementsWith } from "@ax/lib/shared/statement-exec";
import { recordRef, surrealObject, surrealOptionInt, surrealOptionString, surrealString } from "@ax/lib/shared/surql";
import { recordLiteral, stableDigest } from "@ax/lib/ids";
import { BaseStageStats, IngestContext, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

const LITELLM_PRICING_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const MODELS_DEV_API_URL = "https://models.dev/api.json";

export const MODEL_PRICING_SOURCE = "built_in_catalog_2026-08-06";

export interface ModelPricing {
    readonly provider: string;
    readonly inputPerMillionUsd: number | null;
    readonly outputPerMillionUsd: number | null;
    readonly cacheCreationPerMillionUsd: number | null;
    readonly cacheReadPerMillionUsd: number | null;
    readonly inputAbove200kPerMillionUsd?: number | null;
    readonly outputAbove200kPerMillionUsd?: number | null;
    readonly cacheCreationAbove200kPerMillionUsd?: number | null;
    readonly cacheReadAbove200kPerMillionUsd?: number | null;
    readonly fastMultiplier: number;
    readonly contextWindow?: number | null;
    readonly pricingSource: string | null;
}

export interface CostEstimate {
    readonly inputUsd: number | null;
    readonly outputUsd: number | null;
    readonly cacheCreationUsd: number | null;
    readonly cacheReadUsd: number | null;
    readonly totalUsd: number | null;
    readonly pricingSource: string | null;
}

export interface AgentModelPricingRow {
    readonly name?: string | null;
    readonly provider?: string | null;
    readonly input_per_million_usd?: number | null;
    readonly output_per_million_usd?: number | null;
    readonly cache_creation_per_million_usd?: number | null;
    readonly cache_read_per_million_usd?: number | null;
    readonly input_above_200k_per_million_usd?: number | null;
    readonly output_above_200k_per_million_usd?: number | null;
    readonly cache_creation_above_200k_per_million_usd?: number | null;
    readonly cache_read_above_200k_per_million_usd?: number | null;
    readonly fast_multiplier?: number | null;
    readonly context_window?: number | null;
    readonly pricing_source?: string | null;
}

const sqlOptionUsd = (value: number | null | undefined): string =>
    value === null || value === undefined || !Number.isFinite(value)
        ? "NONE"
        : Number(value.toFixed(8)).toString();

const dollarsPerTokenToPerMillion = (value: unknown): number | null => {
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(n) ? n * 1_000_000 : null;
};

const numberOrNull = (value: unknown): number | null => {
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(n) ? n : null;
};

const intOrNull = (value: unknown): number | null => {
    const n = numberOrNull(value);
    return n === null ? null : Math.trunc(n);
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
    typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;

const withCacheDefaults = (pricing: ModelPricing): ModelPricing => ({
    ...pricing,
    cacheCreationPerMillionUsd: pricing.cacheCreationPerMillionUsd ?? (pricing.inputPerMillionUsd === null ? null : pricing.inputPerMillionUsd * 1.25),
    cacheReadPerMillionUsd: pricing.cacheReadPerMillionUsd ?? (pricing.inputPerMillionUsd === null ? null : pricing.inputPerMillionUsd * 0.1),
});

export const BUILTIN_MODEL_PRICING_CATALOG: Readonly<Record<string, ModelPricing>> = {
    "gpt-5": {
        provider: "openai",
        inputPerMillionUsd: 1.25,
        outputPerMillionUsd: 10,
        cacheCreationPerMillionUsd: null,
        cacheReadPerMillionUsd: 0.125,
        fastMultiplier: 1,
        pricingSource: MODEL_PRICING_SOURCE,
    },
    "gpt-5-codex": {
        provider: "openai",
        inputPerMillionUsd: 1.75,
        outputPerMillionUsd: 14,
        cacheCreationPerMillionUsd: 1.75,
        cacheReadPerMillionUsd: 0.175,
        fastMultiplier: 1,
        pricingSource: MODEL_PRICING_SOURCE,
    },
    "gpt-5.1-codex": {
        provider: "openai",
        inputPerMillionUsd: 1.25,
        outputPerMillionUsd: 10,
        cacheCreationPerMillionUsd: 1.25,
        cacheReadPerMillionUsd: 0.125,
        fastMultiplier: 1,
        pricingSource: MODEL_PRICING_SOURCE,
    },
    "gpt-5.2-codex": {
        provider: "openai",
        inputPerMillionUsd: 1.75,
        outputPerMillionUsd: 14,
        cacheCreationPerMillionUsd: 1.75,
        cacheReadPerMillionUsd: 0.175,
        fastMultiplier: 1,
        pricingSource: MODEL_PRICING_SOURCE,
    },
    "gpt-5.3-codex": {
        provider: "openai",
        inputPerMillionUsd: 1.75,
        outputPerMillionUsd: 14,
        cacheCreationPerMillionUsd: 1.75,
        cacheReadPerMillionUsd: 0.175,
        fastMultiplier: 2,
        pricingSource: MODEL_PRICING_SOURCE,
    },
    "gpt-5.3-codex-spark": {
        provider: "openai",
        inputPerMillionUsd: 1.75,
        outputPerMillionUsd: 14,
        cacheCreationPerMillionUsd: 1.75,
        cacheReadPerMillionUsd: 0.175,
        fastMultiplier: 2,
        pricingSource: MODEL_PRICING_SOURCE,
    },
    "gpt-5.4": {
        provider: "openai",
        inputPerMillionUsd: 2.5,
        outputPerMillionUsd: 15,
        cacheCreationPerMillionUsd: 2.5,
        cacheReadPerMillionUsd: 0.25,
        fastMultiplier: 2,
        pricingSource: MODEL_PRICING_SOURCE,
    },
    "gpt-5.5": {
        provider: "openai",
        inputPerMillionUsd: 5,
        outputPerMillionUsd: 30,
        cacheCreationPerMillionUsd: 5,
        cacheReadPerMillionUsd: 0.5,
        fastMultiplier: 2.5,
        pricingSource: MODEL_PRICING_SOURCE,
    },
    // The three gpt-5.6 tiers below carry models.dev rates verbatim, including
    // each one's >200k context tier. Built-in entries WIN over the remote
    // catalogs (`mergePricingCatalogs(modelsDev, litellm, builtIn)`), so a
    // wrong built-in silently overrides a correct upstream one - luna used to
    // sit at 5x its real price that way, and terra had no entry at all and fell
    // through the generic `gpt-5.6-*` rule to gpt-5.5 rates (~2.5x over). #751.
    "gpt-5.6-sol": {
        provider: "openai",
        inputPerMillionUsd: 5,
        outputPerMillionUsd: 30,
        cacheCreationPerMillionUsd: 6.25,
        cacheReadPerMillionUsd: 0.5,
        inputAbove200kPerMillionUsd: 10,
        outputAbove200kPerMillionUsd: 45,
        cacheCreationAbove200kPerMillionUsd: 12.5,
        cacheReadAbove200kPerMillionUsd: 1,
        fastMultiplier: 1,
        contextWindow: 1_050_000,
        pricingSource: MODEL_PRICING_SOURCE,
    },
    "gpt-5.6-terra": {
        provider: "openai",
        inputPerMillionUsd: 2,
        outputPerMillionUsd: 12,
        cacheCreationPerMillionUsd: 2.5,
        cacheReadPerMillionUsd: 0.2,
        inputAbove200kPerMillionUsd: 4,
        outputAbove200kPerMillionUsd: 18,
        cacheCreationAbove200kPerMillionUsd: 5,
        cacheReadAbove200kPerMillionUsd: 0.4,
        fastMultiplier: 1,
        contextWindow: 1_050_000,
        pricingSource: MODEL_PRICING_SOURCE,
    },
    "gpt-5.6-luna": {
        provider: "openai",
        inputPerMillionUsd: 0.2,
        outputPerMillionUsd: 1.2,
        cacheCreationPerMillionUsd: 0.25,
        cacheReadPerMillionUsd: 0.02,
        inputAbove200kPerMillionUsd: 0.4,
        outputAbove200kPerMillionUsd: 1.8,
        cacheCreationAbove200kPerMillionUsd: 0.5,
        cacheReadAbove200kPerMillionUsd: 0.04,
        fastMultiplier: 1,
        contextWindow: 1_050_000,
        pricingSource: MODEL_PRICING_SOURCE,
    },
    "gpt-5-mini": {
        provider: "openai",
        inputPerMillionUsd: 0.25,
        outputPerMillionUsd: 2,
        cacheCreationPerMillionUsd: null,
        cacheReadPerMillionUsd: 0.025,
        fastMultiplier: 1,
        pricingSource: MODEL_PRICING_SOURCE,
    },
    "gpt-5-nano": {
        provider: "openai",
        inputPerMillionUsd: 0.05,
        outputPerMillionUsd: 0.4,
        cacheCreationPerMillionUsd: null,
        cacheReadPerMillionUsd: 0.005,
        fastMultiplier: 1,
        pricingSource: MODEL_PRICING_SOURCE,
    },
    "gpt-4.1": {
        provider: "openai",
        inputPerMillionUsd: 2,
        outputPerMillionUsd: 8,
        cacheCreationPerMillionUsd: null,
        cacheReadPerMillionUsd: 0.5,
        fastMultiplier: 1,
        pricingSource: MODEL_PRICING_SOURCE,
    },
    "gpt-4.1-mini": {
        provider: "openai",
        inputPerMillionUsd: 0.4,
        outputPerMillionUsd: 1.6,
        cacheCreationPerMillionUsd: null,
        cacheReadPerMillionUsd: 0.1,
        fastMultiplier: 1,
        pricingSource: MODEL_PRICING_SOURCE,
    },
    "gpt-4.1-nano": {
        provider: "openai",
        inputPerMillionUsd: 0.1,
        outputPerMillionUsd: 0.4,
        cacheCreationPerMillionUsd: null,
        cacheReadPerMillionUsd: 0.025,
        fastMultiplier: 1,
        pricingSource: MODEL_PRICING_SOURCE,
    },
    "claude-opus-4": {
        provider: "anthropic",
        inputPerMillionUsd: 15,
        outputPerMillionUsd: 75,
        cacheCreationPerMillionUsd: 18.75,
        cacheReadPerMillionUsd: 1.5,
        fastMultiplier: 1,
        pricingSource: MODEL_PRICING_SOURCE,
    },
    "claude-opus-4-5": {
        provider: "anthropic",
        inputPerMillionUsd: 5,
        outputPerMillionUsd: 25,
        cacheCreationPerMillionUsd: 6.25,
        cacheReadPerMillionUsd: 0.5,
        fastMultiplier: 1,
        pricingSource: MODEL_PRICING_SOURCE,
    },
    "claude-opus-4-6": {
        provider: "anthropic",
        inputPerMillionUsd: 5,
        outputPerMillionUsd: 25,
        cacheCreationPerMillionUsd: 6.25,
        cacheReadPerMillionUsd: 0.5,
        fastMultiplier: 1,
        pricingSource: MODEL_PRICING_SOURCE,
    },
    "claude-opus-4-7": {
        provider: "anthropic",
        inputPerMillionUsd: 5,
        outputPerMillionUsd: 25,
        cacheCreationPerMillionUsd: 6.25,
        cacheReadPerMillionUsd: 0.5,
        fastMultiplier: 1,
        pricingSource: MODEL_PRICING_SOURCE,
    },
    "claude-opus-4-8": {
        provider: "anthropic",
        inputPerMillionUsd: 5,
        outputPerMillionUsd: 25,
        cacheCreationPerMillionUsd: 6.25,
        cacheReadPerMillionUsd: 0.5,
        fastMultiplier: 1,
        pricingSource: MODEL_PRICING_SOURCE,
    },
    "claude-opus-4.1": {
        provider: "anthropic",
        inputPerMillionUsd: 15,
        outputPerMillionUsd: 75,
        cacheCreationPerMillionUsd: 18.75,
        cacheReadPerMillionUsd: 1.5,
        fastMultiplier: 1,
        pricingSource: MODEL_PRICING_SOURCE,
    },
    // Rates from models.dev (`claude-opus-5`): input 5 / output 25 /
    // cache_read 0.5 / cache_write 6.25, 1M context. Missing here, opus-5
    // priced $0 on any machine whose pricing cache predates its release -
    // and a $0 model gets share 0 in the profile, so it rendered as "other"
    // instead of as the second-largest model by spend (#751).
    "claude-opus-5": {
        provider: "anthropic",
        inputPerMillionUsd: 5,
        outputPerMillionUsd: 25,
        cacheCreationPerMillionUsd: 6.25,
        cacheReadPerMillionUsd: 0.5,
        fastMultiplier: 1,
        contextWindow: 1_000_000,
        pricingSource: MODEL_PRICING_SOURCE,
    },
    "claude-sonnet-4": {
        provider: "anthropic",
        inputPerMillionUsd: 3,
        outputPerMillionUsd: 15,
        cacheCreationPerMillionUsd: 3.75,
        cacheReadPerMillionUsd: 0.3,
        fastMultiplier: 1,
        pricingSource: MODEL_PRICING_SOURCE,
    },
    "claude-sonnet-5": {
        provider: "anthropic",
        inputPerMillionUsd: 3,
        outputPerMillionUsd: 15,
        cacheCreationPerMillionUsd: 3.75,
        cacheReadPerMillionUsd: 0.3,
        fastMultiplier: 1,
        pricingSource: MODEL_PRICING_SOURCE,
    },
    "claude-fable-5": {
        provider: "anthropic",
        inputPerMillionUsd: 10,
        outputPerMillionUsd: 50,
        cacheCreationPerMillionUsd: 12.5,
        cacheReadPerMillionUsd: 1,
        fastMultiplier: 1,
        pricingSource: MODEL_PRICING_SOURCE,
    },
    "claude-haiku-4-5": {
        provider: "anthropic",
        inputPerMillionUsd: 1,
        outputPerMillionUsd: 5,
        cacheCreationPerMillionUsd: 1.25,
        cacheReadPerMillionUsd: 0.1,
        fastMultiplier: 1,
        pricingSource: MODEL_PRICING_SOURCE,
    },
};

export function normalizeModelName(model: string | null | undefined): string | null {
    const trimmed = model?.trim();
    if (!trimmed || trimmed === "<synthetic>") return null;
    const key = trimmed.toLowerCase();
    if (key === "openai" || key === "anthropic" || key === "google" || key === "deepseek" || key === "qwen") {
        return null;
    }
    return key;
}

export function inferModelProvider(modelKey: string): string {
    if (modelKey.startsWith("claude-")) return "anthropic";
    if (modelKey.startsWith("gpt-") || modelKey.startsWith("o") || modelKey === "openai") return "openai";
    if (modelKey.includes("gemini")) return "google";
    if (modelKey.includes("deepseek")) return "deepseek";
    if (modelKey.includes("qwen")) return "qwen";
    return "unknown";
}

export function parseLiteLlmPricingCatalog(input: unknown): Map<string, ModelPricing> {
    const root = asRecord(input);
    const catalog = new Map<string, ModelPricing>();
    if (!root) return catalog;
    for (const [rawKey, rawValue] of Object.entries(root)) {
        const modelKey = normalizeModelName(rawKey);
        const row = asRecord(rawValue);
        if (!modelKey || !row) continue;
        const inputPerMillionUsd = dollarsPerTokenToPerMillion(row.input_cost_per_token);
        const outputPerMillionUsd = dollarsPerTokenToPerMillion(row.output_cost_per_token);
        if (inputPerMillionUsd === null && outputPerMillionUsd === null) continue;
        catalog.set(modelKey, withCacheDefaults({
            provider: typeof row.litellm_provider === "string" ? row.litellm_provider : inferModelProvider(modelKey),
            inputPerMillionUsd,
            outputPerMillionUsd,
            cacheCreationPerMillionUsd: dollarsPerTokenToPerMillion(row.cache_creation_input_token_cost),
            cacheReadPerMillionUsd: dollarsPerTokenToPerMillion(row.cache_read_input_token_cost),
            inputAbove200kPerMillionUsd: dollarsPerTokenToPerMillion(row.input_cost_per_token_above_200k_tokens),
            outputAbove200kPerMillionUsd: dollarsPerTokenToPerMillion(row.output_cost_per_token_above_200k_tokens),
            cacheCreationAbove200kPerMillionUsd: dollarsPerTokenToPerMillion(row.cache_creation_input_token_cost_above_200k_tokens),
            cacheReadAbove200kPerMillionUsd: dollarsPerTokenToPerMillion(row.cache_read_input_token_cost_above_200k_tokens),
            fastMultiplier: 1,
            contextWindow: intOrNull(row.max_input_tokens ?? row.max_tokens),
            pricingSource: "litellm",
        }));
    }
    return catalog;
}

export function parseModelsDevPricingCatalog(input: unknown): Map<string, ModelPricing> {
    const root = asRecord(input);
    const catalog = new Map<string, ModelPricing>();
    if (!root) return catalog;
    for (const [providerName, providerValue] of Object.entries(root)) {
        const provider = asRecord(providerValue);
        const models = asRecord(provider?.models);
        if (!models) continue;
        for (const [rawKey, rawModel] of Object.entries(models)) {
            const model = asRecord(rawModel);
            const cost = asRecord(model?.cost);
            const limit = asRecord(model?.limit);
            const modelKey = normalizeModelName(typeof model?.id === "string" ? model.id : rawKey);
            if (!modelKey || !cost) continue;
            const inputPerMillionUsd = numberOrNull(cost.input);
            const outputPerMillionUsd = numberOrNull(cost.output);
            if (inputPerMillionUsd === null && outputPerMillionUsd === null) continue;
            catalog.set(modelKey, withCacheDefaults({
                provider: providerName,
                inputPerMillionUsd,
                outputPerMillionUsd,
                cacheCreationPerMillionUsd: numberOrNull(cost.cache_write ?? cost.write),
                cacheReadPerMillionUsd: numberOrNull(cost.cache_read ?? cost.read),
                fastMultiplier: 1,
                contextWindow: intOrNull(limit?.context ?? model?.context_window),
                pricingSource: "models.dev",
            }));
        }
    }
    return catalog;
}

export function mergePricingCatalogs(...catalogs: readonly ReadonlyMap<string, ModelPricing>[]): Map<string, ModelPricing> {
    const merged = new Map<string, ModelPricing>();
    for (const catalog of catalogs) {
        for (const [modelKey, pricing] of catalog) merged.set(modelKey, pricing);
    }
    return merged;
}

export function builtInPricingCatalog(): Map<string, ModelPricing> {
    return new Map(Object.entries(BUILTIN_MODEL_PRICING_CATALOG));
}

export function pricingRowsToCatalog(rows: readonly AgentModelPricingRow[]): Map<string, ModelPricing> {
    const catalog = new Map<string, ModelPricing>();
    for (const row of rows) {
        const modelKey = normalizeModelName(row.name);
        if (!modelKey) continue;
        catalog.set(modelKey, {
            provider: row.provider ?? inferModelProvider(modelKey),
            inputPerMillionUsd: row.input_per_million_usd ?? null,
            outputPerMillionUsd: row.output_per_million_usd ?? null,
            cacheCreationPerMillionUsd: row.cache_creation_per_million_usd ?? null,
            cacheReadPerMillionUsd: row.cache_read_per_million_usd ?? null,
            inputAbove200kPerMillionUsd: row.input_above_200k_per_million_usd ?? null,
            outputAbove200kPerMillionUsd: row.output_above_200k_per_million_usd ?? null,
            cacheCreationAbove200kPerMillionUsd: row.cache_creation_above_200k_per_million_usd ?? null,
            cacheReadAbove200kPerMillionUsd: row.cache_read_above_200k_per_million_usd ?? null,
            fastMultiplier: row.fast_multiplier ?? 1,
            contextWindow: row.context_window ?? null,
            pricingSource: row.pricing_source ?? null,
        });
    }
    return catalog;
}

export function pricingForModel(
    modelKey: string | null,
    catalog: ReadonlyMap<string, ModelPricing> = builtInPricingCatalog(),
): ModelPricing | null {
    if (!modelKey) return null;
    const exact = catalog.get(modelKey);
    if (exact) return exact;
    // sol/terra/luna all carry exact models.dev rates above (exact match wins);
    // these prefix rules catch dated/suffixed variants so they price at their
    // OWN tier instead of falling through to the gpt-5.5 approximation (#751).
    // Any remaining gpt-5.6 variant approximates at gpt-5.5 rather than pricing
    // $0 (issue #696). All of this must precede the generic gpt-5.x rule.
    if (modelKey.startsWith("gpt-5.6-sol")) return catalog.get("gpt-5.6-sol") ?? null;
    if (modelKey.startsWith("gpt-5.6-terra")) return catalog.get("gpt-5.6-terra") ?? null;
    if (modelKey.startsWith("gpt-5.6-luna")) return catalog.get("gpt-5.6-luna") ?? null;
    if (/^gpt-5\.6(?:-|$)/i.test(modelKey)) return catalog.get("gpt-5.5") ?? catalog.get("gpt-5") ?? null;
    if (/^gpt-5(?:\.\d+)?$/i.test(modelKey)) return catalog.get("gpt-5") ?? null;
    if (modelKey.startsWith("claude-fable-5")) return catalog.get("claude-fable-5") ?? null;
    if (modelKey.startsWith("claude-haiku-4-5")) return catalog.get("claude-haiku-4-5") ?? null;
    if (modelKey.startsWith("claude-opus-5")) return catalog.get("claude-opus-5") ?? null;
    if (modelKey.startsWith("claude-opus-4")) return catalog.get("claude-opus-4") ?? null;
    if (modelKey.startsWith("claude-sonnet-5")) return catalog.get("claude-sonnet-5") ?? null;
    if (modelKey.startsWith("claude-sonnet-4")) return catalog.get("claude-sonnet-4") ?? null;
    return null;
}

const componentCost = (tokens: number, basePerMillion: number | null, above200kPerMillion?: number | null): number | null => {
    if (basePerMillion === null) return null;
    if (!above200kPerMillion || tokens <= 200_000) return tokens * basePerMillion / 1_000_000;
    return (200_000 * basePerMillion + (tokens - 200_000) * above200kPerMillion) / 1_000_000;
};

export function estimateCost(input: {
    readonly modelKey: string | null;
    readonly promptTokens: number | null;
    readonly completionTokens: number | null;
    readonly cacheCreationInputTokens: number | null;
    readonly cacheReadInputTokens: number | null;
    readonly estimatedTokens: number;
    readonly pricingCatalog?: ReadonlyMap<string, ModelPricing>;
}): CostEstimate {
    const pricing = pricingForModel(input.modelKey, input.pricingCatalog);
    if (!pricing) {
        return {
            inputUsd: null,
            outputUsd: null,
            cacheCreationUsd: null,
            cacheReadUsd: null,
            totalUsd: null,
            pricingSource: null,
        };
    }
    const promptTokens = input.promptTokens ?? input.estimatedTokens;
    const cacheCreationTokens = input.cacheCreationInputTokens ?? 0;
    const cacheReadTokens = input.cacheReadInputTokens ?? 0;
    const freshInputTokens = Math.max(0, promptTokens - cacheCreationTokens - cacheReadTokens);
    const inputUsd = componentCost(freshInputTokens, pricing.inputPerMillionUsd, pricing.inputAbove200kPerMillionUsd);
    const outputUsd = input.completionTokens === null
        ? null
        : componentCost(input.completionTokens, pricing.outputPerMillionUsd, pricing.outputAbove200kPerMillionUsd);
    const cacheCreationUsd = componentCost(cacheCreationTokens, pricing.cacheCreationPerMillionUsd, pricing.cacheCreationAbove200kPerMillionUsd);
    const cacheReadUsd = componentCost(cacheReadTokens, pricing.cacheReadPerMillionUsd, pricing.cacheReadAbove200kPerMillionUsd);
    const totalUsd = [inputUsd, outputUsd, cacheCreationUsd, cacheReadUsd]
        .filter((value): value is number => value !== null)
        .reduce((sum, value) => sum + value, 0) * pricing.fastMultiplier;
    return {
        inputUsd,
        outputUsd,
        cacheCreationUsd,
        cacheReadUsd,
        totalUsd,
        pricingSource: pricing.pricingSource,
    };
}

export function agentModelStatement(input: {
    readonly modelKey: string;
    readonly provider?: string | null;
    readonly displayName?: string | null;
    readonly pricingCatalog?: ReadonlyMap<string, ModelPricing>;
}): string {
    const pricing = pricingForModel(input.modelKey, input.pricingCatalog);
    const provider = pricing?.provider ?? input.provider ?? inferModelProvider(input.modelKey);
    return `UPSERT ${recordRef("agent_model", input.modelKey)} MERGE ${surrealObject([
        ["name", surrealString(input.modelKey)],
        ["provider", surrealString(provider)],
        ["display_name", surrealString(input.displayName ?? input.modelKey)],
        ["input_per_million_usd", sqlOptionUsd(pricing?.inputPerMillionUsd)],
        ["output_per_million_usd", sqlOptionUsd(pricing?.outputPerMillionUsd)],
        ["cache_creation_per_million_usd", sqlOptionUsd(pricing?.cacheCreationPerMillionUsd)],
        ["cache_read_per_million_usd", sqlOptionUsd(pricing?.cacheReadPerMillionUsd)],
        ["input_above_200k_per_million_usd", sqlOptionUsd(pricing?.inputAbove200kPerMillionUsd)],
        ["output_above_200k_per_million_usd", sqlOptionUsd(pricing?.outputAbove200kPerMillionUsd)],
        ["cache_creation_above_200k_per_million_usd", sqlOptionUsd(pricing?.cacheCreationAbove200kPerMillionUsd)],
        ["cache_read_above_200k_per_million_usd", sqlOptionUsd(pricing?.cacheReadAbove200kPerMillionUsd)],
        ["fast_multiplier", sqlOptionUsd(pricing?.fastMultiplier)],
        ["context_window", surrealOptionInt(pricing?.contextWindow)],
        ["pricing_source", surrealOptionString(pricing?.pricingSource)],
        ["updated_at", "time::now()"],
    ])};`;
}

// OLD: `JSON.parse(await readFile)` in try/catch → null on ANY fault (missing
// file OR malformed JSON). `readFileString` recovers every PlatformError to
// null via `orAbsent`; `decodeJsonOrNull` returns null on a parse error,
// matching the old tolerate-all behavior end-to-end.
const readJsonFile = (path: string): Effect.Effect<unknown | null, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const text = yield* fs.readFileString(path).pipe(orAbsent(null as string | null));
        return text === null ? null : decodeJsonOrNull(text);
    });

/**
 * How long a cached pricing snapshot is trusted before ax tries the network
 * again (#751).
 *
 * The cache used to have NO expiry: whatever was on disk won forever unless
 * someone set `AX_PRICING_REFRESH=1`. So a machine that fetched the catalog
 * once priced every model released afterwards at $0 - silently and
 * indefinitely. That is how `claude-opus-5` came to render as UNPRICED, and
 * (because profile share is cost-weighted) how it collapsed into the profile's
 * "other" bucket while being the second-largest model by spend.
 *
 * A week is short enough that a new model becomes priced on its own, and long
 * enough that ordinary ingests almost never pay for the fetch. Staleness is
 * never fatal: an expired cache that cannot be refreshed is still used.
 */
export const PRICING_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Env override in whole days; "0" disables expiry (always trust the cache). */
export const pricingCacheTtlMs = (env: Record<string, string | undefined>): number => {
    const raw = env.AX_PRICING_MAX_AGE_DAYS?.trim();
    if (!raw) return PRICING_CACHE_TTL_MS;
    const days = Number(raw);
    if (!Number.isFinite(days) || days < 0) return PRICING_CACHE_TTL_MS;
    return days * 24 * 60 * 60 * 1000;
};

/**
 * Is the cached snapshot younger than `ttlMs`? An unreadable/absent file is
 * NOT fresh (fall through to the network); a stat fault is treated the same
 * way, so a filesystem oddity can only cost a fetch, never freeze pricing.
 */
const cacheIsFresh = (
    cachePath: string,
    ttlMs: number,
    now: number,
): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const mtime = yield* fs.stat(cachePath).pipe(
            Effect.map((info): Date | null => Option.getOrNull(info.mtime)),
            orAbsent(null as Date | null),
        );
        if (mtime === null) return false;
        return now - mtime.getTime() < ttlMs;
    });

const fetchJsonWithCache = (
    url: string,
    cachePath: string,
    opts: {
        readonly offline: boolean;
        readonly refresh: boolean;
        readonly ttlMs: number;
        readonly now: number;
    },
): Effect.Effect<
    { json: unknown | null; source: "network" | "cache" | "missing" },
    never,
    FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        // A fresh cache short-circuits; a stale one falls through to the
        // network and is still the fallback if that fetch fails (below).
        if (!opts.refresh) {
            const fresh = opts.ttlMs === 0 || (yield* cacheIsFresh(cachePath, opts.ttlMs, opts.now));
            if (fresh) {
                const cached = yield* readJsonFile(cachePath);
                if (cached !== null) return { json: cached, source: "cache" as const };
            }
        }
        if (!opts.offline) {
            // OLD: the whole network+write block sat in a try/catch that
            // swallowed ANY failure (the cache is the fallback; a refresh must
            // not block ingest). The fetch+parse runs under `Effect.tryPromise`
            // so a network/HTTP/parse fault recovers to `null`; the cache writes
            // are best-effort (`Effect.ignore` drops mkdir/write faults), all
            // leaving the cache-fallback path below intact.
            const networkJson: unknown | null = yield* Effect.tryPromise(async () => {
                const response = await fetch(url);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return (await response.json()) as unknown;
            }).pipe(Effect.orElseSucceed(() => null as unknown | null));
            if (networkJson !== null) {
                yield* fs.makeDirectory(path.dirname(cachePath), { recursive: true }).pipe(Effect.ignore);
                yield* fs.writeFileString(cachePath, `${encodeJson(networkJson)}\n`).pipe(Effect.ignore);
                return { json: networkJson, source: "network" as const };
            }
        }
        const cached = yield* readJsonFile(cachePath);
        return cached === null
            ? { json: null, source: "missing" as const }
            : { json: cached, source: "cache" as const };
    });

export interface PricingCatalogLoadResult {
    readonly catalog: Map<string, ModelPricing>;
    readonly litellmSource: "network" | "cache" | "missing";
    readonly modelsDevSource: "network" | "cache" | "missing";
}

export const loadPricingCatalog = (
    dataDir: string,
    env: Record<string, string | undefined> = process.env,
): Effect.Effect<PricingCatalogLoadResult, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const path = yield* Path.Path;
        const offline = env.AX_PRICING_OFFLINE === "1";
        const refresh = env.AX_PRICING_REFRESH === "1";
        const cacheDir = path.join(dataDir, "pricing");
        // One `now` for both fetches so the two caches age together.
        const fetchOpts = { offline, refresh, ttlMs: pricingCacheTtlMs(env), now: Date.now() };
        const [litellm, modelsDev] = yield* Effect.all([
            fetchJsonWithCache(LITELLM_PRICING_URL, path.join(cacheDir, "litellm-model-prices.json"), fetchOpts),
            fetchJsonWithCache(MODELS_DEV_API_URL, path.join(cacheDir, "models-dev-api.json"), fetchOpts),
        ], { concurrency: "unbounded" });
        const catalog = mergePricingCatalogs(
            parseModelsDevPricingCatalog(modelsDev.json),
            parseLiteLlmPricingCatalog(litellm.json),
            builtInPricingCatalog(),
        );
        return { catalog, litellmSource: litellm.source, modelsDevSource: modelsDev.source };
    });

export interface PricingRefreshStats {
    readonly models: number;
    readonly litellmSource: "network" | "cache" | "missing";
    readonly modelsDevSource: "network" | "cache" | "missing";
}

// ---------------------------------------------------------------------------
// Skip-unchanged via input-fingerprint watermark (attempt 009, mirrors 008).
//
// refreshModelPricing UPSERTs the entire agent_model catalog (hundreds of rows)
// on every run, even though the catalog is a deterministic function of the
// cached pricing JSON + the built-in constants and is unchanged between warm
// runs. We fingerprint the exact UPSERT statements (the `updated_at=time::now()`
// clause is identical text across runs, so it does not perturb the digest) and
// cache it in the shared `ingest_file_state` table (source_kind='pricing', fixed
// sentinel path). On the next run, if the fingerprint matches the stored digest
// the persisted rows are already identical ⇒ skip the whole UPSERT batch
// (output-equivalent; only the volatile `updated_at` would have changed). Any
// catalog change yields a new digest, forcing a full re-write. NEVER `NOT IN`:
// the watermark is one indexed read. `AX_REDERIVE_PRICING=1` forces a full
// re-write (ignores the watermark).
const PRICING_WATERMARK_SOURCE = "pricing";
const PRICING_WATERMARK_PATH = "__pricing__";

const pricingWatermarkId = (): string =>
    recordLiteral("ingest_file_state", stableDigest(`pricing|${PRICING_WATERMARK_PATH}`));

const pricingStatementsFingerprint = (statements: readonly string[]): string =>
    stableDigest(statements.join("\n"), 32);

const loadPricingWatermark = (db: SurrealClientShape): Effect.Effect<string | undefined, DbError> =>
    Effect.gen(function* () {
        const rows = (yield* db.query<[Array<{ sha?: string }>]>(
            `SELECT sha FROM ingest_file_state WHERE source_kind = ${surrealString(PRICING_WATERMARK_SOURCE)};`,
        ))?.[0] ?? [];
        const sha = rows[0]?.sha;
        return typeof sha === "string" ? sha : undefined;
    });

const upsertPricingWatermark = (db: SurrealClientShape, digest: string): Effect.Effect<void, DbError> =>
    executeStatementsWith(
        db,
        [
            `UPSERT ${pricingWatermarkId()} CONTENT { path: ${surrealString(PRICING_WATERMARK_PATH)}, source_kind: ${surrealString(PRICING_WATERMARK_SOURCE)}, sha: ${surrealString(digest)}, ingested_at: time::now() };`,
        ],
        { chunkSize: 1 },
    );

export const refreshModelPricing = (): Effect.Effect<PricingRefreshStats, DbError, SurrealClient | AxConfig | FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const cfg = yield* AxConfig;
        const forceRewrite = process.env.AX_REDERIVE_PRICING === "1";
        const result = yield* loadPricingCatalog(cfg.paths.dataDir);
        const statements = [...result.catalog.entries()].map(([modelKey, pricing]) =>
            agentModelStatement({
                modelKey,
                provider: pricing.provider,
                displayName: modelKey,
                pricingCatalog: result.catalog,
            })
        );
        const digest = pricingStatementsFingerprint(statements);
        const storedDigest = forceRewrite ? undefined : yield* loadPricingWatermark(db);
        if (storedDigest !== digest) {
            yield* executeStatementsWith(db, statements, { chunkSize: 500 });
            yield* upsertPricingWatermark(db, digest);
        }
        return {
            models: result.catalog.size,
            litellmSource: result.litellmSource,
            modelsDevSource: result.modelsDevSource,
        };
    });

export const PricingKey = Schema.Literal("pricing");
export type PricingKey = typeof PricingKey.Type;

export class PricingStageStats extends BaseStageStats.extend<PricingStageStats>("PricingStageStats")({
    models: Schema.Number,
    litellmSource: Schema.String,
    modelsDevSource: Schema.String,
}) {}

export const pricingStage: StageDef<PricingStageStats, SurrealClient | AxConfig | FileSystem.FileSystem | Path.Path> = {
    meta: StageMeta.make({ key: "pricing", deps: [], tags: ["ingest"] }),
    run: (_ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const result = yield* refreshModelPricing();
            return PricingStageStats.make({
                durationMs: Date.now() - t0,
                summary: `loaded ${result.models} model prices (litellm=${result.litellmSource}, models.dev=${result.modelsDevSource})`,
                models: result.models,
                litellmSource: result.litellmSource,
                modelsDevSource: result.modelsDevSource,
            });
        }),
};
