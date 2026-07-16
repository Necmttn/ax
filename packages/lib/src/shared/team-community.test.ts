import { describe, expect, test } from "bun:test";
import { type TeamProfileV1, validateTeamProfile } from "./team-community";

const valid = {
    v: 1,
    login: "necmttn",
    org: "acme",
    repo_key: "remote__github_com_acme_widgets__abc123",
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
} satisfies TeamProfileV1;

describe("validateTeamProfile", () => {
    test("round-trips a well-formed TeamProfileV1 snapshot", () => {
        expect(validateTeamProfile(valid)).toEqual(valid);
    });

    test("accepts an anonymous no-cost snapshot", () => {
        const anon = {
            ...valid,
            login: null,
            spend: {
                ...valid.spend,
                cost_usd: null,
                model_mix: [{ model: "fable", share: 1, tokens: 1_200 }],
            },
        };

        expect(validateTeamProfile(anon)).toEqual(anon);
    });

    test("coerces malformed and injection-looking fields to inert render-safe values", () => {
        expect(validateTeamProfile({
            v: 99,
            login: { toString: () => "<img src=x onerror=alert(1)>" },
            org: "<script>alert(1)</script>",
            repo_key: null,
            window_days: -30,
            generated_at: 42,
            stats: {
                sessions: Number.POSITIVE_INFINITY,
                active_days: -2,
                harnesses: ["<b>claude</b>", 7],
            },
            activity: { daily: "not-an-array" },
            skills: "not-an-array",
            spend: {
                tokens: { prompt: -10, completion: "200" },
                cost_usd: "secret",
                model_mix: [{
                    model: "<svg/onload=alert(1)>",
                    share: 4,
                    tokens: -1,
                    cost_usd: -3,
                }],
            },
            efficiency: {
                tool_calls: -1,
                tool_failures: null,
                verification_calls: Number.NaN,
            },
        })).toEqual({
            v: 1,
            login: "<img src=x onerror=alert(1)>",
            org: "<script>alert(1)</script>",
            repo_key: "",
            window_days: 0,
            generated_at: "42",
            stats: {
                sessions: 0,
                active_days: 0,
                harnesses: ["<b>claude</b>", "7"],
            },
            activity: { daily: [] },
            skills: [],
            spend: {
                tokens: { prompt: 0, completion: 0, total: 0 },
                cost_usd: 0,
                model_mix: [{
                    model: "<svg/onload=alert(1)>",
                    share: 1,
                    tokens: 0,
                    cost_usd: 0,
                }],
            },
            efficiency: {
                tool_calls: 0,
                tool_failures: 0,
                verification_calls: 0,
            },
        });
    });

    test("falls back to an empty snapshot when hostile property access throws", () => {
        const hostile = new Proxy({}, {
            get() {
                throw new Error("hostile getter");
            },
        });

        expect(validateTeamProfile(hostile)).toEqual({
            v: 1,
            login: "",
            org: "",
            repo_key: "",
            window_days: 0,
            generated_at: "",
            stats: { sessions: 0, active_days: 0, harnesses: [] },
            activity: { daily: [] },
            skills: [],
            spend: {
                tokens: { prompt: 0, completion: 0, total: 0 },
                cost_usd: 0,
                model_mix: [],
            },
            efficiency: {
                tool_calls: 0,
                tool_failures: 0,
                verification_calls: 0,
            },
        });
    });
});
