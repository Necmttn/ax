import { describe, expect, test } from "bun:test";
import { makeMockDb, runWithMock } from "@ax/lib/testing/surreal";
import { buildProfile } from "./render.ts";

// Mock result order MUST match the query order in buildProfile:
// 1 tokenTotals  2 dailyActivity  3 harnesses  4 skillInvocations
// 5 skillScopes  6 acceptedProposals  7 costModels
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
});
