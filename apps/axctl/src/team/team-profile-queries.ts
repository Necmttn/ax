/**
 * Repo-scoped queries for the TeamProfileV1 builder. Scoping strategy:
 * ONE indexed query resolves the repo's session ids
 * (`session_repository_started` index, same scoping as listSessionsHere);
 * everything else fetches per-row data keyed by the denormalized `session`
 * field and is filtered/aggregated against that id set in JS. Deref-free
 * SQL, JS joins (SurrealDB 3.x house rules). `session IN [list]` is a
 * non-indexed per-row membership test - never used here; tool_call is
 * fanned out per-session literal (hits tool_call_session_ts, ~1ms each,
 * same pattern as sessions-query.ts enrichSessions).
 */
import { Effect, Schema } from "effect";
import { NumberFromBigIntColumn, TimestampColumn } from "@ax/lib/duckdb/columns";
import { cacheRows } from "@ax/lib/duckdb/query";

const win = (d: number) => Math.max(1, Math.trunc(d));

// --- repo session set --------------------------------------------------------

export interface TeamSessionRow {
    /** type::string(id) form, e.g. `session:⟨uuid⟩` - matches invoked/usage row keys */
    readonly id: string;
    readonly started_at: string;
    readonly source: string;
}

const TeamSessionDbRow = Schema.Struct({ id: Schema.String, started_at: TimestampColumn, source: Schema.String });
const TEAM_REPO_SESSIONS_SQL = `
SELECT id, started_at, source
FROM session
WHERE repository = ?
  AND started_at > CURRENT_TIMESTAMP - (? * INTERVAL '1 day')
  AND started_at IS NOT NULL;`;

export const fetchTeamRepoSessions = Effect.fn("team.fetchTeamRepoSessions")(
    function* (opts: { readonly repoKey: string; readonly windowDays: number }) {
        const rows = yield* cacheRows(TeamSessionDbRow, { sql: TEAM_REPO_SESSIONS_SQL, params: [opts.repoKey, win(opts.windowDays)] }, "team sessions");
        return rows.map((r) => ({
                id: r.id,
                started_at: r.started_at.toISOString(),
                source: r.source,
            })) satisfies TeamSessionRow[];
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

const SessionUsageDbRow = Schema.Struct({ session: Schema.String, model: Schema.NullOr(Schema.String), prompt_tokens: NumberFromBigIntColumn, completion_tokens: NumberFromBigIntColumn, cost_usd: Schema.NullOr(Schema.Number) });
const SESSION_USAGE_SQL = `
SELECT
    session,
    model,
    coalesce(prompt_tokens, 0)::BIGINT AS prompt_tokens,
    coalesce(completion_tokens, 0)::BIGINT AS completion_tokens,
    estimated_cost_usd AS cost_usd
FROM session_token_usage
WHERE ts > CURRENT_TIMESTAMP - (? * INTERVAL '1 day');`;

export const fetchSessionUsageRows = Effect.fn("team.fetchSessionUsageRows")(
    function* (opts: { readonly windowDays: number }) {
        const rows = yield* cacheRows(SessionUsageDbRow, { sql: SESSION_USAGE_SQL, params: [win(opts.windowDays)] }, "team usage");
        return rows.map((r) => ({
                session: r.session,
                model: r.model,
                prompt_tokens: r.prompt_tokens,
                completion_tokens: r.completion_tokens,
                cost_usd: r.cost_usd,
            })) satisfies SessionUsageRow[];
    },
);

// --- tool-call command aggregate, per-session fan-out -------------------------
// Classification (verification share) happens on the FULL command text in JS
// (profile/tool-taxonomy.ts) - command text is never returned to the caller
// beyond this module's aggregation input and never serialized into the
// snapshot (counts-only privacy invariant, mirrors fetchWrappedCounts).

export interface ToolCmdRow {
    readonly cmd: string;
    readonly count: number;
    readonly failures: number;
}

const ToolAggDbRow = Schema.Struct({ cmd: Schema.String, count: NumberFromBigIntColumn, failures: NumberFromBigIntColumn });
const TOOL_AGG_FOR_SESSION_SQL = `
SELECT
    coalesce(command_text, command_norm, name) AS cmd,
    count(*) AS count,
    count(*) FILTER (WHERE has_error = true) AS failures
FROM tool_call
WHERE session = ?
  AND coalesce(command_text, command_norm, name) IS NOT NULL
GROUP BY cmd;`;

const TOOL_AGG_CONCURRENCY = 8;

export const fetchToolCallAggBySession = Effect.fn("team.fetchToolCallAggBySession")(
    function* (opts: { readonly sessionIds: ReadonlyArray<string> }) {
        if (opts.sessionIds.length === 0) return [] as ToolCmdRow[];
        const perSession = yield* Effect.forEach(
            opts.sessionIds,
            (id) =>
                cacheRows(ToolAggDbRow, { sql: TOOL_AGG_FOR_SESSION_SQL, params: [id] }, "team tool calls"),
            { concurrency: TOOL_AGG_CONCURRENCY },
        );
        // Merge per-session command rows into one cmd -> counts map.
        const merged = new Map<string, { count: number; failures: number }>();
        for (const rows of perSession) {
            for (const r of rows) {
                const cmd = String(r.cmd ?? "");
                if (cmd.length === 0) continue;
                const cur = merged.get(cmd) ?? { count: 0, failures: 0 };
                cur.count += Number(r.count ?? 0);
                cur.failures += Number(r.failures ?? 0);
                merged.set(cmd, cur);
            }
        }
        return [...merged.entries()].map(([cmd, v]) => ({
            cmd,
            count: v.count,
            failures: v.failures,
        })) satisfies ToolCmdRow[];
    },
);
