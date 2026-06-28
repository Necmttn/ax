import { describe, expect, test } from "bun:test";
import {
    formatUsd,
    formatUsdCompact,
    profileGistRawUrl,
    registrationRawUrl,
    trendingPatterns,
    trendingSkills,
    validateLeaderboard,
    validatePatternStats,
    validateProfileV1,
    validateRegistration,
} from "./community";

const validProfile = {
    v: 1,
    github: "necmttn",
    generated_at: "2026-06-12T19:00:00Z",
    window_days: 30,
    stats: {
        sessions: 142, active_days: 26, streak_days: 12,
        tokens: { prompt: 31, completion: 7, total: 38 },
        cost_usd: 214.3,
        models: [{ name: "fable", share: 0.58, cost_usd: 124 }],
        harnesses: ["claude", "codex"],
    },
    rig: {
        skills: [{ name: "tdd", source: "superpowers", runs: 88 }],
        hooks: ["enforce-worktree"],
        routing_table: true,
        rules: { count: 14 },
    },
    taste: {
        patterns: [{
            category: "failure-mode", name: "edit-loop-thrash",
            summary: "stop and re-read",
            evidence: { sessions: 12, confidence: 0.8, trend: "rising" },
        }],
    },
};

describe("validateProfileV1", () => {
    test("accepts a valid profile (cost + taste optional both ways)", () => {
        expect(validateProfileV1(validProfile).github).toBe("necmttn");
        const { taste: _t, ...rest } = validProfile;
        const stats = { ...validProfile.stats };
        delete (stats as Record<string, unknown>).cost_usd;
        expect(validateProfileV1({ ...rest, stats }).taste).toBeUndefined();
    });
    test("rejects wrong version / missing stats / non-object", () => {
        expect(() => validateProfileV1({ ...validProfile, v: 2 })).toThrow();
        expect(() => validateProfileV1({ v: 1 })).toThrow();
        expect(() => validateProfileV1("nope")).toThrow();
    });
});

describe("validateProfileV1 - activity + insights sections", () => {
    const profileWithSections = {
        ...validProfile,
        activity: {
            daily: [
                { date: "2026-06-09", sessions: 31, tokens: 800_000 },
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
            ],
        },
    };

    test("accepts profile with valid activity + insights", () => {
        const p = validateProfileV1(profileWithSections);
        expect(p.activity!.daily[0]!.sessions).toBe(31);
        expect(p.insights!.peak_hour_utc).toBe(13);
        expect(p.insights!.busiest_day.date).toBe("2026-06-09");
        expect(p.insights!.tools_top[0]!.name).toBe("Bash");
    });

    test("rejects non-number in tools_top.runs", () => {
        const bad = {
            ...profileWithSections,
            insights: {
                ...profileWithSections.insights,
                tools_top: [{ name: "Bash", runs: "five-thousand" }],
            },
        };
        expect(() => validateProfileV1(bad)).toThrow();
    });

    test("rejects non-string in tools_top.name", () => {
        const bad = {
            ...profileWithSections,
            insights: {
                ...profileWithSections.insights,
                tools_top: [{ name: 42, runs: 100 }],
            },
        };
        expect(() => validateProfileV1(bad)).toThrow();
    });

    test("rejects non-number hours_total", () => {
        const bad = {
            ...profileWithSections,
            insights: {
                ...profileWithSections.insights,
                hours_total: "307.2",
            },
        };
        expect(() => validateProfileV1(bad)).toThrow();
    });

    test("accepts insights with all new optional wrapped-style fields", () => {
        const p = validateProfileV1({
            ...profileWithSections,
            insights: {
                ...profileWithSections.insights,
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

    test("new optional wrapped fields absent is valid (old gist back-compat)", () => {
        // profileWithSections has no wrapped fields
        const p = validateProfileV1(profileWithSections);
        expect(p.insights!.turns).toBeUndefined();
        expect(p.insights!.repos_count).toBeUndefined();
    });

    test("rejects non-number in optional wrapped field", () => {
        const bad = {
            ...profileWithSections,
            insights: {
                ...profileWithSections.insights,
                turns: "lots",
            },
        };
        expect(() => validateProfileV1(bad)).toThrow();
    });

    test("rejects daily row with non-number sessions", () => {
        const bad = {
            ...profileWithSections,
            activity: {
                daily: [{ date: "2026-06-09", sessions: "31", tokens: 800_000 }],
            },
        };
        expect(() => validateProfileV1(bad)).toThrow();
    });
});

describe("validateRegistration", () => {
    test("accepts {github, gist_id, joined}; rejects junk", () => {
        expect(validateRegistration({ github: "a", gist_id: "f00", joined: "2026-06-12" }).gist_id).toBe("f00");
        expect(() => validateRegistration({ github: "a" })).toThrow();
    });
});

describe("validateLeaderboard", () => {
    test("accepts boards shape; rejects rows without login/value", () => {
        const lb = {
            compiled_at: "2026-06-12T03:00:00Z",
            window_days: 30,
            boards: {
                tokens: [{ login: "a", value: 2 }],
                sessions: [], streak: [], cost: [],
            },
        };
        expect(validateLeaderboard(lb).boards.tokens[0]!.login).toBe("a");
        expect(() => validateLeaderboard({ boards: { tokens: [{ nope: 1 }] } })).toThrow();
    });
});

describe("validateProfileV1 - new optional fields (enriched daily, downstream_share, workflow)", () => {
    const base = {
        v: 1,
        github: "necmttn",
        generated_at: "2026-06-13T00:00:00Z",
        window_days: 30,
        stats: {
            sessions: 1, active_days: 1, streak_days: 1,
            tokens: { prompt: 0, completion: 0, total: 0 },
            models: [], harnesses: [],
        },
        rig: { skills: [], hooks: [], routing_table: false },
    };

    test("accepts daily row with models/tool_calls/commits", () => {
        const p = validateProfileV1({
            ...base,
            activity: {
                daily: [{
                    date: "2026-06-13", sessions: 1, tokens: 0,
                    models: [{ name: "fable", tokens: 800_000 }],
                    tool_calls: 100,
                    commits: 5,
                }],
            },
        });
        expect(p.activity!.daily[0]!.models![0]!.name).toBe("fable");
        expect(p.activity!.daily[0]!.tool_calls).toBe(100);
        expect(p.activity!.daily[0]!.commits).toBe(5);
    });

    test("rejects daily models row with non-string name", () => {
        expect(() => validateProfileV1({
            ...base,
            activity: {
                daily: [{ date: "x", sessions: 1, tokens: 0, models: [{ name: 42, tokens: 100 }] }],
            },
        })).toThrow();
    });

    test("rejects daily models row with non-number tokens", () => {
        expect(() => validateProfileV1({
            ...base,
            activity: {
                daily: [{ date: "x", sessions: 1, tokens: 0, models: [{ name: "fable", tokens: "big" }] }],
            },
        })).toThrow();
    });

    test("accepts skill with downstream_share", () => {
        const p = validateProfileV1({
            ...base,
            rig: {
                skills: [{ name: "tdd", source: "superpowers", runs: 88, downstream_share: 0.73 }],
                hooks: [], routing_table: false,
            },
        });
        expect(p.rig.skills[0]!.downstream_share).toBe(0.73);
    });

    test("rejects skill with non-number downstream_share", () => {
        expect(() => validateProfileV1({
            ...base,
            rig: {
                skills: [{ name: "tdd", source: "superpowers", runs: 88, downstream_share: "high" }],
                hooks: [], routing_table: false,
            },
        })).toThrow();
    });

    test("accepts workflow section with arcs", () => {
        const p = validateProfileV1({
            ...base,
            workflow: {
                arcs: [{ steps: ["brainstorming", "writing-plans", "subagent-driven-development"], count: 12 }],
            },
        });
        expect(p.workflow!.arcs[0]!.count).toBe(12);
        expect(p.workflow!.arcs[0]!.steps).toHaveLength(3);
    });

    test("rejects workflow arc with non-array steps", () => {
        expect(() => validateProfileV1({
            ...base,
            workflow: { arcs: [{ steps: "not-array", count: 1 }] },
        })).toThrow();
    });

    test("rejects workflow arc with non-number count", () => {
        expect(() => validateProfileV1({
            ...base,
            workflow: { arcs: [{ steps: ["a"], count: "twelve" }] },
        })).toThrow();
    });

    test("workflow section is optional - omit and still validates", () => {
        const p = validateProfileV1(base);
        expect(p.workflow).toBeUndefined();
    });
});

describe("formatUsd", () => {
    test("groups thousands: 22882 -> $22,882", () => {
        expect(formatUsd(22882)).toBe("$22,882");
    });
    test("rounds to whole dollars", () => {
        expect(formatUsd(42.7)).toBe("$43");
        expect(formatUsd(0)).toBe("$0");
    });
});

describe("formatUsdCompact", () => {
    test("compacts large values: 22882 -> $22.9k", () => {
        expect(formatUsdCompact(22882)).toBe("$22.9K");
    });
    test("small values stay grouped: 605 -> $605", () => {
        expect(formatUsdCompact(605)).toBe("$605");
    });
});

describe("trendingSkills", () => {
    // Keys are canonical identities (bare names); the compile already stripped
    // the install-source prefix and folded local/plugin installs together.
    const stats = {
        "my-personal-skill": { users: 1, runs: 99, source: "local" },
        simplify: { users: 5, runs: 50, source: "local" }, // local-sourced but SHARED
        brainstorming: { users: 3, runs: 30, source: "superpowers" },
        tdd: { users: 2, runs: 12, source: "superpowers" },
        caveman: { users: 1, runs: 5, source: "caveman" },
    };
    test("shared skills trend regardless of install source (no local exclusion)", () => {
        const out = trendingSkills(stats).map(([n]) => n);
        expect(out).toContain("simplify"); // local-sourced, but 5 builders
    });
    test("one-off personal skills drop out via the users >= 2 threshold", () => {
        const out = trendingSkills(stats).map(([n]) => n);
        expect(out).not.toContain("my-personal-skill"); // 1 builder
        expect(out).not.toContain("caveman"); // 1 builder
    });
    test("sorts by users desc, then runs desc", () => {
        const out = trendingSkills(stats).map(([n]) => n);
        expect(out).toEqual(["simplify", "brainstorming", "tdd"]);
    });
    test("minUsers override + limit", () => {
        expect(trendingSkills(stats, { minUsers: 1, limit: 2 })).toHaveLength(2);
    });
});

describe("validatePatternStats + trendingPatterns", () => {
    const stats = {
        compiled_at: "2026-06-12T03:00:00Z",
        patterns: {
            "failure-mode/edit-loop-thrash": {
                category: "failure-mode",
                name: "edit-loop-thrash",
                users: 2,
                sessions: 9,
                recovered_by: {
                    "problem-solving-strategy/full-file-reread": { users: 1, sessions: 5 },
                },
            },
            "workflow/small-review-loops": {
                category: "workflow",
                name: "small-review-loops",
                users: 3,
                sessions: 7,
            },
        },
        dropped: [{ login: "alice", index: 2, reason: "invalid-pattern" }],
    };

    test("validates pattern adoption and recovery joins", () => {
        const out = validatePatternStats(stats);
        expect(out.patterns["failure-mode/edit-loop-thrash"]!.users).toBe(2);
        expect(out.patterns["failure-mode/edit-loop-thrash"]!.recovered_by).toEqual({
            "problem-solving-strategy/full-file-reread": { users: 1, sessions: 5 },
        });
        expect(out.dropped[0]).toEqual({ login: "alice", index: 2, reason: "invalid-pattern" });
    });

    test("rejects malformed recovery rows", () => {
        expect(() => validatePatternStats({
            ...stats,
            patterns: {
                "failure-mode/edit-loop-thrash": {
                    ...stats.patterns["failure-mode/edit-loop-thrash"],
                    recovered_by: { "workflow/x": { users: "lots", sessions: 1 } },
                },
            },
        })).toThrow();
    });

    test("sorts by users desc, then sessions desc", () => {
        const out = trendingPatterns(validatePatternStats(stats)).map(([key]) => key);
        expect(out).toEqual(["workflow/small-review-loops", "failure-mode/edit-loop-thrash"]);
    });
});

describe("validateProfileV1 highlights", () => {
    const base = {
        v: 1, github: "octocat", generated_at: "2026-06-17T00:00:00Z", window_days: 30,
        stats: { sessions: 1, active_days: 1, streak_days: 1, tokens: { prompt: 1, completion: 1, total: 2 }, models: [], harnesses: [] },
        rig: { skills: [], hooks: [], routing_table: false },
    };

    test("accepts a full highlights block", () => {
        const p = validateProfileV1({
            ...base,
            highlights: {
                authored_at: "2026-06-17T00:00:00Z",
                setup: [{ title: "t", what: "w", why: "y", link: "https://x.dev" }],
                skills: [{ name: "tdd", source: "superpowers", summary: "s" }],
                taste: "ship clean",
                wins: [{ text: "shipped", evidence: "PR #1" }],
            },
        });
        expect(p.highlights?.taste).toBe("ship clean");
        expect(p.highlights?.setup?.[0]?.title).toBe("t");
    });

    test("rejects a setup row missing why", () => {
        expect(() => validateProfileV1({
            ...base,
            highlights: { authored_at: "x", setup: [{ title: "t", what: "w" }] },
        })).toThrow();
    });

    test("profile without highlights still validates", () => {
        expect(validateProfileV1(base).highlights).toBeUndefined();
    });
});

describe("validateProfileV1 guardrail receipts", () => {
    const base = {
        v: 1, github: "octocat", generated_at: "2026-06-17T00:00:00Z", window_days: 30,
        stats: { sessions: 1, active_days: 1, streak_days: 1, tokens: { prompt: 1, completion: 1, total: 2 }, models: [], harnesses: [] },
        rig: { skills: [], hooks: ["enforce-worktree"], routing_table: false },
    };

    test("accepts hook receipt counts and verdict tallies", () => {
        const p = validateProfileV1({
            ...base,
            guardrail_receipts: {
                hooks: [
                    { name: "enforce-worktree", fires: 412, blocked: 9, warned: 3 },
                ],
                verdicts: {
                    worked: 5,
                    did_not_work: 2,
                    no_longer_needed: 1,
                },
            },
        });
        expect(p.guardrail_receipts?.hooks[0]?.blocked).toBe(9);
        expect(p.guardrail_receipts?.verdicts.worked).toBe(5);
    });

    test("profile without guardrail receipts still validates", () => {
        expect(validateProfileV1(base).guardrail_receipts).toBeUndefined();
    });

    test("rejects non-number receipt counts", () => {
        expect(() => validateProfileV1({
            ...base,
            guardrail_receipts: {
                hooks: [
                    { name: "enforce-worktree", fires: "many", blocked: 9, warned: 3 },
                ],
                verdicts: {
                    worked: 5,
                    did_not_work: 2,
                    no_longer_needed: 1,
                },
            },
        })).toThrow();
    });
});

describe("urls", () => {
    test("registration + gist raw urls", () => {
        expect(registrationRawUrl("Necmttn")).toBe(
            "https://raw.githubusercontent.com/Necmttn/ax/main/community/users/necmttn.json",
        );
        expect(profileGistRawUrl("necmttn", "abc123")).toBe(
            "https://gist.githubusercontent.com/necmttn/abc123/raw/ax-profile.json",
        );
    });
    test("login is sanitized before url interpolation", () => {
        expect(() => registrationRawUrl("../evil")).toThrow();
    });
});
