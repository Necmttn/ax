import { describe, expect, test } from "bun:test";
import { makeMockDb, runWithMock } from "@ax/lib/testing/surreal";
import {
    fetchAcceptedProposals,
    fetchDailyActivity,
    fetchHarnesses,
    fetchSkillInvocations,
    fetchSkillScopes,
    fetchTokenTotals,
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
