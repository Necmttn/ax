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
 * Algorithm (set-based; #910 - a cold backfill touches ~90k rows, and the
 * original one-`UPDATE`-per-row loop burned the stage's 300s self-time budget
 * and got budget-stopped fail-open):
 *
 * 1. `DESIRED_POSITIONS_SQL` computes the desired `turn_index`/`total_turns`/
 *    `is_first` for every row belonging to an affected (session, out_id) pair
 *    - a pair is affected when ANY row in it still carries a NULL position
 *      field (matched via a correlated `EXISTS`, so recomputing an
 *      incrementally-appended group never flips an existing `is_first`
 *      wrongly). `turn_index` keeps the RELATE-time value when present,
 *      falling back to the joined turn's `seq`; `total_turns` is always the
 *      CURRENT per-session turn count; `is_first` is a `row_number() OVER
 *      (PARTITION BY session, out_id ORDER BY seq, id) = 1` - the `id`
 *      tie-break is a deliberate determinism improvement over the old loop's
 *      fetch-order tie-break (which had none for same-seq rows).
 *
 * 2. Stats are read FIRST via a `SELECT count(*)` / `count(DISTINCT session)`
 *    over that desired set, filtered to rows where at least one field is
 *    `IS DISTINCT FROM` its current value - this is what `backfilled` and
 *    `sessions` report, and is computed BEFORE the write so the stats and the
 *    update agree on exactly the same predicate.
 *
 * 3. One `UPDATE invoked ... FROM (<same query>) d WHERE invoked.id = d.id
 *    AND (<same IS DISTINCT FROM predicate>)` applies the change. The
 *    predicate is load-bearing: a second no-op run touches 0 rows (behavior-
 *    digest tests hash table contents, so an UPDATE that rewrites unchanged
 *    values would flip a digest even though nothing changed).
 */

import { Effect, Option, Schema } from "effect";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { BaseStageStats, IngestContext, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

export interface BackfillInvokedPositionsStats {
    backfilled: number;
    sessions: number;
}

/**
 * Desired turn_index/total_turns/is_first for every row of every (session,
 * out_id) pair that has at least one row with a NULL position field, alongside
 * that row's CURRENT values so callers can filter to what actually changes.
 * A plain SELECT (no CTE) so it can be embedded both wrapped in an aggregate
 * (stats) and as the `FROM` source of an `UPDATE ... FROM` (write).
 */
const DESIRED_POSITIONS_SQL = `
    SELECT
        i.id AS id,
        i.session AS session,
        i.turn_index AS current_turn_index,
        i.total_turns AS current_total_turns,
        i.is_first AS current_is_first,
        COALESCE(i.turn_index, t.seq) AS turn_index,
        tc.n AS total_turns,
        row_number() OVER (
            PARTITION BY i.session, i.out_id ORDER BY t.seq, i.id
        ) = 1 AS is_first
    FROM invoked i
    JOIN turn t ON t.id = i.in_id
    JOIN (SELECT session, count(*) AS n FROM turn GROUP BY session) tc
        ON tc.session = i.session
    WHERE EXISTS (
        SELECT 1 FROM invoked i2
        WHERE i2.session = i.session
          AND i2.out_id = i.out_id
          AND (i2.turn_index IS NULL OR i2.total_turns IS NULL OR i2.is_first IS NULL)
    )
`;

/** Rows of {@link DESIRED_POSITIONS_SQL} (aliased `alias`) whose desired value
 *  differs from its current one - the set both the stats query and the UPDATE
 *  agree on. Column names are qualified by `alias` because the UPDATE's `FROM`
 *  puts both `invoked` and the desired-set alias in scope at once, and
 *  `turn_index`/`total_turns`/`is_first` exist on both. */
const changedPredicate = (alias: string) => `
    ${alias}.current_turn_index IS DISTINCT FROM ${alias}.turn_index
    OR ${alias}.current_total_turns IS DISTINCT FROM ${alias}.total_turns
    OR ${alias}.current_is_first IS DISTINCT FROM ${alias}.is_first
`;

const StatsRow = Schema.Struct({
    backfilled: Schema.Number,
    sessions: Schema.Number,
});

export const backfillInvokedPositions = (write: CacheWriteService): Effect.Effect<
    BackfillInvokedPositionsStats,
    CacheWriteError
> =>
    Effect.gen(function* () {
        const stats = yield* write.first(StatsRow, `
            SELECT
                CAST(count(*) AS DOUBLE) AS backfilled,
                CAST(count(DISTINCT session) AS DOUBLE) AS sessions
            FROM (${DESIRED_POSITIONS_SQL}) x
            WHERE ${changedPredicate("x")}
        `);
        const { backfilled, sessions } = Option.getOrElse(
            stats,
            () => ({ backfilled: 0, sessions: 0 }),
        );
        if (backfilled > 0) {
            yield* write.exec(`
                UPDATE invoked
                SET turn_index = d.turn_index, total_turns = d.total_turns, is_first = d.is_first
                FROM (${DESIRED_POSITIONS_SQL}) d
                WHERE invoked.id = d.id AND (${changedPredicate("d")})
            `);
        }
        return { backfilled, sessions };
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
