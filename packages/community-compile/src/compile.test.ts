import { describe, expect, test } from "bun:test";
import { compileCommunity, normalizeSkillName, skillStatKey, type GistFetcher } from "./compile.ts";

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

    test("skill/hook stats aggregate by bare name across users", async () => {
        const out = await compileCommunity(users, fetcher({
            g1: profile("alice"),
            g2: profile("bob"),
        }), { now: "2026-06-12T03:00:00Z" });

        // Keyed by canonical identity ("tdd"), not "superpowers:tdd".
        expect(out.skillStats["tdd"]).toEqual({ users: 2, runs: 20, source: "superpowers" });
        expect(out.hookStats["enforce-worktree"]).toEqual({ users: 2 });
    });

    test("same skill installed differently per builder (local vs plugin) merges to one row", async () => {
        // THE fix: a loosely-installed `local:simplify` and a plugin
        // `superpowers:simplify` are the SAME skill - one row, users=2, and the
        // real plugin source wins for display.
        const out = await compileCommunity(users, fetcher({
            g1: profile("alice", { rig: { skills: [{ name: "simplify", source: "local", runs: 4 }], hooks: [], routing_table: false } }),
            g2: profile("bob", { rig: { skills: [{ name: "simplify", source: "superpowers", runs: 6 }], hooks: [], routing_table: false } }),
        }), { now: "2026-06-12T03:00:00Z" });

        expect(out.skillStats["simplify"]).toEqual({ users: 2, runs: 10, source: "superpowers" });
        expect(out.skillStats["local:simplify"]).toBeUndefined();
        expect(out.skillStats["superpowers:simplify"]).toBeUndefined();
    });

    test("curated provenance credits a loosely-installed shared skill's author", async () => {
        // grill-me ships as a loose dir (source "local") for everyone, so no
        // builder reports a plugin source - the registry credits mattpocock.
        const out = await compileCommunity(users, fetcher({
            g1: profile("alice", { rig: { skills: [{ name: "grill-me", source: "local", runs: 4 }], hooks: [], routing_table: false } }),
            g2: profile("bob", { rig: { skills: [{ name: "grill-me", source: "local", runs: 6 }], hooks: [], routing_table: false } }),
        }), { now: "2026-06-12T03:00:00Z" });
        expect(out.skillStats["grill-me"]).toEqual({ users: 2, runs: 10, source: "mattpocock" });
    });

    test("an observed plugin source overrides the provenance registry", async () => {
        // If a builder genuinely installed it from a plugin, trust that, not
        // the curated fallback.
        const out = await compileCommunity(users, fetcher({
            g1: profile("alice", { rig: { skills: [{ name: "tdd", source: "someplugin", runs: 1 }], hooks: [], routing_table: false } }),
            g2: profile("bob", { rig: { skills: [{ name: "tdd", source: "local", runs: 1 }], hooks: [], routing_table: false } }),
        }), { now: "2026-06-12T03:00:00Z" });
        expect(out.skillStats["tdd"].source).toBe("someplugin"); // not "mattpocock"
    });

    test("an unknown loose skill stays source 'local'", async () => {
        const out = await compileCommunity(users, fetcher({
            g1: profile("alice", { rig: { skills: [{ name: "my-thing", source: "local", runs: 1 }], hooks: [], routing_table: false } }),
            g2: profile("bob", { rig: { skills: [{ name: "my-thing", source: "local", runs: 1 }], hooks: [], routing_table: false } }),
        }), { now: "2026-06-12T03:00:00Z" });
        expect(out.skillStats["my-thing"].source).toBe("local");
    });

    test("a builder counts once per skill even with duplicate sources", async () => {
        const out = await compileCommunity(
            [{ github: "alice", gist_id: "g1", joined: "2026-06-01" }],
            fetcher({
                g1: profile("alice", { rig: { skills: [
                    { name: "simplify", source: "local", runs: 2 },
                    { name: "simplify", source: "superpowers", runs: 3 },
                ], hooks: [], routing_table: false } }),
            }),
            { now: "2026-06-12T03:00:00Z" },
        );
        expect(out.skillStats["simplify"]).toEqual({ users: 1, runs: 5, source: "superpowers" });
    });

    test("plugin-namespaced skill name does not double its source prefix", async () => {
        // Real shape: source="superpowers", name="superpowers:brainstorming"
        // (rig.ts keeps the plugin id inside the name). Identity is "brainstorming".
        const out = await compileCommunity(users, fetcher({
            g1: profile("alice", { rig: { skills: [{ name: "superpowers:brainstorming", source: "superpowers", runs: 3 }], hooks: [], routing_table: false } }),
            g2: profile("bob", { rig: { skills: [{ name: "superpowers:brainstorming", source: "superpowers", runs: 7 }], hooks: [], routing_table: false } }),
        }), { now: "2026-06-12T03:00:00Z" });

        expect(out.skillStats["brainstorming"]).toEqual({ users: 2, runs: 10, source: "superpowers" });
        expect(out.skillStats["superpowers:brainstorming"]).toBeUndefined();
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
        expect(out.state.skill_adoption["tdd"]).toBe(2);
    });

    test("output is deterministic for identical input", async () => {
        const f = fetcher({ g1: profile("alice"), g2: profile("bob") });
        const a = await compileCommunity(users, f, { now: "2026-06-12T03:00:00Z" });
        const b = await compileCommunity(users, f, { now: "2026-06-12T03:00:00Z" });
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });

    test("skillStatKey dedupes plugin-namespaced source prefix", () => {
        expect(skillStatKey("superpowers", "superpowers:brainstorming")).toBe("superpowers:brainstorming");
        expect(skillStatKey("local", "commit")).toBe("local:commit");
        expect(skillStatKey("local", "codex:rescue")).toBe("local:codex:rescue");
        // bare name equal to source (defensive)
        expect(skillStatKey("superpowers", "superpowers")).toBe("superpowers");
    });

    test("normalizeSkillName strips the install-source prefix to a canonical identity", () => {
        expect(normalizeSkillName("superpowers", "superpowers:brainstorming")).toBe("brainstorming");
        expect(normalizeSkillName("superpowers", "tdd")).toBe("tdd");
        expect(normalizeSkillName("local", "grill-me")).toBe("grill-me");
        // a loose `local:simplify` and a plugin `superpowers:simplify` share identity
        expect(normalizeSkillName("local", "simplify")).toBe(normalizeSkillName("superpowers", "simplify"));
        // plugin-namespaced inner id is preserved
        expect(normalizeSkillName("local", "codex:rescue")).toBe("codex:rescue");
    });

    test("gist impersonation: mallory's gist claiming github=alice is dropped with github-mismatch", async () => {
        // mallory registers under their own login but their profile.github
        // points at a different user (alice) - impersonation attempt.
        const malloryUsers = [{ github: "mallory", gist_id: "gm", joined: "2026-06-01" }];
        const out = await compileCommunity(
            malloryUsers,
            fetcher({ gm: profile("alice") }), // profile.github = "alice", not "mallory"
            { now: "2026-06-12T03:00:00Z" },
        );
        expect(out.leaderboard.boards.tokens).toHaveLength(0);
        expect(out.dropped).toEqual([{ login: "mallory", reason: "github-mismatch" }]);
    });
});
