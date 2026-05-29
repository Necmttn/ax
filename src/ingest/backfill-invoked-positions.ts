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
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import { BaseStageStats, IngestContext, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";
import { executeStatementsWith } from "../lib/shared/statement-exec.ts";

export interface BackfillInvokedPositionsStats {
    backfilled: number;
    sessions: number;
}

type AffectedPairRow = { session: unknown; skill: unknown };
type GroupRow = {
    id: unknown;
    seq: unknown;
    turn_index: unknown;
    total_turns: unknown;
    is_first: unknown;
};

export const backfillInvokedPositions = (): Effect.Effect<
    BackfillInvokedPositionsStats,
    DbError,
    SurrealClient
> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;

        const affectedPairs = (yield* db.query<[Array<AffectedPairRow>]>(
            `SELECT DISTINCT in.session AS session, out AS skill
             FROM invoked
             WHERE turn_index IS NONE OR total_turns IS NONE OR is_first IS NONE;`,
        ))?.[0] ?? [];

        if (affectedPairs.length === 0) {
            return { backfilled: 0, sessions: 0 };
        }

        const turnCountRows = (yield* db.query<
            [Array<{ session: unknown; n: unknown }>]
        >(`SELECT session, count() AS n FROM turn GROUP BY session;`))?.[0] ?? [];

        const turnCountBySession = new Map<string, number>();
        for (const row of turnCountRows) {
            const session = String(row.session ?? "");
            const n = Number(row.n ?? 0);
            if (session) turnCountBySession.set(session, n);
        }

        const stmts: string[] = [];
        const seenSessions = new Set<string>();

        for (const pair of affectedPairs) {
            const session = String(pair.session ?? "");
            const skill = String(pair.skill ?? "");
            if (!session || !skill) continue;

            seenSessions.add(session);

            const groupRows = (yield* db.query<[Array<GroupRow>]>(
                `SELECT id, in.seq AS seq, turn_index, total_turns, is_first
                 FROM invoked
                 WHERE in.session = ${session} AND out = ${skill}
                 ORDER BY in.seq ASC;`,
            ))?.[0] ?? [];

            if (groupRows.length === 0) continue;

            const totalTurns = turnCountBySession.get(session) ?? null;

            for (let i = 0; i < groupRows.length; i += 1) {
                const row = groupRows[i]!;
                const id = String(row.id ?? "");
                if (!id) continue;

                const seq = Number(row.seq ?? 0);
                const currentTurnIndex =
                    row.turn_index !== null && row.turn_index !== undefined
                        ? Number(row.turn_index)
                        : null;
                const desiredTurnIndex = currentTurnIndex !== null ? currentTurnIndex : seq;
                const desiredTotalTurns = totalTurns;
                const desiredIsFirst = i === 0;

                const currentTotalTurns =
                    row.total_turns !== null && row.total_turns !== undefined
                        ? Number(row.total_turns)
                        : null;
                const currentIsFirst =
                    row.is_first !== null && row.is_first !== undefined
                        ? Boolean(row.is_first)
                        : null;

                const turnIndexChanged =
                    row.turn_index === null || row.turn_index === undefined;
                const totalTurnsChanged = currentTotalTurns !== desiredTotalTurns;
                const isFirstChanged = currentIsFirst !== desiredIsFirst;

                if (!turnIndexChanged && !totalTurnsChanged && !isFirstChanged) continue;

                const totalTurnsLit =
                    desiredTotalTurns !== null ? String(desiredTotalTurns) : "NONE";

                stmts.push(
                    `UPDATE ${id} SET turn_index = ${desiredTurnIndex}, total_turns = ${totalTurnsLit}, is_first = ${desiredIsFirst};`,
                );
            }
        }

        if (stmts.length > 0) {
            yield* executeStatementsWith(db, stmts, { chunkSize: 500 });
        }

        return { backfilled: stmts.length, sessions: seenSessions.size };
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
export const invokedPositionsStage: StageDef<InvokedPositionsStats, SurrealClient> = {
    meta: StageMeta.make({
        key: "invoked-positions",
        deps: ["claude", "codex", "subagents"],
        tags: ["derive"],
    }),
    run: (_ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const result = yield* backfillInvokedPositions();
            return InvokedPositionsStats.make({
                durationMs: Date.now() - t0,
                summary: `backfilled ${result.backfilled} invoked rows across ${result.sessions} sessions`,
                backfilled: result.backfilled,
                sessions: result.sessions,
            });
        }),
};
