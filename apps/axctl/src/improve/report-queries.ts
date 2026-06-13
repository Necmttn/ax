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

import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { surrealDate } from "@ax/lib/shared/surql";

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
): Effect.Effect<CreatedProposalRow[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const sql = `SELECT
                type::string(id) AS id,
                title,
                form,
                dedupe_sig,
                type::string(created_at) AS created_at
            FROM proposal
            WHERE created_at >= ${surrealDate(since)}
            ORDER BY created_at ASC
            LIMIT 50;`;
        const result = yield* db.query<[Array<CreatedProposalRow & { created_at?: string }>]>(sql);
        return (result?.[0] ?? []).map(({ id, title, form, dedupe_sig }) => ({ id, title, form, dedupe_sig }));
    });

/** Oldest-first checkpoints whose `user_verdict` was locked at/after `since`. */
export const listVerdictsLockedSince = (
    since: Date,
): Effect.Effect<LockedVerdictRow[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const sql = `SELECT
                user_verdict AS verdict,
                experiment.proposal.title AS title,
                experiment.proposal.dedupe_sig AS sig,
                type::string(observed_at) AS observed_at
            FROM checkpoint
            WHERE user_verdict IS NOT NONE AND observed_at >= ${surrealDate(since)}
            ORDER BY observed_at ASC
            LIMIT 50;`;
        const result = yield* db.query<[Array<LockedVerdictRow & { observed_at?: string }>]>(sql);
        return (result?.[0] ?? []).map(({ verdict, title, sig }) => ({ verdict, title, sig }));
    });
