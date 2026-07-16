import { describe, expect, test } from "bun:test";
import type { TeamProfileV1 } from "@ax/lib/shared/team-community";
import { compileTeam } from "./team-compile.ts";

const profile = (
    login: string | null,
    overrides: Partial<TeamProfileV1> = {},
): TeamProfileV1 => ({
    v: 1,
    login,
    org: "acme",
    repo_key: "acme/widget",
    window_days: 30,
    generated_at: "2026-07-17T00:00:00Z",
    stats: {
        sessions: 10,
        active_days: 5,
        harnesses: ["claude"],
    },
    activity: { daily: [] },
    skills: [],
    spend: {
        tokens: { prompt: 800, completion: 200, total: 1_000 },
        cost_usd: 10,
        model_mix: [],
    },
    efficiency: {
        tool_calls: 100,
        tool_failures: 10,
        verification_calls: 20,
    },
    ...overrides,
});

describe("compileTeam", () => {
    test("aggregates adoption, skills, spend, model mix, and efficiency", () => {
        const boards = compileTeam([
            profile("alice", {
                stats: { sessions: 12, active_days: 6, harnesses: ["claude"] },
                skills: [
                    { skill: "tdd", runs: 8, sessions: 5 },
                    { skill: "review", runs: 3, sessions: 2 },
                ],
                spend: {
                    tokens: { prompt: 800, completion: 200, total: 1_000 },
                    cost_usd: 12,
                    model_mix: [
                        { model: "opus", share: 0.75, tokens: 750, cost_usd: 9 },
                        { model: "haiku", share: 0.25, tokens: 250, cost_usd: 3 },
                    ],
                },
                efficiency: { tool_calls: 100, tool_failures: 10, verification_calls: 20 },
            }),
            profile(null, {
                stats: { sessions: 6, active_days: 3, harnesses: ["codex"] },
                skills: [
                    { skill: "tdd", runs: 2, sessions: 2 },
                    { skill: "browser", runs: 5, sessions: 4 },
                ],
                spend: {
                    tokens: { prompt: 400, completion: 100, total: 500 },
                    cost_usd: 4,
                    model_mix: [
                        { model: "opus", share: 0.4, tokens: 200, cost_usd: 3 },
                        { model: "mini", share: 0.6, tokens: 300, cost_usd: 1 },
                    ],
                },
                efficiency: { tool_calls: 40, tool_failures: 2, verification_calls: 10 },
            }),
            profile("carol", {
                stats: { sessions: 9, active_days: 4, harnesses: ["claude", "codex"] },
                skills: [
                    { skill: "tdd", runs: 5, sessions: 4 },
                    { skill: "review", runs: 7, sessions: 5 },
                ],
                spend: {
                    tokens: { prompt: 1_600, completion: 400, total: 2_000 },
                    cost_usd: null,
                    model_mix: [
                        { model: "opus", share: 0.5, tokens: 1_000 },
                        { model: "mini", share: 0.5, tokens: 1_000 },
                    ],
                },
                efficiency: { tool_calls: 60, tool_failures: 8, verification_calls: 15 },
            }),
        ]);

        expect(boards.coverage).toEqual({
            contributing: 3,
            identified: 2,
        });
        expect(boards.adoption).toEqual({
            contributingDevs: 3,
            identifiedLogins: ["alice", "carol"],
            sessions: { total: 27, average: 9 },
            activeDays: { total: 13, average: 13 / 3 },
        });
        expect(boards.skillMatrix).toEqual([
            { skill: "tdd", devs: 3, runs: 15, sessions: 11, medianRuns: 5 },
            { skill: "review", devs: 2, runs: 10, sessions: 7, medianRuns: 5 },
            { skill: "browser", devs: 1, runs: 5, sessions: 4, medianRuns: 5 },
        ]);
        expect(boards.spend).toEqual({
            tokens: { prompt: 2_800, completion: 700, total: 3_500 },
            costUsd: 16,
            costContributors: 2,
            modelMix: [
                { model: "opus", tokens: 1_950, share: 1_950 / 3_500, costUsd: 12, costContributors: 2 },
                { model: "mini", tokens: 1_300, share: 1_300 / 3_500, costUsd: 1, costContributors: 1 },
                { model: "haiku", tokens: 250, share: 250 / 3_500, costUsd: 3, costContributors: 1 },
            ],
        });
        expect(boards.efficiency).toEqual({
            toolCalls: 200,
            toolFailures: 20,
            verificationCalls: 45,
            toolFailureRate: 0.1,
            verificationShare: 0.225,
        });
    });

    test("returns an empty but valid board", () => {
        expect(compileTeam([])).toEqual({
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

    test("anonymous snapshots contribute without creating an identity", () => {
        const boards = compileTeam([
            profile(null, {
                stats: { sessions: 4, active_days: 2, harnesses: ["claude"] },
                skills: [{ skill: "tdd", runs: 6, sessions: 3 }],
            }),
        ]);

        expect(boards.coverage).toEqual({ contributing: 1, identified: 0 });
        expect(boards.adoption.identifiedLogins).toEqual([]);
        expect(boards.adoption.sessions).toEqual({ total: 4, average: 4 });
        expect(boards.skillMatrix).toEqual([
            { skill: "tdd", devs: 1, runs: 6, sessions: 3, medianRuns: 6 },
        ]);
    });
});
