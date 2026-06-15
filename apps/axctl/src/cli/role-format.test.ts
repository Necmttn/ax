/**
 * P3.7 tests: role-format pure renderers.
 *
 * No I/O, no Effect, no DB. Tests the tabular and JSON renderers for all
 * three role read commands plus the session show by-role section.
 */

import { describe, expect, it } from "bun:test";
import {
    renderSkillsByRoleTable,
    renderSkillsByRoleJson,
    renderRolesForSkillTable,
    renderRolesForSkillJson,
    renderAllRolesTable,
    renderAllRolesJson,
    renderByRoleSection,
} from "./role-format.ts";
import type {
    FetchSkillsByRoleResult,
    FetchRolesForSkillResult,
    FetchAllRolesResult,
} from "../dashboard/role-queries.ts";
import type { ByRoleGroup } from "./role-format.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SKILLS_BY_ROLE_RESULT: FetchSkillsByRoleResult = {
    found: true,
    rows: [
        {
            skill_id: "skill:⟨caveman⟩",
            skill_name: "caveman",
            invocations: 100,
            source: "frontmatter",
            confidence: 0.9,
            rationale: "used for debugging",
        },
        {
            skill_id: "skill:⟨diagnose⟩",
            skill_name: "diagnose",
            invocations: 42,
            source: "brief",
            confidence: 0.8,
            rationale: null,
        },
    ],
};

const ROLES_FOR_SKILL_RESULT: FetchRolesForSkillResult = {
    skillExists: true,
    rows: [
        {
            role_name: "debugging",
            role_weight: 1.5,
            source: "frontmatter",
            confidence: 0.9,
            edge_weight_override: null,
            rationale: "primary debugging tool",
            since: "2026-01-01T00:00:00Z",
        },
        {
            role_name: "triage",
            role_weight: 1.2,
            source: "user",
            confidence: 1.0,
            edge_weight_override: 2.0,
            rationale: null,
            since: null,
        },
    ],
};

const ALL_ROLES_RESULT: FetchAllRolesResult = {
    rows: [
        { name: "debugging", weight: 1.5, skill_count: 12 },
        { name: "planning", weight: 2.0, skill_count: 8 },
        { name: "empty-role", weight: 1.0, skill_count: 0 },
    ],
};

// ---------------------------------------------------------------------------
// renderSkillsByRoleTable
// ---------------------------------------------------------------------------

describe("renderSkillsByRoleTable - found=true", () => {
    it("includes header columns", () => {
        const out = renderSkillsByRoleTable(SKILLS_BY_ROLE_RESULT, "debugging");
        expect(out).toContain("skill");
        expect(out).toContain("invocations");
        expect(out).toContain("source");
        expect(out).toContain("confidence");
    });

    it("includes skill names", () => {
        const out = renderSkillsByRoleTable(SKILLS_BY_ROLE_RESULT, "debugging");
        expect(out).toContain("caveman");
        expect(out).toContain("diagnose");
    });

    it("includes invocation counts", () => {
        const out = renderSkillsByRoleTable(SKILLS_BY_ROLE_RESULT, "debugging");
        expect(out).toContain("100");
        expect(out).toContain("42");
    });

    it("includes source values", () => {
        const out = renderSkillsByRoleTable(SKILLS_BY_ROLE_RESULT, "debugging");
        expect(out).toContain("frontmatter");
        expect(out).toContain("brief");
    });

    it("includes summary line with role name", () => {
        const out = renderSkillsByRoleTable(SKILLS_BY_ROLE_RESULT, "debugging");
        expect(out).toContain('debugging');
        expect(out).toContain("2 skills");
    });
});

describe("renderSkillsByRoleTable - found=false", () => {
    it("returns informational not-found message", () => {
        const out = renderSkillsByRoleTable(
            { found: false, rows: [] },
            "nonexistent-role",
        );
        expect(out).toContain("no skills classified as");
        expect(out).toContain("nonexistent-role");
    });
});

// ---------------------------------------------------------------------------
// renderSkillsByRoleJson
// ---------------------------------------------------------------------------

describe("renderSkillsByRoleJson", () => {
    it("emits valid JSON", () => {
        const out = renderSkillsByRoleJson(SKILLS_BY_ROLE_RESULT, "debugging");
        expect(() => JSON.parse(out)).not.toThrow();
    });

    it("includes role name", () => {
        const parsed = JSON.parse(renderSkillsByRoleJson(SKILLS_BY_ROLE_RESULT, "debugging"));
        expect(parsed.role).toBe("debugging");
    });

    it("includes found=true", () => {
        const parsed = JSON.parse(renderSkillsByRoleJson(SKILLS_BY_ROLE_RESULT, "debugging"));
        expect(parsed.found).toBe(true);
    });

    it("includes rows array", () => {
        const parsed = JSON.parse(renderSkillsByRoleJson(SKILLS_BY_ROLE_RESULT, "debugging"));
        expect(Array.isArray(parsed.rows)).toBe(true);
        expect(parsed.rows).toHaveLength(2);
        expect(parsed.rows[0].skill_name).toBe("caveman");
    });

    it("found=false produces empty rows", () => {
        const parsed = JSON.parse(
            renderSkillsByRoleJson({ found: false, rows: [] }, "nope"),
        );
        expect(parsed.found).toBe(false);
        expect(parsed.rows).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// renderRolesForSkillTable
// ---------------------------------------------------------------------------

describe("renderRolesForSkillTable - skill exists", () => {
    it("includes header columns", () => {
        const out = renderRolesForSkillTable(ROLES_FOR_SKILL_RESULT, "caveman");
        expect(out).toContain("role");
        expect(out).toContain("source");
        expect(out).toContain("confidence");
        expect(out).toContain("rationale");
    });

    it("includes role names", () => {
        const out = renderRolesForSkillTable(ROLES_FOR_SKILL_RESULT, "caveman");
        expect(out).toContain("debugging");
        expect(out).toContain("triage");
    });

    it("includes source values", () => {
        const out = renderRolesForSkillTable(ROLES_FOR_SKILL_RESULT, "caveman");
        expect(out).toContain("frontmatter");
        expect(out).toContain("user");
    });

    it("includes summary line with skill name", () => {
        const out = renderRolesForSkillTable(ROLES_FOR_SKILL_RESULT, "caveman");
        expect(out).toContain("caveman");
        expect(out).toContain("2 roles");
    });

    it("truncates long rationale", () => {
        const longRationale = "x".repeat(100);
        const result: FetchRolesForSkillResult = {
            skillExists: true,
            rows: [
                {
                    role_name: "test",
                    role_weight: 1.0,
                    source: "user",
                    confidence: 1.0,
                    edge_weight_override: null,
                    rationale: longRationale,
                    since: null,
                },
            ],
        };
        const out = renderRolesForSkillTable(result, "myskill");
        // Should not contain the full 100-char string
        expect(out).not.toContain(longRationale);
        expect(out).toContain("…");
    });
});

describe("renderRolesForSkillTable - unknown skill", () => {
    it("returns error message", () => {
        const out = renderRolesForSkillTable(
            { skillExists: false, rows: [] },
            "ghost-skill",
        );
        expect(out).toContain("unknown skill");
        expect(out).toContain("ghost-skill");
    });
});

describe("renderRolesForSkillTable - no roles", () => {
    it("returns informational no-roles message", () => {
        const out = renderRolesForSkillTable(
            { skillExists: true, rows: [] },
            "untagged-skill",
        );
        expect(out).toContain("no roles assigned");
        expect(out).toContain("untagged-skill");
    });
});

// ---------------------------------------------------------------------------
// renderRolesForSkillJson
// ---------------------------------------------------------------------------

describe("renderRolesForSkillJson", () => {
    it("emits valid JSON", () => {
        const out = renderRolesForSkillJson(ROLES_FOR_SKILL_RESULT, "caveman");
        expect(() => JSON.parse(out)).not.toThrow();
    });

    it("includes skill name", () => {
        const parsed = JSON.parse(renderRolesForSkillJson(ROLES_FOR_SKILL_RESULT, "caveman"));
        expect(parsed.skill).toBe("caveman");
    });

    it("includes skill_exists=true", () => {
        const parsed = JSON.parse(renderRolesForSkillJson(ROLES_FOR_SKILL_RESULT, "caveman"));
        expect(parsed.skill_exists).toBe(true);
    });

    it("includes rows with role fields", () => {
        const parsed = JSON.parse(renderRolesForSkillJson(ROLES_FOR_SKILL_RESULT, "caveman"));
        expect(Array.isArray(parsed.rows)).toBe(true);
        expect(parsed.rows[0].role_name).toBe("debugging");
        expect(parsed.rows[0].source).toBe("frontmatter");
        expect(parsed.rows[0].confidence).toBe(0.9);
    });

    it("skill_exists=false for unknown skill", () => {
        const parsed = JSON.parse(
            renderRolesForSkillJson({ skillExists: false, rows: [] }, "ghost"),
        );
        expect(parsed.skill_exists).toBe(false);
        expect(parsed.rows).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// renderAllRolesTable
// ---------------------------------------------------------------------------

describe("renderAllRolesTable", () => {
    it("includes header columns", () => {
        const out = renderAllRolesTable(ALL_ROLES_RESULT);
        expect(out).toContain("role");
        expect(out).toContain("weight");
        expect(out).toContain("skills");
    });

    it("includes role names", () => {
        const out = renderAllRolesTable(ALL_ROLES_RESULT);
        expect(out).toContain("debugging");
        expect(out).toContain("planning");
        expect(out).toContain("empty-role");
    });

    it("includes skill counts including 0", () => {
        const out = renderAllRolesTable(ALL_ROLES_RESULT);
        expect(out).toContain("12");
        expect(out).toContain("8");
        expect(out).toContain("0");
    });

    it("includes summary count", () => {
        const out = renderAllRolesTable(ALL_ROLES_RESULT);
        expect(out).toContain("3 roles");
    });

    it("returns no-roles message for empty result", () => {
        const out = renderAllRolesTable({ rows: [] });
        expect(out).toContain("no roles found");
    });
});

// ---------------------------------------------------------------------------
// renderAllRolesJson
// ---------------------------------------------------------------------------

describe("renderAllRolesJson", () => {
    it("emits valid JSON", () => {
        const out = renderAllRolesJson(ALL_ROLES_RESULT);
        expect(() => JSON.parse(out)).not.toThrow();
    });

    it("includes rows array", () => {
        const parsed = JSON.parse(renderAllRolesJson(ALL_ROLES_RESULT));
        expect(Array.isArray(parsed.rows)).toBe(true);
        expect(parsed.rows).toHaveLength(3);
    });

    it("includes name, weight, skill_count per row", () => {
        const parsed = JSON.parse(renderAllRolesJson(ALL_ROLES_RESULT));
        const debugging = parsed.rows.find((r: { name: string }) => r.name === "debugging");
        expect(debugging).toBeTruthy();
        expect(debugging.weight).toBe(1.5);
        expect(debugging.skill_count).toBe(12);
    });

    it("empty rows for no roles", () => {
        const parsed = JSON.parse(renderAllRolesJson({ rows: [] }));
        expect(parsed.rows).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// renderByRoleSection (session show --by-role)
// ---------------------------------------------------------------------------

describe("renderByRoleSection", () => {
    const groups: ByRoleGroup[] = [
        {
            role: "debugging",
            skills: [
                { skill: "caveman", count: 10 },
                { skill: "diagnose", count: 5 },
            ],
        },
        {
            role: "planning",
            skills: [{ skill: "superpowers:tdd", count: 3 }],
        },
        {
            role: null, // unclassified
            skills: [{ skill: "unknown-skill", count: 2 }],
        },
    ];

    it("emits ## By role header", () => {
        const out = renderByRoleSection(groups);
        expect(out).toContain("## By role");
    });

    it("renders named role subheadings", () => {
        const out = renderByRoleSection(groups);
        expect(out).toContain("### debugging");
        expect(out).toContain("### planning");
    });

    it("renders (unclassified) for null role", () => {
        const out = renderByRoleSection(groups);
        expect(out).toContain("### (unclassified)");
    });

    it("renders skill names and counts", () => {
        const out = renderByRoleSection(groups);
        expect(out).toContain("caveman");
        expect(out).toContain("×10");
        expect(out).toContain("diagnose");
        expect(out).toContain("×5");
        expect(out).toContain("unknown-skill");
        expect(out).toContain("×2");
    });

    it("renders (none) when a group has no skills", () => {
        const emptyGroup: ByRoleGroup[] = [{ role: "empty", skills: [] }];
        const out = renderByRoleSection(emptyGroup);
        expect(out).toContain("(none)");
    });

    it("handles empty groups array", () => {
        const out = renderByRoleSection([]);
        expect(out).toContain("## By role");
        expect(out).toContain("no skill invocations");
    });
});

// ---------------------------------------------------------------------------
// Golden string assertions — full byte-identity snapshots
// These guard that renderTable migration did not change output bytes.
// ---------------------------------------------------------------------------

describe("renderSkillsByRoleTable - golden string", () => {
    it("produces byte-identical output to the pre-renderTable version", () => {
        const out = renderSkillsByRoleTable(SKILLS_BY_ROLE_RESULT, "debugging");
        expect(out).toBe(
            "rank  skill                         invocations  source        confidence\n" +
            "   1  caveman                               100  frontmatter         0.90\n" +
            "   2  diagnose                               42  brief               0.80\n" +
            "\n" +
            "(2 skills for role \"debugging\")",
        );
    });
});

describe("renderRolesForSkillTable - golden string", () => {
    it("produces byte-identical output to the pre-renderTable version", () => {
        const out = renderRolesForSkillTable(ROLES_FOR_SKILL_RESULT, "caveman");
        expect(out).toBe(
            "role                  source        confidence  rationale                     \n" +
            "debugging             frontmatter         0.90  primary debugging tool        \n" +
            "triage                user                   1                                \n" +
            "\n" +
            "(2 roles for skill \"caveman\")",
        );
    });

    it("ellipsis-truncates rationale at max 50 chars (U+2026)", () => {
        const longRationale = "x".repeat(100);
        const result: FetchRolesForSkillResult = {
            skillExists: true,
            rows: [
                {
                    role_name: "test",
                    role_weight: 1.0,
                    source: "user",
                    confidence: 1.0,
                    edge_weight_override: null,
                    rationale: longRationale,
                    since: null,
                },
            ],
        };
        const out = renderRolesForSkillTable(result, "myskill");
        // Column width = 50 (max), rationale = 49 x's + '…'
        expect(out).toBe(
            "role                  source        confidence  rationale                                         \n" +
            "test                  user                   1  xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…\n" +
            "\n" +
            "(1 role for skill \"myskill\")",
        );
        expect(out).toContain("…");
        expect(out).not.toContain("...");
    });
});

describe("renderAllRolesTable - golden string", () => {
    it("produces byte-identical output to the pre-renderTable version", () => {
        const out = renderAllRolesTable(ALL_ROLES_RESULT);
        expect(out).toBe(
            "role                  weight  skills\n" +
            "debugging               1.50      12\n" +
            "planning                   2       8\n" +
            "empty-role                 1       0\n" +
            "\n" +
            "(3 roles)",
        );
    });
});
