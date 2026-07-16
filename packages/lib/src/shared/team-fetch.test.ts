import { describe, expect, test } from "bun:test";
import type { TeamProfileV1 } from "./team-community";
import {
    fetchTeamProfiles,
    type GitHubFetch,
    type GitHubFetchInit,
} from "./team-fetch";

const profile = (login: string): TeamProfileV1 => ({
    v: 1,
    login,
    org: "acme",
    repo_key: `remote__github_com_acme_${login}__abc123`,
    window_days: 30,
    generated_at: "2026-07-16T00:00:00Z",
    stats: { sessions: 12, active_days: 5, harnesses: ["claude", "codex"] },
    activity: { daily: [{ date: "2026-07-15", sessions: 3, tokens: 120_000 }] },
    skills: [{ skill: "tdd", runs: 8, sessions: 4 }],
    spend: {
        tokens: { prompt: 1_000, completion: 200, total: 1_200 },
        cost_usd: 4.2,
        model_mix: [{ model: "fable", share: 1, tokens: 1_200, cost_usd: 4.2 }],
    },
    efficiency: { tool_calls: 300, tool_failures: 12, verification_calls: 40 },
});

interface RecordedCall {
    readonly url: string;
    readonly init: GitHubFetchInit;
}

function jsonResponse(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function contentsResponse(value: unknown): Response {
    return jsonResponse({
        encoding: "base64",
        content: btoa(JSON.stringify(value)),
    });
}

function fakeGitHub(
    responses: Readonly<Record<string, Response | (() => Response)>>,
): { readonly fetch: GitHubFetch; readonly calls: RecordedCall[] } {
    const calls: RecordedCall[] = [];
    const fetch: GitHubFetch = async (input, init) => {
        const url = String(input);
        calls.push({ url, init });
        const response = responses[url];
        if (response === undefined) return new Response("not found", { status: 404 });
        return typeof response === "function" ? response() : response.clone();
    };
    return { fetch, calls };
}

const listUrl = "https://api.github.com/repos/acme/ax-team/contents/.ax-team";
const fileUrl = (login: string): string =>
    `https://api.github.com/repos/acme/ax-team/contents/.ax-team/${login}.json`;

describe("fetchTeamProfiles", () => {
    test("fetches and validates all listed snapshots in parallel", async () => {
        const snapshots = ["alice", "bob", "carol"].map(profile);
        const github = fakeGitHub({
            [listUrl]: jsonResponse([
                { name: "alice.json", path: ".ax-team/alice.json", type: "file" },
                { name: "README.md", path: ".ax-team/README.md", type: "file" },
                { name: "bob.json", path: ".ax-team/bob.json", type: "file" },
                { name: "carol.json", path: ".ax-team/carol.json", type: "file" },
            ]),
            [fileUrl("alice")]: contentsResponse(snapshots[0]),
            [fileUrl("bob")]: contentsResponse(snapshots[1]),
            [fileUrl("carol")]: contentsResponse(snapshots[2]),
        });

        const result = await fetchTeamProfiles({
            org: "acme",
            token: "viewer-token",
            fetch: github.fetch,
        });

        expect(result).toEqual(snapshots);
        expect(github.calls.map((call) => call.url)).toEqual([
            listUrl,
            fileUrl("alice"),
            fileUrl("bob"),
            fileUrl("carol"),
        ]);
        for (const call of github.calls) {
            expect(call.init.headers.authorization).toBe("Bearer viewer-token");
        }
    });

    test("drops unreadable, invalid-json, and wrong-version snapshots", async () => {
        const good = profile("good");
        const github = fakeGitHub({
            [listUrl]: jsonResponse([
                { name: "good.json", path: ".ax-team/good.json", type: "file" },
                { name: "missing.json", path: ".ax-team/missing.json", type: "file" },
                { name: "broken.json", path: ".ax-team/broken.json", type: "file" },
                { name: "invalid.json", path: ".ax-team/invalid.json", type: "file" },
            ]),
            [fileUrl("good")]: contentsResponse(good),
            [fileUrl("missing")]: new Response("not found", { status: 404 }),
            [fileUrl("broken")]: jsonResponse({
                encoding: "base64",
                content: btoa("{not-json"),
            }),
            [fileUrl("invalid")]: contentsResponse({ ...profile("invalid"), v: 2 }),
        });

        await expect(fetchTeamProfiles({
            org: "acme",
            token: "viewer-token",
            fetch: github.fetch,
        })).resolves.toEqual([good]);
    });

    test("returns an empty set when the team snapshot directory does not exist", async () => {
        const github = fakeGitHub({
            [listUrl]: new Response("not found", { status: 404 }),
        });

        await expect(fetchTeamProfiles({
            org: "acme",
            token: "viewer-token",
            fetch: github.fetch,
        })).resolves.toEqual([]);
        expect(github.calls).toHaveLength(1);
        expect(github.calls[0]?.init.headers.authorization).toBe("Bearer viewer-token");
    });
});
