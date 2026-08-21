/**
 * Derive-time cost backfill for session and turn token usage rows that were
 * never priced at ingest (review must-fix on #175 and #937).
 *
 * The read-time estimator (`metrics/cost-estimate.ts`) fixed only the 3
 * surfaces that call `fillEstimatedCost`; every other reader (dashboard cost
 * view, session summaries, share manifests, studio routes) still summed the
 * stored nulls as $0, and ingest never healed them - so each NEW surface had
 * to remember the read-time helper forever. This module moves the fix down a
 * level: on the derive path it computes the same estimate ONCE and writes it
 * back into the stored row with `pricing_source = "estimated:<catalog>"`, so
 * every reader of `session_token_usage` sees the cost for free. Read-time
 * `fillEstimatedCost` stays as a safety net for rows ingested after the last
 * derive run.
 *
 * Invariants:
 * - NEVER overwrites a provider/ingest-priced cost: selection is
 *   `WHERE estimated_cost_usd IS NONE`, and each UPDATE repeats the guard so a
 *   concurrent pricing write wins.
 * - Idempotent: backfilled rows have a non-null cost, so the next run's
 *   selection skips them (rows whose `pricing_source` already starts with
 *   `estimated:` are also skipped in JS, defensively). Re-pricing after a
 *   catalog change is intentionally NOT done here - delete the stored
 *   `estimated:` costs to force a recompute.
 * - Bounded: direct selects over both usage tables share one hard row cap.
 *   UPDATEs use primary record ids. No edge derefs exist on this path.
 */
import { Effect, Schema } from "effect";
import { NumberFromBigIntColumn } from "@ax/lib/duckdb/columns";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import {
    ESTIMATED_PRICING_PREFIX,
    fillEstimatedCost,
    isEstimatedPricingSource,
    loadPricingCatalogForModels,
} from "../metrics/cost-estimate.ts";
import { numOrNull, numOrZero, strOrNull } from "../metrics/util.ts";
import { estimateCost, normalizeModelName } from "./model-pricing.ts";

export interface CostBackfillStats {
    /** Null-cost rows scanned this run. */
    readonly scanned: number;
    /** Rows whose estimated cost was computed and written back. */
    readonly backfilled: number;
    /** Rows left null (unknown/unpriceable model - unknown ≠ $0). */
    readonly unpriced: number;
}

/** Hard cap on rows per run (one row per session - generous headroom; residual
 *  rows heal on the next derive run, which the daemon triggers per ingest). */
const MAX_ROWS_PER_RUN = 20_000;
const MIN_TURN_ROWS_PER_RUN = MAX_ROWS_PER_RUN / 2;

const UsageRow = Schema.Struct({
    id: Schema.String,
    session: Schema.String,
    model: Schema.NullOr(Schema.String),
    prompt_tokens: Schema.NullOr(NumberFromBigIntColumn),
    completion_tokens: Schema.NullOr(NumberFromBigIntColumn),
    cache_creation_input_tokens: Schema.NullOr(NumberFromBigIntColumn),
    cache_read_input_tokens: Schema.NullOr(NumberFromBigIntColumn),
    estimated_tokens: NumberFromBigIntColumn,
    estimated_cost_usd: Schema.NullOr(Schema.Number),
    pricing_source: Schema.NullOr(Schema.String),
});

const TurnCoverageRow = Schema.Struct({
    session: Schema.String,
    turn_rows: NumberFromBigIntColumn,
    priced_rows: NumberFromBigIntColumn,
    prompt_tokens: NumberFromBigIntColumn,
    completion_tokens: NumberFromBigIntColumn,
    cache_creation_input_tokens: NumberFromBigIntColumn,
    cache_read_input_tokens: NumberFromBigIntColumn,
    estimated_tokens: NumberFromBigIntColumn,
    cost_usd: Schema.NullOr(Schema.Number),
});

type TurnCoverage = typeof TurnCoverageRow.Type;

const COMPLETE_TURN_PRICING_SOURCE = `${ESTIMATED_PRICING_PREFIX}turn_sum:complete_turn_coverage`;
const INCOMPLETE_TURN_PRICING_SOURCE =
    `${ESTIMATED_PRICING_PREFIX}turn_sum+session_fallback:incomplete_turn_coverage`;

/**
 * Compute + persist `estimated_cost_usd` for stored token-usage rows that were
 * never priced. Returns counts for the stage summary.
 */
export const deriveCostBackfill = (
    write: CacheWriteService,
): Effect.Effect<CostBackfillStats, CacheWriteError> =>
    Effect.gen(function* () {
        const turnRows = yield* write.rows(
            UsageRow,
            `SELECT id, session, model, prompt_tokens, completion_tokens,`
            + ` cache_creation_input_tokens, cache_read_input_tokens, estimated_tokens,`
            + ` estimated_cost_usd, pricing_source`
            + ` FROM turn_token_usage WHERE estimated_cost_usd IS NULL LIMIT ?`,
            [MIN_TURN_ROWS_PER_RUN],
        );
        const sessionLimit = MAX_ROWS_PER_RUN - turnRows.length;
        const sessionRows = sessionLimit === 0
            ? []
            : yield* write.rows(
                UsageRow,
                `SELECT id, session, model, prompt_tokens, completion_tokens,`
                + ` cache_creation_input_tokens, cache_read_input_tokens, estimated_tokens,`
                + ` estimated_cost_usd, pricing_source`
                + ` FROM session_token_usage WHERE estimated_cost_usd IS NULL LIMIT ?`,
                [sessionLimit],
            );
        const rows = [...sessionRows, ...turnRows];
        if (rows.length === 0) return { scanned: 0, backfilled: 0, unpriced: 0 };

        const catalog = yield* loadPricingCatalogForModels(write, rows.map((r) => strOrNull(r.model)));

        let backfilled = 0;
        let unpriced = 0;
        for (const row of turnRows) {
            const storedCost = numOrNull(row.estimated_cost_usd);
            const storedSource = strOrNull(row.pricing_source);
            // Defensive double-guards (selection already excludes both): never
            // touch a row that somehow carries a stored cost, and never re-price
            // an already-estimated row (idempotency: catalog drift must not make
            // every derive run rewrite the whole table).
            if (storedCost !== null || isEstimatedPricingSource(storedSource)) continue;
            const cost = estimateCost({
                modelKey: normalizeModelName(strOrNull(row.model)),
                promptTokens: numOrNull(row.prompt_tokens),
                completionTokens: numOrNull(row.completion_tokens),
                cacheCreationInputTokens: numOrNull(row.cache_creation_input_tokens),
                cacheReadInputTokens: numOrNull(row.cache_read_input_tokens),
                estimatedTokens: numOrZero(row.estimated_tokens),
                pricingCatalog: catalog,
            });
            if (cost.totalUsd === null || cost.pricingSource === null) {
                unpriced += 1;
                continue;
            }
            yield* write.exec(
                `UPDATE turn_token_usage SET estimated_input_cost_usd = ?,`
                    + ` estimated_output_cost_usd = ?, estimated_cache_creation_cost_usd = ?,`
                    + ` estimated_cache_read_cost_usd = ?, estimated_cost_usd = ?, pricing_source = ?`
                    + ` WHERE id = ? AND estimated_cost_usd IS NULL`,
                [
                    cost.inputUsd,
                    cost.outputUsd,
                    cost.cacheCreationUsd,
                    cost.cacheReadUsd,
                    cost.totalUsd,
                    `${ESTIMATED_PRICING_PREFIX}${cost.pricingSource}`,
                    row.id,
                ],
            );
            backfilled += 1;
        }

        const coverageRows: TurnCoverage[] = [];
        const coverageBatchSize = 500;
        for (let start = 0; start < sessionRows.length; start += coverageBatchSize) {
            const batch = sessionRows.slice(start, start + coverageBatchSize);
            const placeholders = batch.map(() => "?").join(", ");
            coverageRows.push(...yield* write.rows(
                TurnCoverageRow,
                `SELECT session, count(*) AS turn_rows, count(estimated_cost_usd) AS priced_rows,`
                    + ` coalesce(sum(prompt_tokens), 0) AS prompt_tokens,`
                    + ` coalesce(sum(completion_tokens), 0) AS completion_tokens,`
                    + ` coalesce(sum(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,`
                    + ` coalesce(sum(cache_read_input_tokens), 0) AS cache_read_input_tokens,`
                    + ` coalesce(sum(estimated_tokens), 0) AS estimated_tokens,`
                    + ` sum(estimated_cost_usd) AS cost_usd`
                    + ` FROM turn_token_usage WHERE session IN (${placeholders}) GROUP BY session`,
                batch.map((row) => row.session),
            ));
        }
        const coverageBySession = new Map(coverageRows.map((row) => [row.session, row]));

        for (const row of sessionRows) {
            const storedCost = numOrNull(row.estimated_cost_usd);
            const storedSource = strOrNull(row.pricing_source);
            if (storedCost !== null || isEstimatedPricingSource(storedSource)) continue;
            const usage = {
                model: strOrNull(row.model),
                prompt_tokens: numOrNull(row.prompt_tokens),
                completion_tokens: numOrNull(row.completion_tokens),
                cache_creation_input_tokens: numOrNull(row.cache_creation_input_tokens),
                cache_read_input_tokens: numOrNull(row.cache_read_input_tokens),
                estimated_tokens: numOrZero(row.estimated_tokens),
                estimated_cost_usd: null,
                pricing_source: storedSource,
            };
            const coverage = coverageBySession.get(row.session);
            if (coverage !== undefined) {
                if (coverage.priced_rows !== coverage.turn_rows || coverage.cost_usd === null) {
                    unpriced += 1;
                    continue;
                }
                const totals = [
                    [usage.prompt_tokens, coverage.prompt_tokens],
                    [usage.completion_tokens, coverage.completion_tokens],
                    [usage.cache_creation_input_tokens, coverage.cache_creation_input_tokens],
                    [usage.cache_read_input_tokens, coverage.cache_read_input_tokens],
                    [usage.estimated_tokens, coverage.estimated_tokens],
                ] as const;
                if (totals.some(([total, covered]) => total !== null && covered > total)) {
                    unpriced += 1;
                    continue;
                }
                const incomplete = totals.some(([total, covered]) => total !== null && covered < total);
                let sessionCost = coverage.cost_usd;
                let pricingSource = COMPLETE_TURN_PRICING_SOURCE;
                if (incomplete) {
                    const remainder = estimateCost({
                        modelKey: normalizeModelName(usage.model),
                        promptTokens: usage.prompt_tokens === null
                            ? null
                            : usage.prompt_tokens - coverage.prompt_tokens,
                        completionTokens: usage.completion_tokens === null
                            ? null
                            : usage.completion_tokens - coverage.completion_tokens,
                        cacheCreationInputTokens: usage.cache_creation_input_tokens === null
                            ? null
                            : usage.cache_creation_input_tokens - coverage.cache_creation_input_tokens,
                        cacheReadInputTokens: usage.cache_read_input_tokens === null
                            ? null
                            : usage.cache_read_input_tokens - coverage.cache_read_input_tokens,
                        estimatedTokens: Math.max(0, usage.estimated_tokens - coverage.estimated_tokens),
                        pricingCatalog: catalog,
                        aggregated: true,
                    });
                    if (remainder.totalUsd === null) {
                        unpriced += 1;
                        continue;
                    }
                    sessionCost += remainder.totalUsd;
                    pricingSource = INCOMPLETE_TURN_PRICING_SOURCE;
                }
                yield* write.exec(
                    `UPDATE session_token_usage SET estimated_cost_usd = ?, pricing_source = ?`
                        + ` WHERE id = ? AND estimated_cost_usd IS NULL`,
                    [sessionCost, pricingSource, row.id],
                );
                backfilled += 1;
                continue;
            }
            const filled = fillEstimatedCost(usage, catalog);
            if (!filled.estimated || filled.estimatedCostUsd === null || filled.pricingSource === null) {
                unpriced += 1;
                continue;
            }
            // UPDATE by primary record id (never DELETE/UPDATE-WHERE over an
            // indexed field - ghost-index drift, PR #141); the IS NONE guard
            // re-checks at write time so a concurrent ingest-priced cost wins.
            yield* write.exec(
                `UPDATE session_token_usage SET estimated_cost_usd = ?, pricing_source = ?`
                    + ` WHERE id = ? AND estimated_cost_usd IS NULL`,
                [filled.estimatedCostUsd, filled.pricingSource, row.id],
            );
            backfilled += 1;
        }
        return { scanned: rows.length, backfilled, unpriced };
    });
