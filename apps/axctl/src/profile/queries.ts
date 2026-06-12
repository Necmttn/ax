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
