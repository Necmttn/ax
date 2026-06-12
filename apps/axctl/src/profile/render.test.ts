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
        expect(p.rig.skills).toEqual([{ name: "tdd", source: "superpowers", runs: 88 }]);
        expect(p.rig.rules).toEqual({ count: 2 });
        expect(p.taste!.patterns[0]!.name).toBe("stop-edit-loops-early");
        // activity
        expect(p.activity).toBeDefined();
        expect(p.activity!.daily).toHaveLength(2);
        expect(p.activity!.daily[0]).toEqual({ date: "2026-06-11", sessions: 5, tokens: 100_000 });
        expect(p.activity!.daily[1]!.tokens).toBe(120_000_000);
        // insights
        expect(p.insights).toBeDefined();
        expect(p.insights!.hours_total).toBeCloseTo(4, 1); // 2.5h + 1.5h
        expect(p.insights!.longest_session_minutes).toBe(150);
        expect(p.insights!.deep_session_share).toBe(1); // both sessions >= 90min
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

    test("no proposals -> taste omitted", async () => {
        const noProposals = mockResults.map((r, i) => (i === 5 ? [[]] : r));
        const db = makeMockDb(noProposals);
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
