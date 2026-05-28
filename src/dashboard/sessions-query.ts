/**
 * sessions-query.ts - Effect functions for windowed session queries.
 *
 * Pure data layer: no IO formatting, no CLI concerns. Each function returns
 * typed rows from the `session` table with a lightweight turn summary.
 */
import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import { recordLiteral } from "../lib/ids.ts";

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export interface SessionRow {
    readonly id: string;
    readonly started_at: string | null;
    readonly ended_at: string | null;
    readonly source: string;
    readonly project: string | null;
    readonly repository: string | null;
    readonly turn_count: number;
    readonly first_user_message: string | null;
}

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

/**
 * Build the SELECT projection shared by all three query functions.
 * Turn count and first-user-message are resolved with sub-selects.
 */
const SESSION_SELECT = `
    type::string(id) AS id,
    type::string(started_at) AS started_at,
    type::string(ended_at) AS ended_at,
    source,
    project,
    type::string(repository) AS repository,
    array::len((SELECT id FROM turn WHERE session = $parent.id)) AS turn_count,
    (SELECT VALUE text_excerpt FROM turn WHERE session = $parent.id AND role = 'user' ORDER BY seq LIMIT 1)[0] AS first_user_message
FROM session`.trim();

// ---------------------------------------------------------------------------
// listSessionsHere
// ---------------------------------------------------------------------------

export interface SessionsHereOpts {
    /**
     * Bare repository key (suitable for `recordLiteral("repository", key)`).
     * E.g. `remote__github_com_foo_bar__<hash>` - NOT the full record id string.
     */
    readonly repositoryKey: string;
    /** how many days back from now (default 14) */
    readonly days?: number;
}

/**
 * List sessions anchored to a specific repository within a look-back window.
 *
 * SurrealQL uses the `session_repository_started` composite index for efficiency.
 */
export const listSessionsHere = (
    opts: SessionsHereOpts,
): Effect.Effect<SessionRow[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const days = opts.days ?? 14;
        // `days` is a validated integer and `repositoryKey` is validated by recordLiteral -
        // literal interpolation is intentional: record-typed fields require record literals.
        const sql = `
SELECT ${SESSION_SELECT}
WHERE repository = ${recordLiteral("repository", opts.repositoryKey)}
  AND started_at >= time::now() - ${days}d
ORDER BY started_at DESC;`;
        const result = yield* db.query<[SessionRow[]]>(sql);
        return result?.[0] ?? [];
    });

// ---------------------------------------------------------------------------
// listSessionsAround
// ---------------------------------------------------------------------------

export interface SessionsAroundOpts {
    /** centre date */
    readonly date: Date;
    /** half-width of window in days (default 3) */
    readonly days?: number;
    /** optional Claude project slug filter */
    readonly project?: string | null;
}

/**
 * List sessions in the window [date - days, date + days].
 *
 * No git-repo dependency - pure time filter.
 */
export const listSessionsAround = (
    opts: SessionsAroundOpts,
): Effect.Effect<SessionRow[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const days = opts.days ?? 3;
        const from = new Date(opts.date.getTime() - days * 24 * 60 * 60 * 1000);
        const to = new Date(opts.date.getTime() + days * 24 * 60 * 60 * 1000);

        const projectClause = opts.project
            ? `  AND project = $project`
            : "";

        const sql = `
SELECT ${SESSION_SELECT}
WHERE started_at >= $from
  AND started_at <= $to${projectClause}
ORDER BY started_at DESC;`;

        const bindings: Record<string, unknown> = { from, to };
        if (opts.project) bindings.project = opts.project;

        const result = yield* db.query<[SessionRow[]]>(sql, bindings);
        return result?.[0] ?? [];
    });

// ---------------------------------------------------------------------------
// listSessionsNear
// ---------------------------------------------------------------------------

export interface SessionsNearOpts {
    /** start of commit window (predecessor ts or commitTs - 3d fallback) */
    readonly from: Date;
    /** end of commit window (commit ts or commitTs + 3d fallback) */
    readonly to: Date;
    /**
     * Bare repository key (suitable for `recordLiteral("repository", key)`).
     * Omit or pass null/undefined to skip the repo filter.
     */
    readonly repositoryKey?: string | null;
}

/**
 * List sessions within a commit-derived time window.
 *
 * Window comes from `findCommitWindow` (git-window.ts); caller is responsible
 * for resolving the adaptive window and repository id.
 */
export const listSessionsNear = (
    opts: SessionsNearOpts,
): Effect.Effect<SessionRow[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        // Record-typed fields require record literals, not bindings, for correct comparison.
        const repoClause = opts.repositoryKey
            ? `  AND repository = ${recordLiteral("repository", opts.repositoryKey)}`
            : "";

        const sql = `
SELECT ${SESSION_SELECT}
WHERE started_at >= $from
  AND started_at <= $to${repoClause}
ORDER BY started_at DESC;`;

        const result = yield* db.query<[SessionRow[]]>(sql, { from: opts.from, to: opts.to });
        return result?.[0] ?? [];
    });
