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
 */

import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import { executeStatementsWith } from "../lib/shared/statement-exec.ts";

export interface BackfillInvokedPositionsStats {
    backfilled: number;
    sessions: number;
}

/**
 * One-shot idempotent backfill: for every invoked row where any of the three
 * position fields is NONE, compute the correct values from the per-session turn
 * count and the sorted (session, skill) group, then UPDATE the row.
 *
 * Second run is a no-op: the guard `WHERE turn_index IS NONE OR total_turns IS
 * NONE OR is_first IS NONE` returns 0 rows when everything is already filled.
 */
export const backfillInvokedPositions = (): Effect.Effect<
    BackfillInvokedPositionsStats,
    DbError,
    SurrealClient
> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;

        // 1. Find all invoked rows that need backfilling.
        //    The joined select pulls session + seq from the source turn so we
        //    don't need a second round-trip per row.
        const missingRows = (yield* db.query<
            [Array<{ id: unknown; session: unknown; seq: unknown; skill: unknown }>]
        >(
            `SELECT id, in.session AS session, in.seq AS seq, out AS skill
             FROM invoked
             WHERE turn_index IS NONE OR total_turns IS NONE OR is_first IS NONE;`,
        ))?.[0] ?? [];

        if (missingRows.length === 0) {
            return { backfilled: 0, sessions: 0 };
        }

        // 2. Per-session turn counts: how many turns exist for each session.
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

        // 3. Group invoked rows by (session, skill). Within each group, sort by
        //    seq ascending. First row in each group = is_first=true.
        type MissingRow = { id: unknown; session: unknown; seq: unknown; skill: unknown };
        const groups = new Map<string, MissingRow[]>();
        for (const row of missingRows) {
            const session = String(row.session ?? "");
            const skill = String(row.skill ?? "");
            const key = `${session}|||${skill}`;
            const existing = groups.get(key);
            if (existing) {
                existing.push(row);
            } else {
                groups.set(key, [row]);
            }
        }

        // Sort each group by seq ascending so the first element is is_first.
        for (const rows of groups.values()) {
            rows.sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));
        }

        // 4. Build UPDATE statements. One per invoked row, guarded by the NONE
        //    check so re-running is always a no-op for already-filled rows.
        const stmts: string[] = [];
        const seenSessions = new Set<string>();

        for (const [, rows] of groups) {
            for (let i = 0; i < rows.length; i += 1) {
                const row = rows[i]!;
                const session = String(row.session ?? "");
                const seq = Number(row.seq ?? 0);
                const id = String(row.id ?? "");
                const n = turnCountBySession.get(session) ?? null;
                const isFirst = i === 0;

                seenSessions.add(session);

                const totalTurns = n !== null ? String(n) : "NONE";
                stmts.push(
                    `UPDATE ${id} SET turn_index = ${seq}, total_turns = ${totalTurns}, is_first = ${isFirst} WHERE turn_index IS NONE OR total_turns IS NONE OR is_first IS NONE;`,
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
