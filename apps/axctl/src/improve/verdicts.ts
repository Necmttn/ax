/**
 * Named queries for `axctl improve verdict` - the experiment verdict surface.
 *
 * These reads do NOT decompose into a clean row->domain mapping the way the
 * `defineQuery`/`runQuery` seam expects: each statement carries a per-row
 * correlated subquery (`(SELECT ... FROM checkpoint WHERE experiment =
 * $parent.id ...)`) that materializes a nested `latest_checkpoint` /
 * `checkpoints` object the command handler then walks field-by-field. Per the
 * graph-access decision (2026-05-21), a query that doesn't decompose cleanly
 * stays a raw-SQL named function with a typed row interface rather than being
 * forced through the typed read DSL. The SQL is moved verbatim from
 * `cli/commands/improve.ts`; rows + output bytes are identical.
 */

import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { surrealLiteral } from "@ax/lib/json";
import type { DbError } from "@ax/lib/errors";

/** One experiment row in the verdict listing, with its newest checkpoint
 *  inlined as `latest_checkpoint` (or `null` when none exists yet). */
export type VerdictListRow = Record<string, unknown>;

/** One experiment row in the verdict drill-down, with all checkpoints inlined
 *  as the `checkpoints` array (newest first). */
export type VerdictShowRow = Record<string, unknown>;

/**
 * List every experiment with its newest suggested verdict (newest experiments
 * first, capped at 30). Drives `axctl improve verdict` (no positional arg).
 */
export const listVerdicts = (): Effect.Effect<
    ReadonlyArray<VerdictListRow>,
    DbError,
    SurrealClient
> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const rows = yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT
                proposal.title AS title,
                proposal.dedupe_sig AS dedupe_sig,
                artifact_path,
                type::string(created_at) AS created_at,
                type::string(scaffolded_at) AS scaffolded_at,
                locked_verdict,
                (SELECT kind, suggested, user_verdict, type::string(observed_at) AS observed_at FROM checkpoint WHERE experiment = $parent.id ORDER BY observed_at DESC LIMIT 1)[0] AS latest_checkpoint
            FROM experiment ORDER BY created_at DESC LIMIT 30;`,
        );
        return rows?.[0] ?? [];
    });

/**
 * Drill into one experiment matched by dedupe_sig OR record id, with every
 * checkpoint inlined (newest first). Returns the single matching row or `null`.
 * Drives `axctl improve verdict <id>` and the `--set` lock path.
 */
export const showVerdict = (
    sigOrId: string,
): Effect.Effect<VerdictShowRow | null, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const idLiteral = surrealLiteral(sigOrId);
        const sel = yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT
                id,
                proposal.title AS title,
                proposal.dedupe_sig AS dedupe_sig,
                proposal.status AS proposal_status,
                artifact_path,
                type::string(created_at) AS created_at,
                type::string(scaffolded_at) AS scaffolded_at,
                locked_verdict,
                (SELECT id, kind, suggested, user_verdict, measured, type::string(observed_at) AS observed_at FROM checkpoint WHERE experiment = $parent.id ORDER BY observed_at DESC) AS checkpoints
            FROM experiment
            WHERE proposal.dedupe_sig = ${idLiteral} OR id = ${idLiteral}
            LIMIT 1;`,
        );
        return (sel?.[0] ?? [])[0] ?? null;
    });
