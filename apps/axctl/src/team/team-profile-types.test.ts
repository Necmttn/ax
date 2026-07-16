import { describe, expect, test } from "bun:test";
import { decodeTeamProfile } from "./team-profile-types.ts";

const valid = {
    v: 1,
    login: "necmttn",
    org: "acme",
    repo_key: "remote__github_com_acme_widgets__abc123",
    window_days: 30,
    generated_at: "2026-07-16T00:00:00Z",
    stats: { sessions: 12, active_days: 5, harnesses: ["claude", "codex"] },
    activity: { daily: [{ date: "2026-07-15", sessions: 3, tokens: 120000 }] },
    skills: [{ skill: "tdd", runs: 8, sessions: 4 }],
    spend: {
        tokens: { prompt: 1000, completion: 200, total: 1200 },
        cost_usd: 4.2,
        model_mix: [{ model: "fable", share: 1, tokens: 1200, cost_usd: 4.2 }],
    },
    efficiency: { tool_calls: 300, tool_failures: 12, verification_calls: 40 },
};

describe("decodeTeamProfile", () => {
    test("round-trips a valid snapshot", () => {
        const decoded = decodeTeamProfile(valid);
        expect(decoded).toEqual(valid as never);
        // plain-JSON serializable (lands in git, read by a browser)
        expect(decodeTeamProfile(JSON.parse(JSON.stringify(decoded)))).toEqual(decoded);
    });

    test("accepts anon (login null) and no-cost (cost_usd null, no per-model cost)", () => {
        const anon = {
            ...valid,
            login: null,
            spend: {
                ...valid.spend,
                cost_usd: null,
                model_mix: [{ model: "fable", share: 1, tokens: 1200 }],
            },
        };
        expect(decodeTeamProfile(anon).login).toBeNull();
        expect(decodeTeamProfile(anon).spend.cost_usd).toBeNull();
    });

    test("rejects malformed snapshots", () => {
        expect(() => decodeTeamProfile({ ...valid, v: 2 })).toThrow();
        expect(() => decodeTeamProfile({ ...valid, stats: { sessions: "12" } })).toThrow();
        expect(() => decodeTeamProfile(null)).toThrow();
    });

    test("has no free-text summary fields anywhere in the shape", () => {
        expect(JSON.stringify(valid)).not.toContain("summary");
        expect(JSON.stringify(valid)).not.toContain("patterns");
    });
});
