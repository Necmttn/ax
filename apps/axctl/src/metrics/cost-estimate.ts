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
 * Hang safety: queries here are a direct record-id fetch over `agent_model`
 * (a few keys per call) and an indexed-or-full `session_token_usage` select
 * (`fetchSessionCostMap`) - no edge derefs.
 */
import { Effect, Schema } from "effect";
import { NumberFromBigIntColumn } from "@ax/lib/duckdb/columns";
import type { CacheReadError, CacheReadService } from "@ax/lib/duckdb/seam";
import {
    builtInPricingCatalog,
    estimateCost,
    mergePricingCatalogs,
    normalizeModelName,
    pricingRowsToCatalog,
    type AgentModelPricingRow,
    type ModelPricing,
} from "../ingest/model-pricing.ts";
import { chunked, cleanSessionId, numOrNull, numOrZero, sessionIdsClause, strOrNull } from "./util.ts";

const NullableNumber = Schema.NullOr(Schema.Number);
const NullableBigIntNumber = Schema.NullOr(NumberFromBigIntColumn);
const AgentModelPricingSchema = Schema.Struct({
    name: Schema.String,
    provider: Schema.String,
    input_per_million_usd: NullableNumber,
    output_per_million_usd: NullableNumber,
    cache_creation_per_million_usd: NullableNumber,
    cache_read_per_million_usd: NullableNumber,
    input_above_200k_per_million_usd: NullableNumber,
    output_above_200k_per_million_usd: NullableNumber,
    cache_creation_above_200k_per_million_usd: NullableNumber,
    cache_read_above_200k_per_million_usd: NullableNumber,
    fast_multiplier: NullableNumber,
    context_window: NullableBigIntNumber,
    pricing_source: Schema.NullOr(Schema.String),
});

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
        // `usage` is a `session_token_usage` row - one session's SUMMED
        // token counts, not one request. See plan 003.
        aggregated: true,
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
    read: CacheReadService,
    models: ReadonlyArray<string | null | undefined>,
): Effect.Effect<Map<string, ModelPricing>, CacheReadError> =>
    Effect.gen(function* () {
        const keys = new Set<string>(FALLBACK_MODEL_KEYS);
        for (const model of models) {
            const key = normalizeModelName(model);
            if (key) keys.add(key);
        }
        const names = sessionIdsClause("name", [...keys]);
        const rows = yield* read.rows(
            AgentModelPricingSchema,
            `SELECT name, provider, input_per_million_usd, output_per_million_usd,`
            + ` cache_creation_per_million_usd, cache_read_per_million_usd,`
            + ` input_above_200k_per_million_usd, output_above_200k_per_million_usd,`
            + ` cache_creation_above_200k_per_million_usd, cache_read_above_200k_per_million_usd,`
            + ` fast_multiplier, context_window, pricing_source`
            + ` FROM agent_model WHERE TRUE ${names.sql}`,
            names.params,
        );
        return mergePricingCatalogs(builtInPricingCatalog(), pricingRowsToCatalog(rows as AgentModelPricingRow[]));
    });

// ---------------------------------------------------------------------------
// Shared session→cost map (the ONE place the session_token_usage columns +
// fillEstimatedCost mapping live - both the metrics listing and the aggregate
// scan consume this, so a pricing-column change is a single edit)
// ---------------------------------------------------------------------------

/** Resolved cost (+ model) for one session's token-usage row. */
export interface SessionCostEntry {
    /** Normalized model name from the usage row (aggregate group-by dimension). */
    readonly model: string | null;
    readonly estimatedCostUsd: number | null;
    readonly pricingSource: string | null;
    /** True when the cost was estimated at read time (#175 provenance). */
    readonly estimated: boolean;
}

const SessionUsageSchema = Schema.Struct({
    session: Schema.String,
    model: Schema.NullOr(Schema.String),
    prompt_tokens: NullableBigIntNumber,
    completion_tokens: NullableBigIntNumber,
    cache_creation_input_tokens: NullableBigIntNumber,
    cache_read_input_tokens: NullableBigIntNumber,
    estimated_tokens: NumberFromBigIntColumn,
    estimated_cost_usd: NullableNumber,
    pricing_source: Schema.NullOr(Schema.String),
});

const USAGE_SELECT =
    `SELECT session, model, prompt_tokens, completion_tokens,`
    + ` cache_creation_input_tokens, cache_read_input_tokens, estimated_tokens,`
    + ` estimated_cost_usd, pricing_source FROM session_token_usage`;

/** Max record refs per `session IN [...]` batch (keeps query strings sane). */
const IN_CHUNK = 500;

/**
 * Fetch `session_token_usage` rows and resolve each session's cost: stored
 * when priced at ingest, estimated from token counts × `agent_model` pricing
 * otherwise (#175 - the Claude byte-estimate rows were never priced, so every
 * Claude session showed a null cost).
 *
 * `sessionIds === null` scans the whole table (aggregate fallback when the
 * session set is too large to enumerate); otherwise the select is bounded via
 * the UNIQUE `session_token_usage_session` index in `IN_CHUNK`-sized batches.
 * Keys are normalized with `cleanSessionId` - look up with the same.
 */
export const fetchSessionCostMap = (
    read: CacheReadService,
    sessionIds: readonly string[] | null,
): Effect.Effect<Map<string, SessionCostEntry>, CacheReadError> =>
    Effect.gen(function* () {
        const out = new Map<string, SessionCostEntry>();
        if (sessionIds !== null && sessionIds.length === 0) return out;
        const usageRows = sessionIds === null
            ? yield* read.rows(SessionUsageSchema, USAGE_SELECT)
            : (yield* Effect.all(
                chunked(sessionIds, IN_CHUNK).map((ids) =>
                    {
                        const sessions = sessionIdsClause("session", ids);
                        return read.rows(SessionUsageSchema, `${USAGE_SELECT} WHERE TRUE ${sessions.sql}`, sessions.params);
                    }),
                { concurrency: 4 },
            )).flatMap((batch) => batch);
        const catalog = yield* loadPricingCatalogForModels(read, usageRows.map((u) => u.model));
        for (const u of usageRows) {
            const filled = fillEstimatedCost({
                model: strOrNull(u.model),
                prompt_tokens: numOrNull(u.prompt_tokens),
                completion_tokens: numOrNull(u.completion_tokens),
                cache_creation_input_tokens: numOrNull(u.cache_creation_input_tokens),
                cache_read_input_tokens: numOrNull(u.cache_read_input_tokens),
                estimated_tokens: numOrZero(u.estimated_tokens),
                estimated_cost_usd: numOrNull(u.estimated_cost_usd),
                pricing_source: strOrNull(u.pricing_source),
            }, catalog);
            out.set(cleanSessionId(String(u.session ?? "")), {
                model: normalizeModelName(strOrNull(u.model)),
                estimatedCostUsd: filled.estimatedCostUsd,
                pricingSource: filled.pricingSource,
                estimated: filled.estimated,
            });
        }
        return out;
    });
