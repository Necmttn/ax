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
    fetchWindowedInvocations,
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
    test("returns day keys from session table (not turn)", async () => {
        const db = makeMockDb([[[{ date: "2026-06-11" }, { date: "2026-06-12" }]]]);
        const r = await runWithMock(db, fetchDailyActivity({ windowDays: 30 }));
        expect(r).toEqual(["2026-06-11", "2026-06-12"]);
        // Fix 1a: must use session.started_at (fast) not turn.ts (full-scan)
        expect(db.captured[0]).toContain('time::format(started_at, "%Y-%m-%d")');
        expect(db.captured[0]).toContain("FROM session");
        expect(db.captured[0]).not.toContain("FROM turn");
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
        // Fix 1b: must use session table (fast) not turn table full-scan
        expect(db.captured[0]).toContain("FROM session");
        expect(db.captured[0]).toContain("count() AS sessions");
        expect(db.captured[0]).not.toContain("array::len(array::distinct(session))");
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
            // 5: verifyAgg (full command_text labels)
            [[
                { cmd: "bun test", count: 900 },
                { cmd: "Read", count: 2000 },
                { cmd: "Bash", count: 3000 },
            ]],
        ]);
        const r = await runWithMock(db, fetchWrappedCounts({ windowDays: 30 }));
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
        expect(db.captured[0]).toContain("time::now() - 30d");
        expect(db.captured[0]).toContain("FROM tool_call");
        expect(db.captured[1]).toContain("FROM turn");
        expect(db.captured[2]).toContain("FROM invoked");
        expect(db.captured[3]).toContain("FROM session");
        // 5th query classifies the full command text
        expect(db.captured[4]).toContain("command_text");
    });

    test("empty tables -> all zeros", async () => {
        const db = makeMockDb([[[]], [[]], [[]], [[]], [[]]]);
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
            // verifyAgg (full command_text labels)
            [[
                { cmd: "lint", count: 500 },   // verification
                { cmd: "grep", count: 300 },   // context
                { cmd: "Agent", count: 200 },  // neither
            ]],
        ]);
        const r = await runWithMock(db, fetchWrappedCounts({ windowDays: 30 }));
        expect(r.verification_calls).toBe(500);
        expect(r.context_calls).toBe(300);
        expect(r.tool_calls).toBe(1000);
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
