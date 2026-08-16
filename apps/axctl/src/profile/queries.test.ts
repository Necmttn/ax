import { describe, expect, test } from "bun:test";
import { Effect, type Layer } from "effect";
import { makeMockDb, runWithMock } from "@ax/lib/testing/surreal";
import { makeTestCacheRead, type TestCacheOptions } from "@ax/lib/testing/cache";
import type { CacheRead, CacheReadError } from "@ax/lib/duckdb/seam";
import { judgmentTestLayer } from "../testing/judgment-test-layer.ts";
import {
    fetchAcceptedProposals,
    fetchCommitCount,
    fetchDailyActivity,
    fetchDailyActivityFull,
    fetchDailyCommits,
    fetchDailyModels,
    fetchDailyToolCalls,
    fetchDeepSessionCount,
    fetchGuardrailHookEvidence,
    fetchGuardrailVerdicts,
    fetchHarnesses,
    fetchPeakHour,
    fetchSessionDurations,
    fetchSkillInvocations,
    fetchSkillScopes,
    fetchSpawnedCount,
    fetchTokenTotals,
    fetchTopTools,
    fetchWindowedInvocations,
    fetchWindowedSessions,
    fetchWrappedCounts,
} from "./queries.ts";

/** A real-decode CacheRead fake (@ax/lib/testing/cache). */
const cacheRead = (routes: TestCacheOptions["routes"] = {}) => makeTestCacheRead({ routes });
const runCache = <A>(
    eff: Effect.Effect<A, CacheReadError, CacheRead>,
    layer: Layer.Layer<CacheRead>,
): Promise<A> => Effect.runPromise(eff.pipe(Effect.provide(layer)));

describe("fetchTokenTotals", () => {
    test("sums tokens and sessions over the window", async () => {
        const cache = cacheRead({
            "FROM session_token_usage": [{ prompt_tokens: 100, completion_tokens: 40, sessions: 3 }],
        });
        const r = await runCache(fetchTokenTotals({ windowDays: 30 }), cache.layer);
        expect(r).toEqual({ prompt_tokens: 100, completion_tokens: 40, sessions: 3 });
        expect(cache.captured[0]).toContain("INTERVAL '1 day'");
        expect(cache.captured[0]).toContain("session_token_usage");
    });

    test("empty window -> zeros", async () => {
        const cache = cacheRead({});
        const r = await runCache(fetchTokenTotals({ windowDays: 30 }), cache.layer);
        expect(r).toEqual({ prompt_tokens: 0, completion_tokens: 0, sessions: 0 });
    });
});

describe("fetchDailyActivity", () => {
    test("returns day keys from session table (not turn)", async () => {
        const cache = cacheRead({ "FROM session": [{ date: "2026-06-11" }, { date: "2026-06-12" }] });
        const r = await runCache(fetchDailyActivity({ windowDays: 30 }), cache.layer);
        expect(r).toEqual(["2026-06-11", "2026-06-12"]);
        // Fix 1a: must use session.started_at (fast) not turn.ts (full-scan)
        expect(cache.captured[0]).toContain("strftime(started_at, '%Y-%m-%d')");
        expect(cache.captured[0]).toContain("FROM session");
        expect(cache.captured[0]).not.toContain("FROM turn");
    });
});

describe("fetchHarnesses", () => {
    test("returns distinct sources", async () => {
        const cache = cacheRead({ "FROM session": [{ source: "claude" }, { source: "codex" }] });
        const r = await runCache(fetchHarnesses({ windowDays: 30 }), cache.layer);
        expect(r).toEqual(["claude", "codex"]);
        expect(cache.captured[0]).toContain("GROUP BY source");
    });
});

describe("fetchSkillInvocations", () => {
    test("returns name+count rows, window applied", async () => {
        const cache = cacheRead({ "FROM invoked": [{ skill: "tdd", count: 88 }] });
        const r = await runCache(fetchSkillInvocations({ windowDays: 30 }), cache.layer);
        expect(r).toEqual([{ skill: "tdd", count: 88 }]);
        expect(cache.captured[0]).toContain("FROM invoked");
        expect(cache.captured[0]).toContain("INTERVAL '1 day'");
    });
});

describe("fetchSkillScopes", () => {
    test("maps name -> scope, tombstones filtered in SQL", async () => {
        const cache = cacheRead({
            "FROM skill": [
                { name: "tdd", scope: "plugin:superpowers" },
                { name: "my-local", scope: "user" },
            ],
        });
        const r = await runCache(fetchSkillScopes(), cache.layer);
        expect(r.get("tdd")).toBe("plugin:superpowers");
        expect(cache.captured[0]).toContain("deleted_at IS NULL");
    });
});

describe("fetchAcceptedProposals", () => {
    test("returns accepted proposals with fields the taste deriver needs", async () => {
        const rows = [
            {
                id: "p1",
                form: "guidance",
                title: "Stop edit loops early",
                hypothesis: "3+ edits same file means requirements drift",
                confidence: "high",
                frequency: 12,
                dedupe_sig: "sig",
                status: "accepted",
                origin: "agent",
                hypothesis_template: null,
                evidence_query: null,
                reject_reason: null,
                baseline: null,
                updated_at: "2026-06-10T00:00:00Z",
                created_at: "2026-06-01T00:00:00Z",
            },
        ];
        const r = await Effect.runPromise(fetchAcceptedProposals().pipe(
            Effect.provide(judgmentTestLayer((sql) => sql.includes("FROM proposal") ? rows.map((row) => ({
                ...row,
                updated_at: new Date(row.updated_at),
                created_at: new Date(row.created_at),
            })) : [])),
        ));
        expect(r[0]!.title).toBe("Stop edit loops early");
    });
});

describe("fetchDailyActivityFull", () => {
    test("returns date+sessions+tokens rows, window applied", async () => {
        const cache = cacheRead({
            "FROM session\nWHERE": [{ date: "2026-06-11", sessions: 5 }, { date: "2026-06-12", sessions: 3 }],
            "FROM session_token_usage": [{ date: "2026-06-11", tokens: 100_000 }, { date: "2026-06-12", tokens: 80_000 }],
        });
        const r = await runCache(fetchDailyActivityFull({ windowDays: 30 }), cache.layer);
        expect(r).toHaveLength(2);
        expect(r[0]).toEqual({ date: "2026-06-11", sessions: 5, tokens: 100_000 });
        expect(r[1]).toEqual({ date: "2026-06-12", sessions: 3, tokens: 80_000 });
        expect(cache.captured[0]).toContain("INTERVAL '1 day'");
        // Fix 1b: must use session table (fast) not turn table full-scan
        expect(cache.captured[0]).toContain("FROM session");
        expect(cache.captured[0]).toContain("count(*) AS sessions");
        expect(cache.captured[0]).not.toContain("array::len(array::distinct(session))");
    });

    test("day with no tokens entry gets tokens=0", async () => {
        const cache = cacheRead({
            "FROM session\nWHERE": [{ date: "2026-06-11", sessions: 5 }],
            "FROM session_token_usage": [],
        });
        const r = await runCache(fetchDailyActivityFull({ windowDays: 30 }), cache.layer);
        expect(r[0]).toEqual({ date: "2026-06-11", sessions: 5, tokens: 0 });
    });

    test("empty window -> empty array", async () => {
        const cache = cacheRead({});
        const r = await runCache(fetchDailyActivityFull({ windowDays: 30 }), cache.layer);
        expect(r).toHaveLength(0);
    });
});

describe("fetchSessionDurations", () => {
    test("returns started_at+ended_at as ISO strings, window applied", async () => {
        const cache = cacheRead({
            "FROM session": [
                { started_at: "2026-06-11T10:00:00.000Z", ended_at: "2026-06-11T12:30:00.000Z" },
                { started_at: "2026-06-12T09:00:00.000Z", ended_at: "2026-06-12T10:00:00.000Z" },
            ],
        });
        const r = await runCache(fetchSessionDurations({ windowDays: 30 }), cache.layer);
        expect(r[0]!.started_at).toBe("2026-06-11T10:00:00.000Z");
        expect(r[0]!.ended_at).toBe("2026-06-11T12:30:00.000Z");
        expect(cache.captured[0]).toContain("ended_at IS NOT NULL");
        expect(cache.captured[0]).toContain("started_at IS NOT NULL");
        expect(cache.captured[0]).toContain("INTERVAL '1 day'");
    });

    test("empty window -> empty array", async () => {
        const cache = cacheRead({});
        const r = await runCache(fetchSessionDurations({ windowDays: 30 }), cache.layer);
        expect(r).toHaveLength(0);
    });
});

describe("fetchDeepSessionCount", () => {
    test("counts sessions with >=1 real (non-reverted, LOC>0) commit", async () => {
        const cache = cacheRead({
            "count(*) AS total FROM session": [{ total: 42 }],
            "FROM produced p": [
                { session: "sess-a", commit: "commit-1" },
                { session: "sess-b", commit: "commit-2" },
            ],
            "FROM touched t": [
                { commit: "commit-1", loc: 12 },
                { commit: "commit-2", loc: 0 },
            ],
        });
        const r = await runCache(fetchDeepSessionCount({ windowDays: 30 }), cache.layer);
        expect(r).toEqual({ deep: 1, total: 42 });
        expect(cache.captured.some((sql) => sql.includes("c.reverted IS DISTINCT FROM TRUE"))).toBe(true);
        expect(cache.captured.some((sql) => sql.includes("s.source != 'claude-subagent'"))).toBe(true);
        expect(cache.captured.some((sql) => sql.includes("t.in_id IN (?, ?)"))).toBe(true);
    });

    test("no produced rows -> deep 0, total preserved", async () => {
        const cache = cacheRead({
            "count(*) AS total FROM session": [{ total: 7 }],
            "FROM produced p": [],
        });
        const r = await runCache(fetchDeepSessionCount({ windowDays: 30 }), cache.layer);
        expect(r).toEqual({ deep: 0, total: 7 });
    });
});

describe("fetchPeakHour", () => {
    test("returns the peak hour as a number", async () => {
        const cache = cacheRead({ "strftime(started_at, '%H')": [{ hour: "13", count: 42 }] });
        const r = await runCache(fetchPeakHour({ windowDays: 30 }), cache.layer);
        expect(r).toBe(13);
        expect(cache.captured[0]).toContain("strftime(started_at");
        expect(cache.captured[0]).toContain("INTERVAL '1 day'");
    });

    test("empty window -> null", async () => {
        const cache = cacheRead({});
        const r = await runCache(fetchPeakHour({ windowDays: 30 }), cache.layer);
        expect(r).toBeNull();
    });
});

describe("fetchSpawnedCount", () => {
    test("returns spawned count in window", async () => {
        const cache = cacheRead({ "FROM spawned": [{ count: 420 }] });
        const r = await runCache(fetchSpawnedCount({ windowDays: 30 }), cache.layer);
        expect(r).toBe(420);
        expect(cache.captured[0]).toContain("FROM spawned");
        expect(cache.captured[0]).toContain("INTERVAL '1 day'");
    });

    test("empty -> 0", async () => {
        const cache = cacheRead({});
        const r = await runCache(fetchSpawnedCount({ windowDays: 30 }), cache.layer);
        expect(r).toBe(0);
    });
});

describe("fetchCommitCount", () => {
    test("returns commit count using ts field", async () => {
        const cache = cacheRead({ 'FROM "commit"': [{ count: 1000 }] });
        const r = await runCache(fetchCommitCount({ windowDays: 30 }), cache.layer);
        expect(r).toBe(1000);
        expect(cache.captured[0]).toContain('FROM "commit"');
        expect(cache.captured[0]).toContain("ts >=");
        expect(cache.captured[0]).toContain("INTERVAL '1 day'");
    });

    test("empty -> 0", async () => {
        const cache = cacheRead({});
        const r = await runCache(fetchCommitCount({ windowDays: 30 }), cache.layer);
        expect(r).toBe(0);
    });
});

describe("fetchTopTools", () => {
    test("returns top 10 tools by run count, window applied", async () => {
        const cache = cacheRead({
            "FROM tool_call": [
                { tool: "Bash", count: 5000 },
                { tool: "Read", count: 3200 },
            ],
        });
        const r = await runCache(fetchTopTools({ windowDays: 30 }), cache.layer);
        expect(r[0]).toEqual({ name: "Bash", runs: 5000 });
        expect(r[1]).toEqual({ name: "Read", runs: 3200 });
        expect(cache.captured[0]).toContain("FROM tool_call");
        expect(cache.captured[0]).toContain("COALESCE(command_norm, name)");
        expect(cache.captured[0]).toContain("LIMIT 10");
        expect(cache.captured[0]).toContain("INTERVAL '1 day'");
    });

    test("empty -> empty array", async () => {
        const cache = cacheRead({});
        const r = await runCache(fetchTopTools({ windowDays: 30 }), cache.layer);
        expect(r).toHaveLength(0);
    });
});

describe("fetchWrappedCounts", () => {
    test("aggregates tool_calls, failures, distinct_tools and pattern-matches in JS", async () => {
        const cache = makeTestCacheRead({
            // Positional, mirroring fetchWrappedCounts' fixed query order:
            // toolAgg, turnCount, distinctSkills, reposCount, verifyAgg.
            responses: [
                [
                    { tool: "bun test", count: 900, failures: 10 },
                    { tool: "Read", count: 2000, failures: 5 },
                    { tool: "Bash", count: 3000, failures: 50 },
                ],
                [{ count: 41200 }],
                [{ count: 56 }],
                [{ count: 12 }],
                [
                    { cmd: "bun test", count: 900 },
                    { cmd: "Read", count: 2000 },
                    { cmd: "Bash", count: 3000 },
                ],
            ],
        });
        const r = await runCache(fetchWrappedCounts({ windowDays: 30 }), cache.layer);
        expect(r.turns).toBe(41200);
        expect(r.tool_calls).toBe(5900); // 900+2000+3000
        expect(r.tool_failures).toBe(65); // 10+5+50
        expect(r.distinct_tools).toBe(3);
        expect(r.distinct_skills).toBe(56);
        expect(r.repos_count).toBe(12);
        // "bun test" -> verification via tool-taxonomy isVerificationTool (verifyAgg)
        expect(r.verification_calls).toBe(900);
        // "Read" -> context via tool-taxonomy isContextTool (verifyAgg)
        expect(r.context_calls).toBe(2000);
        // SQL contains window clause
        expect(cache.captured[0]).toContain("INTERVAL '1 day'");
        expect(cache.captured[0]).toContain("FROM tool_call");
        expect(cache.captured[1]).toContain("FROM turn");
        expect(cache.captured[2]).toContain("FROM invoked");
        expect(cache.captured[3]).toContain("FROM session");
        // 5th query classifies the full command text
        expect(cache.captured[4]).toContain("command_text");
    });

    test("empty tables -> all zeros", async () => {
        const cache = makeTestCacheRead({ responses: [[], [], [], [], []] });
        const r = await runCache(fetchWrappedCounts({ windowDays: 30 }), cache.layer);
        expect(r.turns).toBe(0);
        expect(r.tool_calls).toBe(0);
        expect(r.tool_failures).toBe(0);
        expect(r.distinct_tools).toBe(0);
        expect(r.distinct_skills).toBe(0);
        expect(r.repos_count).toBe(0);
        expect(r.verification_calls).toBe(0);
        expect(r.context_calls).toBe(0);
    });

    test("verification + context patterns are exclusive of non-matching tools", async () => {
        const cache = makeTestCacheRead({
            responses: [
                [
                    { tool: "lint", count: 500, failures: 0 }, // verification
                    { tool: "grep", count: 300, failures: 2 }, // context
                    { tool: "Agent", count: 200, failures: 0 }, // neither
                ],
                [{ count: 1000 }],
                [{ count: 10 }],
                [{ count: 5 }],
                [
                    { cmd: "lint", count: 500 }, // verification
                    { cmd: "grep", count: 300 }, // context
                    { cmd: "Agent", count: 200 }, // neither
                ],
            ],
        });
        const r = await runCache(fetchWrappedCounts({ windowDays: 30 }), cache.layer);
        expect(r.verification_calls).toBe(500);
        expect(r.context_calls).toBe(300);
        expect(r.tool_calls).toBe(1000);
    });
});

describe("fetchDailyModels", () => {
    test("returns per-day per-model token totals, null model -> (unattributed)", async () => {
        const cache = cacheRead({
            "FROM session_token_usage": [
                { date: "2026-06-11", model: "claude-opus-5", tokens: 40000 },
                { date: "2026-06-11", model: null, tokens: 500 },
            ],
        });
        const r = await runCache(fetchDailyModels({ windowDays: 30 }), cache.layer);
        expect(r[0]).toEqual({ date: "2026-06-11", model: "claude-opus-5", tokens: 40000 });
        expect(r[1]).toEqual({ date: "2026-06-11", model: "(unattributed)", tokens: 500 });
        expect(cache.captured[0]).toContain("strftime(ts, '%Y-%m-%d')");
        expect(cache.captured[0]).toContain("INTERVAL '1 day'");
    });

    test("empty -> empty array", async () => {
        const cache = cacheRead({});
        const r = await runCache(fetchDailyModels({ windowDays: 30 }), cache.layer);
        expect(r).toHaveLength(0);
    });
});

describe("fetchDailyToolCalls", () => {
    test("returns per-day tool_call counts", async () => {
        const cache = cacheRead({
            "FROM tool_call": [
                { date: "2026-06-11", tool_calls: 120 },
                { date: "2026-06-12", tool_calls: 80 },
            ],
        });
        const r = await runCache(fetchDailyToolCalls({ windowDays: 30 }), cache.layer);
        expect(r).toEqual([
            { date: "2026-06-11", tool_calls: 120 },
            { date: "2026-06-12", tool_calls: 80 },
        ]);
        expect(cache.captured[0]).toContain("strftime(ts, '%Y-%m-%d')");
        expect(cache.captured[0]).toContain("INTERVAL '1 day'");
    });

    test("empty -> empty array", async () => {
        const cache = cacheRead({});
        const r = await runCache(fetchDailyToolCalls({ windowDays: 30 }), cache.layer);
        expect(r).toHaveLength(0);
    });
});

describe("fetchDailyCommits", () => {
    test("returns per-day commit counts", async () => {
        const cache = cacheRead({
            'FROM "commit"': [
                { date: "2026-06-11", commits: 3 },
                { date: "2026-06-12", commits: 1 },
            ],
        });
        const r = await runCache(fetchDailyCommits({ windowDays: 30 }), cache.layer);
        expect(r).toEqual([
            { date: "2026-06-11", commits: 3 },
            { date: "2026-06-12", commits: 1 },
        ]);
        expect(cache.captured[0]).toContain("strftime(ts, '%Y-%m-%d')");
        expect(cache.captured[0]).toContain('FROM "commit"');
        expect(cache.captured[0]).toContain("INTERVAL '1 day'");
    });

    test("empty -> empty array", async () => {
        const cache = cacheRead({});
        const r = await runCache(fetchDailyCommits({ windowDays: 30 }), cache.layer);
        expect(r).toHaveLength(0);
    });
});

describe("fetchWindowedInvocations", () => {
    test("uses denormalized session field (not in.session deref) and filters NONE rows", async () => {
        const db = makeMockDb([[[
            { session: "session:1", skill: "tdd", ts: "2026-06-12T10:00:00Z" },
            // pre-denormalization edge: session = NONE (stringified to "NONE")
            { session: "NONE", skill: "tdd", ts: "2026-06-12T11:00:00Z" },
            // null session (js null)
            { session: null, skill: "ship", ts: "2026-06-12T12:00:00Z" },
        ]]]);
        const r = await runWithMock(db, fetchWindowedInvocations({ windowDays: 30 }));
        // Fix 2: SQL must read the denormalized `session` field, not `in.session`
        expect(db.captured[0]).toContain("type::string(session) AS session");
        expect(db.captured[0]).not.toContain("in.session");
        // Fix 2: NONE and null rows are filtered out in JS
        expect(r).toHaveLength(1);
        expect(r[0]).toEqual({ session: "session:1", skill: "tdd", ts: "2026-06-12T10:00:00Z" });
    });

    test("empty invocations -> empty array", async () => {
        const db = makeMockDb([[[]]]);
        const r = await runWithMock(db, fetchWindowedInvocations({ windowDays: 7 }));
        expect(r).toHaveLength(0);
    });
});

describe("fetchWindowedSessions", () => {
    test("returns id+s+e as ISO strings, ended_at required", async () => {
        // "s"/"e" aren't `_at`-suffixed, so the fixture helper's auto Date
        // conversion doesn't apply here - pass real Dates directly.
        const cache = cacheRead({
            "id, started_at AS s, ended_at AS e": [
                {
                    id: "sess-1",
                    s: new Date("2026-06-12T10:00:00.000Z"),
                    e: new Date("2026-06-12T12:30:00.000Z"),
                },
                { id: "sess-2", s: new Date("2026-06-12T09:00:00.000Z"), e: null },
            ],
        });
        const r = await runCache(fetchWindowedSessions({ windowDays: 30 }), cache.layer);
        // sess-2 has no ended_at -> filtered out
        expect(r).toEqual([
            { id: "sess-1", s: "2026-06-12T10:00:00.000Z", e: "2026-06-12T12:30:00.000Z" },
        ]);
        expect(cache.captured[0]).toContain("AND ended_at IS NOT NULL");
        expect(cache.captured[0]).toContain("INTERVAL '1 day'");
    });

    test("empty -> empty array", async () => {
        const cache = cacheRead({});
        const r = await runCache(fetchWindowedSessions({ windowDays: 30 }), cache.layer);
        expect(r).toHaveLength(0);
    });
});

describe("fetchGuardrailHookEvidence", () => {
    test("returns per-hook fire/block/warn counts from hook evidence", async () => {
        const cache = cacheRead({
            "FROM hook_command_invocation": [
                { hook_name: "enforce-worktree", fires: 12, blocked: 3, warned: 1 },
                { hook_name: "route-dispatch", fires: 8, blocked: 0, warned: 6 },
            ],
        });
        const rows = await runCache(fetchGuardrailHookEvidence({ windowDays: 14 }), cache.layer);
        expect(rows).toEqual([
            { hook_name: "enforce-worktree", fires: 12, blocked: 3, warned: 1 },
            { hook_name: "route-dispatch", fires: 8, blocked: 0, warned: 6 },
        ]);
        expect(cache.captured[0]).toContain("FROM hook_command_invocation");
        expect(cache.captured[0]).toContain("INTERVAL '1 day'");
        expect(cache.captured[0]).toContain("GROUP BY hook_name");
        expect(cache.captured[0]).toContain("effect = 'blocked'");
        expect(cache.captured[0]).toContain("'injected_context'");
    });
});

describe("fetchGuardrailVerdicts", () => {
    test("returns locked verdict counts from windowed checkpoint rows", async () => {
        const now = new Date();
        const rows = await Effect.runPromise(fetchGuardrailVerdicts({ windowDays: 30 }).pipe(
            Effect.provide(judgmentTestLayer((sql) => {
                if (sql.includes("FROM proposal")) return [{
                    id: "p1", form: "guidance", title: "x", hypothesis: "y", dedupe_sig: "sig",
                    frequency: 1, confidence: "high", status: "accepted", origin: "agent",
                    hypothesis_template: null, evidence_query: null, reject_reason: null, baseline: null,
                    created_at: now, updated_at: now,
                }];
                if (sql.includes("FROM experiment")) return [{
                    id: "e1", proposal: "p1", artifact: null, artifact_path: null,
                    scaffolded_at: now, created_at: now, locked_verdict: null,
                    status: "scaffolded", task_path: null,
                }];
                if (sql.includes("FROM checkpoint")) return [
                    ...Array.from({ length: 4 }, (_, i) => ({ id: `a${i}`, experiment: "e1", kind: "+3s", measured: {}, suggested: null, user_verdict: "adopted", observed_at: now })),
                    ...Array.from({ length: 2 }, (_, i) => ({ id: `i${i}`, experiment: "e1", kind: "+3s", measured: {}, suggested: null, user_verdict: "ignored", observed_at: now })),
                    { id: "n1", experiment: "e1", kind: "+3s", measured: {}, suggested: null, user_verdict: "no_longer_needed", observed_at: now },
                ];
                return [];
            })),
        ));
        expect(rows).toEqual([
            { verdict: "adopted", count: 4 },
            { verdict: "ignored", count: 2 },
            { verdict: "no_longer_needed", count: 1 },
        ]);
    });
});
