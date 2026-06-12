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
        skills: [{ name: "tdd", source: "superpowers", runs_30d: 88 }],
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
