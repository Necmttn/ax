/**
 * Read-time cost estimation for token-usage rows whose `estimated_cost_usd`
 * was never computed at ingest (issue #175).
 *
 * Most Claude `session_token_usage` rows come from the session-health
 * byte-estimate path (`unpriced_model_reason: pricing_not_computed`), so spend
 * surfaces showed `null` for every Claude session while Codex rows were priced
 * at ingest. Rather than mutating stored rows (re-pricing history belongs to
 * ingest), we estimate at READ time from the row's own token counts × the
 * `agent_model` pricing table, and mark provenance with an `estimated:` prefix
 * on `pricing_source` so callers can tell provider-derived cost from our
 * estimate.
 *
 * Hang safety: the only query here is a direct record-id fetch over
 * `agent_model` (a few keys per call) - no edge derefs, no table scans.
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { recordLiteral } from "@ax/lib/ids";
import {
    builtInPricingCatalog,
    estimateCost,
    mergePricingCatalogs,
    normalizeModelName,
    pricingRowsToCatalog,
    type AgentModelPricingRow,
    type ModelPricing,
} from "../ingest/model-pricing.ts";

/** Prefix marking a cost we estimated at read time (vs. priced at ingest). */
export const ESTIMATED_PRICING_PREFIX = "estimated:";

export const isEstimatedPricingSource = (source: string | null | undefined): boolean =>
    typeof source === "string" && source.startsWith(ESTIMATED_PRICING_PREFIX);

/** The token-usage fields cost estimation reads (snake_case, as stored). */
export interface UsageCostFields {
    readonly model: string | null;
    readonly prompt_tokens: number | null;
    readonly completion_tokens: number | null;
    readonly cache_creation_input_tokens: number | null;
    readonly cache_read_input_tokens: number | null;
    readonly estimated_tokens: number;
    readonly estimated_cost_usd: number | null;
    readonly pricing_source: string | null;
}

export interface FilledCost {
    readonly estimatedCostUsd: number | null;
    readonly pricingSource: string | null;
    /** True when the cost was estimated here rather than stored at ingest. */
    readonly estimated: boolean;
}

/**
 * Pure: keep the stored cost when present; otherwise estimate from token
 * counts × catalog pricing. Byte-estimate rows carry only `estimated_tokens`
 * (no prompt/completion split) - `estimateCost` then prices the whole count at
 * the input rate, which under-counts output but is an honest lower-bound
 * estimate. Unknown/unpriced models stay null (unknown ≠ $0).
 */
export function fillEstimatedCost(
    usage: UsageCostFields,
    catalog: ReadonlyMap<string, ModelPricing>,
): FilledCost {
    if (usage.estimated_cost_usd !== null && usage.estimated_cost_usd !== undefined) {
        return {
            estimatedCostUsd: usage.estimated_cost_usd,
            pricingSource: usage.pricing_source ?? null,
            estimated: false,
        };
    }
    const cost = estimateCost({
        modelKey: normalizeModelName(usage.model),
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        cacheCreationInputTokens: usage.cache_creation_input_tokens,
        cacheReadInputTokens: usage.cache_read_input_tokens,
        estimatedTokens: usage.estimated_tokens,
        pricingCatalog: catalog,
    });
    if (cost.totalUsd === null) {
        return { estimatedCostUsd: null, pricingSource: usage.pricing_source ?? null, estimated: false };
    }
    return {
        estimatedCostUsd: cost.totalUsd,
        pricingSource: `${ESTIMATED_PRICING_PREFIX}${cost.pricingSource ?? "unknown"}`,
        estimated: true,
    };
}

/** Family keys `pricingForModel` falls back to for unseen model variants. */
const FALLBACK_MODEL_KEYS = ["gpt-5", "claude-opus-4", "claude-sonnet-4"] as const;

/**
 * Load pricing for the given model names from `agent_model` (direct record-id
 * fetch - the record key IS the normalized model name), merged over the
 * built-in catalog as fallback (DB rows win: litellm/models.dev refreshes are
 * fresher than the compiled-in table).
 */
export const loadPricingCatalogForModels = (
    models: ReadonlyArray<string | null | undefined>,
): Effect.Effect<Map<string, ModelPricing>, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const keys = new Set<string>(FALLBACK_MODEL_KEYS);
        for (const model of models) {
            const key = normalizeModelName(model);
            // recordLiteral throws on `/newline/NUL keys - skip rather than defect.
            if (key && !/[`\n\u0000]/.test(key)) keys.add(key);
        }
        const refs = [...keys].map((k) => recordLiteral("agent_model", k)).join(", ");
        const rows = (yield* db.query<[AgentModelPricingRow[]]>(
            `SELECT name, provider, input_per_million_usd, output_per_million_usd,`
            + ` cache_creation_per_million_usd, cache_read_per_million_usd,`
            + ` input_above_200k_per_million_usd, output_above_200k_per_million_usd,`
            + ` cache_creation_above_200k_per_million_usd, cache_read_above_200k_per_million_usd,`
            + ` fast_multiplier, context_window, pricing_source`
            + ` FROM [${refs}];`,
        ))?.[0] ?? [];
        return mergePricingCatalogs(builtInPricingCatalog(), pricingRowsToCatalog(rows));
    });
