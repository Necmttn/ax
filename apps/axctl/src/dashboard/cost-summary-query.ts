/**
 * Named queries for `axctl costs summary` - the per-provider/model cost rollup.
 *
 * These three reads are correlated aggregate scans (`GROUP ALL`, `GROUP BY
 * source, model, pricing_source`) over `session_token_usage`, sharing one
 * runtime-built WHERE clause. The rows are heterogeneous aggregate shapes the
 * command handler formats field-by-field; they do NOT decompose into a clean
 * row->domain mapping, so per the graph-access decision (2026-05-21) they stay
 * raw-SQL named functions with typed row interfaces rather than being forced
 * through the `defineQuery`/`runQuery` typed read DSL. The SQL is moved verbatim
 * from `cli/commands/costs.ts`; rows + output bytes are identical.
 */

import { Effect, Schema } from "effect";
import { CacheRead, type CacheReadError, type DuckDbParam } from "@ax/lib/duckdb";
import { NumberFromBigIntColumn, TimestampColumn } from "@ax/lib/duckdb/columns";

/** One aggregate row (totals, by-model, or recent session). The handler reads
 *  its fields defensively, so the row stays untyped at the column level. */
export type CostSummaryRow = Record<string, unknown>;

export interface CostSummaryParams {
    readonly limit: number;
    readonly source: string | null;
    readonly sinceDays: number | null;
}

export interface CostSummaryResult {
    readonly totals: ReadonlyArray<CostSummaryRow>;
    readonly byModel: ReadonlyArray<CostSummaryRow>;
    readonly recent: ReadonlyArray<CostSummaryRow>;
}

/**
 * Build the shared WHERE clause for the cost-summary scans. Always filters to
 * priced rows; optionally narrows by source and a since-day window (clamped to
 * 1..3650 days, matching the original inline logic).
 */
const buildWhereClause = (params: CostSummaryParams): { sql: string; params: ReadonlyArray<DuckDbParam> } => {
    const where = ["estimated_cost_usd IS NOT NULL"];
    const bindings: DuckDbParam[] = [];
    if (params.source) { where.push("source = ?"); bindings.push(params.source); }
    if (params.sinceDays !== null) {
        const since = Math.min(Math.max(Math.trunc(params.sinceDays), 1), 3650);
        // CAST to naive TIMESTAMP before subtracting: DuckDB's bare
        // CURRENT_TIMESTAMP is TIMESTAMP WITH TIME ZONE, and ax's own icu-less
        // build has no `-(TIMESTAMP WITH TIME ZONE, INTERVAL)` overload (that
        // arithmetic is registered by the icu extension, which this build
        // doesn't link) - only `-(TIMESTAMP, INTERVAL)`. `ts` itself is a plain
        // UTC TIMESTAMP column (see schema.duckdb.sql), so casting the
        // comparison side to match is correct, not a workaround. Same idiom as
        // `assertUtcClock` in packages/lib/src/duckdb/seam.ts.
        where.push("ts > CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - (? * INTERVAL 1 DAY)");
        bindings.push(since);
    }
    return { sql: `WHERE ${where.join(" AND ")}`, params: bindings };
};

const TotalsRow = Schema.Struct({
    sessions: NumberFromBigIntColumn, tokens: Schema.NullOr(NumberFromBigIntColumn),
    prompt_tokens: Schema.NullOr(NumberFromBigIntColumn), completion_tokens: Schema.NullOr(NumberFromBigIntColumn),
    cache_creation_input_tokens: Schema.NullOr(NumberFromBigIntColumn), cache_read_input_tokens: Schema.NullOr(NumberFromBigIntColumn),
    cost: Schema.NullOr(Schema.Number),
});
const ByModelRow = Schema.Struct({
    source: Schema.String, model: Schema.NullOr(Schema.String), pricing_source: Schema.NullOr(Schema.String),
    ...TotalsRow.fields,
});
const RecentRow = Schema.Struct({
    session: Schema.String, source: Schema.String, model: Schema.NullOr(Schema.String),
    estimated_tokens: NumberFromBigIntColumn, estimated_cost_usd: Schema.NullOr(Schema.Number),
    pricing_source: Schema.NullOr(Schema.String), ts: TimestampColumn,
});

/**
 * Run the three cost-summary scans (totals / by-model / recent) concurrently
 * against `session_token_usage`. Drives `axctl costs summary`.
 */
export const fetchCostSummaryRollup = (
    params: CostSummaryParams,
): Effect.Effect<CostSummaryResult, CacheReadError, CacheRead> =>
    Effect.gen(function* () {
        const db = yield* CacheRead;
        const where = buildWhereClause(params);
        const limit = Math.min(Math.max(params.limit, 1), 200);
        const [totals, byModel, recent] = yield* Effect.all([
            db.rows(TotalsRow, `
SELECT count(*) AS sessions, CAST(sum(estimated_tokens) AS BIGINT) AS tokens, CAST(sum(prompt_tokens) AS BIGINT) AS prompt_tokens,
       CAST(sum(completion_tokens) AS BIGINT) AS completion_tokens, CAST(sum(cache_creation_input_tokens) AS BIGINT) AS cache_creation_input_tokens,
       CAST(sum(cache_read_input_tokens) AS BIGINT) AS cache_read_input_tokens, sum(estimated_cost_usd) AS cost
FROM session_token_usage
${where.sql}`, where.params),
            db.rows(ByModelRow, `
SELECT source, model, pricing_source, count(*) AS sessions, CAST(sum(estimated_tokens) AS BIGINT) AS tokens,
       CAST(sum(prompt_tokens) AS BIGINT) AS prompt_tokens, CAST(sum(completion_tokens) AS BIGINT) AS completion_tokens,
       CAST(sum(cache_creation_input_tokens) AS BIGINT) AS cache_creation_input_tokens,
       CAST(sum(cache_read_input_tokens) AS BIGINT) AS cache_read_input_tokens,
       sum(estimated_cost_usd) AS cost
FROM session_token_usage
${where.sql}
GROUP BY source, model, pricing_source
ORDER BY cost DESC
LIMIT ?`, [...where.params, limit]),
            db.rows(RecentRow, `
SELECT session, source, model, estimated_tokens, estimated_cost_usd, pricing_source, ts
FROM session_token_usage
${where.sql}
ORDER BY ts DESC
LIMIT ?`, [...where.params, limit]).pipe(
                Effect.map((rows) => rows.map((row) => ({ ...row, ts: row.ts.toISOString() }))),
            ),
        ], { concurrency: 3 });
        return { totals, byModel, recent };
    });

/** One model-pricing row from `agent_model`. Read defensively by the handler. */
export type PricingRow = Record<string, unknown>;

/**
 * Fetch every imported model-pricing row (ordered by provider, name; capped at
 * 5000). Drives `axctl pricing`; client-side filtering/limit stay in the
 * handler so the output bytes are unchanged.
 */
export const fetchPricingRows = (): Effect.Effect<
    ReadonlyArray<PricingRow>,
    CacheReadError,
    CacheRead
> =>
    Effect.gen(function* () {
        const db = yield* CacheRead;
        const PricingSchema = Schema.Struct({
            name: Schema.String, provider: Schema.String, display_name: Schema.NullOr(Schema.String),
            input_per_million_usd: Schema.NullOr(Schema.Number), output_per_million_usd: Schema.NullOr(Schema.Number),
            cache_creation_per_million_usd: Schema.NullOr(Schema.Number), cache_read_per_million_usd: Schema.NullOr(Schema.Number),
            fast_multiplier: Schema.NullOr(Schema.Number), context_window: Schema.NullOr(NumberFromBigIntColumn),
            pricing_source: Schema.NullOr(Schema.String),
        });
        const rows = yield* db.rows(PricingSchema, `
SELECT name, provider, display_name, input_per_million_usd, output_per_million_usd,
       cache_creation_per_million_usd, cache_read_per_million_usd,
       fast_multiplier, context_window, pricing_source
FROM agent_model
ORDER BY provider, name
LIMIT 5000`);
        return rows;
    });
