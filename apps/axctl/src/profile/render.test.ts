import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { makeMockDb, type MockDbResponses, type TestSurrealClient } from "@ax/lib/testing/surreal";
import { cacheReadTestLayer, judgmentTestLayer } from "../testing/judgment-test-layer.ts";
import { buildProfile } from "./render.ts";

// EVERY statement `buildProfile` issues now goes through CacheRead. The mock
// SurrealClient below is still provided because `buildProfile`'s signature
// carries the requirement transitively, but nothing reaches it - a query that
// did would surface as an "out of results" mock failure rather than a silent
// wrong answer. The two that used to: `fetchCostModels` (ported by
// `c-read-analytics`) and `fetchWindowedInvocations` (ported here); both now
// have entries in CACHE_ROUTES, keyed by a fragment of their own SQL.
const surrealResults = [] satisfies MockDbResponses;

// `fetchContentTypeBreakdown` (queries/content-types.ts) reads the published
// CacheRead snapshot, matched below by its own "has_content" fragment (a
// different wave-3 chunk's convention, unchanged here).
const contentTypeRows = [
    { ct: "content_type:code", calls: 10, bytes: 800 },
    { ct: "content_type:text", calls: 5, bytes: 200 },
];

// One entry per queries.ts CacheRead statement, keyed by a fragment of that
// statement's own SQL text unique enough not to collide with any other
// statement in this file (verified by hand against queries.ts; every key
// names the _SQL constant it targets). `cacheReadTestLayer` does NOT run
// Schema decode (see judgment-test-layer.ts), so a field a ported function
// calls a Date method on (fetchSessionDurations' .toISOString()) must be a
// real `Date` here, not a string - everything else here is read via
// Number(...)/String(...) at the call site, so plain values are safe.
const CACHE_ROUTES: Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>> = {
    // fetchWindowedInvocations (WINDOWED_INVOCATIONS_SQL) - ported off
    // SurrealQL here. Keyed on the join, which is unique to this statement.
    // `ts` is a TIMESTAMP column now, so the fixture passes real Dates; the
    // reader renders them back to the ISO strings its callers compare.
    "JOIN skill s ON s.id = i.out_id": [
        { session: "session:1", skill: "tdd", ts: new Date("2026-06-12T10:01:00.000Z") },
        { session: "session:1", skill: "tdd", ts: new Date("2026-06-12T10:30:00.000Z") },
        { session: "session:2", skill: "tdd", ts: new Date("2026-06-12T11:01:00.000Z") },
    ],
    // fetchCostModels (COST_MODELS_SQL) - ported off SurrealQL by
    // `c-read-analytics`. Keyed on `GROUP BY model`, which no other statement
    // in this file uses; the `FROM session_token_usage` fragment alone would
    // collide with fetchTokenTotals below.
    "GROUP BY model": [
        {
            model: "fable", sessions: 100, prompt_tokens: 1, completion_tokens: 1,
            cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: 150,
        },
        {
            model: "haiku", sessions: 42, prompt_tokens: 1, completion_tokens: 1,
            cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: 50,
        },
    ],
    // fetchTokenTotals (TOKEN_TOTALS_SQL)
    "count(*) AS sessions\nFROM session_token_usage": [
        { prompt_tokens: 31_000_000, completion_tokens: 7_000_000, sessions: 142 },
    ],
    // fetchDailyActivity (DAILY_ACTIVITY_SQL)
    "AS date\nFROM session\nWHERE started_at IS NOT NULL": [
        { date: "2026-06-11" }, { date: "2026-06-12" },
    ],
    // fetchHarnesses (HARNESSES_SQL)
    "source, count(*) AS count": [{ source: "claude" }, { source: "codex" }],
    // fetchSkillInvocations (SKILL_INVOCATIONS_SQL)
    "sk.name AS skill, count(*) AS count": [{ skill: "tdd", count: 88 }],
    // fetchSkillScopes (SKILL_SCOPES_SQL)
    "FROM skill WHERE deleted_at IS NULL": [{ name: "tdd", scope: "plugin:superpowers" }],
    // fetchDailyActivityFull sessions half (DAILY_SESSIONS_SQL)
    "count(*) AS sessions\nFROM session\nWHERE started_at IS NOT NULL": [
        { date: "2026-06-11", sessions: 5 }, { date: "2026-06-12", sessions: 12 },
    ],
    // fetchDailyActivityFull tokens half (DAILY_TOKENS_SQL)
    "FROM session_token_usage\nWHERE ts IS NOT NULL": [
        { date: "2026-06-11", tokens: 100_000 }, { date: "2026-06-12", tokens: 120_000_000 },
    ],
    // fetchSessionDurations (SESSION_DURATIONS_SQL) - real Dates, see header note.
    "SELECT started_at, ended_at\nFROM session": [
        { started_at: new Date("2026-06-12T10:00:00Z"), ended_at: new Date("2026-06-12T12:30:00Z") },
        { started_at: new Date("2026-06-12T09:00:00Z"), ended_at: new Date("2026-06-12T10:30:00Z") },
    ],
    // fetchPeakHour (PEAK_HOUR_SQL)
    "strftime(started_at, '%H') AS hour": [{ hour: "13", count: 42 }],
    // fetchSpawnedCount (SPAWNED_COUNT_SQL)
    "FROM spawned": [{ count: 420 }],
    // fetchCommitCount (COMMIT_COUNT_SQL)
    "AS count\nFROM \"commit\"": [{ count: 1000 }],
    // fetchTopTools (TOP_TOOLS_SQL)
    "COALESCE(command_norm, name) AS tool, count(*) AS count": [
        { tool: "Bash", count: 5000 }, { tool: "Read", count: 3200 },
    ],
    // fetchWrappedCounts toolAgg (TOOL_AGG_SQL) - Bash=verification, Read=context
    "SUM(CASE WHEN has_error THEN 1 ELSE 0 END) AS failures": [
        { tool: "bun test", count: 900, failures: 10 },
        { tool: "Read", count: 2000, failures: 5 },
        { tool: "Bash", count: 3000, failures: 50 },
    ],
    // fetchWrappedCounts turnCount (TURN_COUNT_SQL)
    "count(*) AS count\nFROM turn": [{ count: 41200 }],
    // fetchWrappedCounts distinctSkills (DISTINCT_SKILLS_SQL)
    "    JOIN skill sk ON sk.id = i.out_id\n    WHERE TRUE": [{ count: 56 }],
    // fetchWrappedCounts reposCount (REPOS_COUNT_SQL)
    "    SELECT repository\n    FROM session": [{ count: 12 }],
    // fetchWrappedCounts verifyAgg (VERIFY_AGG_SQL) - full command_text labels
    "COALESCE(command_text, command_norm, name) AS cmd": [
        { cmd: "bun test", count: 900 }, { cmd: "Read", count: 2000 }, { cmd: "Bash", count: 3000 },
    ],
    // fetchDailyModels (DAILY_MODEL_TOKENS_SQL)
    "    model,\n    SUM(COALESCE(prompt_tokens, 0))": [
        { date: "2026-06-11", model: "fable", tokens: 80_000 },
        { date: "2026-06-12", model: "fable", tokens: 100_000_000 },
        { date: "2026-06-12", model: "haiku", tokens: 20_000_000 },
    ],
    // fetchDailyToolCalls (DAILY_TOOL_CALLS_SQL)
    "AS tool_calls\nFROM tool_call": [
        { date: "2026-06-11", tool_calls: 200 }, { date: "2026-06-12", tool_calls: 3900 },
    ],
    // fetchDailyCommits (DAILY_COMMITS_SQL)
    "AS commits\nFROM \"commit\"": [
        { date: "2026-06-11", commits: 7 }, { date: "2026-06-12", commits: 50 },
    ],
    // fetchDeepSessionCount total (DEEP_SESSION_TOTAL_SQL) - non-subagent
    // session count = DEPTH denominator
    "count(*) AS total FROM session": [{ total: 2 }],
    // fetchDeepSessionCount produced edges (DEEP_PRODUCED_SQL) - session -> non-reverted commit
    "FROM produced p": [
        { session: "session:1", commit: "commit:abc" },
        { session: "session:2", commit: "commit:def" },
    ],
    // fetchDeepSessionCount landed LOC per commit (COMMIT_LANDED_LOC_SQL) -
    // commit:def landed nothing -> not deep
    "FROM touched t": [{ commit: "commit:abc", loc: 120 }, { commit: "commit:def", loc: 0 }],
    // fetchWindowedSessions (WINDOWED_SESSIONS_SQL) - real Dates, see header note.
    "id, started_at AS s, ended_at AS e": [
        {
            id: "session:1",
            s: new Date("2026-06-12T10:00:00Z"),
            e: new Date("2026-06-12T12:30:00Z"),
        },
        {
            id: "session:2",
            s: new Date("2026-06-12T09:00:00Z"),
            e: new Date("2026-06-12T10:30:00Z"),
        },
    ],
    // fetchGuardrailHookEvidence (GUARDRAIL_HOOK_EVIDENCE_SQL)
    "FROM hook_command_invocation": [
        { hook_name: "/Users/me/.ax/hooks/enforce-worktree.ts", fires: 412, blocked: 9, warned: 0 },
        { hook_name: "route-dispatch", fires: 25, blocked: 0, warned: 12 },
        { hook_name: "uninstalled.ts", fires: 99, blocked: 99, warned: 0 },
    ],
};

const proposalRows = [{
    id: "p1", form: "guidance", title: "Stop edit loops early",
    hypothesis: "3+ edits means drift", confidence: "high", frequency: 12,
    dedupe_sig: "sig", status: "accepted", origin: "agent",
    hypothesis_template: null, evidence_query: null, reject_reason: null, baseline: null,
    updated_at: new Date("2026-06-10T00:00:00Z"), created_at: new Date("2026-06-01T00:00:00Z"),
}];
const verdictRows = [
    { verdict: "adopted", count: 4 },
    { verdict: "regressed", count: 1 },
    { verdict: "ignored", count: 1 },
    { verdict: "no_longer_needed", count: 1 },
    { verdict: "partial", count: 2 },
];

const runProfile = <A, E>(
    db: TestSurrealClient,
    effect: Effect.Effect<A, E, unknown>,
    proposals: ReadonlyArray<Record<string, unknown>> = proposalRows,
    contentTypes: ReadonlyArray<Record<string, unknown>> = contentTypeRows,
    cacheOverrides: Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>> = {},
) => Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(
    db.layer,
    // Dispatched by SQL text: content-type breakdown (`has_content`, a
    // different wave-3 chunk's convention) first, then per-test overrides,
    // then the default CACHE_ROUTES table built above. The pricing-catalog
    // lookup inside fetchCostModels resolves when a row stores zero cost
    // against real tokens - none of these fixtures do, so falling through to
    // empty is the right answer for it.
    cacheReadTestLayer((sql) => {
        if (sql.includes("has_content")) return contentTypes;
        for (const [key, rows] of Object.entries(cacheOverrides)) {
            if (sql.includes(key)) return rows;
        }
        for (const [key, rows] of Object.entries(CACHE_ROUTES)) {
            if (sql.includes(key)) return rows;
        }
        return [];
    }),
    judgmentTestLayer((sql) => {
        const now = new Date();
        if (sql.includes("FROM proposal")) return proposals;
        if (proposals.length === 0) return [];
        if (sql.includes("FROM experiment")) return [{
            id: "e1", proposal: "p1", artifact: null, artifact_path: null,
            scaffolded_at: now, created_at: now, locked_verdict: null,
            status: "scaffolded", task_path: null,
        }];
        if (sql.includes("FROM checkpoint")) return verdictRows.flatMap(({ verdict, count }) =>
            Array.from({ length: count }, (_, index) => ({
                id: `${verdict}-${index}`, experiment: "e1", kind: "+3s", measured: {},
                suggested: null, user_verdict: verdict, observed_at: now,
            }))
        );
        return [];
    }),
))) as Effect.Effect<A, E>);

const env = {
    github: "necmttn",
    generatedAt: "2026-06-12T19:00:00Z",
    today: "2026-06-12",
    hookFiles: ["enforce-worktree.ts", "route-dispatch.ts"],
    hasRoutingTable: true,
    rulesMarkdown: "- rule one\n- rule two",
    highlights: null,
};

describe("buildProfile", () => {
    test("assembles a valid ProfileV1", async () => {
        const db = makeMockDb(surrealResults);
        const p = await runProfile(db, buildProfile({ windowDays: 30, includeCost: true, env }));

        expect(p.v).toBe(1);
        expect(p.github).toBe("necmttn");
        expect(p.window_days).toBe(30);
        expect(p.stats.sessions).toBe(142);
        expect(p.stats.tokens.total).toBe(38_000_000);
        expect(p.stats.streak_days).toBe(2);
        expect(p.stats.cost_usd).toBe(200);
        expect(p.stats.models).toEqual([
            { name: "fable", share: 0.75, cost_usd: 150 },
            { name: "haiku", share: 0.25, cost_usd: 50 },
        ]);
        expect(p.stats.harnesses).toEqual(["claude", "codex"]);
        // tdd gets downstream_share from 2 qualifying sessions (avg ~0.5 due to late-fire in s2)
        expect(p.rig.skills[0]!.name).toBe("tdd");
        expect(p.rig.skills[0]!.source).toBe("superpowers");
        expect(p.rig.skills[0]!.runs).toBe(88);
        expect(p.rig.skills[0]!.downstream_share).toBeDefined();
        expect(p.rig.rules).toEqual({ count: 2 });
        expect(p.taste!.patterns[0]!.name).toBe("stop-edit-loops-early");
        // activity
        expect(p.activity).toBeDefined();
        expect(p.activity!.daily).toHaveLength(2);
        // enriched daily
        const day0 = p.activity!.daily[0]!;
        expect(day0.date).toBe("2026-06-11");
        expect(day0.sessions).toBe(5);
        expect(day0.tokens).toBe(100_000);
        expect(day0.models).toBeDefined();
        expect(day0.models![0]!.name).toBe("fable");
        expect(day0.models![0]!.tokens).toBe(80_000);
        expect(day0.tool_calls).toBe(200);
        expect(day0.commits).toBe(7);
        const day1 = p.activity!.daily[1]!;
        expect(day1.tokens).toBe(120_000_000);
        expect(day1.models).toHaveLength(2); // fable + haiku
        expect(day1.tool_calls).toBe(3900);
        expect(day1.commits).toBe(50);
        // workflow: tdd only fires in 2 sessions, no pair -> no bigrams >= 3, omitted
        expect(p.workflow).toBeUndefined();
        // downstream_share on tdd skill: 2 qualifying sessions -> defined
        expect(p.rig.skills[0]!.downstream_share).toBeDefined();
        // insights
        expect(p.insights).toBeDefined();
        expect(p.insights!.hours_total).toBeCloseTo(4, 1); // 2.5h + 1.5h
        expect(p.insights!.longest_session_minutes).toBe(150);
        // 1 of 2 non-subagent sessions landed a real commit (session:1 -> commit:abc, loc>0)
        expect(p.insights!.deep_session_share).toBe(0.5);
        expect(p.insights!.peak_hour_utc).toBe(13);
        expect(p.insights!.busiest_day).toEqual({ date: "2026-06-12", sessions: 12 });
        expect(p.insights!.max_parallel_sessions).toBe(2);
        expect(p.insights!.subagents_spawned).toBe(420);
        expect(p.insights!.commits).toBe(1000);
        expect(p.insights!.tools_top).toEqual([
            { name: "Bash", runs: 5000 },
            { name: "Read", runs: 3200 },
        ]);
        // wrapped-style counts
        expect(p.insights!.turns).toBe(41200);
        expect(p.insights!.tool_calls).toBe(5900); // 900+2000+3000
        expect(p.insights!.tool_failures).toBe(65); // 10+5+50
        expect(p.insights!.distinct_tools).toBe(3);
        expect(p.insights!.distinct_skills).toBe(56);
        expect(p.insights!.repos_count).toBe(12);
        expect(p.insights!.verification_calls).toBe(900); // "bun test" matches
        expect(p.insights!.context_calls).toBe(2000); // "Read" matches
        expect(p.guardrail_receipts).toEqual({
            hooks: [
                { name: "enforce-worktree", fires: 412, blocked: 9, warned: 0 },
                { name: "route-dispatch", fires: 25, blocked: 0, warned: 12 },
            ],
            verdicts: {
                worked: 4,
                did_not_work: 2,
                no_longer_needed: 1,
                partial: 2,
            },
        });
    });

    test("includeCost=false strips cost everywhere; share falls back to sessions", async () => {
        const db = makeMockDb(surrealResults);
        const p = await runProfile(db, buildProfile({ windowDays: 30, includeCost: false, env }));
        expect(p.stats.cost_usd).toBeUndefined();
        expect(p.stats.models[0]).toEqual({ name: "fable", share: 100 / 142 });
    });

    test("no proposals -> taste has only the mix pattern from content types", async () => {
        const db = makeMockDb(surrealResults);
        const p = await runProfile(db, buildProfile({ windowDays: 30, includeCost: true, env }), []);
        expect(p.taste?.patterns).toHaveLength(1);
        expect(p.taste?.patterns[0]?.category).toBe("tool-output-mix");
    });

    test("no proposals + no content types -> taste omitted", async () => {
        const db = makeMockDb(surrealResults);
        const p = await runProfile(db, buildProfile({ windowDays: 30, includeCost: true, env }), [], []);
        expect(p.taste).toBeUndefined();
    });

    test("empty daily + durations -> activity and insights omitted", async () => {
        // Blank out dailyFull(sessions+tokens) and sessionDurations via a
        // CACHE_ROUTES override - all three are now CacheRead statements.
        const db = makeMockDb(surrealResults);
        const p = await runProfile(
            db,
            buildProfile({ windowDays: 30, includeCost: true, env }),
            proposalRows,
            contentTypeRows,
            {
                "count(*) AS sessions\nFROM session\nWHERE started_at IS NOT NULL": [],
                "FROM session_token_usage\nWHERE ts IS NOT NULL": [],
                "SELECT started_at, ended_at\nFROM session": [],
            },
        );
        expect(p.activity).toBeUndefined();
        expect(p.insights).toBeUndefined();
    });

    test("buildProfile attaches highlights from env", async () => {
        const db = makeMockDb(surrealResults);
        const profile = await runProfile(db, buildProfile({
            windowDays: 30,
            includeCost: true,
            env: {
                github: "octocat", generatedAt: "2026-06-12T00:00:00Z", today: "2026-06-12",
                hookFiles: [], hasRoutingTable: false, rulesMarkdown: null,
                highlights: { authored_at: "2026-06-17T00:00:00Z", taste: "ship clean" },
            },
        }));
        expect(profile.highlights?.taste).toBe("ship clean");
    });

    test("buildProfile omits highlights when env.highlights is null", async () => {
        const db = makeMockDb(surrealResults);
        const profile = await runProfile(db, buildProfile({
            windowDays: 30,
            includeCost: true,
            env: {
                github: "octocat", generatedAt: "2026-06-12T00:00:00Z", today: "2026-06-12",
                hookFiles: [], hasRoutingTable: false, rulesMarkdown: null, highlights: null,
            },
        }));
        expect(profile.highlights).toBeUndefined();
    });
});
