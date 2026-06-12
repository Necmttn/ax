import { describe, expect, test } from "bun:test";
import { makeMockDb, runWithMock } from "@ax/lib/testing/surreal";
import {
    fetchAcceptedProposals,
    fetchCommitCount,
    fetchDailyActivity,
    fetchDailyActivityFull,
    fetchHarnesses,
    fetchPeakHour,
    fetchSessionDurations,
    fetchSkillInvocations,
    fetchSkillScopes,
    fetchSpawnedCount,
    fetchTokenTotals,
    fetchTopTools,
    fetchWrappedCounts,
} from "./queries.ts";

describe("fetchTokenTotals", () => {
    test("sums tokens and sessions over the window", async () => {
        const db = makeMockDb([[[{ prompt_tokens: 100, completion_tokens: 40, sessions: 3 }]]]);
        const r = await runWithMock(db, fetchTokenTotals({ windowDays: 30 }));
        expect(r).toEqual({ prompt_tokens: 100, completion_tokens: 40, sessions: 3 });
        expect(db.captured[0]).toContain("time::now() - 30d");
        expect(db.captured[0]).toContain("session_token_usage");
    });

    test("empty window -> zeros", async () => {
        const db = makeMockDb([[[]]]);
        const r = await runWithMock(db, fetchTokenTotals({ windowDays: 30 }));
        expect(r).toEqual({ prompt_tokens: 0, completion_tokens: 0, sessions: 0 });
    });
});

describe("fetchDailyActivity", () => {
    test("returns day keys", async () => {
        const db = makeMockDb([[[{ date: "2026-06-11" }, { date: "2026-06-12" }]]]);
        const r = await runWithMock(db, fetchDailyActivity({ windowDays: 30 }));
        expect(r).toEqual(["2026-06-11", "2026-06-12"]);
        expect(db.captured[0]).toContain('time::format(ts, "%Y-%m-%d")');
    });
});

describe("fetchHarnesses", () => {
    test("returns distinct sources", async () => {
        const db = makeMockDb([[[{ source: "claude" }, { source: "codex" }]]]);
        const r = await runWithMock(db, fetchHarnesses({ windowDays: 30 }));
        expect(r).toEqual(["claude", "codex"]);
        expect(db.captured[0]).toContain("GROUP BY source");
    });
});

describe("fetchSkillInvocations", () => {
    test("returns name+count rows, window applied", async () => {
        const db = makeMockDb([[[{ skill: "tdd", count: 88 }]]]);
        const r = await runWithMock(db, fetchSkillInvocations({ windowDays: 30 }));
        expect(r).toEqual([{ skill: "tdd", count: 88 }]);
        expect(db.captured[0]).toContain("FROM invoked");
        expect(db.captured[0]).toContain("time::now() - 30d");
    });
});

describe("fetchSkillScopes", () => {
    test("maps name -> scope, tombstones filtered in SQL", async () => {
        const db = makeMockDb([[[
            { name: "tdd", scope: "plugin:superpowers" },
            { name: "my-local", scope: "user" },
        ]]]);
        const r = await runWithMock(db, fetchSkillScopes());
        expect(r.get("tdd")).toBe("plugin:superpowers");
        expect(db.captured[0]).toContain("deleted_at IS NONE");
    });
});

describe("fetchAcceptedProposals", () => {
    test("returns accepted proposals with fields the taste deriver needs", async () => {
        const db = makeMockDb([[[
            {
                form: "guidance",
                title: "Stop edit loops early",
                hypothesis: "3+ edits same file means requirements drift",
                confidence: "high",
                frequency: 12,
                updated_at: "2026-06-10T00:00:00Z",
                created_at: "2026-06-01T00:00:00Z",
            },
        ]]]);
        const r = await runWithMock(db, fetchAcceptedProposals());
        expect(r[0]!.title).toBe("Stop edit loops early");
        expect(db.captured[0]).toContain("status = 'accepted'");
    });
});

describe("fetchDailyActivityFull", () => {
    test("returns date+sessions+tokens rows, window applied", async () => {
        const db = makeMockDb([
            [[{ date: "2026-06-11", sessions: 5 }, { date: "2026-06-12", sessions: 3 }]],
            [[{ date: "2026-06-11", tokens: 100_000 }, { date: "2026-06-12", tokens: 80_000 }]],
        ]);
        const r = await runWithMock(db, fetchDailyActivityFull({ windowDays: 30 }));
        expect(r).toHaveLength(2);
        expect(r[0]).toEqual({ date: "2026-06-11", sessions: 5, tokens: 100_000 });
        expect(r[1]).toEqual({ date: "2026-06-12", sessions: 3, tokens: 80_000 });
        expect(db.captured[0]).toContain("time::now() - 30d");
        expect(db.captured[0]).toContain("array::len(array::distinct(session))");
    });

    test("day with no tokens entry gets tokens=0", async () => {
        const db = makeMockDb([
            [[{ date: "2026-06-11", sessions: 5 }]],
            [[]],
        ]);
        const r = await runWithMock(db, fetchDailyActivityFull({ windowDays: 30 }));
        expect(r[0]).toEqual({ date: "2026-06-11", sessions: 5, tokens: 0 });
    });

    test("empty window -> empty array", async () => {
        const db = makeMockDb([[[]], [[]]]);
        const r = await runWithMock(db, fetchDailyActivityFull({ windowDays: 30 }));
        expect(r).toHaveLength(0);
    });
});

describe("fetchSessionDurations", () => {
    test("returns started_at+ended_at as ISO strings, window applied", async () => {
        const db = makeMockDb([[[
            { started_at: "2026-06-11T10:00:00Z", ended_at: "2026-06-11T12:30:00Z" },
            { started_at: "2026-06-12T09:00:00Z", ended_at: "2026-06-12T10:00:00Z" },
        ]]]);
        const r = await runWithMock(db, fetchSessionDurations({ windowDays: 30 }));
        expect(r[0]!.started_at).toBe("2026-06-11T10:00:00Z");
        expect(r[0]!.ended_at).toBe("2026-06-11T12:30:00Z");
        expect(db.captured[0]).toContain("ended_at IS NOT NONE");
        expect(db.captured[0]).toContain("started_at IS NOT NONE");
        expect(db.captured[0]).toContain("time::now() - 30d");
    });

    test("empty window -> empty array", async () => {
        const db = makeMockDb([[[]]]);
        const r = await runWithMock(db, fetchSessionDurations({ windowDays: 30 }));
        expect(r).toHaveLength(0);
    });
});

describe("fetchPeakHour", () => {
    test("returns the peak hour as a number", async () => {
        const db = makeMockDb([[[{ hour: "13", count: 42 }]]]);
        const r = await runWithMock(db, fetchPeakHour({ windowDays: 30 }));
        expect(r).toBe(13);
        expect(db.captured[0]).toContain("time::format(started_at");
        expect(db.captured[0]).toContain("time::now() - 30d");
    });

    test("empty window -> null", async () => {
        const db = makeMockDb([[[]]]);
        const r = await runWithMock(db, fetchPeakHour({ windowDays: 30 }));
        expect(r).toBeNull();
    });
});

describe("fetchSpawnedCount", () => {
    test("returns spawned count in window", async () => {
        const db = makeMockDb([[[{ count: 420 }]]]);
        const r = await runWithMock(db, fetchSpawnedCount({ windowDays: 30 }));
        expect(r).toBe(420);
        expect(db.captured[0]).toContain("FROM spawned");
        expect(db.captured[0]).toContain("time::now() - 30d");
    });

    test("empty -> 0", async () => {
        const db = makeMockDb([[[]]]);
        const r = await runWithMock(db, fetchSpawnedCount({ windowDays: 30 }));
        expect(r).toBe(0);
    });
});

describe("fetchCommitCount", () => {
    test("returns commit count using ts field", async () => {
        const db = makeMockDb([[[{ count: 1000 }]]]);
        const r = await runWithMock(db, fetchCommitCount({ windowDays: 30 }));
        expect(r).toBe(1000);
        expect(db.captured[0]).toContain("FROM commit");
        expect(db.captured[0]).toContain("ts >");
        expect(db.captured[0]).toContain("time::now() - 30d");
    });

    test("empty -> 0", async () => {
        const db = makeMockDb([[[]]]);
        const r = await runWithMock(db, fetchCommitCount({ windowDays: 30 }));
        expect(r).toBe(0);
    });
});

describe("fetchTopTools", () => {
    test("returns top 10 tools by run count, window applied", async () => {
        const db = makeMockDb([[[
            { tool: "Bash", count: 5000 },
            { tool: "Read", count: 3200 },
        ]]]);
        const r = await runWithMock(db, fetchTopTools({ windowDays: 30 }));
        expect(r[0]).toEqual({ name: "Bash", runs: 5000 });
        expect(r[1]).toEqual({ name: "Read", runs: 3200 });
        expect(db.captured[0]).toContain("FROM tool_call");
        expect(db.captured[0]).toContain("command_norm ?? name");
        expect(db.captured[0]).toContain("LIMIT 10");
        expect(db.captured[0]).toContain("time::now() - 30d");
    });

    test("empty -> empty array", async () => {
        const db = makeMockDb([[[]]]);
        const r = await runWithMock(db, fetchTopTools({ windowDays: 30 }));
        expect(r).toHaveLength(0);
    });
});

describe("fetchWrappedCounts", () => {
    test("aggregates tool_calls, failures, distinct_tools and pattern-matches in JS", async () => {
        const db = makeMockDb([
            // 1: toolAgg rows
            [[
                { tool: "bun test", count: 900, failures: 10 },
                { tool: "Read", count: 2000, failures: 5 },
                { tool: "Bash", count: 3000, failures: 50 },
            ]],
            // 2: turnCount
            [[{ count: 41200 }]],
            // 3: distinctSkills
            [[{ count: 56 }]],
            // 4: reposCount
            [[{ count: 12 }]],
        ]);
        const r = await runWithMock(db, fetchWrappedCounts({ windowDays: 30 }));
        expect(r.turns).toBe(41200);
        expect(r.tool_calls).toBe(5900); // 900+2000+3000
        expect(r.tool_failures).toBe(65); // 10+5+50
        expect(r.distinct_tools).toBe(3);
        expect(r.distinct_skills).toBe(56);
        expect(r.repos_count).toBe(12);
        // "bun test" matches /test|check|verify|lint|typecheck|tsc|vitest|bun test/i
        expect(r.verification_calls).toBe(900);
        // "Read" matches /recall|context|rg|sed|cat|find|grep|open|read/i
        expect(r.context_calls).toBe(2000);
        // SQL contains window clause
        expect(db.captured[0]).toContain("time::now() - 30d");
        expect(db.captured[0]).toContain("FROM tool_call");
        expect(db.captured[1]).toContain("FROM turn");
        expect(db.captured[2]).toContain("FROM invoked");
        expect(db.captured[3]).toContain("FROM session");
    });

    test("empty tables -> all zeros", async () => {
        const db = makeMockDb([[[]], [[]], [[]], [[]]]);
        const r = await runWithMock(db, fetchWrappedCounts({ windowDays: 30 }));
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
        const db = makeMockDb([
            [[
                { tool: "lint", count: 500, failures: 0 },   // verification
                { tool: "grep", count: 300, failures: 2 },   // context
                { tool: "Agent", count: 200, failures: 0 },  // neither
            ]],
            [[{ count: 1000 }]],
            [[{ count: 10 }]],
            [[{ count: 5 }]],
        ]);
        const r = await runWithMock(db, fetchWrappedCounts({ windowDays: 30 }));
        expect(r.verification_calls).toBe(500);
        expect(r.context_calls).toBe(300);
        expect(r.tool_calls).toBe(1000);
    });
});
