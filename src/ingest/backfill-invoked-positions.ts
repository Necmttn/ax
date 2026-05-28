/**
 * Backfill stage for P3.1: compute and write `turn_index`, `total_turns`, and
 * `is_first` onto every `invoked` edge that still carries NONE for any of those
 * fields.
 *
 * Rationale: these fields are written at RELATE time for new ingests
 * (turn_index = seq at that moment), but total_turns and is_first require the
 * full turn count per session and the per-(session, skill) group ordering -
 * information that is only stable after all transcripts are ingested. This
 * stage runs after `claude`, `codex`, and `subagents` to fill in those values.
 *
 * Algorithm (R4 - incremental-safe):
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

import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import { executeStatementsWith } from "../lib/shared/statement-exec.ts";

export interface BackfillInvokedPositionsStats {
    backfilled: number;
    sessions: number;
}

/** Row returned by the "find affected pairs" SELECT. */
type AffectedPairRow = { session: unknown; skill: unknown };

/** Row returned by the "all rows for a group" SELECT. */
type GroupRow = {
    id: unknown;
    seq: unknown;
    turn_index: unknown;
    total_turns: unknown;
    is_first: unknown;
};

/**
 * Idempotent backfill: recomputes is_first, total_turns, and turn_index for
 * every (session, skill) group that has at least one row with a missing field.
 * Rows that already carry the correct values are not re-updated.
 */
export const backfillInvokedPositions = (): Effect.Effect<
    BackfillInvokedPositionsStats,
    DbError,
    SurrealClient
> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;

        // 1. Identify affected (session, skill) pairs.
        //    A pair is "affected" when ANY of its invoked rows has a NONE field.
        const affectedPairs = (yield* db.query<[Array<AffectedPairRow>]>(
            `SELECT DISTINCT in.session AS session, out AS skill
             FROM invoked
             WHERE turn_index IS NONE OR total_turns IS NONE OR is_first IS NONE;`,
        ))?.[0] ?? [];

        if (affectedPairs.length === 0) {
            return { backfilled: 0, sessions: 0 };
        }

        // 2. Per-session turn counts. Fetch once; sessions can grow between runs
        //    so we always recompute total_turns even for already-filled rows.
        const turnCountRows = (yield* db.query<
            [Array<{ session: unknown; n: unknown }>]
        >(
            `SELECT session, count() AS n FROM turn GROUP BY session;`,
        ))?.[0] ?? [];

        const turnCountBySession = new Map<string, number>();
        for (const row of turnCountRows) {
            const session = String(row.session ?? "");
            const n = Number(row.n ?? 0);
            if (session) turnCountBySession.set(session, n);
        }

        // 3. For each affected pair, fetch ALL rows in the group and compute
        //    the desired state. Emit an UPDATE only when something changes.
        const stmts: string[] = [];
        const seenSessions = new Set<string>();

        for (const pair of affectedPairs) {
            const session = String(pair.session ?? "");
            const skill = String(pair.skill ?? "");
            if (!session || !skill) continue;

            seenSessions.add(session);

            // Fetch every invoked row for this (session, skill) pair.
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

                // turn_index: preserve RELATE-time snapshot; fill from seq only
                // when currently NONE.
                const currentTurnIndex =
                    row.turn_index !== null && row.turn_index !== undefined
                        ? Number(row.turn_index)
                        : null;
                const desiredTurnIndex = currentTurnIndex !== null ? currentTurnIndex : seq;

                // total_turns: always refresh (session size can grow).
                const desiredTotalTurns = totalTurns;

                // is_first: the row with the smallest seq in the full group.
                const desiredIsFirst = i === 0;

                // Compare current vs desired. Skip if everything already matches.
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

                if (!turnIndexChanged && !totalTurnsChanged && !isFirstChanged) {
                    continue; // already correct - skip
                }

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

        return {
            backfilled: stmts.length,
            sessions: seenSessions.size,
        };
    });
