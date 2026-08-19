/**
 * @stage cache-bust
 * @rationale Populate the cache-bust ledger (#868): one priced row per usage
 * row whose billing event carried a cache_miss_reason, the substrate for
 * `ax cost cache` (what re-injects your context, and what re-establishing the
 * cache costs). The whole derivation is the cache-bust SQL MODEL
 * (models/cache-bust-event.sql) - filter + agent_model join + independent
 * flat-rate corroboration price, executed inside DuckDB; no rows cross the
 * JS boundary. Incremental by the ingest since-window; id ==
 * turn_token_usage.id so re-runs UPSERT idempotently; version-marked cutover
 * wipes + fully re-derives when the model SQL changes.
 */
import { Effect, Schema } from "effect";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { runCacheBustModels } from "./models/cache-bust-models.ts";
import { BaseStageStats, IngestContext, sinceDaysFromCtx, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

export class CacheBustStats extends BaseStageStats.extend<CacheBustStats>("CacheBustStats")({
    written: Schema.Number,
}) {}

export const cacheBustStage: StageDef<CacheBustStats, never, CacheWriteError> = {
    meta: StageMeta.make({
        // Deps: claude writes the only usage rows that carry
        // cache_miss_reason_type today; pricing writes the agent_model rates
        // the corroboration column joins.
        key: "cache-bust",
        deps: ["claude", "pricing"],
        tags: ["derive"],
        writes: [
            { table: "cache_bust_event", mode: "derive" },
            { table: "ingest_file_state", mode: "bookkeep" },
        ],
    }),
    run: (ctx: IngestContext, write: CacheWriteService) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const result = yield* runCacheBustModels(write, sinceDaysFromCtx(ctx));
            return CacheBustStats.make({
                durationMs: Date.now() - t0,
                summary: `derived ${result.written} cache-bust events (sql model${
                    result.rebuilt ? ", version cutover: rebuilt" : ""
                })`,
                written: result.written,
            });
        }),
};
