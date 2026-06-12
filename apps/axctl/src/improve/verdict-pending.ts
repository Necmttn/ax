/**
 * Pending-verdict experiments: rows in the improve loop whose
 * `locked_verdict` has not been set yet. Feeds the dojo agenda
 * (and anything else that wants "what still needs a human verdict").
 * Pure query - presentation lives in the caller.
 */

import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";

export interface PendingVerdictRow {
    readonly id: string;      // full record id string, e.g. "experiment:aaa"
    readonly title: string;   // proposal title
    readonly status: string;
}

/**
 * Oldest-first list of experiments still awaiting a locked verdict.
 * Ordered by `created_at` (always set; `scaffolded_at` is NONE for
 * status='task_emitted' rows, so it is not a safe sort key).
 */
export const listPendingVerdicts = (): Effect.Effect<PendingVerdictRow[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        // SurrealDB 3.0 requires the ORDER BY field to appear in the
        // projection, so created_at is selected and stripped below.
        const sql = `SELECT
                type::string(id) AS id,
                proposal.title AS title,
                status,
                type::string(created_at) AS created_at
            FROM experiment
            WHERE locked_verdict IS NONE AND status != 'retired'
            ORDER BY created_at ASC
            LIMIT 20;`; // cap keeps the dojo agenda to one reviewable sitting
        const result = yield* db.query<[Array<PendingVerdictRow & { created_at?: string }>]>(sql);
        return (result?.[0] ?? []).map(({ id, title, status }) => ({ id, title, status }));
    });
