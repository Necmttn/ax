/**
 * derive-directive-ngrams: Lift-refit ingest stage (Milestone A, Task A4 #587).
 *
 * Calls fetchDirectiveLift with a FIXED 90d window, then UPSERTs per-ngram
 * lift rows into the `directive_ngram` table so the table stays fresh across
 * incremental ingests regardless of `--since`.
 */

import { Effect, Schema } from "effect";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { stableId } from "@ax/lib/stable-id";
import {
    fetchDirectiveLift,
    type LiftRow,
} from "../queries/directive-ngrams.ts";
import {
    BaseStageStats,
    IngestContext,
    StageMeta,
} from "./stage/types.ts";
import type { IngestStageError, StageDef } from "./stage/registry.ts";

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export class DirectiveNgramsStats extends BaseStageStats.extend<DirectiveNgramsStats>(
    "DirectiveNgramsStats",
)({
    refit: Schema.Number,
}) {}

// ---------------------------------------------------------------------------
// Pure row builder (TDD surface)
// ---------------------------------------------------------------------------

/**
 * Build one `UPSERT directive_ngram:<safe-id> SET ...` statement per row.
 *
 * The record ID is derived from the ngram string via `safeKeyPart` so spaces
 * and special characters are safe for SurrealQL. The raw ngram text is stored
 * in the `ngram` field. `first_seen` is left to the schema default (never
 * overwritten on subsequent refits).
 */
export const buildNgramRows = (rows: readonly LiftRow[], now = new Date()) =>
    rows.map((row) => ({
        id: stableId("directive_ngram", [row.ngram]),
        ngram: row.ngram,
        n: row.n,
        occurrences: row.occurrences,
        outcomes: row.outcomes,
        sessions: row.sessions,
        lift: row.lift,
        last_seen: now,
        refit_at: now,
    }));

// ---------------------------------------------------------------------------
// Stage definition
// ---------------------------------------------------------------------------

export const DirectiveNgramsKey = Schema.Literal("directive-ngrams");
export type DirectiveNgramsKey = typeof DirectiveNgramsKey.Type;

/**
 * Directive-ngrams refit stage.
 *
 * Depends on {@link ClosureKey} (turns + outcomes must be written first).
 * Uses a FIXED 90d window so the lift table is stable across `--since` runs.
 */
export const directiveNgramsStage: StageDef<DirectiveNgramsStats, never, IngestStageError> = {
    meta: StageMeta.make({
        key: "directive-ngrams",
        deps: ["closure"],
        tags: ["derive"],
    }),
    run: (_ctx: IngestContext, write: CacheWriteService) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const rows = yield* fetchDirectiveLift(write, { sinceDays: 90 });
            const cacheRows = buildNgramRows(rows);
            if (cacheRows.length > 0) yield* write.putMany("directive_ngram", cacheRows);
            return DirectiveNgramsStats.make({
                durationMs: Date.now() - t0,
                summary: `refit ${rows.length} directive ngram lift rows`,
                refit: rows.length,
            });
        }),
};
