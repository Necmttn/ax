/**
 * Windowed stat queries for the profile renderer. These are parameterized
 * variants of queries/wrapped.ts (which hardcodes 365d). No stacked
 * in/out deref combos inside grouped aggregates (SurrealDB 3.x hang rule);
 * fetchSkillInvocations carries the single out.name deref that
 * WRAPPED_SKILLS_SQL already established. Joins happen in JS.
 * Read-only tables: session_token_usage, turn, session, invoked, skill,
 * proposal.
 */
import { Effect, Schema } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { CacheRead, type CacheReadError, type CacheReadService } from "@ax/lib/duckdb/seam";
import { NumberFromBigIntColumn, TimestampColumn } from "@ax/lib/duckdb/columns";
import { inClause, withinDaysClause } from "@ax/lib/duckdb/clause";
import type { DuckDbParam } from "@ax/lib/duckdb/types";
import { isContextTool, isVerificationTool } from "./tool-taxonomy.ts";
import type { GuardrailHookEvidenceRow, GuardrailVerdictRow } from "./guardrails.ts";
import { listStoredProposals } from "../improve/judgment-proposals.ts";

const win = (d: number) => `${Math.max(1, Math.trunc(d))}d`;

/**
 * Unwrap `CacheReadService.raw`'s `{ columns, rows }` to just the rows - the
 * DuckDB-side equivalent of the old `db.query(...).pipe(Effect.map(r => r?.[0]
 * ?? []))` SurrealDB multi-statement-result unwrap. Schema-free on purpose:
 * every function here already coerces each field with `Number(...)`/
 * `String(...)` at the call site (its pre-existing style), and `Number(...)`
 * on a native BIGINT is a safe widening (unlike `JSON.stringify`, which is
 * never called on these raw rows before that coercion happens).
 */
const rawRows = (
    read: CacheReadService,
    sql: string,
    params?: ReadonlyArray<DuckDbParam>,
): Effect.Effect<ReadonlyArray<Record<string, unknown>>, CacheReadError> =>
    read.raw(sql, params).pipe(Effect.map((r) => r.rows));

// ---------------------------------------------------------------------------
// Per-query slow-query diagnostics
// ---------------------------------------------------------------------------
// Wraps a DB query effect to log a warning when the query exceeds SLOW_QUERY_MS.
// Non-invasive: the warning is best-effort (logWarning is fire-and-forget) and
// the result is unchanged.

const SLOW_QUERY_MS = 500;

function timedQuery<A, E, R>(
    label: string,
    queryEffect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
    return Effect.gen(function* () {
        const start = Date.now();
        const result = yield* queryEffect;
        const elapsed = Date.now() - start;
        if (elapsed > SLOW_QUERY_MS) {
            yield* Effect.logWarning(
                `[profile] slow query "${label}" took ${elapsed}ms (>${SLOW_QUERY_MS}ms threshold)`,
            );
        }
        return result;
    });
}

// --- token totals -----------------------------------------------------------

export interface TokenTotals {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly sessions: number;
}

const TOKEN_TOTALS_SQL = `
SELECT
    SUM(COALESCE(prompt_tokens, 0)) AS prompt_tokens,
    SUM(COALESCE(completion_tokens, 0)) AS completion_tokens,
    count(*) AS sessions
FROM session_token_usage
WHERE TRUE`;

export const fetchTokenTotals = Effect.fn("profile.fetchTokenTotals")(
    function* (opts: { readonly windowDays: number }) {
        const read = yield* CacheRead;
        const within = withinDaysClause("ts", opts.windowDays);
        const rows = yield* timedQuery(
            "tokenTotals",
            rawRows(read, `${TOKEN_TOTALS_SQL} ${within.sql}`, within.params),
        );
        const row = rows[0] ?? {};
        return {
            prompt_tokens: Number(row.prompt_tokens ?? 0),
            completion_tokens: Number(row.completion_tokens ?? 0),
            sessions: Number(row.sessions ?? 0),
        } satisfies TokenTotals;
    },
);

// --- daily activity (streak input) -----------------------------------------
// Session-based scan: ~18ms vs ~3s on the turn table (150× faster for Codex
// users who accumulate millions of turn rows). The streak only needs distinct
// active days, and session.started_at is indexed.

const DAILY_ACTIVITY_SQL = `
SELECT strftime(started_at, '%Y-%m-%d') AS date
FROM session
WHERE started_at IS NOT NULL`;

export const fetchDailyActivity = Effect.fn("profile.fetchDailyActivity")(
    function* (opts: { readonly windowDays: number }) {
        const read = yield* CacheRead;
        const within = withinDaysClause("started_at", opts.windowDays);
        const rows = yield* timedQuery(
            "dailyActivity",
            rawRows(
                read,
                `${DAILY_ACTIVITY_SQL} ${within.sql} GROUP BY date ORDER BY date ASC`,
                within.params,
            ),
        );
        return rows
            .map((r) => String(r.date))
            .filter((d) => d !== "undefined" && d !== "null");
    },
);

// --- harnesses --------------------------------------------------------------

const HARNESSES_SQL = `
SELECT source, count(*) AS count
FROM session
WHERE source IS NOT NULL`;

export const fetchHarnesses = Effect.fn("profile.fetchHarnesses")(
    function* (opts: { readonly windowDays: number }) {
        const read = yield* CacheRead;
        const within = withinDaysClause("started_at", opts.windowDays);
        const rows = yield* rawRows(
            read,
            `${HARNESSES_SQL} ${within.sql} GROUP BY source ORDER BY count DESC`,
            within.params,
        );
        return rows.map((r) => String(r.source));
    },
);

// --- skill invocations + scopes ---------------------------------------------

export interface SkillInvocationRow {
    readonly skill: string;
    readonly count: number;
}

// `invoked.out_id` is a bare ref -> skill (no graph deref in DuckDB), so the
// skill name comes from a join, not a dotted path.
const SKILL_INVOCATIONS_SQL = `
SELECT sk.name AS skill, count(*) AS count
FROM invoked i
JOIN skill sk ON sk.id = i.out_id
WHERE TRUE`;

export const fetchSkillInvocations = Effect.fn("profile.fetchSkillInvocations")(
    function* (opts: { readonly windowDays: number }) {
        const read = yield* CacheRead;
        const within = withinDaysClause("i.ts", opts.windowDays);
        const rows = yield* rawRows(
            read,
            `${SKILL_INVOCATIONS_SQL} ${within.sql} GROUP BY sk.name ORDER BY count DESC LIMIT 100`,
            within.params,
        );
        return rows.map((r) => ({
            skill: String(r.skill),
            count: Number(r.count ?? 0),
        })) satisfies SkillInvocationRow[];
    },
);

const SKILL_SCOPES_SQL = `
SELECT name, scope FROM skill WHERE deleted_at IS NULL`;

export const fetchSkillScopes = Effect.fn("profile.fetchSkillScopes")(
    function* () {
        const read = yield* CacheRead;
        const rows = yield* rawRows(read, SKILL_SCOPES_SQL);
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

export const fetchAcceptedProposals = Effect.fn("profile.fetchAcceptedProposals")(
    function* () {
        const rows = (yield* listStoredProposals(10_000))
            .filter((proposal) => proposal.status === "accepted")
            .sort((a, b) => b.frequency - a.frequency)
            .slice(0, 100);
        return rows.map((r) => ({
            form: r.form,
            title: r.title,
            hypothesis: r.hypothesis,
            confidence: r.confidence,
            frequency: r.frequency,
            updated_at: r.updated_at?.toISOString() ?? null,
            created_at: r.created_at?.toISOString() ?? null,
        })) satisfies ProposalRow[];
    },
);

// --- daily activity full (sessions + tokens per day) ------------------------

export interface DailyActivityRow {
    readonly date: string;
    readonly sessions: number;
    readonly tokens: number;
}

// Session-based: count() per day from the session table - avoids the full
// turn-table scan (array::distinct(session) over millions of Codex turns = 3s+).
const DAILY_SESSIONS_SQL = `
SELECT
    strftime(started_at, '%Y-%m-%d') AS date,
    count(*) AS sessions
FROM session
WHERE started_at IS NOT NULL`;

const DAILY_TOKENS_SQL = `
SELECT
    strftime(ts, '%Y-%m-%d') AS date,
    SUM(COALESCE(prompt_tokens, 0)) + SUM(COALESCE(completion_tokens, 0)) AS tokens
FROM session_token_usage
WHERE ts IS NOT NULL`;

export const fetchDailyActivityFull = Effect.fn("profile.fetchDailyActivityFull")(
    function* (opts: { readonly windowDays: number }) {
        const read = yield* CacheRead;
        const withinStarted = withinDaysClause("started_at", opts.windowDays);
        const withinTs = withinDaysClause("ts", opts.windowDays);
        const sessionRows = yield* timedQuery(
            "dailySessions",
            rawRows(
                read,
                `${DAILY_SESSIONS_SQL} ${withinStarted.sql} GROUP BY date ORDER BY date ASC`,
                withinStarted.params,
            ),
        );
        const tokenRows = yield* timedQuery(
            "dailyTokens",
            rawRows(
                read,
                `${DAILY_TOKENS_SQL} ${withinTs.sql} GROUP BY date ORDER BY date ASC`,
                withinTs.params,
            ),
        );
        // Join tokens onto session rows in JS (two grouped queries; mirrors
        // the deref-free-aggregate discipline the SurrealDB era established).
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

const SESSION_DURATIONS_SQL = `
SELECT started_at, ended_at
FROM session
WHERE started_at IS NOT NULL
  AND ended_at IS NOT NULL`;

// `started_at`/`ended_at` are TIMESTAMP columns - `raw()` would hand back
// native `Date`s, and `String(date)` is NOT an ISO string (it's the JS
// default toString() format). Decode through Schema + toISOString() so the
// string contract this row type promises actually holds.
const SessionDurationDbRow = Schema.Struct({
    started_at: TimestampColumn,
    ended_at: TimestampColumn,
});

export const fetchSessionDurations = Effect.fn("profile.fetchSessionDurations")(
    function* (opts: { readonly windowDays: number }) {
        const read = yield* CacheRead;
        const within = withinDaysClause("started_at", opts.windowDays);
        const rows = yield* read.rows(
            SessionDurationDbRow,
            `${SESSION_DURATIONS_SQL} ${within.sql}`,
            within.params,
        );
        return rows.map((r) => ({
            started_at: r.started_at.toISOString(),
            ended_at: r.ended_at.toISOString(),
        })) satisfies SessionDurationRow[];
    },
);

// --- deep sessions (outcome density) ----------------------------------------

/**
 * Sessions that landed a real, non-reverted commit (>0 lines touched). This is
 * the numerator for DEPTH. Two cheap deref-light statements joined in JS (house
 * style): (1) produced edges in window from non-subagent sessions to
 * non-reverted commits, (2) landed LOC per of those commits. A session is
 * "deep" when at least one of its produced commits actually touched code. No
 * LOC floor beyond >0 - a surgical fix that ships clean is a deep outcome; size
 * lives on the SCALE axis, not here.
 */
// DuckDB is bare-ref (no `session:`/`commit:` record prefixes and no `in`/`out`
// graph deref), so the old SurrealQL `in.started_at`/`in.source`/`out.reverted`
// path through the `produced` edge becomes explicit JOINs against `session` and
// `commit`, and `touched.in`/`commit` become `touched.in_id`/`"commit".id`.
// `out.reverted != true` needs `IS DISTINCT FROM TRUE` (not `!= TRUE`) because
// `reverted` is a nullable BOOLEAN (schema.duckdb.sql: NONE means "not known
// reverted") and plain `!=` against NULL evaluates to NULL, which WHERE treats
// as false and would wrongly drop every commit that has never been checked.
const DEEP_PRODUCED_SQL = `
SELECT p.in_id AS session, p.out_id AS commit
FROM produced p
JOIN session s ON s.id = p.in_id
JOIN "commit" c ON c.id = p.out_id
WHERE TRUE`;

const COMMIT_LANDED_LOC_SQL = `
SELECT t.in_id AS commit, SUM(COALESCE(t.additions, 0) + COALESCE(t.deletions, 0)) AS loc
FROM touched t
WHERE TRUE`;

// DEPTH denominator: own (non-subagent) session count, so the numerator's
// subagent filter is mirrored. fetchSessionDurations (which feeds hours/longest)
// keeps counting every session, so the two denominators differ on purpose -
// subagent sessions roughly DOUBLE the raw count and would halve this share.
const DEEP_SESSION_TOTAL_SQL = `
SELECT count(*) AS total FROM session
WHERE TRUE`;

const LOC_CHUNK = 500;

export interface DeepSessionCount {
    /** sessions that landed >=1 real, non-reverted commit (DEPTH numerator) */
    readonly deep: number;
    /** non-subagent sessions in window (DEPTH denominator) */
    readonly total: number;
}

const DeepSessionTotalRow = Schema.Struct({ total: NumberFromBigIntColumn });
const DeepProducedRow = Schema.Struct({ session: Schema.String, commit: Schema.String });
const CommitLandedLocRow = Schema.Struct({ commit: Schema.String, loc: NumberFromBigIntColumn });

export const fetchDeepSessionCount = Effect.fn("profile.fetchDeepSessionCount")(
    function* (opts: { readonly windowDays: number }) {
        const read = yield* CacheRead;

        const totalWithin = withinDaysClause("started_at", opts.windowDays);
        const totalRows = yield* read.rows(
            DeepSessionTotalRow,
            `${DEEP_SESSION_TOTAL_SQL} ${totalWithin.sql} AND started_at IS NOT NULL AND source != 'claude-subagent'`,
            totalWithin.params,
        );
        const total = totalRows[0]?.total ?? 0;

        const producedWithin = withinDaysClause("s.started_at", opts.windowDays);
        const produced = yield* read.rows(
            DeepProducedRow,
            `${DEEP_PRODUCED_SQL} ${producedWithin.sql} `
                + "AND s.source != 'claude-subagent' AND c.reverted IS DISTINCT FROM TRUE",
            producedWithin.params,
        );

        // (session, commit) pairs for landed, non-reverted commits. Ids are
        // already bare strings in DuckDB, so no key-extraction step is needed.
        const pairs = produced.filter((p) => p.session.length > 0 && p.commit.length > 0);
        if (pairs.length === 0) return { deep: 0, total } satisfies DeepSessionCount;

        const commitKeys = [...new Set(pairs.map((p) => p.commit))];
        const chunks: string[][] = [];
        for (let i = 0; i < commitKeys.length; i += LOC_CHUNK) {
            chunks.push(commitKeys.slice(i, i + LOC_CHUNK));
        }
        const locRows = (yield* Effect.all(
            chunks.map((keys) => {
                const inKeys = inClause("t.in_id", keys);
                return read.rows(
                    CommitLandedLocRow,
                    `${COMMIT_LANDED_LOC_SQL} ${inKeys.sql} GROUP BY t.in_id`,
                    inKeys.params,
                );
            }),
            { concurrency: 4 },
        )).flat();

        // Commits whose landed diff actually touched code.
        const realCommits = new Set<string>();
        for (const row of locRows) {
            if (row.loc > 0) realCommits.add(row.commit);
        }

        // Distinct sessions that produced >=1 real commit.
        const deep = new Set<string>();
        for (const p of pairs) {
            if (realCommits.has(p.commit)) deep.add(p.session);
        }
        return { deep: deep.size, total } satisfies DeepSessionCount;
    },
);

// --- peak hour ---------------------------------------------------------------

// time::format(started_at, "%H") -> DuckDB strftime; both return a
// zero-padded 24h hour string ("00".."23").
const PEAK_HOUR_SQL = `
SELECT strftime(started_at, '%H') AS hour, count(*) AS count
FROM session
WHERE TRUE`;

const PeakHourRow = Schema.Struct({ hour: Schema.String, count: NumberFromBigIntColumn });

export const fetchPeakHour = Effect.fn("profile.fetchPeakHour")(
    function* (opts: { readonly windowDays: number }) {
        const read = yield* CacheRead;
        const within = withinDaysClause("started_at", opts.windowDays);
        const rows = yield* read.rows(
            PeakHourRow,
            `${PEAK_HOUR_SQL} ${within.sql} AND started_at IS NOT NULL `
                + "GROUP BY hour ORDER BY count DESC LIMIT 1",
            within.params,
        );
        const row = rows[0];
        if (row == null) return null;
        return Number(row.hour);
    },
);

// --- spawned count -----------------------------------------------------------

const SPAWNED_COUNT_SQL = `
SELECT count(*) AS count
FROM spawned
WHERE TRUE`;

const CountRow = Schema.Struct({ count: NumberFromBigIntColumn });

export const fetchSpawnedCount = Effect.fn("profile.fetchSpawnedCount")(
    function* (opts: { readonly windowDays: number }) {
        const read = yield* CacheRead;
        const within = withinDaysClause("ts", opts.windowDays);
        const rows = yield* read.rows(CountRow, `${SPAWNED_COUNT_SQL} ${within.sql}`, within.params);
        return rows[0]?.count ?? 0;
    },
);

// --- commit count ------------------------------------------------------------
// commit table uses `ts` (datetime) - confirmed in packages/schema/src/schema.surql.

const COMMIT_COUNT_SQL = `
SELECT count(*) AS count
FROM "commit"
WHERE TRUE`;

export const fetchCommitCount = Effect.fn("profile.fetchCommitCount")(
    function* (opts: { readonly windowDays: number }) {
        const read = yield* CacheRead;
        const within = withinDaysClause("ts", opts.windowDays);
        const rows = yield* read.rows(CountRow, `${COMMIT_COUNT_SQL} ${within.sql}`, within.params);
        return rows[0]?.count ?? 0;
    },
);

// --- top tools ---------------------------------------------------------------

export interface TopToolRow {
    readonly name: string;
    readonly runs: number;
}

const TOP_TOOLS_SQL = `
SELECT COALESCE(command_norm, name) AS tool, count(*) AS count
FROM tool_call
WHERE TRUE`;

const TopToolDbRow = Schema.Struct({ tool: Schema.String, count: NumberFromBigIntColumn });

export const fetchTopTools = Effect.fn("profile.fetchTopTools")(
    function* (opts: { readonly windowDays: number }) {
        const read = yield* CacheRead;
        const within = withinDaysClause("ts", opts.windowDays);
        const rows = yield* read.rows(
            TopToolDbRow,
            `${TOP_TOOLS_SQL} ${within.sql} AND COALESCE(command_norm, name) IS NOT NULL `
                + "GROUP BY tool ORDER BY count DESC LIMIT 10",
            within.params,
        );
        return rows.map((r) => ({
            name: r.tool,
            runs: r.count,
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
const TOOL_AGG_SQL = `
SELECT
    COALESCE(command_norm, name) AS tool,
    count(*) AS count,
    SUM(CASE WHEN has_error THEN 1 ELSE 0 END) AS failures
FROM tool_call
WHERE TRUE`;

const ToolAggRow = Schema.Struct({
    tool: Schema.String,
    count: NumberFromBigIntColumn,
    failures: NumberFromBigIntColumn,
});

// Verification / context counts classify on the FULL command (`command_text`),
// not the collapsed `command_norm` - `normalizeCommand` strips the subcommand
// for non-SUBCOMMAND_TOOLS (e.g. `mvn test` -> `mvn`, `npm run lint` ->
// `npm run`, `bundle exec rspec` -> `bundle`), so the normalized label alone
// can't see the verifier. Grouped to keep cardinality sane; the command text
// is classified in-process and never returned (counts-only privacy invariant).
const VERIFY_AGG_SQL = `
SELECT COALESCE(command_text, command_norm, name) AS cmd, count(*) AS count
FROM tool_call
WHERE TRUE`;

const VerifyAggRow = Schema.Struct({ cmd: Schema.String, count: NumberFromBigIntColumn });

// Total turn count in window.
const TURN_COUNT_SQL = `
SELECT count(*) AS count
FROM turn
WHERE TRUE`;

// Distinct invoked skill names in window. DuckDB is bare-ref, so the old
// `out.name` deref through `invoked` becomes an explicit JOIN against `skill`.
const DISTINCT_SKILLS_SQL = `
SELECT count(*) AS count
FROM (
    SELECT sk.name AS skill
    FROM invoked i
    JOIN skill sk ON sk.id = i.out_id
    WHERE TRUE`;

// Count of distinct non-null repositories in window (count only, never names).
const REPOS_COUNT_SQL = `
SELECT count(*) AS count
FROM (
    SELECT repository
    FROM session
    WHERE TRUE`;

export const fetchWrappedCounts = Effect.fn("profile.fetchWrappedCounts")(
    function* (opts: { readonly windowDays: number }) {
        const read = yield* CacheRead;
        const toolWithin = withinDaysClause("ts", opts.windowDays);
        const verifyWithin = withinDaysClause("ts", opts.windowDays);
        const turnWithin = withinDaysClause("ts", opts.windowDays);
        const skillWithin = withinDaysClause("i.ts", opts.windowDays);
        const repoWithin = withinDaysClause("started_at", opts.windowDays);

        const toolRows = yield* read.rows(
            ToolAggRow,
            `${TOOL_AGG_SQL} ${toolWithin.sql} AND COALESCE(command_norm, name) IS NOT NULL `
                + "GROUP BY tool ORDER BY count DESC LIMIT 200",
            toolWithin.params,
        );
        const turnRows = yield* read.rows(
            CountRow,
            `${TURN_COUNT_SQL} ${turnWithin.sql}`,
            turnWithin.params,
        );
        const skillRows = yield* read.rows(
            CountRow,
            `${DISTINCT_SKILLS_SQL} ${skillWithin.sql} AND sk.name IS NOT NULL GROUP BY skill) t`,
            skillWithin.params,
        );
        const repoRows = yield* read.rows(
            CountRow,
            `${REPOS_COUNT_SQL} ${repoWithin.sql} AND repository IS NOT NULL GROUP BY repository) t`,
            repoWithin.params,
        );
        const verifyRows = yield* read.rows(
            VerifyAggRow,
            `${VERIFY_AGG_SQL} ${verifyWithin.sql} AND COALESCE(command_text, command_norm, name) IS NOT NULL `
                + "GROUP BY cmd",
            verifyWithin.params,
        );

        const tool_calls = toolRows.reduce((s, r) => s + r.count, 0);
        const tool_failures = toolRows.reduce((s, r) => s + r.failures, 0);
        const distinct_tools = toolRows.length;

        // Verification/context classify on the full command text (verifyRows),
        // not the collapsed command_norm tool label (toolRows).
        const cmdCount = (pred: (label: string) => boolean): number =>
            verifyRows
                .filter((r) => pred(r.cmd))
                .reduce((s, r) => s + r.count, 0);

        return {
            turns: turnRows[0]?.count ?? 0,
            tool_calls,
            tool_failures,
            distinct_tools,
            distinct_skills: skillRows[0]?.count ?? 0,
            repos_count: repoRows[0]?.count ?? 0,
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

// Reads the denormalized `session` field on the invoked edge rather than the
// deref `in.session` - avoids a per-row SurrealDB record lookup (~3–4× faster
// on the maintainer's 64k-invocation graph). Pre-denormalization edges stored
// session = NONE; the JS filter below excludes them ("NONE" guard).
const WINDOWED_INVOCATIONS_SQL = (d: number) => `
SELECT
    type::string(session) AS session,
    out.name AS skill,
    type::string(ts) AS ts
FROM invoked
WHERE ts > time::now() - ${win(d)};`;

export const fetchWindowedInvocations = Effect.fn("profile.fetchWindowedInvocations")(
    function* (opts: { readonly windowDays: number }) {
        const db = yield* SurrealClient;
        const rows = yield* timedQuery(
            "windowedInvocations",
            db.query<[Array<Record<string, unknown>>]>(WINDOWED_INVOCATIONS_SQL(opts.windowDays))
                .pipe(Effect.map((r) => r?.[0] ?? [])),
        );
        return rows
            .filter((r) =>
                r.session != null && r.skill != null
                && r.session !== "null" && r.skill !== "null"
                && r.session !== "NONE" // pre-denormalization edges stored session = NONE
            )
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

// --- guardrail receipts -----------------------------------------------------

const GUARDRAIL_HOOK_EVIDENCE_SQL = (d: number) => `
SELECT
    hook_name,
    count() AS fires,
    math::sum(IF effect = "blocked" OR provider_status = "blocking_error" THEN 1 ELSE 0 END) AS blocked,
    math::sum(IF effect IN ["notified", "injected_context", "modified_input"] THEN 1 ELSE 0 END) AS warned
FROM hook_command_invocation
WHERE ts > time::now() - ${win(d)}
  AND hook_name IS NOT NONE
GROUP BY hook_name
ORDER BY fires DESC
LIMIT 1000;`;

export const fetchGuardrailHookEvidence = Effect.fn("profile.fetchGuardrailHookEvidence")(
    function* (opts: { readonly windowDays: number }) {
        const db = yield* SurrealClient;
        const rows = yield* timedQuery(
            "guardrailHookEvidence",
            db.query<[Array<Record<string, unknown>>]>(GUARDRAIL_HOOK_EVIDENCE_SQL(opts.windowDays))
                .pipe(Effect.map((r) => r?.[0] ?? [])),
        );
        return rows.map((r) => ({
            hook_name: String(r.hook_name ?? ""),
            fires: Number(r.fires ?? 0),
            blocked: Number(r.blocked ?? 0),
            warned: Number(r.warned ?? 0),
        })).filter((r) => r.hook_name.length > 0) satisfies GuardrailHookEvidenceRow[];
    },
);

export const fetchGuardrailVerdicts = Effect.fn("profile.fetchGuardrailVerdicts")(
    function* (opts: { readonly windowDays: number }) {
        const cutoff = new Date(Date.now() - Math.max(1, opts.windowDays) * 86_400_000);
        const proposals = yield* timedQuery(
            "guardrailVerdicts",
            listStoredProposals(10_000),
        );
        const counts = new Map<string, number>();
        for (const checkpoint of proposals.flatMap((proposal) => proposal.experiment?.checkpoints ?? [])) {
            if (checkpoint.observed_at <= cutoff || checkpoint.user_verdict === null) continue;
            counts.set(checkpoint.user_verdict, (counts.get(checkpoint.user_verdict) ?? 0) + 1);
        }
        return [...counts.entries()]
            .map(([verdict, count]) => ({ verdict, count }))
            .sort((a, b) => b.count - a.count || a.verdict.localeCompare(b.verdict)) satisfies GuardrailVerdictRow[];
    },
);
