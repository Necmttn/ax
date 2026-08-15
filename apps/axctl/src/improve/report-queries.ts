/**
 * Report graph queries: what the improve loop produced in a window.
 *
 *   listProposalsCreatedSince - proposals minted since a cutoff
 *   listVerdictsLockedSince    - checkpoints whose user_verdict was set since a cutoff
 *
 * Pure queries feeding `ax dojo report`; presentation lives in the caller.
 *
 * Datetime comparison inlines a real SurrealQL datetime literal via
 * `surrealDate` (the repo's dominant pattern - see session-metrics-query.ts /
 * aggregates.ts / session-churn.ts), not a `$bind`, so the cutoff is compared
 * as a datetime rather than a quoted string. SurrealDB 3.0 requires any ORDER
 * BY field to appear in the projection, so the sort key is selected and
 * stripped in JS (mirrors verdict-pending.ts).
 */

import { Effect, Schema } from "effect";
import { Judgment, TextColumn, type JudgmentError } from "@ax/lib/sqlite";

export interface CreatedProposalRow {
    readonly id: string;
    readonly title: string;
    readonly form: string;
    readonly dedupe_sig: string;
}

export interface LockedVerdictRow {
    readonly verdict: string;
    readonly title: string;
    readonly sig: string;
}

/** Oldest-first proposals minted at/after `since`. */
export const listProposalsCreatedSince = (
    since: Date,
): Effect.Effect<CreatedProposalRow[], JudgmentError, Judgment> =>
    Effect.gen(function* () {
        const judgment = yield* Judgment;
        return [...yield* judgment.rows(
            Schema.Struct({ id: TextColumn, title: TextColumn, form: TextColumn, dedupe_sig: TextColumn }),
            `SELECT id, title, form, dedupe_sig FROM proposal
             WHERE created_at >= ? ORDER BY created_at ASC LIMIT 50`,
            [since],
        )];
    });

/** Oldest-first checkpoints whose `user_verdict` was locked at/after `since`. */
export const listVerdictsLockedSince = (
    since: Date,
): Effect.Effect<LockedVerdictRow[], JudgmentError, Judgment> =>
    Effect.gen(function* () {
        const judgment = yield* Judgment;
        return [...yield* judgment.rows(
            Schema.Struct({ verdict: TextColumn, title: TextColumn, sig: TextColumn }),
            `SELECT c.user_verdict AS verdict, p.title, p.dedupe_sig AS sig
             FROM checkpoint c
             JOIN experiment e ON e.id = c.experiment
             JOIN proposal p ON p.id = e.proposal
             WHERE c.user_verdict IS NOT NULL AND c.observed_at >= ?
             ORDER BY c.observed_at ASC LIMIT 50`,
            [since],
        )];
    });
