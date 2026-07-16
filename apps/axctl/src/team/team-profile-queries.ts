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
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { recordLiteral } from "@ax/lib/ids";

const win = (d: number) => `${Math.max(1, Math.trunc(d))}d`;

// --- repo session set --------------------------------------------------------

export interface TeamSessionRow {
    /** type::string(id) form, e.g. `session:⟨uuid⟩` - matches invoked/usage row keys */
    readonly id: string;
    readonly started_at: string;
    readonly source: string;
}

const TEAM_REPO_SESSIONS_SQL = (repoKey: string, d: number) => `
SELECT
    type::string(id) AS id,
    type::string(started_at) AS started_at,
    source
FROM session
WHERE repository = ${recordLiteral("repository", repoKey)}
  AND started_at > time::now() - ${win(d)}
  AND started_at IS NOT NONE;`;

export const fetchTeamRepoSessions = Effect.fn("team.fetchTeamRepoSessions")(
    function* (opts: { readonly repoKey: string; readonly windowDays: number }) {
        const db = yield* SurrealClient;
        const rows = yield* db
            .query<[Array<Record<string, unknown>>]>(
                TEAM_REPO_SESSIONS_SQL(opts.repoKey, opts.windowDays),
            )
            .pipe(Effect.map((r) => r?.[0] ?? []));
        return rows
            .filter((r) => r.id != null && r.started_at != null)
            .map((r) => ({
                id: String(r.id),
                started_at: String(r.started_at),
                source: String(r.source ?? "claude"),
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

const SESSION_USAGE_SQL = (d: number) => `
SELECT
    type::string(session) AS session,
    model,
    prompt_tokens ?? 0 AS prompt_tokens,
    completion_tokens ?? 0 AS completion_tokens,
    estimated_cost_usd AS cost_usd
FROM session_token_usage
WHERE ts > time::now() - ${win(d)};`;

export const fetchSessionUsageRows = Effect.fn("team.fetchSessionUsageRows")(
    function* (opts: { readonly windowDays: number }) {
        const db = yield* SurrealClient;
        const rows = yield* db
            .query<[Array<Record<string, unknown>>]>(SESSION_USAGE_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        return rows
            .filter((r) => r.session != null)
            .map((r) => ({
                session: String(r.session),
                model: r.model == null ? null : String(r.model),
                prompt_tokens: Number(r.prompt_tokens ?? 0),
                completion_tokens: Number(r.completion_tokens ?? 0),
                cost_usd: r.cost_usd == null ? null : Number(r.cost_usd),
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

const TOOL_AGG_FOR_SESSION_SQL = (sessionLit: string) => `
SELECT
    (command_text ?? command_norm ?? name) AS cmd,
    count() AS count,
    math::sum(IF has_error = true THEN 1 ELSE 0 END) AS failures
FROM tool_call
WHERE session = ${sessionLit}
  AND (command_text ?? command_norm ?? name) IS NOT NONE
GROUP BY cmd;`;

/** `type::string(id)` output → clean backtick record literal (sessions-query.ts idiom). */
const sessionLiteral = (id: string): string => {
    let k = id.replace(/^session:/, "");
    if (k.startsWith("⟨") && k.endsWith("⟩")) k = k.slice(1, -1);
    else if (k.startsWith("`") && k.endsWith("`")) k = k.slice(1, -1);
    return `session:\`${k}\``;
};

const TOOL_AGG_CONCURRENCY = 8;

export const fetchToolCallAggBySession = Effect.fn("team.fetchToolCallAggBySession")(
    function* (opts: { readonly sessionIds: ReadonlyArray<string> }) {
        if (opts.sessionIds.length === 0) return [] as ToolCmdRow[];
        const db = yield* SurrealClient;
        const perSession = yield* Effect.forEach(
            opts.sessionIds,
            (id) =>
                db.query<[Array<Record<string, unknown>>]>(
                    TOOL_AGG_FOR_SESSION_SQL(sessionLiteral(id)),
                ).pipe(Effect.map((r) => r?.[0] ?? [])),
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
