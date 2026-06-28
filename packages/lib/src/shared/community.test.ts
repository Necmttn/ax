import { afterEach, describe, expect, test } from "bun:test";
import {
    fetchMember,
    fetchMembers,
    profileGistRawUrl,
    registrationRawUrl,
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
