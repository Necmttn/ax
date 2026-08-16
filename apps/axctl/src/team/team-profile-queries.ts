/**
 * Repo-scoped queries for the TeamProfileV1 builder, over the DuckDB cache
 * through {@link CacheRead}. Scoping strategy: ONE indexed query resolves the
 * repo's session ids (`session_repository_started` index, same scoping as
 * listSessionsHere); everything else fetches per-row data keyed by the
 * denormalized `session` column and is filtered/aggregated against that id
 * set in JS. `session IN (...)` is never used here; tool_call is fanned out
 * per-session (hits `tool_call_session_ts`, ~1ms each, same pattern as
 * sessions-query.ts enrichSessions).
 *
 * `repository` is looked up ONCE by the caller (`pwd.ts`'s
 * `resolvePwdCacheRepository` / `queries/repository-scope.ts`) and handed in
 * as a resolved DuckDB row id - see that module's doc for why a reader cannot
 * construct the id from git alone in v2 (content-hashed, not git-keyed).
 */
import { Effect, Schema } from "effect";
import { CacheRead } from "@ax/lib/duckdb/seam";
import { NumberFromBigIntColumn, TextColumn, TimestampColumn } from "@ax/lib/duckdb/columns";
import { withinDaysClause } from "@ax/lib/duckdb/clause";

// --- repo session set --------------------------------------------------------

export interface TeamSessionRow {
    readonly id: string;
    readonly started_at: string;
    readonly source: string;
}

const TeamSessionDbRow = Schema.Struct({
    id: TextColumn,
    started_at: TimestampColumn,
    source: TextColumn,
});

export const fetchTeamRepoSessions = Effect.fn("team.fetchTeamRepoSessions")(
    function* (opts: { readonly repositoryId: string | null; readonly windowDays: number }) {
        if (opts.repositoryId === null) return [] as TeamSessionRow[];
        const read = yield* CacheRead;
        const since = withinDaysClause("started_at", opts.windowDays);
        const rows = yield* read.rows(
            TeamSessionDbRow,
            `SELECT id, started_at, source
             FROM session
             WHERE repository = ? AND started_at IS NOT NULL ${since.sql}`,
            [opts.repositoryId, ...since.params],
        );
        return rows.map(
            (r): TeamSessionRow => ({
                id: r.id,
                started_at: r.started_at.toISOString(),
                source: r.source,
            }),
        );
    },
);
// --- per-session token usage (machine window; repo-filtered in JS) -----------
// One row per session (session_token_usage_session UNIQUE index), so a
// whole-window scan is a few thousand rows at most - cheaper and simpler
// than per-session fan-out here.

export interface SessionUsageRow {
    readonly session: string;
    readonly model: string | null;
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly cost_usd: number | null;
}

const SessionUsageDbRow = Schema.Struct({
    session: TextColumn,
    model: Schema.NullOr(TextColumn),
    prompt_tokens: Schema.NullOr(NumberFromBigIntColumn),
    completion_tokens: Schema.NullOr(NumberFromBigIntColumn),
    cost_usd: Schema.NullOr(Schema.Number),
});

export const fetchSessionUsageRows = Effect.fn("team.fetchSessionUsageRows")(
    function* (opts: { readonly windowDays: number }) {
        const read = yield* CacheRead;
        const since = withinDaysClause("ts", opts.windowDays);
        const rows = yield* read.rows(
            SessionUsageDbRow,
            `SELECT session, model, prompt_tokens, completion_tokens, estimated_cost_usd AS cost_usd
             FROM session_token_usage
             WHERE 1 = 1 ${since.sql}`,
            since.params,
        );
        return rows.map(
            (r): SessionUsageRow => ({
                session: r.session,
                model: r.model,
                prompt_tokens: r.prompt_tokens ?? 0,
                completion_tokens: r.completion_tokens ?? 0,
                cost_usd: r.cost_usd,
            }),
        );
    },
);

// --- tool-call command aggregate, bulk IN-list ------------------------------
// Classification (verification share) happens on the FULL command text in JS
// (profile/tool-taxonomy.ts) - command text is never returned to the caller
// beyond this module's aggregation input and never serialized into the
// snapshot (counts-only privacy invariant, mirrors fetchWrappedCounts).
//
// One bulk `session IN (...)` query, chunked, rather than a per-session
// fan-out: DuckDB has a real index on tool_call(session, ts) and no
// Surreal-style membership-scan penalty for an IN-list (see clause.ts's doc).

export interface ToolCmdRow {
    readonly cmd: string;
    readonly count: number;
    readonly failures: number;
}

const ToolAggDbRow = Schema.Struct({
    cmd: TextColumn,
    count: NumberFromBigIntColumn,
    failures: NumberFromBigIntColumn,
});

/** Bound `session IN (...)` params per chunk, so a large session set never
 *  produces an unbounded bound-parameter list. */
const SESSION_CHUNK = 500;

const chunkOf = <T>(items: ReadonlyArray<T>, size: number): ReadonlyArray<ReadonlyArray<T>> => {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
};

export const fetchToolCallAggBySession = Effect.fn("team.fetchToolCallAggBySession")(
    function* (opts: { readonly sessionIds: ReadonlyArray<string> }) {
        if (opts.sessionIds.length === 0) return [] as ToolCmdRow[];
        const read = yield* CacheRead;
        const perChunk = yield* Effect.forEach(
            chunkOf(opts.sessionIds, SESSION_CHUNK),
            (ids) =>
                read.rows(
                    ToolAggDbRow,
                    `SELECT COALESCE(command_text, command_norm, name) AS cmd,
                        COUNT(*) AS count,
                        SUM(CASE WHEN has_error THEN 1 ELSE 0 END) AS failures
                     FROM tool_call
                     WHERE session IN (${ids.map(() => "?").join(", ")})
                       AND COALESCE(command_text, command_norm, name) IS NOT NULL
                     GROUP BY cmd`,
                    ids,
                ),
            { concurrency: 4 },
        );
        // Merge per-chunk command rows into one cmd -> counts map.
        const merged = new Map<string, { count: number; failures: number }>();
        for (const rows of perChunk) {
            for (const r of rows) {
                const cur = merged.get(r.cmd) ?? { count: 0, failures: 0 };
                cur.count += r.count;
                cur.failures += r.failures;
                merged.set(r.cmd, cur);
            }
        }
        return [...merged.entries()].map(([cmd, v]) => ({
            cmd,
            count: v.count,
            failures: v.failures,
        })) satisfies ToolCmdRow[];
    },
);
