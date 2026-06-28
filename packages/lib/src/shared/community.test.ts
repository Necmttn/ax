import { afterEach, describe, expect, test } from "bun:test";
import {
    fetchSkillAdoption,
    fetchMember,
    fetchMembers,
    profileGistRawUrl,
    registrationRawUrl,
    skillRouteKey,
    validateSkillStats,
    validateSkillRouteKey,
    validateMemberProfile,
} from "./community";

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

const profile = {
    v: 1,
    github: "octocat",
    generated_at: "2026-06-19T00:00:00Z",
    window_days: 30,
    stats: {
        sessions: 42,
        active_days: 12,
        streak_days: 5,
        tokens: { prompt: 10, completion: 5, total: 15 },
        cost_usd: 9.5,
        models: [
            { name: "claude-sonnet", share: 0.7, cost_usd: 6 },
            { name: "gpt-5", share: 0.3 },
        ],
        harnesses: ["claude", "codex"],
    },
    rig: {
        skills: [
            { name: "review", source: "local", runs: 4 },
            { name: "tdd", source: "superpowers", runs: 9 },
        ],
        hooks: [],
        routing_table: true,
    },
};

describe("validateMemberProfile", () => {
    test("projects a ProfileV1 into the studio member roster shape", () => {
        expect(validateMemberProfile(profile)).toEqual({
            github: "octocat",
            generated_at: "2026-06-19T00:00:00Z",
            window_days: 30,
            sessions: 42,
            active_days: 12,
            streak_days: 5,
            tokens_total: 15,
            cost_usd: 9.5,
            models: [
                { name: "claude-sonnet", share: 0.7, cost_usd: 6 },
                { name: "gpt-5", share: 0.3 },
            ],
            harnesses: ["claude", "codex"],
            skills_top: [
                { name: "tdd", runs: 9 },
                { name: "review", runs: 4 },
            ],
        });
    });
});

describe("community member fetchers", () => {
    test("fetchMember follows registration to the registered profile gist", async () => {
        const seen: string[] = [];
        globalThis.fetch = (async (input: string | URL | Request) => {
            const url = String(input);
            seen.push(url);
            if (url === registrationRawUrl("Octocat")) {
                return new Response(JSON.stringify({ github: "octocat", gist_id: "abc123", joined: "2026-06-19" }));
            }
            if (url === profileGistRawUrl("octocat", "abc123")) {
                return new Response(JSON.stringify(profile));
            }
            return new Response("nope", { status: 404 });
        }) as typeof fetch;

        await expect(fetchMember("Octocat")).resolves.toMatchObject({
            github: "octocat",
            sessions: 42,
            tokens_total: 15,
        });
        expect(seen).toEqual([
            registrationRawUrl("Octocat"),
            profileGistRawUrl("octocat", "abc123"),
        ]);
    });

    test("fetchMembers drops failed lookups and sorts resolved members by sessions", async () => {
        const high = { ...profile, github: "high", stats: { ...profile.stats, sessions: 99 } };
        const low = { ...profile, github: "low", stats: { ...profile.stats, sessions: 1 } };
        globalThis.fetch = (async (input: string | URL | Request) => {
            const url = String(input);
            if (url === registrationRawUrl("high")) {
                return new Response(JSON.stringify({ github: "high", gist_id: "aaa", joined: "2026-06-19" }));
            }
            if (url === registrationRawUrl("low")) {
                return new Response(JSON.stringify({ github: "low", gist_id: "bbb", joined: "2026-06-19" }));
            }
            if (url === profileGistRawUrl("high", "aaa")) return new Response(JSON.stringify(high));
            if (url === profileGistRawUrl("low", "bbb")) return new Response(JSON.stringify(low));
            return new Response("missing", { status: 404 });
        }) as typeof fetch;

        const members = await fetchMembers(["missing", "low", "high"]);

        expect(members.map((m) => m.github)).toEqual(["high", "low"]);
    });
});

describe("skill adoption fetchers", () => {
    test("validates a source:name route key and rejects attribute-injection input", () => {
        expect(validateSkillRouteKey("superpowers:brainstorming")).toEqual({
            key: "superpowers:brainstorming",
            source: "superpowers",
            name: "brainstorming",
            identity: "brainstorming",
        });
        expect(validateSkillRouteKey("local:codex:rescue")).toEqual({
            key: "local:codex:rescue",
            source: "local",
            name: "codex:rescue",
            identity: "codex:rescue",
        });
        expect(validateSkillRouteKey("local:local")).toEqual({
            key: "local:local",
            source: "local",
            name: "local",
            identity: "local",
        });

        expect(() => validateSkillRouteKey("nosource")).toThrow("invalid skill key");
        expect(() => validateSkillRouteKey("local::rescue")).toThrow("invalid skill key");
        expect(() => validateSkillRouteKey('local:x" onclick="alert(1)')).toThrow("invalid skill key");
        expect(() => validateSkillRouteKey("local:<script>")).toThrow("invalid skill key");
        expect(() => validateSkillRouteKey("local:path/segment")).toThrow("invalid skill key");
    });

    test("builds source:name route keys from old and current skill-stat rows", () => {
        expect(skillRouteKey("tdd", { users: 2, runs: 12, source: "superpowers" })).toBe("superpowers:tdd");
        expect(skillRouteKey("local", { users: 1, runs: 1, source: "local" })).toBe("local:local");
        expect(skillRouteKey("local:agent-browser", { users: 1, runs: 6 })).toBe("local:agent-browser");
        expect(skillRouteKey("brainstorming", { users: 2, runs: 20, source: "superpowers" })).toBe("superpowers:brainstorming");
    });

    test("validateSkillStats drops rows whose keys cannot be safely linked", () => {
        expect(validateSkillStats({
            tdd: { users: 2, runs: 12, source: "superpowers" },
            "<img src=x>": { users: 9, runs: 99, source: "local" },
            "local:path/segment": { users: 3, runs: 3 },
        })).toEqual({
            tdd: { users: 2, runs: 12, source: "superpowers" },
        });
    });

    test("fetchSkillAdoption resolves stats, caps profile fan-out, and lists matching users", async () => {
        const seen: string[] = [];
        const userProfile = (github: string, runs: number) => ({
            ...profile,
            github,
            rig: {
                ...profile.rig,
                skills: [
                    { name: "superpowers:brainstorming", source: "superpowers", runs },
                    { name: "other", source: "local", runs: 99 },
                ],
            },
        });

        globalThis.fetch = (async (input: string | URL | Request) => {
            const url = String(input);
            seen.push(url);
            if (url === "https://ax-community.necmttn.com/skills") {
                return new Response(JSON.stringify({
                    brainstorming: { users: 2, runs: 15, source: "superpowers" },
                }));
            }
            if (url === "https://ax-community.necmttn.com/leaders") {
                return new Response(JSON.stringify({
                    compiled_at: "2026-06-19T00:00:00Z",
                    window_days: 30,
                    boards: {
                        tokens: [
                            { login: "alice", value: 100 },
                            { login: "bob", value: 50 },
                            { login: "charlie", value: 25 },
                        ],
                        sessions: [],
                        streak: [],
                        cost: [],
                    },
                }));
            }
            if (url === registrationRawUrl("alice")) {
                return new Response(JSON.stringify({ github: "alice", gist_id: "aaa", joined: "2026-06-19" }));
            }
            if (url === registrationRawUrl("bob")) {
                return new Response(JSON.stringify({ github: "bob", gist_id: "bbb", joined: "2026-06-19" }));
            }
            if (url === profileGistRawUrl("alice", "aaa")) return new Response(JSON.stringify(userProfile("alice", 4)));
            if (url === profileGistRawUrl("bob", "bbb")) return new Response(JSON.stringify(userProfile("bob", 11)));
            return new Response("missing", { status: 404 });
        }) as typeof fetch;

        await expect(fetchSkillAdoption("superpowers:brainstorming", { maxProfiles: 2 })).resolves.toMatchObject({
            key: "superpowers:brainstorming",
            name: "brainstorming",
            source: "superpowers",
            stats: { users: 2, runs: 15, source: "superpowers" },
            users: [
                { login: "bob", runs: 11, source: "superpowers", name: "superpowers:brainstorming" },
                { login: "alice", runs: 4, source: "superpowers", name: "superpowers:brainstorming" },
            ],
            rosterCount: 3,
            fetchedProfiles: 2,
            truncated: true,
        });

        expect(seen).not.toContain(registrationRawUrl("charlie"));
    });

    test("fetchSkillAdoption returns notFound for validated but unknown skills", async () => {
        globalThis.fetch = (async (input: string | URL | Request) => {
            const url = String(input);
            if (url === "https://ax-community.necmttn.com/skills") {
                return new Response(JSON.stringify({ tdd: { users: 1, runs: 3, source: "superpowers" } }));
            }
            return new Response("missing", { status: 404 });
        }) as typeof fetch;

        await expect(fetchSkillAdoption("superpowers:missing")).rejects.toMatchObject({ notFound: true });
    });
});
