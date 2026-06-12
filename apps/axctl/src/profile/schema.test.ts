import { describe, expect, test } from "bun:test";
import {
    PATTERN_CATEGORIES,
    decodeProfile,
    type ProfileV1,
} from "./schema.ts";

const validProfile = {
    v: 1,
    github: "necmttn",
    generated_at: "2026-06-12T19:04:00Z",
    window_days: 30,
    stats: {
        sessions: 142,
        active_days: 26,
        streak_days: 12,
        tokens: { prompt: 31_000_000, completion: 7_000_000, total: 38_000_000 },
        cost_usd: 214.3,
        models: [{ name: "fable", share: 0.58, cost_usd: 124 }],
        harnesses: ["claude-code", "codex"],
    },
    rig: {
        skills: [{ name: "tdd", source: "superpowers", runs: 88 }],
        hooks: ["enforce-worktree", "route-dispatch"],
        routing_table: true,
        rules: { count: 14 },
    },
    taste: {
        patterns: [
            {
                category: "failure-mode",
                name: "edit-loop-thrash",
                summary: "3+ edits to same file -> stop, re-read requirements",
                evidence: {
                    sessions: 12,
                    confidence: 0.8,
                    last_reinforced: "2026-06-10",
                    trend: "rising",
                },
                links: [
                    { rel: "recovered-by", ref: "problem-solving-strategy/full-file-reread" },
                ],
            },
            {
                category: "stack-choice",
                slot: "state-management",
                name: "effect-atom",
                over: ["redux", "zustand"],
                context: "react apps",
                evidence: { sessions: 23, confidence: 0.9, last_reinforced: "2026-06-11", trend: "stable" },
            },
        ],
    },
};

describe("decodeProfile", () => {
    test("accepts a full valid profile", () => {
        const profile: ProfileV1 = decodeProfile(validProfile);
        expect(profile.github).toBe("necmttn");
        expect(profile.taste!.patterns).toHaveLength(2);
        const stackChoice = profile.taste!.patterns.find(
            (p) => p.category === "stack-choice",
        );
        if (stackChoice?.category !== "stack-choice") {
            throw new Error("expected a stack-choice pattern");
        }
        expect(stackChoice.slot).toBe("state-management");
        expect(stackChoice.over).toContain("redux");
    });

    test("cost_usd is optional (--no-cost)", () => {
        const { cost_usd: _omit, ...stats } = validProfile.stats;
        const profile = decodeProfile({ ...validProfile, stats });
        expect(profile.stats.cost_usd).toBeUndefined();
    });

    test("taste section is optional", () => {
        const { taste: _omit, ...rest } = validProfile;
        const profile = decodeProfile(rest);
        expect(profile.taste).toBeUndefined();
    });

    test("rejects unknown pattern category", () => {
        const bad = {
            ...validProfile,
            taste: {
                patterns: [
                    { category: "vibes", name: "x", summary: "y", evidence: { sessions: 1, confidence: 0.5 } },
                ],
            },
        };
        expect(() => decodeProfile(bad)).toThrow();
    });

    test("stack-choice requires slot; prose categories require summary", () => {
        const noSlot = {
            ...validProfile,
            taste: { patterns: [{ category: "stack-choice", name: "x", evidence: { sessions: 1, confidence: 0.5 } }] },
        };
        expect(() => decodeProfile(noSlot)).toThrow();
        const noSummary = {
            ...validProfile,
            taste: { patterns: [{ category: "workflow", name: "x", evidence: { sessions: 1, confidence: 0.5 } }] },
        };
        expect(() => decodeProfile(noSummary)).toThrow();
    });

    test("rejects invalid evidence trend value", () => {
        const bad = {
            ...validProfile,
            taste: {
                patterns: [
                    {
                        category: "workflow",
                        name: "x",
                        summary: "y",
                        evidence: { sessions: 1, confidence: 0.5, trend: "exploding" },
                    },
                ],
            },
        };
        expect(() => decodeProfile(bad)).toThrow();
    });

    test("rejects invalid links[].rel value", () => {
        const bad = {
            ...validProfile,
            taste: {
                patterns: [
                    {
                        category: "workflow",
                        name: "x",
                        summary: "y",
                        evidence: { sessions: 1, confidence: 0.5 },
                        links: [{ rel: "caused-by", ref: "debugging/some-pattern" }],
                    },
                ],
            },
        };
        expect(() => decodeProfile(bad)).toThrow();
    });

    test("category enum is exactly the spec set", () => {
        expect([...PATTERN_CATEGORIES].sort()).toEqual([
            "debugging",
            "design-aesthetic",
            "failure-mode",
            "problem-solving-strategy",
            "stack-choice",
            "workflow",
        ]);
    });
});

describe("activity + insights sections", () => {
    const withSections = {
        ...validProfile,
        activity: {
            daily: [
                { date: "2026-06-09", sessions: 31, tokens: 800_000 },
                { date: "2026-06-12", sessions: 12, tokens: 120_000_000 },
            ],
        },
        insights: {
            hours_total: 307.2,
            longest_session_minutes: 960,
            deep_session_share: 0.58,
            peak_hour_utc: 13,
            busiest_day: { date: "2026-06-09", sessions: 31 },
            max_parallel_sessions: 11,
            subagents_spawned: 420,
            commits: 1000,
            tools_top: [
                { name: "Bash", runs: 5000 },
                { name: "Read", runs: 3200 },
            ],
        },
    };

    test("accepts valid profile with both sections", () => {
        const p = decodeProfile(withSections);
        expect(p.activity!.daily).toHaveLength(2);
        expect(p.activity!.daily[0]!.sessions).toBe(31);
        expect(p.insights!.hours_total).toBe(307.2);
        expect(p.insights!.busiest_day.date).toBe("2026-06-09");
        expect(p.insights!.tools_top[0]!.name).toBe("Bash");
    });

    test("activity section is optional - omit it and profile still decodes", () => {
        const { activity: _a, ...rest } = withSections;
        const p = decodeProfile(rest);
        expect(p.activity).toBeUndefined();
    });

    test("insights section is optional - omit it and profile still decodes", () => {
        const { insights: _i, ...rest } = withSections;
        const p = decodeProfile(rest);
        expect(p.insights).toBeUndefined();
    });

    test("rejects tools_top row with non-number runs", () => {
        const bad = {
            ...withSections,
            insights: {
                ...withSections.insights,
                tools_top: [{ name: "Bash", runs: "five-thousand" }],
            },
        };
        expect(() => decodeProfile(bad)).toThrow();
    });

    test("rejects tools_top row with non-string name", () => {
        const bad = {
            ...withSections,
            insights: {
                ...withSections.insights,
                tools_top: [{ name: 42, runs: 100 }],
            },
        };
        expect(() => decodeProfile(bad)).toThrow();
    });

    test("rejects activity daily row with missing tokens", () => {
        const bad = {
            ...withSections,
            activity: {
                daily: [{ date: "2026-06-09", sessions: 31 }],
            },
        };
        expect(() => decodeProfile(bad)).toThrow();
    });
});
