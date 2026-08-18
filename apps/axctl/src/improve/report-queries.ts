/**
 * Report graph queries: what the improve loop produced in a window.
 *
 *   listProposalsCreatedSince - proposals minted since a cutoff
 *   listVerdictsLockedSince    - checkpoints whose user_verdict was set since a cutoff
 *
 * Pure queries feeding `ax dojo report`; presentation lives in the caller.
 *
 * Both queries run against the `Judgment` SQLite sidecar. The cutoff is a
 * bound `?` parameter (a real `Date`, not a stringified literal), and the
 * `ORDER BY` sort key does not need to appear in the `SELECT` projection.
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
