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
    normalizeRecallParams,
    isEmptyRecallQuery,
    RECALL_DEFAULT_OFFSET,
    RECALL_DEFAULT_LIMIT,
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

describe("isEmptyRecallQuery", () => {
    test("empty / whitespace-only is empty; any non-blank char is not", () => {
        expect(isEmptyRecallQuery("")).toBe(true);
        expect(isEmptyRecallQuery("   ")).toBe(true);
        expect(isEmptyRecallQuery("\t\n")).toBe(true);
        expect(isEmptyRecallQuery("x")).toBe(false);
        expect(isEmptyRecallQuery("  x  ")).toBe(false);
    });
});

describe("normalizeRecallParams", () => {
    test("echoes RAW q - no trim/lowercase (fetchRecall lowercases internally)", () => {
        expect(normalizeRecallParams({ q: "  Foo BAR " }).q).toBe("  Foo BAR ");
    });

    test("missing/null q collapses to empty string", () => {
        expect(normalizeRecallParams({}).q).toBe("");
        expect(normalizeRecallParams({ q: null }).q).toBe("");
    });

    test("fills offset/limit PRESENCE defaults when absent", () => {
        const out = normalizeRecallParams({ q: "auth" });
        expect(out.offset).toBe(RECALL_DEFAULT_OFFSET);
        expect(out.limit).toBe(RECALL_DEFAULT_LIMIT);
        expect(RECALL_DEFAULT_OFFSET).toBe(0);
        expect(RECALL_DEFAULT_LIMIT).toBe(50);
    });

    test("passes present offset/limit through and does NOT clamp (fetchRecall owns the clamp)", () => {
        const out = normalizeRecallParams({ q: "auth", offset: 5, limit: 500 });
        expect(out.offset).toBe(5);
        expect(out.limit).toBe(500); // > maxLimit 200, intentionally unclamped here
    });

    test("passes sources through UNRESOLVED (no resolveRecallSources pre-application)", () => {
        expect(normalizeRecallParams({ q: "a", sources: ["commit"] }).sources).toEqual([
            "commit",
        ]);
        // absent sources stay absent so fetchRecall/buildRecallNext resolve once
        expect("sources" in normalizeRecallParams({ q: "a" })).toBe(false);
    });

    test("passes project/skill/since/scope through, defaulting the first three to null", () => {
        const bare = normalizeRecallParams({ q: "a" });
        expect(bare.project).toBeNull();
        expect(bare.skill).toBeNull();
        expect(bare.since).toBeNull();
        expect("scope" in bare).toBe(false);

        const scoped = normalizeRecallParams({
            q: "a",
            project: "p",
            skill: "s",
            since: "2026-01-01",
            scope: { kind: "all" },
        });
        expect(scoped.project).toBe("p");
        expect(scoped.skill).toBe("s");
        expect(scoped.since).toBe("2026-01-01");
        expect(scoped.scope).toEqual({ kind: "all" });

        // scope null (CLI --scope unset) is a meaningful value, preserved
        expect(normalizeRecallParams({ q: "a", scope: null }).scope).toBeNull();
    });
});

// Per-rule parity: each transport (CLI / HTTP-query / MCP-args) carries a
// different SUBSET of recall args, but for the fields they share the normalized
// result must agree. Documents the genuine surface differences (HTTP has no
// sources/scope, MCP has no scope) as intentional, not drift.
describe("normalizeRecallParams - cross-transport parity", () => {
    const httpQuery = { q: "auth flow", project: "ax", skill: null, since: null };
    const mcpArgs = { q: "auth flow", sources: ["turn"] as const };
    const cliOpts = {
        q: "auth flow",
        project: "ax",
        skill: null,
        since: null,
        sources: ["turn"] as const,
        scope: null,
    };

    test("shared fields collapse identically: raw-q echo + presence defaults", () => {
        const h = normalizeRecallParams(httpQuery);
        const m = normalizeRecallParams(mcpArgs);
        const c = normalizeRecallParams(cliOpts);
        for (const p of [h, m, c]) {
            expect(p.q).toBe("auth flow"); // raw echo, every transport
            expect(p.offset).toBe(RECALL_DEFAULT_OFFSET);
            expect(p.limit).toBe(RECALL_DEFAULT_LIMIT);
        }
    });

    test("project agrees where carried (HTTP+CLI); MCP simply omits it", () => {
        expect(normalizeRecallParams(httpQuery).project).toBe("ax");
        expect(normalizeRecallParams(cliOpts).project).toBe("ax");
        expect(normalizeRecallParams(mcpArgs).project).toBeNull();
    });

    test("documented surface differences: HTTP has no sources/scope, MCP no scope", () => {
        expect("sources" in normalizeRecallParams(httpQuery)).toBe(false);
        expect("scope" in normalizeRecallParams(httpQuery)).toBe(false);
        expect("scope" in normalizeRecallParams(mcpArgs)).toBe(false);
        expect(normalizeRecallParams(cliOpts).scope).toBeNull();
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
