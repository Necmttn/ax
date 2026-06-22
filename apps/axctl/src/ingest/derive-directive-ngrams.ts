/**
 * derive-directive-ngrams: Lift-refit ingest stage (Milestone A, Task A4 #587).
 *
 * Calls fetchDirectiveLift with a FIXED 90d window, then UPSERTs per-ngram
 * lift rows into the `directive_ngram` table so the table stays fresh across
 * incremental ingests regardless of `--since`.
 */

import { Effect, Schema } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { surrealString } from "@ax/lib/shared/surql";
import { executeStatementsWith } from "@ax/lib/shared/statement-exec";
import { safeKeyPart } from "@ax/lib/shared/derive-keys";
import {
    fetchDirectiveLift,
    type LiftRow,
} from "../queries/directive-ngrams.ts";
import {
    BaseStageStats,
    IngestContext,
    StageMeta,
} from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export class DirectiveNgramsStats extends BaseStageStats.extend<DirectiveNgramsStats>(
    "DirectiveNgramsStats",
)({
    refit: Schema.Number,
}) {}

// ---------------------------------------------------------------------------
// Pure statement builder (TDD surface)
// ---------------------------------------------------------------------------

/**
 * Build one `UPSERT directive_ngram:<safe-id> SET ...` statement per row.
 *
 * The record ID is derived from the ngram string via `safeKeyPart` so spaces
 * and special characters are safe for SurrealQL. The raw ngram text is stored
 * in the `ngram` field. `first_seen` is left to the schema default (never
 * overwritten on subsequent refits).
 */
export const buildNgramUpsertStatements = (rows: readonly LiftRow[]): string[] =>
    rows.map((row) => {
        const id = safeKeyPart(row.ngram);
        return (
            `UPSERT directive_ngram:${id} SET ` +
            `ngram = ${surrealString(row.ngram)}, ` +
            `n = ${row.n}, ` +
            `occurrences = ${row.occurrences}, ` +
            `outcomes = ${row.outcomes}, ` +
            `sessions = ${row.sessions}, ` +
            `lift = ${row.lift}, ` +
            `last_seen = time::now(), ` +
            `refit_at = time::now();`
        );
    });

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
export const directiveNgramsStage: StageDef<DirectiveNgramsStats, SurrealClient> = {
    meta: StageMeta.make({
        key: "directive-ngrams",
        deps: ["closure"],
        tags: ["derive"],
    }),
    run: (_ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const rows = yield* fetchDirectiveLift({ sinceDays: 90 });
            const stmts = buildNgramUpsertStatements(rows);
            if (stmts.length > 0) {
                yield* executeStatementsWith(yield* SurrealClient, stmts, {
                    chunkSize: 500,
                });
            }
            return DirectiveNgramsStats.make({
                durationMs: Date.now() - t0,
                summary: `refit ${rows.length} directive ngram lift rows`,
                refit: rows.length,
            });
        }),
};
