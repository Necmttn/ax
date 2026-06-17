import { describe, expect, test } from "bun:test";
import { makeMockDb, runWithMock } from "@ax/lib/testing/surreal";
import { buildProfile } from "./render.ts";

// Mock result order MUST match the query order in buildProfile:
// 1 tokenTotals  2 dailyActivity  3 harnesses  4 skillInvocations
// 5 skillScopes  6 acceptedProposals  7 costModels
// 8 dailyActivityFull(sessions)  9 dailyActivityFull(tokens)
// 10 sessionDurations  11 peakHour  12 spawnedCount  13 commitCount  14 topTools
// 15 wrappedCounts(toolAgg)  16 wrappedCounts(turnCount)
// 17 wrappedCounts(distinctSkills)  18 wrappedCounts(reposCount)
// 18b wrappedCounts(verifyAgg)
// 19 dailyModels  20 dailyToolCalls  21 dailyCommits
// 22 windowedInvocations  23 windowedSessions
// 24 deepSessions:total  25 deepSessions:produced  26 deepSessions:landed-loc
// 27 contentTypeBreakdown
const mockResults = [
    [[{ prompt_tokens: 31_000_000, completion_tokens: 7_000_000, sessions: 142 }]],
    [[{ date: "2026-06-11" }, { date: "2026-06-12" }]],
    [[{ source: "claude" }, { source: "codex" }]],
    [[{ skill: "tdd", count: 88 }]],
    [[{ name: "tdd", scope: "plugin:superpowers" }]],
    [[{
        form: "guidance", title: "Stop edit loops early",
        hypothesis: "3+ edits means drift", confidence: "high", frequency: 12,
        updated_at: "2026-06-10T00:00:00Z", created_at: "2026-06-01T00:00:00Z",
    }]],
    [[{
        model: "fable", sessions: 100, prompt_tokens: 1, completion_tokens: 1,
        cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: 150,
    }, {
        model: "haiku", sessions: 42, prompt_tokens: 1, completion_tokens: 1,
        cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: 50,
    }]],
    [[{ date: "2026-06-11", sessions: 5 }, { date: "2026-06-12", sessions: 12 }]],
    [[{ date: "2026-06-11", tokens: 100_000 }, { date: "2026-06-12", tokens: 120_000_000 }]],
    [[
        { started_at: "2026-06-12T10:00:00Z", ended_at: "2026-06-12T12:30:00Z" },
        { started_at: "2026-06-12T09:00:00Z", ended_at: "2026-06-12T10:30:00Z" },
    ]],
    [[{ hour: "13", count: 42 }]],
    [[{ count: 420 }]],
    [[{ count: 1000 }]],
    [[{ tool: "Bash", count: 5000 }, { tool: "Read", count: 3200 }]],
    // 15: wrappedCounts toolAgg (Bash=verification, Read=context)
    [[
        { tool: "bun test", count: 900, failures: 10 },
        { tool: "Read", count: 2000, failures: 5 },
        { tool: "Bash", count: 3000, failures: 50 },
    ]],
    // 16: wrappedCounts turnCount
    [[{ count: 41200 }]],
    // 17: wrappedCounts distinctSkills
    [[{ count: 56 }]],
    // 18: wrappedCounts reposCount
    [[{ count: 12 }]],
    // 18b: wrappedCounts verifyAgg (full command_text: bun test=verification, Read=context)
    [[
        { cmd: "bun test", count: 900 },
        { cmd: "Read", count: 2000 },
        { cmd: "Bash", count: 3000 },
    ]],
    // 19: dailyModels
    [[
        { date: "2026-06-11", model: "fable", tokens: 80_000 },
        { date: "2026-06-12", model: "fable", tokens: 100_000_000 },
        { date: "2026-06-12", model: "haiku", tokens: 20_000_000 },
    ]],
    // 20: dailyToolCalls
    [[{ date: "2026-06-11", tool_calls: 200 }, { date: "2026-06-12", tool_calls: 3900 }]],
    // 21: dailyCommits
    [[{ date: "2026-06-11", commits: 7 }, { date: "2026-06-12", commits: 50 }]],
    // 22: windowedInvocations
    [[
        { session: "session:1", skill: "tdd", ts: "2026-06-12T10:01:00Z" },
        { session: "session:1", skill: "tdd", ts: "2026-06-12T10:30:00Z" },
        { session: "session:2", skill: "tdd", ts: "2026-06-12T11:01:00Z" },
    ]],
    // 23: windowedSessions
    [[
        { id: "session:1", s: "2026-06-12T10:00:00Z", e: "2026-06-12T12:30:00Z" },
        { id: "session:2", s: "2026-06-12T09:00:00Z", e: "2026-06-12T10:30:00Z" },
    ]],
    // 24: deepSessions total (non-subagent session count = DEPTH denominator)
    [[{ total: 2 }]],
    // 25: deepSessions produced edges (session -> non-reverted commit)
    [[
        { session: "session:1", commit: "commit:abc" },
        { session: "session:2", commit: "commit:def" },
    ]],
    // 26: deepSessions landed LOC per commit (commit:def landed nothing -> not deep)
    [[
        { commit: "commit:abc", loc: 120 },
        { commit: "commit:def", loc: 0 },
    ]],
    // 27: contentTypeBreakdown
    [[
        { ct: "content_type:code", calls: 10, bytes: 800 },
        { ct: "content_type:text", calls: 5, bytes: 200 },
    ]],
];

const env = {
    github: "necmttn",
    generatedAt: "2026-06-12T19:00:00Z",
    today: "2026-06-12",
    hookFiles: ["enforce-worktree.ts"],
    hasRoutingTable: true,
    rulesMarkdown: "- rule one\n- rule two",
};

describe("buildProfile", () => {
    test("assembles a valid ProfileV1", async () => {
        const db = makeMockDb(mockResults);
        const p = await runWithMock(db, buildProfile({ windowDays: 30, includeCost: true, env }));

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
    });

    test("includeCost=false strips cost everywhere; share falls back to sessions", async () => {
        const db = makeMockDb(mockResults);
        const p = await runWithMock(db, buildProfile({ windowDays: 30, includeCost: false, env }));
        expect(p.stats.cost_usd).toBeUndefined();
        expect(p.stats.models[0]).toEqual({ name: "fable", share: 100 / 142 });
    });

    test("no proposals -> taste has only the mix pattern from content types", async () => {
        const noProposals = mockResults.map((r, i) => (i === 5 ? [[]] : r));
        const db = makeMockDb(noProposals);
        const p = await runWithMock(db, buildProfile({ windowDays: 30, includeCost: true, env }));
        expect(p.taste?.patterns).toHaveLength(1);
        expect(p.taste?.patterns[0]?.category).toBe("tool-output-mix");
    });

    test("no proposals + no content types -> taste omitted", async () => {
        const noTaste = mockResults.map((r, i) => (i === 5 || i === 27 ? [[]] : r));
        const db = makeMockDb(noTaste);
        const p = await runWithMock(db, buildProfile({ windowDays: 30, includeCost: true, env }));
        expect(p.taste).toBeUndefined();
    });

    test("empty daily + durations -> activity and insights omitted", async () => {
        // Blank out dailyFull(sessions+tokens) and sessionDurations (indices 7, 8, 9).
        const empty = mockResults.map((r, i) => (i >= 7 && i <= 9 ? [[]] : r));
        const db = makeMockDb(empty);
        const p = await runWithMock(db, buildProfile({ windowDays: 30, includeCost: true, env }));
        expect(p.activity).toBeUndefined();
        expect(p.insights).toBeUndefined();
    });
});
