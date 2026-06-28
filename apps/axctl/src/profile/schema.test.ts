import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
    PATTERN_CATEGORIES,
    decodeProfile,
    Highlights,
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
            "tool-output-mix",
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

    test("accepts insights with all new optional wrapped-style fields", () => {
        const p = decodeProfile({
            ...withSections,
            insights: {
                ...withSections.insights,
                turns: 41200,
                tool_calls: 88000,
                tool_failures: 3100,
                distinct_skills: 56,
                distinct_tools: 41,
                repos_count: 12,
                verification_calls: 9100,
                context_calls: 22000,
            },
        });
        expect(p.insights!.turns).toBe(41200);
        expect(p.insights!.tool_calls).toBe(88000);
        expect(p.insights!.tool_failures).toBe(3100);
        expect(p.insights!.distinct_skills).toBe(56);
        expect(p.insights!.distinct_tools).toBe(41);
        expect(p.insights!.repos_count).toBe(12);
        expect(p.insights!.verification_calls).toBe(9100);
        expect(p.insights!.context_calls).toBe(22000);
    });

    test("new optional wrapped fields may be absent (old gist back-compat)", () => {
        // withSections has no wrapped fields - must still decode
        const p = decodeProfile(withSections);
        expect(p.insights!.turns).toBeUndefined();
        expect(p.insights!.repos_count).toBeUndefined();
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

describe("new enriched daily fields (optional)", () => {
    const base = {
        v: 1, github: "x", generated_at: "2026-06-13T00:00:00Z", window_days: 30,
        stats: {
            sessions: 1, active_days: 1, streak_days: 1,
            tokens: { prompt: 0, completion: 0, total: 0 },
            models: [], harnesses: [],
        },
        rig: { skills: [], hooks: [], routing_table: false },
    };

    test("daily row accepts optional models/tool_calls/commits", () => {
        const p = decodeProfile({
            ...base,
            activity: {
                daily: [{
                    date: "2026-06-13", sessions: 5, tokens: 1_000_000,
                    models: [{ name: "fable", tokens: 800_000 }],
                    tool_calls: 4100,
                    commits: 57,
                }],
            },
        });
        const row = p.activity!.daily[0]!;
        expect(row.models).toHaveLength(1);
        expect(row.models![0]!.name).toBe("fable");
        expect(row.models![0]!.tokens).toBe(800_000);
        expect(row.tool_calls).toBe(4100);
        expect(row.commits).toBe(57);
    });

    test("daily row without new optional fields still decodes", () => {
        const p = decodeProfile({
            ...base,
            activity: { daily: [{ date: "2026-06-13", sessions: 1, tokens: 0 }] },
        });
        expect(p.activity!.daily[0]!.models).toBeUndefined();
        expect(p.activity!.daily[0]!.tool_calls).toBeUndefined();
        expect(p.activity!.daily[0]!.commits).toBeUndefined();
    });

    test("daily models row rejects non-string name", () => {
        expect(() => decodeProfile({
            ...base,
            activity: {
                daily: [{
                    date: "2026-06-13", sessions: 1, tokens: 0,
                    models: [{ name: 42, tokens: 100 }],
                }],
            },
        })).toThrow();
    });

    test("daily models row rejects non-number tokens", () => {
        expect(() => decodeProfile({
            ...base,
            activity: {
                daily: [{
                    date: "2026-06-13", sessions: 1, tokens: 0,
                    models: [{ name: "fable", tokens: "big" }],
                }],
            },
        })).toThrow();
    });

    test("workflow section accepted when arcs present", () => {
        const p = decodeProfile({
            ...base,
            workflow: {
                arcs: [
                    { steps: ["superpowers:brainstorming", "superpowers:writing-plans", "superpowers:subagent-driven-development"], count: 12 },
                ],
            },
        });
        expect(p.workflow!.arcs).toHaveLength(1);
        expect(p.workflow!.arcs[0]!.steps[0]).toBe("superpowers:brainstorming");
        expect(p.workflow!.arcs[0]!.count).toBe(12);
    });

    test("workflow section is optional", () => {
        const p = decodeProfile(base);
        expect(p.workflow).toBeUndefined();
    });

    test("workflow arc rejects non-array steps", () => {
        expect(() => decodeProfile({
            ...base,
            workflow: { arcs: [{ steps: "not-array", count: 1 }] },
        })).toThrow();
    });

    test("workflow arc rejects non-number count", () => {
        expect(() => decodeProfile({
            ...base,
            workflow: { arcs: [{ steps: ["a", "b"], count: "twelve" }] },
        })).toThrow();
    });

    test("rig skill accepts downstream_share", () => {
        const p = decodeProfile({
            ...base,
            rig: {
                skills: [{ name: "tdd", source: "superpowers", runs: 88, downstream_share: 0.73 }],
                hooks: [], routing_table: false,
            },
        });
        expect(p.rig.skills[0]!.downstream_share).toBe(0.73);
    });

    test("rig skill without downstream_share still decodes", () => {
        const p = decodeProfile(base);
        // rig.skills is [] but if it had a row without downstream_share, no error
        expect(p.rig.skills).toHaveLength(0);
    });

    test("rig skill rejects non-number downstream_share", () => {
        expect(() => decodeProfile({
            ...base,
            rig: {
                skills: [{ name: "tdd", source: "superpowers", runs: 88, downstream_share: "high" }],
                hooks: [], routing_table: false,
            },
        })).toThrow();
    });
});

describe("guardrail receipts schema", () => {
    const base = {
        v: 1, github: "x", generated_at: "2026-06-13T00:00:00Z", window_days: 30,
        stats: {
            sessions: 1, active_days: 1, streak_days: 1,
            tokens: { prompt: 0, completion: 0, total: 0 },
            models: [], harnesses: [],
        },
        rig: { skills: [], hooks: ["enforce-worktree"], routing_table: false },
    };

    test("accepts optional hook receipt counts and verdict tallies", () => {
        const p = decodeProfile({
            ...base,
            guardrail_receipts: {
                hooks: [
                    { name: "enforce-worktree", fires: 412, blocked: 9, warned: 3 },
                    { name: "route-dispatch", fires: 25, blocked: 0, warned: 12 },
                ],
                verdicts: {
                    worked: 4,
                    did_not_work: 2,
                    no_longer_needed: 1,
                },
            },
        });
        expect(p.guardrail_receipts!.hooks[0]).toEqual({
            name: "enforce-worktree",
            fires: 412,
            blocked: 9,
            warned: 3,
        });
        expect(p.guardrail_receipts!.verdicts.no_longer_needed).toBe(1);
    });

    test("omits guardrail receipts for old gists", () => {
        const p = decodeProfile(base);
        expect(p.guardrail_receipts).toBeUndefined();
    });

    test("rejects non-count receipt fields", () => {
        expect(() => decodeProfile({
            ...base,
            guardrail_receipts: {
                hooks: [{ name: "enforce-worktree", fires: "lots", blocked: 9, warned: 0 }],
                verdicts: { worked: 1, did_not_work: 0, no_longer_needed: 0 },
            },
        })).toThrow();
    });
});

describe("Highlights schema", () => {
    test("Highlights decodes a full block", () => {
        const decode = Schema.decodeUnknownSync(Highlights);
        const v = decode({
            authored_at: "2026-06-17T00:00:00Z",
            setup: [{ title: "loader", what: "injects code", why: "saves time", link: "https://x.dev" }],
            skills: [{ name: "tdd", source: "superpowers", summary: "tests first" }],
            taste: "I optimize for landed-clean commits.",
            wins: [{ text: "duel page", evidence: "PR #527" }],
        });
        expect(v.setup?.[0]?.title).toBe("loader");
        expect(v.wins?.[0]?.evidence).toBe("PR #527");
    });

    test("Highlights decodes a taste-only block", () => {
        const v = Schema.decodeUnknownSync(Highlights)({ authored_at: "2026-06-17T00:00:00Z", taste: "ship clean" });
        expect(v.taste).toBe("ship clean");
        expect(v.setup).toBeUndefined();
    });

    test("Highlights rejects a setup row missing `why`", () => {
        expect(() => Schema.decodeUnknownSync(Highlights)({
            authored_at: "2026-06-17T00:00:00Z",
            setup: [{ title: "x", what: "y" }],
        })).toThrow();
    });
});
