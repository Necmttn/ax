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
