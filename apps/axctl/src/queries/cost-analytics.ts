/**
 * `ax cost models / sessions / split`: model/cost analytics over
 * `session_token_usage`. GROUP BY stays on scalar fields of the scanned table
 * only (source, model); any grouping that needs a derived dimension (origin)
 * happens in JS after a single scan, so origin classification lives in one
 * place (`originOfSource`) instead of duplicated SQL CASE logic.
 *
 * Tables used (read-only):
 *   session_token_usage: source, model, prompt_tokens, completion_tokens,
 *     cache_creation_input_tokens, cache_read_input_tokens,
 *     estimated_cost_usd, ts
 *   session: id, source, project, started_at, model
 */
import { Effect, Schema } from "effect";
import { NumberFromBigIntColumn, TimestampColumn } from "@ax/lib/duckdb/columns";
import { CacheRead } from "@ax/lib/duckdb/seam";
import { eqClause, withinDaysClause } from "@ax/lib/duckdb/clause";
import { fetchContentTypeBreakdown, type ContentTypeBreakdown } from "./content-types.ts";
import { originOfSource } from "../ingest/source-origin.ts";
import { estimateCost, normalizeModelName, pricingForModel, type ModelPricing } from "../ingest/model-pricing.ts";
import { loadPricingCatalogForModels } from "../metrics/cost-estimate.ts";

// ---------------------------------------------------------------------------
// Row contracts
// ---------------------------------------------------------------------------

const nnum = Schema.NullOr(NumberFromBigIntColumn);

const CostModelsAggRow = Schema.Struct({
    model: Schema.NullOr(Schema.String),
    sessions: NumberFromBigIntColumn,
    priced_rows: Schema.NullOr(NumberFromBigIntColumn),
    unpriced_rows: Schema.NullOr(NumberFromBigIntColumn),
    prompt_tokens: nnum,
    completion_tokens: nnum,
    cache_read_tokens: nnum,
    cache_create_tokens: nnum,
    cost_usd: Schema.NullOr(Schema.Number),
});

const CostSplitAggRow = Schema.Struct({
    source: Schema.String,
    model: Schema.NullOr(Schema.String),
    sessions: NumberFromBigIntColumn,
    priced_rows: Schema.NullOr(NumberFromBigIntColumn),
    unpriced_rows: Schema.NullOr(NumberFromBigIntColumn),
    prompt_tokens: nnum,
    completion_tokens: nnum,
    cache_read_tokens: nnum,
    cache_create_tokens: nnum,
    cost_usd: Schema.NullOr(Schema.Number),
});

// ---------------------------------------------------------------------------
// Shared constants + SQL-boundary helpers
// ---------------------------------------------------------------------------

/** Default look-back window for all `ax cost *` subcommands (models / sessions / split). */
export const COST_DEFAULT_WINDOW_DAYS = 14;

/**
 * SQL-interpolation boundary guard for day-window values.
 *
 * Distinct from transport-level defaults: this guard lives at the SQL
 * interpolation site to prevent negative/fractional/NaN values reaching the
 * query. It is intentionally SEPARATE from clampInt / Flag.withDefault so
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
 * 1. A fully priced stored cost > 0 is real money - never mask or recompute it.
 * 2. Zero tokens is a genuine zero-usage row (including the "(unattributed)"
 *    sentinel) - show $0, not UNPRICED.
 * 3. A zero-cost or partly priced group with a catalog rate is recomputed from
 *    its token split at query time.
 * 4. A zero-cost or partly priced group without a catalog rate is flagged
 *    UNPRICED. A partial stored sum remains visible.
 */
const EMPTY_PRICING_CATALOG: ReadonlyMap<string, ModelPricing> = new Map();

/**
 * True when any row needs price resolution. This includes zero-cost rows and
 * groups with incomplete price coverage. Keeps the catalog DB round-trip out
 * of the common fully priced path.
 */
interface PriceableTotals {
    readonly cost_usd: number | null;
    readonly sessions?: number;
    readonly priced_rows?: number | null;
    readonly unpriced_rows?: number | null;
    readonly prompt_tokens: number | null;
    readonly completion_tokens: number | null;
    readonly cache_read_tokens: number | null;
    readonly cache_create_tokens: number | null;
}

const rowsNeedPricing = (rows: ReadonlyArray<PriceableTotals>): boolean =>
    rows.some((row) =>
        ((row.unpriced_rows ?? 0) > 0
            || (row.priced_rows != null && row.sessions !== undefined && row.priced_rows !== row.sessions)
            || (row.cost_usd ?? 0) === 0)
        && (row.prompt_tokens ?? 0) + (row.completion_tokens ?? 0)
            + (row.cache_read_tokens ?? 0) + (row.cache_create_tokens ?? 0) > 0,
    );

function resolveRowCost(
    input: {
        readonly model: string;
        readonly promptTokens: number;
        readonly completionTokens: number;
        readonly cacheReadTokens: number;
        readonly cacheCreateTokens: number;
        readonly costUsd: number;
        readonly rowCount: number;
        readonly pricedRows: number;
        readonly unpricedRows: number;
    },
    catalog: ReadonlyMap<string, ModelPricing>,
): { readonly cost_usd: number; readonly unpriced: boolean } {
    const storedCost = Number.isFinite(input.costUsd) ? input.costUsd : 0;
    const incompletePricing = input.unpricedRows > 0 || input.pricedRows !== input.rowCount;
    if (storedCost > 0 && !incompletePricing) {
        return { cost_usd: storedCost, unpriced: false };
    }
    const totalTokens = input.promptTokens + input.completionTokens + input.cacheReadTokens + input.cacheCreateTokens;
    if (totalTokens === 0) {
        return { cost_usd: 0, unpriced: false };
    }
    const modelKey = normalizeModelName(input.model);
    const pricing = pricingForModel(modelKey, catalog);
    if (!pricing) {
        return { cost_usd: storedCost, unpriced: true };
    }
    const estimate = estimateCost({
        modelKey,
        promptTokens: input.promptTokens,
        completionTokens: input.completionTokens,
        cacheCreationInputTokens: input.cacheCreateTokens,
        cacheReadInputTokens: input.cacheReadTokens,
        estimatedTokens: input.promptTokens,
        pricingCatalog: catalog,
        // A rollup group (many sessions summed), sometimes even a whole
        // session row - never one request's context. See plan 003.
        aggregated: true,
    });
    return estimate.totalUsd === null
        ? { cost_usd: storedCost, unpriced: true }
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
export const fetchCostModels = Effect.fn("queries.fetchCostModels")(
    function* (opts: { readonly sinceDays: number }) {
        const read = yield* CacheRead;
        const clause = withinDaysClause("ts", sqlWindowDays(opts.sinceDays));
        const rows = yield* read.rows(
            CostModelsAggRow,
            `SELECT
    model,
    count(*) AS sessions,
    count(estimated_cost_usd) AS priced_rows,
    count(*) FILTER (WHERE estimated_cost_usd IS NULL) AS unpriced_rows,
    coalesce(sum(prompt_tokens), 0) AS prompt_tokens,
    coalesce(sum(completion_tokens), 0) AS completion_tokens,
    coalesce(sum(cache_read_input_tokens), 0) AS cache_read_tokens,
    coalesce(sum(cache_creation_input_tokens), 0) AS cache_create_tokens,
    coalesce(sum(estimated_cost_usd), 0) AS cost_usd
FROM session_token_usage
WHERE 1 = 1 ${clause.sql}
GROUP BY model
ORDER BY cost_usd DESC;`,
            clause.params,
        );

        // Lazy: the catalog round-trip only happens when some row actually
        // needs pricing resolution (stored zero cost with real tokens) - the
        // common all-priced window skips the extra query entirely.
        const catalog = rowsNeedPricing(rows)
            ? yield* loadPricingCatalogForModels(
                read,
                rows.map((row) => row.model),
            )
            : EMPTY_PRICING_CATALOG;

        const parsed: CostModelsRow[] = rows.map((row) => {
            const model = row.model ?? "(unattributed)";
            const promptTokens = row.prompt_tokens ?? 0;
            const completionTokens = row.completion_tokens ?? 0;
            const cacheReadTokens = row.cache_read_tokens ?? 0;
            const cacheCreateTokens = row.cache_create_tokens ?? 0;
            const resolved = resolveRowCost({
                model,
                promptTokens,
                completionTokens,
                cacheReadTokens,
                cacheCreateTokens,
                costUsd: row.cost_usd ?? 0,
                rowCount: row.sessions,
                pricedRows: row.priced_rows ?? row.sessions,
                unpricedRows: row.unpriced_rows ?? 0,
            }, catalog);
            return {
                model,
                sessions: row.sessions,
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                cache_read_tokens: cacheReadTokens,
                cache_create_tokens: cacheCreateTokens,
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

const CostSessionsQueryRow = Schema.Struct({
    session_id: Schema.String,
    project: Schema.NullOr(Schema.String),
    model: Schema.NullOr(Schema.String),
    started_at: Schema.NullOr(TimestampColumn),
    cost_usd: Schema.NullOr(Schema.Number),
    completion_tokens: nnum,
    cache_read_tokens: nnum,
});

export const fetchCostSessions = Effect.fn("queries.fetchCostSessions")(
    function* (opts: {
        readonly sinceDays: number;
        readonly limit: number;
        readonly model: string | null;
    }) {
        const read = yield* CacheRead;
        const windowClause = withinDaysClause("stu.ts", sqlWindowDays(opts.sinceDays));
        const modelClause = eqClause("stu.model", opts.model);
        const limit = Math.min(Math.max(1, Math.trunc(opts.limit)), 500);
        const rows = yield* read.rows(
            CostSessionsQueryRow,
            `SELECT
    stu.session AS session_id,
    s.project AS project,
    stu.model AS model,
    s.started_at AS started_at,
    stu.estimated_cost_usd AS cost_usd,
    stu.completion_tokens AS completion_tokens,
    stu.cache_read_input_tokens AS cache_read_tokens
FROM session_token_usage stu
LEFT JOIN session s ON s.id = stu.session
WHERE stu.estimated_cost_usd IS NOT NULL ${windowClause.sql} ${modelClause.sql}
ORDER BY stu.estimated_cost_usd DESC
LIMIT ?;`,
            [...windowClause.params, ...modelClause.params, limit],
        );

        const parsed: CostSessionsRow[] = rows.map((row) => ({
            session_id: row.session_id,
            project: row.project,
            model: row.model,
            started_at: row.started_at === null ? null : row.started_at.toISOString(),
            cost_usd: row.cost_usd ?? 0,
            completion_tokens: row.completion_tokens ?? 0,
            cache_read_tokens: row.cache_read_tokens ?? 0,
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

/**
 * Aggregate into (origin × model) cells where origin is "subagent" for any
 * subagent source (claude-subagent / codex-subagent) and "main" otherwise.
 * Aggregation + share computation run in JS after a single DB scan.
 */
export const fetchCostSplit = Effect.fn("queries.fetchCostSplit")(
    function* (opts: { readonly sinceDays: number }) {
        const read = yield* CacheRead;
        const clause = withinDaysClause("ts", sqlWindowDays(opts.sinceDays));
        const rows = yield* read.rows(
            CostSplitAggRow,
            `SELECT
    source,
    model,
    count(*) AS sessions,
    count(estimated_cost_usd) AS priced_rows,
    count(*) FILTER (WHERE estimated_cost_usd IS NULL) AS unpriced_rows,
    coalesce(sum(prompt_tokens), 0) AS prompt_tokens,
    coalesce(sum(completion_tokens), 0) AS completion_tokens,
    coalesce(sum(cache_read_input_tokens), 0) AS cache_read_tokens,
    coalesce(sum(cache_creation_input_tokens), 0) AS cache_create_tokens,
    coalesce(sum(estimated_cost_usd), 0) AS cost_usd
FROM session_token_usage
WHERE 1 = 1 ${clause.sql}
GROUP BY source, model
ORDER BY cost_usd DESC;`,
            clause.params,
        );

        // Aggregate per (origin × model)
        const cellMap = new Map<string, {
            origin: "main" | "subagent";
            model: string;
            sessions: number;
            priced_rows: number;
            unpriced_rows: number;
            prompt_tokens: number;
            completion_tokens: number;
            cache_read_tokens: number;
            cache_create_tokens: number;
            cost_usd: number;
        }>();

        for (const row of rows) {
            const origin = originOfSource(row.source);
            const model = row.model ?? "(unattributed)";
            const key = `${origin}\x00${model}`;

            const sessions = row.sessions;
            const prompt = row.prompt_tokens ?? 0;
            const completion = row.completion_tokens ?? 0;
            const cacheRead = row.cache_read_tokens ?? 0;
            const cacheCreate = row.cache_create_tokens ?? 0;
            const cost = row.cost_usd ?? 0;
            const pricedRows = row.priced_rows ?? sessions;
            const unpricedRows = row.unpriced_rows ?? 0;

            const existing = cellMap.get(key);
            if (existing) {
                existing.sessions += sessions;
                existing.priced_rows += pricedRows;
                existing.unpriced_rows += unpricedRows;
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
                    priced_rows: pricedRows,
                    unpriced_rows: unpricedRows,
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
            ? yield* loadPricingCatalogForModels(read, aggregated.map((cell) => cell.model))
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
                rowCount: cell.sessions,
                pricedRows: cell.priced_rows,
                unpricedRows: cell.unpriced_rows,
            }, catalog);
            const { priced_rows: _pricedRows, unpriced_rows: _unpricedRows, ...publicCell } = cell;
            return { ...publicCell, cost_usd: resolved.cost_usd, unpriced: resolved.unpriced };
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
