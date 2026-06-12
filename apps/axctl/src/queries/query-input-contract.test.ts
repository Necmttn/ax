/**
 * Query Input Contract tests.
 *
 * Each query module that backs both a CLI command and an MCP tool exports a
 * `normalize*` function that applies the shared argument semantics (defaults,
 * presence rules) so the two transports cannot drift. These tests pin those
 * semantics: defaults, divergent per-transport defaults, and how non-finite /
 * empty inputs collapse to the canonical shape.
 */
import { describe, expect, test } from "bun:test";
import {
    normalizeRecommendInput,
} from "../improve/recommend.ts";
import {
    normalizeListProposalsInput,
    LIST_PROPOSALS_DEFAULT_STATUS,
    LIST_PROPOSALS_DEFAULT_LIMIT,
} from "../improve/list.ts";
import {
    resolveRecallSources,
    RECALL_DEFAULT_SOURCES,
} from "../dashboard/recall.ts";
import {
    normalizeSessionsAroundOpts,
    SESSIONS_AROUND_DEFAULT_DAYS,
} from "../dashboard/sessions-query.ts";
import {
    normalizeSkillsWeightedParams,
    SKILLS_WEIGHTED_DEFAULT_LIMIT,
    SKILLS_WEIGHTED_DEFAULT_DOCTOR_THRESHOLD,
} from "../dashboard/skills-weighted.ts";
import {
    normalizeSkillsByRoleParams,
    SKILLS_BY_ROLE_DEFAULT_LIMIT,
} from "../dashboard/role-queries.ts";

// ---------------------------------------------------------------------------
// recommend - DIVERGENT limit default (CLI 5, MCP 10)
// ---------------------------------------------------------------------------

describe("normalizeRecommendInput", () => {
    test("applies the caller's default limit when limit is absent", () => {
        expect(normalizeRecommendInput({}, 5).limit).toBe(5);
        expect(normalizeRecommendInput({}, 10).limit).toBe(10);
    });

    test("a supplied limit overrides the caller default", () => {
        expect(normalizeRecommendInput({ limit: 3 }, 10).limit).toBe(3);
    });

    test("non-finite limit falls back to the caller default", () => {
        expect(normalizeRecommendInput({ limit: Number.NaN }, 5).limit).toBe(5);
        expect(normalizeRecommendInput({ limit: Infinity }, 7).limit).toBe(7);
    });

    test("empty forms array is dropped, non-empty is kept", () => {
        expect(normalizeRecommendInput({ forms: [] }, 5).forms).toBeUndefined();
        expect(normalizeRecommendInput({ forms: ["skill"] }, 5).forms).toEqual([
            "skill",
        ]);
    });

    test("agent/sinceDays are only present when supplied", () => {
        const bare = normalizeRecommendInput({}, 5);
        expect("agent" in bare).toBe(false);
        expect("sinceDays" in bare).toBe(false);
        const full = normalizeRecommendInput(
            { agent: "codex", sinceDays: 14 },
            5,
        );
        expect(full.agent).toBe("codex");
        expect(full.sinceDays).toBe(14);
    });
});

// ---------------------------------------------------------------------------
// list proposals - shared status + limit defaults
// ---------------------------------------------------------------------------

describe("normalizeListProposalsInput", () => {
    test("defaults status to open and limit to 30", () => {
        const out = normalizeListProposalsInput({});
        expect(out.status).toBe(LIST_PROPOSALS_DEFAULT_STATUS);
        expect(out.status).toBe("open");
        expect(out.limit).toBe(LIST_PROPOSALS_DEFAULT_LIMIT);
        expect(out.limit).toBe(30);
    });

    test("explicit status (including 'all') and limit pass through", () => {
        const out = normalizeListProposalsInput({ status: "all", limit: 5 });
        expect(out.status).toBe("all");
        expect(out.limit).toBe(5);
    });

    test("form is only present when supplied", () => {
        expect("form" in normalizeListProposalsInput({})).toBe(false);
        expect(normalizeListProposalsInput({ form: "hook" }).form).toBe("hook");
    });

    test("non-finite limit falls back to the default", () => {
        expect(normalizeListProposalsInput({ limit: Number.NaN }).limit).toBe(30);
    });
});

// ---------------------------------------------------------------------------
// recall - shared default source set
// ---------------------------------------------------------------------------

describe("resolveRecallSources", () => {
    test("null/undefined/empty all resolve to the default [turn]", () => {
        expect(resolveRecallSources(null)).toEqual(RECALL_DEFAULT_SOURCES);
        expect(resolveRecallSources(undefined)).toEqual(["turn"]);
        expect(resolveRecallSources([])).toEqual(["turn"]);
    });

    test("a non-empty requested set passes through unchanged", () => {
        expect(resolveRecallSources(["commit", "skill"])).toEqual([
            "commit",
            "skill",
        ]);
    });
});

// ---------------------------------------------------------------------------
// sessions around - shared half-width default
// ---------------------------------------------------------------------------

describe("normalizeSessionsAroundOpts", () => {
    const date = new Date("2026-06-01T00:00:00.000Z");

    test("defaults days to 3 and omits project when absent", () => {
        const out = normalizeSessionsAroundOpts({ date });
        expect(out.days).toBe(SESSIONS_AROUND_DEFAULT_DAYS);
        expect(out.days).toBe(3);
        expect("project" in out).toBe(false);
        expect(out.date).toBe(date);
    });

    test("null/empty project is omitted, a real slug is kept", () => {
        expect("project" in normalizeSessionsAroundOpts({ date, project: null })).toBe(
            false,
        );
        expect("project" in normalizeSessionsAroundOpts({ date, project: "" })).toBe(
            false,
        );
        expect(
            normalizeSessionsAroundOpts({ date, project: "my-proj" }).project,
        ).toBe("my-proj");
    });

    test("non-finite days falls back to 3, explicit days passes through", () => {
        expect(normalizeSessionsAroundOpts({ date, days: Number.NaN }).days).toBe(3);
        expect(normalizeSessionsAroundOpts({ date, days: 7 }).days).toBe(7);
    });
});

// ---------------------------------------------------------------------------
// skills weighted - shared limit / doctor-threshold / includeTools defaults
// ---------------------------------------------------------------------------

describe("normalizeSkillsWeightedParams", () => {
    test("applies shared defaults", () => {
        const out = normalizeSkillsWeightedParams({});
        expect(out.limit).toBe(SKILLS_WEIGHTED_DEFAULT_LIMIT);
        expect(out.limit).toBe(25);
        expect(out.doctorThreshold).toBe(SKILLS_WEIGHTED_DEFAULT_DOCTOR_THRESHOLD);
        expect(out.doctorThreshold).toBe(5);
        expect(out.includeTools).toBe(false);
        expect("windowDays" in out).toBe(false);
    });

    test("supplied values pass through; windowDays only when present", () => {
        const out = normalizeSkillsWeightedParams({
            windowDays: 30,
            limit: 10,
            doctorThreshold: 8,
            includeTools: true,
        });
        expect(out.windowDays).toBe(30);
        expect(out.limit).toBe(10);
        expect(out.doctorThreshold).toBe(8);
        expect(out.includeTools).toBe(true);
    });

    test("non-finite limit / threshold collapse to defaults", () => {
        const out = normalizeSkillsWeightedParams({
            limit: Infinity,
            doctorThreshold: Number.NaN,
        });
        expect(out.limit).toBe(25);
        expect(out.doctorThreshold).toBe(5);
    });
});

// ---------------------------------------------------------------------------
// skills by-role - shared limit default
// ---------------------------------------------------------------------------

describe("normalizeSkillsByRoleParams", () => {
    test("defaults limit to 50 and carries the role through", () => {
        const out = normalizeSkillsByRoleParams({ role: "execution" });
        expect(out.role).toBe("execution");
        expect(out.limit).toBe(SKILLS_BY_ROLE_DEFAULT_LIMIT);
        expect(out.limit).toBe(50);
    });

    test("supplied limit overrides, non-finite falls back", () => {
        expect(normalizeSkillsByRoleParams({ role: "r", limit: 12 }).limit).toBe(12);
        expect(
            normalizeSkillsByRoleParams({ role: "r", limit: Number.NaN }).limit,
        ).toBe(50);
    });
});
