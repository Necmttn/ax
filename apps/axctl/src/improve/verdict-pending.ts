/**
 * Pending-verdict experiments: rows in the improve loop whose
 * `locked_verdict` has not been set yet. Feeds the dojo agenda
 * (and anything else that wants "what still needs a human verdict").
 * Pure query - presentation lives in the caller.
 */

import { Effect, Schema } from "effect";
import { Judgment, TextColumn, type JudgmentError } from "@ax/lib/sqlite";

export interface PendingVerdictRow {
    readonly id: string;      // full record id string, e.g. "experiment:aaa"
    readonly sig: string;     // proposal dedupe_sig - the only id `ax improve verdict` resolves
    readonly title: string;   // proposal title
    readonly status: string;
}

/**
 * Oldest-first list of experiments still awaiting a locked verdict.
 * Ordered by `created_at` (always set; `scaffolded_at` is NONE for
 * status='task_emitted' rows, so it is not a safe sort key).
 */
export const listPendingVerdicts = (): Effect.Effect<PendingVerdictRow[], JudgmentError, Judgment> =>
    Effect.gen(function* () {
        const judgment = yield* Judgment;
        return [...yield* judgment.rows(
            Schema.Struct({ id: TextColumn, sig: TextColumn, title: TextColumn, status: TextColumn }),
            `SELECT e.id, p.dedupe_sig AS sig, p.title, e.status
             FROM experiment e JOIN proposal p ON p.id = e.proposal
             WHERE e.locked_verdict IS NULL AND e.status != 'retired'
             ORDER BY e.created_at ASC LIMIT 20`,
        )];
    });
