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

import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { surrealLiteral } from "@ax/lib/json";
import type { DbError } from "@ax/lib/errors";

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
const buildWhereClause = (params: CostSummaryParams): string => {
    const where = ["estimated_cost_usd != NONE"];
    if (params.source) where.push(`source = ${surrealLiteral(params.source)}`);
    if (params.sinceDays !== null) {
        const since = Math.min(Math.max(Math.trunc(params.sinceDays), 1), 3650);
        where.push(`ts > time::now() - ${since}d`);
    }
    return `WHERE ${where.join(" AND ")}`;
};

/**
 * Run the three cost-summary scans (totals / by-model / recent) concurrently
 * against `session_token_usage`. Drives `axctl costs summary`.
 */
export const fetchCostSummaryRollup = (
    params: CostSummaryParams,
): Effect.Effect<CostSummaryResult, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const whereClause = buildWhereClause(params);
        const limit = Math.min(Math.max(params.limit, 1), 200);
        const [totals, byModel, recent] = yield* Effect.all([
            db.query<[Array<Record<string, unknown>>]>(`
SELECT count() AS sessions, math::sum(estimated_tokens) AS tokens, math::sum(prompt_tokens) AS prompt_tokens,
       math::sum(completion_tokens) AS completion_tokens, math::sum(cache_creation_input_tokens) AS cache_creation_input_tokens,
       math::sum(cache_read_input_tokens) AS cache_read_input_tokens, math::sum(estimated_cost_usd) AS cost
FROM session_token_usage
${whereClause}
GROUP ALL;`).pipe(Effect.map((rows) => rows?.[0] ?? [])),
            db.query<[Array<Record<string, unknown>>]>(`
SELECT source, model, pricing_source, count() AS sessions, math::sum(estimated_tokens) AS tokens,
       math::sum(prompt_tokens) AS prompt_tokens, math::sum(completion_tokens) AS completion_tokens,
       math::sum(cache_creation_input_tokens) AS cache_creation_input_tokens,
       math::sum(cache_read_input_tokens) AS cache_read_input_tokens,
       math::sum(estimated_cost_usd) AS cost
FROM session_token_usage
${whereClause}
GROUP BY source, model, pricing_source
ORDER BY cost DESC
LIMIT ${limit};`).pipe(Effect.map((rows) => rows?.[0] ?? [])),
            db.query<[Array<Record<string, unknown>>]>(`
SELECT session, source, model, estimated_tokens, estimated_cost_usd, pricing_source, type::string(ts) AS ts
FROM session_token_usage
${whereClause}
ORDER BY ts DESC
LIMIT ${limit};`).pipe(Effect.map((rows) => rows?.[0] ?? [])),
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
    DbError,
    SurrealClient
> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const rows = yield* db.query<[Array<Record<string, unknown>>]>(`
SELECT name, provider, display_name, input_per_million_usd, output_per_million_usd,
       cache_creation_per_million_usd, cache_read_per_million_usd,
       fast_multiplier, context_window, pricing_source
FROM agent_model
ORDER BY provider, name
LIMIT 5000;`).pipe(Effect.map((result) => result?.[0] ?? []));
        return rows;
    });
