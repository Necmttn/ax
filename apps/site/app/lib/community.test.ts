// apps/site/app/lib/community.test.ts
import { describe, expect, test } from "bun:test";
import {
    profileGistRawUrl,
    registrationRawUrl,
    validateLeaderboard,
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
