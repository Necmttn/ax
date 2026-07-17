import { afterAll, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { TeamProfileV1 } from "@ax/lib/shared/team-community";
import { GitHubEnvTest } from "../../profile/github-env.ts";
import {
    isContractRequest,
    makeContractWebHandler,
    type ContractWebHandler,
} from "./web-handler.ts";

const profile: TeamProfileV1 = {
    v: 1,
    login: "alice",
    org: "acme",
    repo_key: "acme/widget",
    window_days: 30,
    generated_at: "2026-07-17T00:00:00Z",
    stats: { sessions: 6, active_days: 3, harnesses: ["codex"] },
    activity: { daily: [] },
    skills: [{ skill: "tdd", runs: 4, sessions: 3 }],
    spend: {
        tokens: { prompt: 800, completion: 200, total: 1_000 },
        cost_usd: 5,
        model_mix: [{ model: "gpt-5", share: 1, tokens: 1_000, cost_usd: 5 }],
    },
    efficiency: { tool_calls: 40, tool_failures: 2, verification_calls: 10 },
};

const stubDb = Layer.mock(SurrealClient, {
    query: <T extends unknown[] = unknown[]>() => Effect.succeed([] as unknown as T),
    raw: null as never,
});

const handlers: ContractWebHandler[] = [];
afterAll(async () => {
    for (const handler of handlers) await handler.dispose();
});

describe("GET /api/team", () => {
    test("is owned by the contract router", () => {
        expect(isContractRequest("GET", "/api/team")).toBe(true);
    });

    test("returns compiled team boards for valid GitHub snapshots", async () => {
        const github = GitHubEnvTest({
            responses: {
                "GET /repos/acme/ax-team/contents/.ax-team": [
                    { name: "alice.json", type: "file" },
                ],
                "GET /repos/acme/ax-team/contents/.ax-team/alice.json": {
                    encoding: "base64",
                    content: btoa(JSON.stringify(profile)),
                },
            },
        });
        const handler = makeContractWebHandler({
            ingestStream: null,
            services: stubDb,
            github: github.layer,
        });
        handlers.push(handler);

        const response = await handler.handler(
            new Request("http://127.0.0.1:1738/api/team?org=acme"),
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            coverage: { contributing: 1, identified: 1 },
            adoption: {
                contributingDevs: 1,
                identifiedLogins: ["alice"],
                sessions: { total: 6, average: 6 },
                activeDays: { total: 3, average: 3 },
            },
            skillMatrix: [
                { skill: "tdd", devs: 1, runs: 4, sessions: 3, medianRuns: 4 },
            ],
            spend: {
                tokens: { prompt: 800, completion: 200, total: 1_000 },
                costUsd: 5,
                costContributors: 1,
                modelMix: [
                    {
                        model: "gpt-5",
                        tokens: 1_000,
                        share: 1,
                        costUsd: 5,
                        costContributors: 1,
                    },
                ],
            },
            efficiency: {
                toolCalls: 40,
                toolFailures: 2,
                verificationCalls: 10,
                toolFailureRate: 0.05,
                verificationShare: 0.25,
            },
        });
    });

    test("returns an empty valid board when the team repository is missing", async () => {
        const github = GitHubEnvTest({ responses: {} });
        const handler = makeContractWebHandler({
            ingestStream: null,
            services: stubDb,
            github: github.layer,
        });
        handlers.push(handler);

        const response = await handler.handler(
            new Request("http://127.0.0.1:1738/api/team?org=missing-org"),
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            coverage: { contributing: 0, identified: 0 },
            adoption: {
                contributingDevs: 0,
                identifiedLogins: [],
                sessions: { total: 0, average: 0 },
                activeDays: { total: 0, average: 0 },
            },
            skillMatrix: [],
            spend: {
                tokens: { prompt: 0, completion: 0, total: 0 },
                costUsd: 0,
                costContributors: 0,
                modelMix: [],
            },
            efficiency: {
                toolCalls: 0,
                toolFailures: 0,
                verificationCalls: 0,
                toolFailureRate: 0,
                verificationShare: 0,
            },
        });
    });

    test("drops a malformed snapshot and aggregates the valid remainder", async () => {
        const github = GitHubEnvTest({
            responses: {
                "GET /repos/acme/ax-team/contents/.ax-team": [
                    { name: "alice.json", type: "file" },
                    { name: "broken.json", type: "file" },
                ],
                "GET /repos/acme/ax-team/contents/.ax-team/alice.json": {
                    encoding: "base64",
                    content: btoa(JSON.stringify(profile)),
                },
                "GET /repos/acme/ax-team/contents/.ax-team/broken.json": {
                    encoding: "base64",
                    content: btoa(JSON.stringify({ v: 2, login: "mallory" })),
                },
            },
        });
        const handler = makeContractWebHandler({
            ingestStream: null,
            services: stubDb,
            github: github.layer,
        });
        handlers.push(handler);

        const response = await handler.handler(
            new Request("http://127.0.0.1:1738/api/team?org=acme"),
        );
        const body = await response.json() as {
            coverage: { contributing: number; identified: number };
            adoption: { identifiedLogins: string[] };
        };

        expect(response.status).toBe(200);
        expect(body.coverage).toEqual({ contributing: 1, identified: 1 });
        expect(body.adoption.identifiedLogins).toEqual(["alice"]);
    });
});
