/**
 * sessions-query.ts - Effect functions for windowed session queries.
 *
 * Pure data layer: no IO formatting, no CLI concerns. Each function returns
 * typed rows from the `session` table with a lightweight turn summary.
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { AxConfig } from "@ax/lib/config";
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
 * `type::string(id)` returns one of: `session:plain`, `session:⟨key⟩`, or
 * `` session:`key` `` depending on the key's char set. Strip the prefix + any
 * wrapping delimiters and rebuild a clean backtick record literal.
 */
const sessionLiteral = (id: string): string => {
    let k = id.replace(/^session:/, "");
    if (k.startsWith("⟨") && k.endsWith("⟩")) k = k.slice(1, -1);
    else if (k.startsWith("`") && k.endsWith("`")) k = k.slice(1, -1);
    return `session:\`${k}\``;
};

/**
 * Enrich session rows with turn_count + first_user_message.
 *
 * One INDEXED lookup per session, fanned out with bounded concurrency. The
 * obvious batch form - `... FROM turn WHERE session IN [<all ids>] ...` - does
 * NOT use the `turn_session_seq` index; SurrealDB evaluates `session IN [list]`
 * as a per-row membership test, so cost is O(total_turns × #sessions) and a
 * 120d/798-session window took >24s (and could wedge the DB). A literal-id
 * lookup (`session = session:\`k\``) hits the index in ~1ms; 798 of them at
 * concurrency 16 finish in well under a second. Order is preserved by
 * `Effect.forEach`.
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
): Effect.Effect<SessionRow[], DbError, SurrealClient | AxConfig> =>
    Effect.gen(function* () {
        if (rows.length === 0) return [];
        const db = yield* SurrealClient;
        // Fan-out width comes from AxConfig (the single env boundary), not a raw
        // process.env read. 16 is empirically fast (798 sessions ~1.3s through
        // the WS client, which multiplexes by request id); tune down via
        // AX_SESSIONS_ENRICH_CONCURRENCY if a load test shows saturation.
        const concurrency = (yield* AxConfig).knobs.sessionsEnrichConcurrency;

        return yield* Effect.forEach(
            rows,
            (r) =>
                Effect.gen(function* () {
                    const lit = sessionLiteral(r.id);
                    // `FROM ONLY <session record>` returns a single object; the
                    // two correlated counts use literal ids (not `$parent.id`,
                    // which would defeat the index).
                    const result = yield* db.query<
                        [{ turn_count: number | null; first_user_message: string | null } | null]
                    >(
                        `SELECT
                            (SELECT count() FROM turn WHERE session = ${lit} GROUP ALL)[0].count AS turn_count,
                            (SELECT VALUE text_excerpt FROM turn WHERE session = ${lit} AND role = 'user' ORDER BY seq ASC LIMIT 1)[0] AS first_user_message
                         FROM ONLY ${lit};`,
                    );
                    const enriched = result?.[0] ?? null;
                    return {
                        ...r,
                        turn_count: Number(enriched?.turn_count ?? 0) || 0,
                        first_user_message: enriched?.first_user_message ?? null,
                    };
                }),
            { concurrency },
        );
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
): Effect.Effect<SessionRow[], DbError, SurrealClient | AxConfig> =>
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
): Effect.Effect<SessionRow[], DbError, SurrealClient | AxConfig> =>
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
): Effect.Effect<SessionRow[], DbError, SurrealClient | AxConfig> =>
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
