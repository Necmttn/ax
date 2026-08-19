/**
 * @stage invoked-positions
 * @rationale Computes and writes `turn_index`, `total_turns`, and `is_first`
 *   onto every `invoked` edge that still carries NONE for any of those fields.
 *   `turn_index` is written at RELATE time for new ingests, but `total_turns`
 *   and `is_first` require the full turn count per session and the per-
 *   (session, skill) group ordering - information that is only stable after
 *   all transcripts are ingested. This stage runs after `claude`, `codex`,
 *   and `subagents` to fill in those values.
 * @inputs `invoked` edges with NONE position fields
 * @outputs `invoked.turn_index`, `invoked.total_turns`, `invoked.is_first`
 * @order 80
 *
 * Algorithm (incremental-safe):
 *
 * 1. Identify affected (session, skill) pairs - those with ANY row where at
 *    least one position field is NONE. Even if only one new row was appended,
 *    we must recompute the full group to avoid marking a non-first invocation
 *    as is_first=true.
 *
 * 2. For each affected pair, fetch ALL invoked rows in that group.
 *
 * 3. Compute desired state:
 *    - turn_index: keep existing value if NOT NONE (RELATE-time snapshot);
 *      fall back to in.seq only when currently NONE.
 *    - total_turns: always recompute from current session turn count (sessions
 *      grow as new transcripts are appended).
 *    - is_first: always recompute - the row with the smallest seq in the group.
 *
 * 4. Emit UPDATE only when at least one field differs from the current value.
 *    Idempotent: a second run with no new data produces 0 updates.
 */

import { Effect, Schema } from "effect";
import { NumberFromBigIntColumn } from "@ax/lib/duckdb/columns";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { BaseStageStats, IngestContext, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

export interface BackfillInvokedPositionsStats {
    backfilled: number;
    sessions: number;
}

const PositionRow = Schema.Struct({
    id: Schema.String,
    session: Schema.String,
    skill: Schema.String,
    seq: NumberFromBigIntColumn,
    turn_index: Schema.NullOr(NumberFromBigIntColumn),
    total_turns: Schema.NullOr(NumberFromBigIntColumn),
    is_first: Schema.NullOr(Schema.Boolean),
    desired_total_turns: NumberFromBigIntColumn,
});

export const backfillInvokedPositions = (write: CacheWriteService): Effect.Effect<
    BackfillInvokedPositionsStats,
    CacheWriteError
> =>
    Effect.gen(function* () {
        const rows = yield* write.rows(PositionRow, `
            WITH affected AS (
                SELECT DISTINCT session, out_id
                FROM invoked
                WHERE turn_index IS NULL OR total_turns IS NULL OR is_first IS NULL
            ), turn_counts AS (
                SELECT session, count(*) AS n FROM turn GROUP BY session
            )
            SELECT i.id, i.session, i.out_id AS skill, t.seq, i.turn_index,
                   i.total_turns, i.is_first, tc.n AS desired_total_turns
            FROM invoked i
            JOIN affected a ON a.session = i.session AND a.out_id = i.out_id
            JOIN turn t ON t.id = i.in_id
            JOIN turn_counts tc ON tc.session = i.session
            ORDER BY i.session, i.out_id, t.seq
        `);
        const seenSessions = new Set<string>();
        let backfilled = 0;
        let previousPair = "";
        for (const row of rows) {
            seenSessions.add(row.session);
            const pair = `${row.session}\u0000${row.skill}`;
            const desiredIsFirst = pair !== previousPair;
            previousPair = pair;
            const desiredTurnIndex = row.turn_index ?? row.seq;
            if (
                row.turn_index !== null &&
                row.total_turns === row.desired_total_turns &&
                row.is_first === desiredIsFirst
            ) continue;
            yield* write.exec(
                "UPDATE invoked SET turn_index = ?, total_turns = ?, is_first = ? WHERE id = ?",
                [desiredTurnIndex, row.desired_total_turns, desiredIsFirst, row.id],
            );
            backfilled += 1;
        }
        return { backfilled, sessions: seenSessions.size };
    });

// ---------------------------------------------------------------------------
// Co-located StageDef
// ---------------------------------------------------------------------------

export const InvokedPositionsKey = Schema.Literal("invoked-positions");
export type InvokedPositionsKey = typeof InvokedPositionsKey.Type;

export class InvokedPositionsStats extends BaseStageStats.extend<InvokedPositionsStats>(
    "InvokedPositionsStats",
)({
    backfilled: Schema.Number,
    sessions: Schema.Number,
}) {}

/**
 * Invoked-positions stage - fills derived position fields on `invoked` edges.
 *
 * Depends on: claude, codex, subagents (all of which write `invoked`).
 * Consumed by: signals + the weighted-skills query.
 * Tags: derive
 */
export const invokedPositionsStage: StageDef<InvokedPositionsStats, never, CacheWriteError> = {
    meta: StageMeta.make({
        key: "invoked-positions",
        deps: ["claude", "codex", "subagents"],
        tags: ["derive"],
        writes: [{ table: "invoked", mode: "enrich" }],
    }),
    run: (_ctx: IngestContext, write) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const result = yield* backfillInvokedPositions(write);
            return InvokedPositionsStats.make({
                durationMs: Date.now() - t0,
                summary: `backfilled ${result.backfilled} invoked rows across ${result.sessions} sessions`,
                backfilled: result.backfilled,
                sessions: result.sessions,
            });
        }),
};
