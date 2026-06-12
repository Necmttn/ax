// scripts/compile-community.test.ts
import { describe, expect, test } from "bun:test";
import { compileCommunity, type GistFetcher } from "./compile-community.ts";

const profile = (login: string, over: Record<string, unknown> = {}) => ({
    v: 1,
    github: login,
    generated_at: "2026-06-12T00:00:00Z",
    window_days: 30,
    stats: {
        sessions: 100, active_days: 20, streak_days: 5,
        tokens: { prompt: 900, completion: 100, total: 1000 },
        cost_usd: 42, models: [], harnesses: ["claude"],
        ...((over.stats as object) ?? {}),
    },
    rig: {
        skills: [{ name: "tdd", source: "superpowers", runs: 10 }],
        hooks: ["enforce-worktree"],
        routing_table: true,
        ...((over.rig as object) ?? {}),
    },
});

const fetcher = (gists: Record<string, unknown>): GistFetcher => async (gistId) =>
    gistId in gists ? { profile: gists[gistId], etag: null } : null;

const users = [
    { github: "alice", gist_id: "g1", joined: "2026-06-01" },
    { github: "bob", gist_id: "g2", joined: "2026-06-02" },
];

describe("compileCommunity", () => {
    test("builds boards sorted by value desc", async () => {
        const out = await compileCommunity(users, fetcher({
            g1: profile("alice", { stats: { tokens: { prompt: 1, completion: 1, total: 2000 } } }),
            g2: profile("bob"),
        }), { now: "2026-06-12T03:00:00Z" });

        expect(out.leaderboard.boards.tokens.map((r) => r.login)).toEqual(["alice", "bob"]);
        expect(out.leaderboard.boards.cost[0]).toEqual({ login: "alice", value: 42 });
        expect(out.leaderboard.compiled_at).toBe("2026-06-12T03:00:00Z");
    });

    test("skill/hook stats aggregate by source+name across users", async () => {
        const out = await compileCommunity(users, fetcher({
            g1: profile("alice"),
            g2: profile("bob"),
        }), { now: "2026-06-12T03:00:00Z" });

        expect(out.skillStats["superpowers:tdd"]).toEqual({ users: 2, runs: 20 });
        expect(out.hookStats["enforce-worktree"]).toEqual({ users: 2 });
    });

    test("invalid profile rows are dropped and reported", async () => {
        const out = await compileCommunity(users, fetcher({
            g1: profile("alice"),
            g2: { v: 99, garbage: true },
        }), { now: "2026-06-12T03:00:00Z" });

        expect(out.leaderboard.boards.tokens).toHaveLength(1);
        expect(out.dropped).toEqual([{ login: "bob", reason: "invalid-profile" }]);
    });

    test("absurd values excluded from boards", async () => {
        const out = await compileCommunity(users, fetcher({
            g1: profile("alice", { stats: { tokens: { prompt: 0, completion: 0, total: 200e9 } } }),
            g2: profile("bob"),
        }), { now: "2026-06-12T03:00:00Z" });

        expect(out.leaderboard.boards.tokens.map((r) => r.login)).toEqual(["bob"]);
        expect(out.dropped).toEqual([{ login: "alice", reason: "absurd-values" }]);
    });

    test("unreachable gist dropped, compile continues", async () => {
        const out = await compileCommunity(users, fetcher({ g1: profile("alice") }), { now: "2026-06-12T03:00:00Z" });
        expect(out.leaderboard.boards.tokens).toHaveLength(1);
        expect(out.dropped).toEqual([{ login: "bob", reason: "fetch-failed" }]);
    });

    test("state distributions: model share + harness mix histograms exist", async () => {
        const out = await compileCommunity(users, fetcher({ g1: profile("alice"), g2: profile("bob") }), {
            now: "2026-06-12T03:00:00Z",
        });
        expect(out.state.year).toBe(2026);
        expect(out.state.users).toBe(2);
        expect(out.state.harness_mix.claude).toBe(2);
        expect(out.state.skill_adoption["superpowers:tdd"]).toBe(2);
    });

    test("output is deterministic for identical input", async () => {
        const f = fetcher({ g1: profile("alice"), g2: profile("bob") });
        const a = await compileCommunity(users, f, { now: "2026-06-12T03:00:00Z" });
        const b = await compileCommunity(users, f, { now: "2026-06-12T03:00:00Z" });
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
});
