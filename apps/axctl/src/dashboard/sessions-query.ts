/**
 * sessions-query.ts - Effect functions for windowed session queries.
 *
 * Pure data layer: no IO formatting, no CLI concerns. Each function returns
 * typed rows from the `session` table with a lightweight turn summary.
 *
 * A real `GROUP BY` aggregate plus a `row_number() OVER (PARTITION BY
 * session ...)` window compute `turn_count` + `first_user_message` using the
 * `turn_session_seq` index directly, so the whole session list - projection
 * AND enrichment - is ONE statement with two `LEFT JOIN`s, not a fan-out of
 * one indexed query per session. There is accordingly no per-session
 * concurrency knob in any signature here.
 */
import { Effect, Schema } from "effect";
import { andAll, eqClause, withinDaysClause, type Clause } from "@ax/lib/duckdb/clause";
import { NumberFromBigIntColumn, TimestampColumn } from "@ax/lib/duckdb/columns";
import { cacheRows } from "@ax/lib/duckdb/query";
import { CacheRead } from "@ax/lib/duckdb/seam";
import { sessionIdsByPrefixCacheQuery } from "../queries/session-detail-cache.ts";
import { runCacheQuery } from "@ax/lib/duckdb/query";
import { toBareSessionId } from "@ax/lib/shared/session-id";

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export interface SessionRow {
    readonly id: string;
    readonly started_at: string | null;
    readonly ended_at: string | null;
    readonly source: string;
    readonly project: string | null;
    /** Session working directory - feeds the resume-command NavLink. */
    readonly cwd: string | null;
    readonly repository: string | null;
    readonly turn_count: number;
    readonly first_user_message: string | null;
}

const NullableText = Schema.NullOr(Schema.String);
const NullableTimestamp = Schema.NullOr(TimestampColumn);

const SessionEnrichedRow = Schema.Struct({
    id: Schema.String,
    started_at: NullableTimestamp,
    ended_at: NullableTimestamp,
    source: Schema.String,
    project: NullableText,
    cwd: NullableText,
    repository: NullableText,
    turn_count: NumberFromBigIntColumn,
    first_user_message: NullableText,
});

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

const toSessionRow = (row: typeof SessionEnrichedRow.Type): SessionRow => ({
    id: toBareSessionId(row.id),
    started_at: iso(row.started_at),
    ended_at: iso(row.ended_at),
    source: row.source,
    project: row.project,
    cwd: row.cwd,
    repository: row.repository,
    turn_count: row.turn_count,
    first_user_message: row.first_user_message,
});

/**
 * The one session projection every list variant shares: turn count and the
 * first user-role turn's excerpt, both joined in rather than fanned out.
 * `where` is appended after `WHERE TRUE` on the outer `session s` scan.
 */
const fetchSessions = (where: Clause): Effect.Effect<SessionRow[], never, CacheRead> =>
    Effect.map(
        cacheRows(
            SessionEnrichedRow,
            {
                sql: `SELECT s.id AS id, s.started_at AS started_at, s.ended_at AS ended_at,
                             s.source AS source, s.project AS project, s.cwd AS cwd, s.repository AS repository,
                             COALESCE(tc.turn_count, 0) AS turn_count, fu.text_excerpt AS first_user_message
                      FROM session s
                      LEFT JOIN (SELECT session, count(*) AS turn_count FROM turn GROUP BY session) tc
                          ON tc.session = s.id
                      LEFT JOIN (
                          SELECT session, text_excerpt,
                                 row_number() OVER (PARTITION BY session ORDER BY seq ASC) AS rn
                          FROM turn
                          WHERE role = 'user'
                      ) fu ON fu.session = s.id AND fu.rn = 1
                      WHERE TRUE ${where.sql}
                      ORDER BY s.started_at DESC`,
                params: where.params,
            },
            "sessions-query.list",
        ),
        (rows) => rows.map(toSessionRow),
    );

// ---------------------------------------------------------------------------
// findSessionIdsByPrefix
// ---------------------------------------------------------------------------

/**
 * Resolve a session-id prefix to full bare ids. Convenience for
 * `ax sessions show <prefix>` - agents routinely paste the short ids shown
 * in listings (dogfood retro R2: `sessions show 5f4a02e9` → not-found →
 * wasted a recall round-trip recovering the full uuid).
 *
 * Full scan over `session`, but it only runs on the not-found fallback path,
 * never on the happy path.
 */
export const findSessionIdsByPrefix = (
    prefix: string,
    limit = 5,
): Effect.Effect<ReadonlyArray<string>, never, CacheRead> =>
    runCacheQuery(sessionIdsByPrefixCacheQuery, { prefix, limit });

// ---------------------------------------------------------------------------
// listSessionsHere
// ---------------------------------------------------------------------------

export interface SessionsHereOpts {
    /**
     * Bare repository row id (`session.repository` / `checkout.repository`),
     * bound as a plain parameter - DuckDB row ids are VARCHARs, not a typed
     * record reference, so there is no record-literal seam to go through.
     */
    readonly repositoryId: string;
    /** how many days back from now (default 14) */
    readonly days?: number;
}

/** List sessions anchored to a specific repository within a look-back window. */
export const listSessionsHere = (
    opts: SessionsHereOpts,
): Effect.Effect<SessionRow[], never, CacheRead> =>
    fetchSessions(
        andAll([
            eqClause("s.repository", opts.repositoryId),
            withinDaysClause("s.started_at", opts.days ?? 14),
        ]),
    );

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

/** Shared half-width default for the around-date window (CLI + MCP). */
export const SESSIONS_AROUND_DEFAULT_DAYS = 3;

/**
 * Transport-agnostic raw input for `listSessionsAround`. The CLI flag parser
 * and the MCP zod handler both decode their wire shapes (date string, optional
 * days/project) into a resolved {@link Date} plus optionals, then call
 * {@link normalizeSessionsAroundOpts} so the half-width default + project
 * presence rule live in one place.
 *
 * Date parsing/validation (the CLI's strict YYYY-MM-DD guard, the MCP's
 * `Number.isNaN` reject) stays transport-local - both pass an already-resolved
 * `Date`. `days` positivity also stays transport-local.
 */
export interface SessionsAroundQueryArgs {
    readonly date: Date;
    readonly days?: number | undefined;
    readonly project?: string | null | undefined;
}

export const normalizeSessionsAroundOpts = (
    args: SessionsAroundQueryArgs,
): SessionsAroundOpts => ({
    date: args.date,
    days:
        typeof args.days === "number" && Number.isFinite(args.days)
            ? args.days
            : SESSIONS_AROUND_DEFAULT_DAYS,
    ...(args.project != null && args.project !== ""
        ? { project: args.project }
        : {}),
});

/**
 * List sessions in the window [date - days, date + days].
 *
 * No git-repo dependency - pure time filter.
 */
export const listSessionsAround = (
    opts: SessionsAroundOpts,
): Effect.Effect<SessionRow[], never, CacheRead> => {
    const days = opts.days ?? SESSIONS_AROUND_DEFAULT_DAYS;
    const from = new Date(opts.date.getTime() - days * 24 * 60 * 60 * 1000);
    const to = new Date(opts.date.getTime() + days * 24 * 60 * 60 * 1000);
    return fetchSessions(
        andAll([
            { sql: "AND s.started_at >= ? AND s.started_at <= ?", params: [from, to] },
            eqClause("s.project", opts.project),
        ]),
    );
};

// ---------------------------------------------------------------------------
// listSessionsNear
// ---------------------------------------------------------------------------

export interface SessionsNearOpts {
    /** start of commit window (predecessor ts or commitTs - 3d fallback) */
    readonly from: Date;
    /** end of commit window (commit ts or commitTs + 3d fallback) */
    readonly to: Date;
    /**
     * Bare repository row id. Omit or pass null/undefined to skip the repo
     * filter.
     */
    readonly repositoryId?: string | null;
}

/**
 * List sessions within a commit-derived time window.
 *
 * Window comes from `findCommitWindow` (git-window.ts); caller is responsible
 * for resolving the adaptive window and repository id.
 */
export const listSessionsNear = (
    opts: SessionsNearOpts,
): Effect.Effect<SessionRow[], never, CacheRead> =>
    fetchSessions(
        andAll([
            { sql: "AND s.started_at >= ? AND s.started_at <= ?", params: [opts.from, opts.to] },
            eqClause("s.repository", opts.repositoryId),
        ]),
    );
