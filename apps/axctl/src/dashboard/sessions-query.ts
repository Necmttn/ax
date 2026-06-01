/**
 * sessions-query.ts - Effect functions for windowed session queries.
 *
 * Pure data layer: no IO formatting, no CLI concerns. Each function returns
 * typed rows from the `session` table with a lightweight turn summary.
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { recordLiteral } from "@ax/lib/ids";

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
 * Core session projection. Turn count and first-user-message are resolved
 * in a second batched query (`enrichSessions`) instead of correlated sub-
 * selects, which were O(N * turns_per_session) and hung at ~5k sessions.
 */
const SESSION_SELECT = `
    type::string(id) AS id,
    type::string(started_at) AS started_at,
    type::string(ended_at) AS ended_at,
    source,
    project,
    type::string(repository) AS repository
FROM session`.trim();

/**
 * Enrich session rows with turn_count + first_user_message via two bulk
 * queries instead of per-row sub-selects. Returns rows in original order.
 */
const enrichSessions = (
    rows: ReadonlyArray<{
        readonly id: string;
        readonly started_at: string | null;
        readonly ended_at: string | null;
        readonly source: string;
        readonly project: string | null;
        readonly repository: string | null;
    }>,
): Effect.Effect<SessionRow[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        if (rows.length === 0) return [];
        const db = yield* SurrealClient;

        // type::string(id) returns one of: `session:plain`, `session:⟨key⟩`,
        // or `` session:`key` `` depending on the key's char set. Strip prefix
        // + any wrapping delimiters so we can rebuild a clean backtick literal.
        const ids = rows.map((r) => {
            let k = r.id.replace(/^session:/, "");
            if (k.startsWith("⟨") && k.endsWith("⟩")) k = k.slice(1, -1);
            else if (k.startsWith("`") && k.endsWith("`")) k = k.slice(1, -1);
            return k;
        });
        const idLiterals = ids.map((k) => `session:\`${k}\``).join(", ");
        const inClause = `[${idLiterals}]`;

        const countResult = yield* db.query<[Array<{ session: unknown; n: number }>]>(
            `SELECT type::string(session) AS session, count() AS n FROM turn WHERE session IN ${inClause} GROUP BY session;`,
        );
        const counts = new Map<string, number>();
        for (const row of countResult?.[0] ?? []) {
            const sid = String(row.session);
            counts.set(sid, Number(row.n) || 0);
        }

        const firstResult = yield* db.query<[Array<{ session: unknown; text: string | null }>]>(
            `SELECT type::string(session) AS session, seq, text_excerpt AS text FROM turn
             WHERE session IN ${inClause} AND role = 'user'
             ORDER BY session, seq;`,
        );
        const firstMsg = new Map<string, string | null>();
        for (const row of firstResult?.[0] ?? []) {
            const sid = String(row.session);
            if (!firstMsg.has(sid)) firstMsg.set(sid, row.text ?? null);
        }

        return rows.map((r) => ({
            ...r,
            turn_count: counts.get(r.id) ?? 0,
            first_user_message: firstMsg.get(r.id) ?? null,
        }));
    });

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
        const result = yield* db.query<[Array<Omit<SessionRow, "turn_count" | "first_user_message">>]>(sql);
        return yield* enrichSessions(result?.[0] ?? []);
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

        const result = yield* db.query<[Array<Omit<SessionRow, "turn_count" | "first_user_message">>]>(sql, bindings);
        return yield* enrichSessions(result?.[0] ?? []);
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

        const result = yield* db.query<[Array<Omit<SessionRow, "turn_count" | "first_user_message">>]>(sql, { from: opts.from, to: opts.to });
        return yield* enrichSessions(result?.[0] ?? []);
    });
