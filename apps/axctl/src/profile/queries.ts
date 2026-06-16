/**
 * Windowed stat queries for the profile renderer. These are parameterized
 * variants of queries/wrapped.ts (which hardcodes 365d). No stacked
 * in/out deref combos inside grouped aggregates (SurrealDB 3.x hang rule);
 * fetchSkillInvocations carries the single out.name deref that
 * WRAPPED_SKILLS_SQL already established. Joins happen in JS.
 * Read-only tables: session_token_usage, turn, session, invoked, skill,
 * proposal.
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { isContextTool, isVerificationTool } from "./tool-taxonomy.ts";

const win = (d: number) => `${Math.max(1, Math.trunc(d))}d`;

// --- token totals -----------------------------------------------------------

export interface TokenTotals {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly sessions: number;
}

const TOKEN_TOTALS_SQL = (d: number) => `
SELECT
    math::sum(prompt_tokens ?? 0) AS prompt_tokens,
    math::sum(completion_tokens ?? 0) AS completion_tokens,
    count() AS sessions
FROM session_token_usage
WHERE ts > time::now() - ${win(d)}
GROUP ALL;`;

export const fetchTokenTotals = Effect.fn("profile.fetchTokenTotals")(
    function* (opts: { readonly windowDays: number }) {
        const db = yield* SurrealClient;
        const rows = yield* db
            .query<[Array<Record<string, unknown>>]>(TOKEN_TOTALS_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        const row = rows[0] ?? {};
        return {
            prompt_tokens: Number(row.prompt_tokens ?? 0),
            completion_tokens: Number(row.completion_tokens ?? 0),
            sessions: Number(row.sessions ?? 0),
        } satisfies TokenTotals;
    },
);

// --- daily activity (streak input) -----------------------------------------

const DAILY_ACTIVITY_SQL = (d: number) => `
SELECT time::format(ts, "%Y-%m-%d") AS date
FROM turn
WHERE ts > time::now() - ${win(d)} AND ts IS NOT NONE
GROUP BY date
ORDER BY date ASC;`;

export const fetchDailyActivity = Effect.fn("profile.fetchDailyActivity")(
    function* (opts: { readonly windowDays: number }) {
        const db = yield* SurrealClient;
        const rows = yield* db
            .query<[Array<Record<string, unknown>>]>(DAILY_ACTIVITY_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        return rows
            .map((r) => String(r.date))
            .filter((d) => d !== "undefined" && d !== "null");
    },
);

// --- harnesses --------------------------------------------------------------

const HARNESSES_SQL = (d: number) => `
SELECT source, count() AS count
FROM session
WHERE started_at > time::now() - ${win(d)} AND source IS NOT NONE
GROUP BY source
ORDER BY count DESC;`;

export const fetchHarnesses = Effect.fn("profile.fetchHarnesses")(
    function* (opts: { readonly windowDays: number }) {
        const db = yield* SurrealClient;
        const rows = yield* db
            .query<[Array<Record<string, unknown>>]>(HARNESSES_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        return rows.map((r) => String(r.source));
    },
);

// --- skill invocations + scopes ---------------------------------------------

export interface SkillInvocationRow {
    readonly skill: string;
    readonly count: number;
}

const SKILL_INVOCATIONS_SQL = (d: number) => `
SELECT out.name AS skill, count() AS count
FROM invoked
WHERE ts > time::now() - ${win(d)} AND out.name IS NOT NONE
GROUP BY skill
ORDER BY count DESC
LIMIT 100;`;

export const fetchSkillInvocations = Effect.fn("profile.fetchSkillInvocations")(
    function* (opts: { readonly windowDays: number }) {
        const db = yield* SurrealClient;
        const rows = yield* db
            .query<[Array<Record<string, unknown>>]>(SKILL_INVOCATIONS_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        return rows.map((r) => ({
            skill: String(r.skill),
            count: Number(r.count ?? 0),
        })) satisfies SkillInvocationRow[];
    },
);

const SKILL_SCOPES_SQL = `
SELECT name, scope FROM skill WHERE deleted_at IS NONE;`;

export const fetchSkillScopes = Effect.fn("profile.fetchSkillScopes")(
    function* () {
        const db = yield* SurrealClient;
        const rows = yield* db
            .query<[Array<Record<string, unknown>>]>(SKILL_SCOPES_SQL)
            .pipe(Effect.map((r) => r?.[0] ?? []));
        return new Map(rows.map((r) => [String(r.name), String(r.scope)]));
    },
);

// --- accepted proposals (taste input) ---------------------------------------

export interface ProposalRow {
    readonly form: string;
    readonly title: string;
    readonly hypothesis: string;
    readonly confidence: string;
    readonly frequency: number;
    readonly updated_at: string | null;
    readonly created_at: string | null;
}

const ACCEPTED_PROPOSALS_SQL = `
SELECT form, title, hypothesis, confidence, frequency,
       type::string(updated_at) AS updated_at,
       type::string(created_at) AS created_at
FROM proposal
WHERE status = 'accepted'
ORDER BY frequency DESC
LIMIT 100;`;

export const fetchAcceptedProposals = Effect.fn("profile.fetchAcceptedProposals")(
    function* () {
        const db = yield* SurrealClient;
        const rows = yield* db
            .query<[Array<Record<string, unknown>>]>(ACCEPTED_PROPOSALS_SQL)
            .pipe(Effect.map((r) => r?.[0] ?? []));
        return rows.map((r) => ({
            form: String(r.form ?? ""),
            title: String(r.title ?? ""),
            hypothesis: String(r.hypothesis ?? ""),
            confidence: String(r.confidence ?? ""),
            frequency: Number(r.frequency ?? 0),
            updated_at: r.updated_at == null ? null : String(r.updated_at),
            created_at: r.created_at == null ? null : String(r.created_at),
        })) satisfies ProposalRow[];
    },
);

// --- daily activity full (sessions + tokens per day) ------------------------

export interface DailyActivityRow {
    readonly date: string;
    readonly sessions: number;
    readonly tokens: number;
}

const DAILY_SESSIONS_SQL = (d: number) => `
SELECT
    time::format(ts, "%Y-%m-%d") AS date,
    array::len(array::distinct(session)) AS sessions
FROM turn
WHERE ts > time::now() - ${win(d)} AND ts IS NOT NONE
GROUP BY date
ORDER BY date ASC;`;

const DAILY_TOKENS_SQL = (d: number) => `
SELECT
    time::format(ts, "%Y-%m-%d") AS date,
    math::sum(prompt_tokens ?? 0) + math::sum(completion_tokens ?? 0) AS tokens
FROM session_token_usage
WHERE ts > time::now() - ${win(d)} AND ts IS NOT NONE
GROUP BY date
ORDER BY date ASC;`;

export const fetchDailyActivityFull = Effect.fn("profile.fetchDailyActivityFull")(
    function* (opts: { readonly windowDays: number }) {
        const db = yield* SurrealClient;
        const sessionRows = yield* db
            .query<[Array<Record<string, unknown>>]>(DAILY_SESSIONS_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        const tokenRows = yield* db
            .query<[Array<Record<string, unknown>>]>(DAILY_TOKENS_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        // Join tokens onto session rows in JS (two grouped queries; SurrealDB
        // 3.x grouped aggregates stay deref-free per the hang rule).
        const tokenMap = new Map(
            tokenRows
                .map((r) => [String(r.date), Number(r.tokens ?? 0)] as const)
                .filter(([day]) => day !== "undefined" && day !== "null"),
        );
        return sessionRows
            .map((r) => {
                const date = String(r.date);
                return { date, sessions: Number(r.sessions ?? 0), tokens: tokenMap.get(date) ?? 0 };
            })
            .filter((r) => r.date !== "undefined" && r.date !== "null") satisfies DailyActivityRow[];
    },
);

// --- session durations -------------------------------------------------------

export interface SessionDurationRow {
    readonly started_at: string;
    readonly ended_at: string;
}

const SESSION_DURATIONS_SQL = (d: number) => `
SELECT
    type::string(started_at) AS started_at,
    type::string(ended_at) AS ended_at
FROM session
WHERE started_at > time::now() - ${win(d)}
  AND started_at IS NOT NONE
  AND ended_at IS NOT NONE;`;

export const fetchSessionDurations = Effect.fn("profile.fetchSessionDurations")(
    function* (opts: { readonly windowDays: number }) {
        const db = yield* SurrealClient;
        const rows = yield* db
            .query<[Array<Record<string, unknown>>]>(SESSION_DURATIONS_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        return rows
            .filter((r) => r.started_at != null && r.ended_at != null)
            .map((r) => ({
                started_at: String(r.started_at),
                ended_at: String(r.ended_at),
            })) satisfies SessionDurationRow[];
    },
);

// --- peak hour ---------------------------------------------------------------

const PEAK_HOUR_SQL = (d: number) => `
SELECT
    time::format(started_at, "%H") AS hour,
    count() AS count
FROM session
WHERE started_at > time::now() - ${win(d)}
  AND started_at IS NOT NONE
GROUP BY hour
ORDER BY count DESC
LIMIT 1;`;

export const fetchPeakHour = Effect.fn("profile.fetchPeakHour")(
    function* (opts: { readonly windowDays: number }) {
        const db = yield* SurrealClient;
        const rows = yield* db
            .query<[Array<Record<string, unknown>>]>(PEAK_HOUR_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        const row = rows[0];
        if (row == null) return null;
        return Number(row.hour ?? 0);
    },
);

// --- spawned count -----------------------------------------------------------

const SPAWNED_COUNT_SQL = (d: number) => `
SELECT count() AS count
FROM spawned
WHERE ts > time::now() - ${win(d)}
GROUP ALL;`;

export const fetchSpawnedCount = Effect.fn("profile.fetchSpawnedCount")(
    function* (opts: { readonly windowDays: number }) {
        const db = yield* SurrealClient;
        const rows = yield* db
            .query<[Array<Record<string, unknown>>]>(SPAWNED_COUNT_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        return Number(rows[0]?.count ?? 0);
    },
);

// --- commit count ------------------------------------------------------------
// commit table uses `ts` (datetime) - confirmed in packages/schema/src/schema.surql.

const COMMIT_COUNT_SQL = (d: number) => `
SELECT count() AS count
FROM commit
WHERE ts > time::now() - ${win(d)}
GROUP ALL;`;

export const fetchCommitCount = Effect.fn("profile.fetchCommitCount")(
    function* (opts: { readonly windowDays: number }) {
        const db = yield* SurrealClient;
        const rows = yield* db
            .query<[Array<Record<string, unknown>>]>(COMMIT_COUNT_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        return Number(rows[0]?.count ?? 0);
    },
);

// --- top tools ---------------------------------------------------------------

export interface TopToolRow {
    readonly name: string;
    readonly runs: number;
}

const TOP_TOOLS_SQL = (d: number) => `
SELECT
    (command_norm ?? name) AS tool,
    count() AS count
FROM tool_call
WHERE ts > time::now() - ${win(d)}
  AND (command_norm ?? name) IS NOT NONE
GROUP BY tool
ORDER BY count DESC
LIMIT 10;`;

export const fetchTopTools = Effect.fn("profile.fetchTopTools")(
    function* (opts: { readonly windowDays: number }) {
        const db = yield* SurrealClient;
        const rows = yield* db
            .query<[Array<Record<string, unknown>>]>(TOP_TOOLS_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        return rows.map((r) => ({
            name: String(r.tool),
            runs: Number(r.count ?? 0),
        })) satisfies TopToolRow[];
    },
);

// --- wrapped-style aggregates ------------------------------------------------
// Counts only; no names, no paths (privacy invariant).
//
// One combined SQL returns all per-tool rows (mirroring WRAPPED_TOOLS_SQL) so
// we can compute verification/context pattern matches in JS just as
// dashboard/wrapped.ts does (contextToolPattern / verificationToolPattern).
// Separate SQL for turn count, distinct skills, and repo count (distinct
// grouped aggregates; deref-free per the SurrealDB 3.x hang rule).

export interface WrappedCounts {
    readonly turns: number;
    readonly tool_calls: number;
    readonly tool_failures: number;
    readonly distinct_tools: number;
    readonly distinct_skills: number;
    readonly repos_count: number;
    readonly verification_calls: number;
    readonly context_calls: number;
}

// Verification / context classification is shared with dashboard/wrapped.ts
// via tool-taxonomy.ts (ecosystem-aware program matching; see issue #471).

// Per-tool rows (name, count, failures) - same shape as WRAPPED_TOOLS_SQL but windowed.
const TOOL_AGG_SQL = (d: number) => `
SELECT
    (command_norm ?? name) AS tool,
    count() AS count,
    math::sum(IF has_error = true THEN 1 ELSE 0 END) AS failures
FROM tool_call
WHERE ts > time::now() - ${win(d)}
  AND (command_norm ?? name) IS NOT NONE
GROUP BY tool
ORDER BY count DESC
LIMIT 200;`;

// Verification / context counts classify on the FULL command (`command_text`),
// not the collapsed `command_norm` - `normalizeCommand` strips the subcommand
// for non-SUBCOMMAND_TOOLS (e.g. `mvn test` -> `mvn`, `npm run lint` ->
// `npm run`, `bundle exec rspec` -> `bundle`), so the normalized label alone
// can't see the verifier. Grouped to keep cardinality sane; the command text
// is classified in-process and never returned (counts-only privacy invariant).
const VERIFY_AGG_SQL = (d: number) => `
SELECT
    (command_text ?? command_norm ?? name) AS cmd,
    count() AS count
FROM tool_call
WHERE ts > time::now() - ${win(d)}
  AND (command_text ?? command_norm ?? name) IS NOT NONE
GROUP BY cmd;`;

// Total turn count in window.
const TURN_COUNT_SQL = (d: number) => `
SELECT count() AS count
FROM turn
WHERE ts > time::now() - ${win(d)}
GROUP ALL;`;

// Distinct invoked skill names in window.
const DISTINCT_SKILLS_SQL = (d: number) => `
SELECT count() AS count
FROM (
    SELECT out.name AS skill
    FROM invoked
    WHERE ts > time::now() - ${win(d)} AND out.name IS NOT NONE
    GROUP BY skill
) GROUP ALL;`;

// Count of distinct non-null repositories in window (count only, never names).
const REPOS_COUNT_SQL = (d: number) => `
SELECT count() AS count
FROM (
    SELECT repository
    FROM session
    WHERE started_at > time::now() - ${win(d)} AND repository IS NOT NONE
    GROUP BY repository
) GROUP ALL;`;

export const fetchWrappedCounts = Effect.fn("profile.fetchWrappedCounts")(
    function* (opts: { readonly windowDays: number }) {
        const db = yield* SurrealClient;
        const toolRows = yield* db
            .query<[Array<Record<string, unknown>>]>(TOOL_AGG_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        const turnRows = yield* db
            .query<[Array<Record<string, unknown>>]>(TURN_COUNT_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        const skillRows = yield* db
            .query<[Array<Record<string, unknown>>]>(DISTINCT_SKILLS_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        const repoRows = yield* db
            .query<[Array<Record<string, unknown>>]>(REPOS_COUNT_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        const verifyRows = yield* db
            .query<[Array<Record<string, unknown>>]>(VERIFY_AGG_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));

        const tool_calls = toolRows.reduce((s, r) => s + Number(r.count ?? 0), 0);
        const tool_failures = toolRows.reduce((s, r) => s + Number(r.failures ?? 0), 0);
        const distinct_tools = toolRows.length;

        // Verification/context classify on the full command text (verifyRows),
        // not the collapsed command_norm tool label (toolRows).
        const cmdCount = (pred: (label: string) => boolean): number =>
            verifyRows
                .filter((r) => pred(String(r.cmd ?? "")))
                .reduce((s, r) => s + Number(r.count ?? 0), 0);

        return {
            turns: Number(turnRows[0]?.count ?? 0),
            tool_calls,
            tool_failures,
            distinct_tools,
            distinct_skills: Number(skillRows[0]?.count ?? 0),
            repos_count: Number(repoRows[0]?.count ?? 0),
            verification_calls: cmdCount(isVerificationTool),
            context_calls: cmdCount(isContextTool),
        } satisfies WrappedCounts;
    },
);

// --- per-day per-model tokens -----------------------------------------------

export interface DailyModelRow {
    readonly date: string;
    readonly model: string;
    readonly tokens: number;
}

const DAILY_MODEL_TOKENS_SQL = (d: number) => `
SELECT
    time::format(ts, "%Y-%m-%d") AS date,
    model,
    math::sum(prompt_tokens ?? 0) + math::sum(completion_tokens ?? 0) AS tokens
FROM session_token_usage
WHERE ts > time::now() - ${win(d)} AND ts IS NOT NONE
GROUP BY date, model
ORDER BY date ASC, tokens DESC;`;

export const fetchDailyModels = Effect.fn("profile.fetchDailyModels")(
    function* (opts: { readonly windowDays: number }) {
        const db = yield* SurrealClient;
        const rows = yield* db
            .query<[Array<Record<string, unknown>>]>(DAILY_MODEL_TOKENS_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        return rows.map((r) => ({
            date: String(r.date),
            model: r.model == null ? "(unattributed)" : String(r.model),
            tokens: Number(r.tokens ?? 0),
        })) satisfies DailyModelRow[];
    },
);

// --- per-day tool call counts ------------------------------------------------

export interface DailyToolCallRow {
    readonly date: string;
    readonly tool_calls: number;
}

const DAILY_TOOL_CALLS_SQL = (d: number) => `
SELECT
    time::format(ts, "%Y-%m-%d") AS date,
    count() AS tool_calls
FROM tool_call
WHERE ts > time::now() - ${win(d)} AND ts IS NOT NONE
GROUP BY date
ORDER BY date ASC;`;

export const fetchDailyToolCalls = Effect.fn("profile.fetchDailyToolCalls")(
    function* (opts: { readonly windowDays: number }) {
        const db = yield* SurrealClient;
        const rows = yield* db
            .query<[Array<Record<string, unknown>>]>(DAILY_TOOL_CALLS_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        return rows
            .map((r) => ({
                date: String(r.date),
                tool_calls: Number(r.tool_calls ?? 0),
            }))
            .filter((r) => r.date !== "undefined" && r.date !== "null") satisfies DailyToolCallRow[];
    },
);

// --- per-day commit counts ---------------------------------------------------

export interface DailyCommitRow {
    readonly date: string;
    readonly commits: number;
}

const DAILY_COMMITS_SQL = (d: number) => `
SELECT
    time::format(ts, "%Y-%m-%d") AS date,
    count() AS commits
FROM commit
WHERE ts > time::now() - ${win(d)} AND ts IS NOT NONE
GROUP BY date
ORDER BY date ASC;`;

export const fetchDailyCommits = Effect.fn("profile.fetchDailyCommits")(
    function* (opts: { readonly windowDays: number }) {
        const db = yield* SurrealClient;
        const rows = yield* db
            .query<[Array<Record<string, unknown>>]>(DAILY_COMMITS_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        return rows
            .map((r) => ({
                date: String(r.date),
                commits: Number(r.commits ?? 0),
            }))
            .filter((r) => r.date !== "undefined" && r.date !== "null") satisfies DailyCommitRow[];
    },
);

// --- windowed invocation events (for workflow + downstream_share) ------------

export interface WindowedInvocationRow {
    readonly session: string;
    readonly skill: string;
    readonly ts: string;
}

const WINDOWED_INVOCATIONS_SQL = (d: number) => `
SELECT
    type::string(in.session) AS session,
    out.name AS skill,
    type::string(ts) AS ts
FROM invoked
WHERE ts > time::now() - ${win(d)};`;

export const fetchWindowedInvocations = Effect.fn("profile.fetchWindowedInvocations")(
    function* (opts: { readonly windowDays: number }) {
        const db = yield* SurrealClient;
        const rows = yield* db
            .query<[Array<Record<string, unknown>>]>(WINDOWED_INVOCATIONS_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        return rows
            .filter((r) => r.session != null && r.skill != null && r.session !== "null" && r.skill !== "null")
            .map((r) => ({
                session: String(r.session),
                skill: String(r.skill),
                ts: String(r.ts),
            })) satisfies WindowedInvocationRow[];
    },
);

// --- windowed session times (for downstream_share) --------------------------

export interface WindowedSessionRow {
    readonly id: string;
    readonly s: string;
    readonly e: string;
}

const WINDOWED_SESSIONS_SQL = (d: number) => `
SELECT
    type::string(id) AS id,
    type::string(started_at) AS s,
    type::string(ended_at) AS e
FROM session
WHERE started_at > time::now() - ${win(d)} AND ended_at IS NOT NONE;`;

export const fetchWindowedSessions = Effect.fn("profile.fetchWindowedSessions")(
    function* (opts: { readonly windowDays: number }) {
        const db = yield* SurrealClient;
        const rows = yield* db
            .query<[Array<Record<string, unknown>>]>(WINDOWED_SESSIONS_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        return rows
            .filter((r) => r.id != null && r.s != null && r.e != null)
            .map((r) => ({
                id: String(r.id),
                s: String(r.s),
                e: String(r.e),
            })) satisfies WindowedSessionRow[];
    },
);
