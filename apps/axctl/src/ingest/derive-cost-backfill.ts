/**
 * Derive-time cost backfill for `session_token_usage` rows that were never
 * priced at ingest (review must-fix on #175).
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
 * - Bounded: one indexed-or-full select over session_token_usage (one row per
 *   session, ~thousands) with a hard row cap; UPDATEs by primary record id in
 *   chunks. No edge derefs (hang safety).
 */
import { Effect, Schema } from "effect";
import { NumberFromBigIntColumn } from "@ax/lib/duckdb/columns";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import {
    fillEstimatedCost,
    isEstimatedPricingSource,
    loadPricingCatalogForModels,
} from "../metrics/cost-estimate.ts";
import { numOrNull, numOrZero, strOrNull } from "../metrics/util.ts";

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

const UsageRow = Schema.Struct({
    id: Schema.String,
    model: Schema.NullOr(Schema.String),
    prompt_tokens: Schema.NullOr(NumberFromBigIntColumn),
    completion_tokens: Schema.NullOr(NumberFromBigIntColumn),
    cache_creation_input_tokens: Schema.NullOr(NumberFromBigIntColumn),
    cache_read_input_tokens: Schema.NullOr(NumberFromBigIntColumn),
    estimated_tokens: NumberFromBigIntColumn,
    estimated_cost_usd: Schema.NullOr(Schema.Number),
    pricing_source: Schema.NullOr(Schema.String),
});

/**
 * Compute + persist `estimated_cost_usd` for stored token-usage rows that were
 * never priced. Returns counts for the stage summary.
 */
export const deriveCostBackfill = (
    write: CacheWriteService,
): Effect.Effect<CostBackfillStats, CacheWriteError> =>
    Effect.gen(function* () {
        const rows = yield* write.rows(
            UsageRow,
            `SELECT id, model, prompt_tokens, completion_tokens,`
            + ` cache_creation_input_tokens, cache_read_input_tokens, estimated_tokens,`
            + ` estimated_cost_usd, pricing_source`
            + ` FROM session_token_usage WHERE estimated_cost_usd IS NULL LIMIT ?`,
            [MAX_ROWS_PER_RUN],
        );
        if (rows.length === 0) return { scanned: 0, backfilled: 0, unpriced: 0 };

        const catalog = yield* loadPricingCatalogForModels(write, rows.map((r) => strOrNull(r.model)));

        let backfilled = 0;
        let unpriced = 0;
        for (const row of rows) {
            const storedCost = numOrNull(row.estimated_cost_usd);
            const storedSource = strOrNull(row.pricing_source);
            // Defensive double-guards (selection already excludes both): never
            // touch a row that somehow carries a stored cost, and never re-price
            // an already-estimated row (idempotency: catalog drift must not make
            // every derive run rewrite the whole table).
            if (storedCost !== null || isEstimatedPricingSource(storedSource)) continue;
            const filled = fillEstimatedCost({
                model: strOrNull(row.model),
                prompt_tokens: numOrNull(row.prompt_tokens),
                completion_tokens: numOrNull(row.completion_tokens),
                cache_creation_input_tokens: numOrNull(row.cache_creation_input_tokens),
                cache_read_input_tokens: numOrNull(row.cache_read_input_tokens),
                estimated_tokens: numOrZero(row.estimated_tokens),
                estimated_cost_usd: null,
                pricing_source: storedSource,
            }, catalog);
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
