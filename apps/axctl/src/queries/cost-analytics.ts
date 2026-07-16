/**
 * `ax cost models / sessions / split`: model/cost analytics over
 * `session_token_usage`. GROUP BY stays on scalar fields of the scanned table
 * only - record derefs inside aggregates over large tables hang SurrealDB 3.x -
 * so any grouping that needs a derived dimension (origin) happens in JS after
 * a single scan.
 *
 * Tables used (read-only):
 *   session_token_usage: source, model, prompt_tokens, completion_tokens,
 *     cache_creation_input_tokens, cache_read_input_tokens,
 *     estimated_cost_usd, ts
 *   session: id, source, project, started_at, model
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { surrealLiteral } from "@ax/lib/json";
import { countField, stringFieldOr } from "@ax/lib/shared/surreal";
import { fetchContentTypeBreakdown, type ContentTypeBreakdown } from "./content-types.ts";
import { originOfSource } from "../ingest/source-origin.ts";
import { estimateCost, normalizeModelName, pricingForModel, type ModelPricing } from "../ingest/model-pricing.ts";
import { loadPricingCatalogForModels } from "../metrics/cost-estimate.ts";

// ---------------------------------------------------------------------------
// Shared constants + SQL-boundary helpers
// ---------------------------------------------------------------------------

/** Default look-back window for all `ax cost *` subcommands (models / sessions / split). */
export const COST_DEFAULT_WINDOW_DAYS = 14;

/**
 * SQL-interpolation boundary guard for day-window values.
 *
 * Distinct from transport-level defaults: this guard lives at the SQL
 * interpolation site to prevent negative/fractional/NaN values reaching
 * SurrealDB. It is intentionally SEPARATE from clampInt / Flag.withDefault so
 * that neither the CLI default nor the MCP default bypass the injection guard.
 */
const sqlWindowDays = (n: number): number => Math.max(1, Math.trunc(n));

/**
 * Resolve a rollup row/cell's displayed cost + `unpriced` flag against a
 * query-time pricing catalog (issue #696 follow-up).
 *
 * `isUnpricedModel` (the prior implementation) checked only the built-in
 * catalog, but stored `cost_usd` is computed at ingest from the MERGED
 * catalog (built-in + litellm/models.dev DB refresh, see
 * `ingest/model-pricing.ts` + `metrics/cost-estimate.ts`). A model priced only
 * via the DB refresh got real nonzero `cost_usd` yet rendered UNPRICED - the
 * catalog check and the stored number disagreed. Worse, a model added to the
 * built-in catalog AFTER older rows were ingested (e.g. claude-sonnet-5,
 * gpt-5.6-sol/luna - #696) has those older rows stored with a real zero/null
 * cost forever, since ingest only backfills null-cost rows (never re-prices a
 * row that already carries a stored cost - `derive-cost-backfill.ts`).
 *
 * Resolution order:
 * 1. A stored cost > 0 is real money - never mask it, never recompute it.
 * 2. Zero tokens is a genuine zero-usage row (including the "(unattributed)"
 *    sentinel) - show $0, not UNPRICED.
 * 3. Stored cost === 0 with real tokens and a catalog rate: recompute from
 *    the row's own token split at query time (self-healing without an
 *    ingest re-run).
 * 4. Stored cost === 0 with real tokens and NO catalog rate: genuinely
 *    unpriced - render UNPRICED rather than a silent $0.
 */
const EMPTY_PRICING_CATALOG: ReadonlyMap<string, ModelPricing> = new Map();

/**
 * True when any row carries a stored zero cost with real tokens - the only
 * shape `resolveRowCost` needs a catalog for. Keeps the catalog DB round-trip
 * out of the common all-priced path (and out of every positional-mock caller
 * that never exercises recompute, e.g. buildProfile).
 */
const rowsNeedPricing = (rows: ReadonlyArray<Record<string, unknown>>): boolean =>
    rows.some((row) =>
        countField(row, "cost_usd") === 0
        && countField(row, "prompt_tokens") + countField(row, "completion_tokens")
            + countField(row, "cache_read_tokens") + countField(row, "cache_create_tokens") > 0,
    );

function resolveRowCost(
    input: {
        readonly model: string;
        readonly promptTokens: number;
        readonly completionTokens: number;
        readonly cacheReadTokens: number;
        readonly cacheCreateTokens: number;
        readonly costUsd: number;
    },
    catalog: ReadonlyMap<string, ModelPricing>,
): { readonly cost_usd: number; readonly unpriced: boolean } {
    if (input.costUsd > 0) {
        return { cost_usd: input.costUsd, unpriced: false };
    }
    const totalTokens = input.promptTokens + input.completionTokens + input.cacheReadTokens + input.cacheCreateTokens;
    if (totalTokens === 0) {
        return { cost_usd: 0, unpriced: false };
    }
    const modelKey = normalizeModelName(input.model);
    const pricing = pricingForModel(modelKey, catalog);
    if (!pricing) {
        return { cost_usd: 0, unpriced: true };
    }
    const estimate = estimateCost({
        modelKey,
        promptTokens: input.promptTokens,
        completionTokens: input.completionTokens,
        cacheCreationInputTokens: input.cacheCreateTokens,
        cacheReadInputTokens: input.cacheReadTokens,
        estimatedTokens: input.promptTokens,
        pricingCatalog: catalog,
    });
    return estimate.totalUsd === null
        ? { cost_usd: 0, unpriced: true }
        : { cost_usd: estimate.totalUsd, unpriced: false };
}

// ---------------------------------------------------------------------------
// cost models
// ---------------------------------------------------------------------------

export interface CostModelsRow {
    readonly model: string;
    readonly sessions: number;
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly cache_read_tokens: number;
    readonly cache_create_tokens: number;
    readonly cost_usd: number;
    readonly unpriced: boolean;
}

export interface CostModelsResult {
    readonly rows: ReadonlyArray<CostModelsRow>;
    readonly total_cost_usd: number;
}

/**
 * Fetch raw session_token_usage rows for the cost-models rollup. Avoids
 * GROUP BY + deref inside aggregates; aggregation is done in JS.
 */
const COST_MODELS_SQL = (sinceDays: number) => `
SELECT
    model,
    count() AS sessions,
    math::sum(prompt_tokens) AS prompt_tokens,
    math::sum(completion_tokens) AS completion_tokens,
    math::sum(cache_read_input_tokens) AS cache_read_tokens,
    math::sum(cache_creation_input_tokens) AS cache_create_tokens,
    math::sum(estimated_cost_usd) AS cost_usd
FROM session_token_usage
WHERE ts > time::now() - ${sqlWindowDays(sinceDays)}d
GROUP BY model
ORDER BY cost_usd DESC;
`;

export const fetchCostModels = Effect.fn("queries.fetchCostModels")(
    function* (opts: { readonly sinceDays: number }) {
        const db = yield* SurrealClient;
        const rows = yield* db.query<[Array<Record<string, unknown>>]>(
            COST_MODELS_SQL(opts.sinceDays),
        ).pipe(Effect.map((r) => r?.[0] ?? []));

        // Lazy: the catalog round-trip only happens when some row actually
        // needs pricing resolution (stored zero cost with real tokens) - the
        // common all-priced window skips the extra query entirely.
        const catalog = rowsNeedPricing(rows)
            ? yield* loadPricingCatalogForModels(
                rows.map((row) => (row.model == null ? null : String(row.model))),
            )
            : EMPTY_PRICING_CATALOG;

        const parsed: CostModelsRow[] = rows.map((row) => {
            const model = row.model == null ? "(unattributed)" : String(row.model);
            const resolved = resolveRowCost({
                model,
                promptTokens: countField(row, "prompt_tokens"),
                completionTokens: countField(row, "completion_tokens"),
                cacheReadTokens: countField(row, "cache_read_tokens"),
                cacheCreateTokens: countField(row, "cache_create_tokens"),
                costUsd: countField(row, "cost_usd"),
            }, catalog);
            return {
                model,
                sessions: countField(row, "sessions"),
                prompt_tokens: countField(row, "prompt_tokens"),
                completion_tokens: countField(row, "completion_tokens"),
                cache_read_tokens: countField(row, "cache_read_tokens"),
                cache_create_tokens: countField(row, "cache_create_tokens"),
                cost_usd: resolved.cost_usd,
                unpriced: resolved.unpriced,
            };
        });

        // Sort by cost desc
        parsed.sort((a, b) => b.cost_usd - a.cost_usd);

        const total_cost_usd = parsed.reduce((sum, r) => sum + r.cost_usd, 0);
        return { rows: parsed, total_cost_usd } satisfies CostModelsResult;
    },
);

// ---------------------------------------------------------------------------
// cost sessions
// ---------------------------------------------------------------------------

export interface CostSessionsRow {
    readonly session_id: string;
    readonly project: string | null;
    readonly model: string | null;
    readonly started_at: string | null;
    readonly cost_usd: number;
    readonly completion_tokens: number;
    readonly cache_read_tokens: number;
}

export interface CostSessionsResult {
    readonly rows: ReadonlyArray<CostSessionsRow>;
}

const COST_SESSIONS_SQL = (sinceDays: number, limit: number, modelFilter: string | null) => {
    const whereFragments = [
        `ts > time::now() - ${sqlWindowDays(sinceDays)}d`,
        "estimated_cost_usd != NONE",
    ];
    if (modelFilter) {
        whereFragments.push(`model = ${surrealLiteral(modelFilter)}`);
    }
    const where = whereFragments.join(" AND ");
    return `
SELECT
    type::string(session) AS session_id,
    session.project AS project,
    model,
    type::string(session.started_at) AS started_at,
    estimated_cost_usd AS cost_usd,
    completion_tokens,
    cache_read_input_tokens AS cache_read_tokens
FROM session_token_usage
WHERE ${where}
ORDER BY estimated_cost_usd DESC
LIMIT ${Math.min(Math.max(1, Math.trunc(limit)), 500)};
`;
};

export const fetchCostSessions = Effect.fn("queries.fetchCostSessions")(
    function* (opts: {
        readonly sinceDays: number;
        readonly limit: number;
        readonly model: string | null;
    }) {
        const db = yield* SurrealClient;
        const rows = yield* db.query<[Array<Record<string, unknown>>]>(
            COST_SESSIONS_SQL(opts.sinceDays, opts.limit, opts.model),
        ).pipe(Effect.map((r) => r?.[0] ?? []));

        const parsed: CostSessionsRow[] = rows.map((row) => ({
            session_id: stringFieldOr(row, "session_id"),
            project: row.project == null ? null : String(row.project),
            model: row.model == null ? null : String(row.model),
            started_at: row.started_at == null ? null : String(row.started_at),
            cost_usd: countField(row, "cost_usd"),
            completion_tokens: countField(row, "completion_tokens"),
            cache_read_tokens: countField(row, "cache_read_tokens"),
        }));

        return { rows: parsed } satisfies CostSessionsResult;
    },
);

// ---------------------------------------------------------------------------
// cost split
// ---------------------------------------------------------------------------

export interface CostSplitRow {
    readonly origin: "main" | "subagent";
    readonly model: string;
    readonly sessions: number;
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly cache_read_tokens: number;
    readonly cache_create_tokens: number;
    readonly cost_usd: number;
    readonly share_pct: number;
    readonly unpriced: boolean;
}

export interface CostSplitTotals {
    readonly sessions: number;
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly cache_read_tokens: number;
    readonly cache_create_tokens: number;
    readonly cost_usd: number;
}

export interface CostSplitResult {
    readonly rows: ReadonlyArray<CostSplitRow>;
    readonly totals: CostSplitTotals;
    /** Global content-type breakdown across all sessions in the window.
     * CostSplitRow is aggregated by (origin x model) with no per-session id,
     * so per-row tagging is not meaningful - the distribution is a sibling
     * field instead. */
    readonly contentTypes: ContentTypeBreakdown;
}

const COST_SPLIT_SQL = (sinceDays: number) => `
SELECT
    source,
    model,
    count() AS sessions,
    math::sum(prompt_tokens) AS prompt_tokens,
    math::sum(completion_tokens) AS completion_tokens,
    math::sum(cache_read_input_tokens) AS cache_read_tokens,
    math::sum(cache_creation_input_tokens) AS cache_create_tokens,
    math::sum(estimated_cost_usd) AS cost_usd
FROM session_token_usage
WHERE ts > time::now() - ${sqlWindowDays(sinceDays)}d
GROUP BY source, model
ORDER BY cost_usd DESC;
`;

/**
 * Aggregate into (origin × model) cells where origin is "subagent" for any
 * subagent source (claude-subagent / codex-subagent) and "main" otherwise.
 * Aggregation + share computation run in JS after a single DB scan.
 */
export const fetchCostSplit = Effect.fn("queries.fetchCostSplit")(
    function* (opts: { readonly sinceDays: number }) {
        const db = yield* SurrealClient;
        const rows = yield* db.query<[Array<Record<string, unknown>>]>(
            COST_SPLIT_SQL(opts.sinceDays),
        ).pipe(Effect.map((r) => r?.[0] ?? []));

        // Aggregate per (origin × model)
        const cellMap = new Map<string, {
            origin: "main" | "subagent";
            model: string;
            sessions: number;
            prompt_tokens: number;
            completion_tokens: number;
            cache_read_tokens: number;
            cache_create_tokens: number;
            cost_usd: number;
        }>();

        for (const row of rows) {
            const origin = originOfSource(stringFieldOr(row, "source"));
            const model = row.model == null ? "(unattributed)" : String(row.model);
            const key = `${origin}\x00${model}`;

            const sessions = countField(row, "sessions");
            const prompt = countField(row, "prompt_tokens");
            const completion = countField(row, "completion_tokens");
            const cacheRead = countField(row, "cache_read_tokens");
            const cacheCreate = countField(row, "cache_create_tokens");
            const cost = countField(row, "cost_usd");

            const existing = cellMap.get(key);
            if (existing) {
                existing.sessions += sessions;
                existing.prompt_tokens += prompt;
                existing.completion_tokens += completion;
                existing.cache_read_tokens += cacheRead;
                existing.cache_create_tokens += cacheCreate;
                existing.cost_usd += cost;
            } else {
                cellMap.set(key, {
                    origin,
                    model,
                    sessions,
                    prompt_tokens: prompt,
                    completion_tokens: completion,
                    cache_read_tokens: cacheRead,
                    cache_create_tokens: cacheCreate,
                    cost_usd: cost,
                });
            }
        }

        // Lazy catalog load - see fetchCostModels; checked on the aggregated
        // cells since recompute operates at cell grain.
        const aggregated = [...cellMap.values()];
        const catalog = rowsNeedPricing(aggregated)
            ? yield* loadPricingCatalogForModels(aggregated.map((cell) => cell.model))
            : EMPTY_PRICING_CATALOG;

        // Resolve pricing per cell BEFORE totals/share so a recomputed cell's
        // dollars are reflected everywhere downstream (#696 live-smoke gap).
        const priced = aggregated.map((cell) => {
            const resolved = resolveRowCost({
                model: cell.model,
                promptTokens: cell.prompt_tokens,
                completionTokens: cell.completion_tokens,
                cacheReadTokens: cell.cache_read_tokens,
                cacheCreateTokens: cell.cache_create_tokens,
                costUsd: cell.cost_usd,
            }, catalog);
            return { ...cell, cost_usd: resolved.cost_usd, unpriced: resolved.unpriced };
        });

        const totalCost = priced.reduce((sum, c) => sum + c.cost_usd, 0);
        const totals: CostSplitTotals = {
            sessions: priced.reduce((sum, c) => sum + c.sessions, 0),
            prompt_tokens: priced.reduce((sum, c) => sum + c.prompt_tokens, 0),
            completion_tokens: priced.reduce((sum, c) => sum + c.completion_tokens, 0),
            cache_read_tokens: priced.reduce((sum, c) => sum + c.cache_read_tokens, 0),
            cache_create_tokens: priced.reduce((sum, c) => sum + c.cache_create_tokens, 0),
            cost_usd: totalCost,
        };

        const cells = priced.sort((a, b) => b.cost_usd - a.cost_usd);
        const splitRows: CostSplitRow[] = cells.map((cell) => ({
            ...cell,
            share_pct: totalCost > 0 ? (cell.cost_usd / totalCost) * 100 : 0,
        }));

        const contentTypes = yield* fetchContentTypeBreakdown();

        return { rows: splitRows, totals, contentTypes } satisfies CostSplitResult;
    },
);
