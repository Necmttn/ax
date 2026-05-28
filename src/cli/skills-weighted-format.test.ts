/**
 * P3.6 tests: skills-weighted-format pure renderers.
 *
 * All tests are pure (no DB, no Effect) - just data in, string out.
 */
import { describe, it, expect } from "bun:test";
import { renderWeightedTable, renderWeightedJson } from "./skills-weighted-format.ts";
import type { SkillsWeightedResult } from "../dashboard/skills-weighted.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const twoClassified: SkillsWeightedResult = {
    rows: [
        {
            skill_id: "skill:⟨superpowers:tdd⟩",
            skill_name: "superpowers:tdd",
            invocations: 124,
            session_count: 45,
            roles: ["framing", "execution"],
            weight: 2.0,
            score: 248.0,
        },
        {
            skill_id: "skill:⟨caveman⟩",
            skill_name: "caveman",
            invocations: 87,
            session_count: 30,
            roles: ["execution-mode"],
            weight: 1.0,
            score: 87.0,
        },
    ],
    doctor: {
        unclassified_count: 2,
        threshold: 5,
        advice: null,
    },
};

const withUnclassified: SkillsWeightedResult = {
    rows: [
        {
            skill_id: "skill:⟨superpowers:tdd⟩",
            skill_name: "superpowers:tdd",
            invocations: 124,
            session_count: 45,
            roles: ["framing", "execution"],
            weight: 2.0,
            score: 248.0,
        },
        {
            skill_id: "skill:⟨worktree-read-strategy⟩",
            skill_name: "worktree-read-strategy",
            invocations: 62,
            session_count: 12,
            roles: [],
            weight: 1.0,
            score: 62.0,
        },
    ],
    doctor: {
        unclassified_count: 7,
        threshold: 5,
        advice: [
            "7 skills (≥3 invocations) have no role classification.",
            "Their score uses neutral weight 1.0 - ranking may be noisy.",
            "To classify:    axctl skills classify",
            "Then:           edit .ax/tasks/classify-*.md  →  axctl skills lint",
        ].join("\n"),
    },
};

const emptyResult: SkillsWeightedResult = {
    rows: [],
    doctor: { unclassified_count: 0, threshold: 5, advice: null },
};

// ---------------------------------------------------------------------------
// TTY table tests
// ---------------------------------------------------------------------------

describe("renderWeightedTable", () => {
    it("renders rank column starting at 1", () => {
        const out = renderWeightedTable(twoClassified);
        const lines = out.split("\n").filter((l) => l.trim().length > 0);
        // Find the data rows (after header)
        const dataLines = lines.slice(1);
        expect(dataLines[0]).toMatch(/^\s*1\s/);
        expect(dataLines[1]).toMatch(/^\s*2\s/);
    });

    it("includes skill names", () => {
        const out = renderWeightedTable(twoClassified);
        expect(out).toContain("superpowers:tdd");
        expect(out).toContain("caveman");
    });

    it("renders roles as comma-separated", () => {
        const out = renderWeightedTable(twoClassified);
        expect(out).toContain("framing, execution");
        expect(out).toContain("execution-mode");
    });

    it("renders unclassified skills with (unclassified) marker", () => {
        const out = renderWeightedTable(withUnclassified);
        expect(out).toContain("(unclassified)");
    });

    it("includes header row with column names", () => {
        const out = renderWeightedTable(twoClassified);
        expect(out).toContain("rank");
        expect(out).toContain("skill");
        expect(out).toContain("uses");
        expect(out).toContain("sessions");
        expect(out).toContain("roles");
        expect(out).toContain("weight");
        expect(out).toContain("score");
    });

    it("shows count footer", () => {
        const out = renderWeightedTable(twoClassified);
        expect(out).toContain("2 skills shown");
    });

    it("shows doctor block BEFORE table when advice present", () => {
        const out = renderWeightedTable(withUnclassified);
        const doctorIdx = out.indexOf("⚠");
        const headerIdx = out.indexOf("rank");
        expect(doctorIdx).toBeGreaterThanOrEqual(0);
        expect(headerIdx).toBeGreaterThan(doctorIdx);
    });

    it("does NOT show doctor block when advice is null", () => {
        const out = renderWeightedTable(twoClassified);
        expect(out).not.toContain("⚠");
    });

    it("doctor block contains guidance hint", () => {
        const out = renderWeightedTable(withUnclassified);
        expect(out).toContain("axctl skills classify");
    });

    it("handles empty rows", () => {
        const out = renderWeightedTable(emptyResult);
        expect(out).toContain("no skill invocations found");
    });

    it("renders score values", () => {
        const out = renderWeightedTable(twoClassified);
        expect(out).toContain("248");
        expect(out).toContain("87");
    });
});

// ---------------------------------------------------------------------------
// JSON renderer tests
// ---------------------------------------------------------------------------

describe("renderWeightedJson", () => {
    it("parses as valid JSON", () => {
        const out = renderWeightedJson(twoClassified);
        expect(() => JSON.parse(out)).not.toThrow();
    });

    it("includes rows array with correct shape", () => {
        const out = renderWeightedJson(twoClassified);
        const parsed = JSON.parse(out) as { rows: unknown[] };
        expect(parsed.rows).toHaveLength(2);
        const first = parsed.rows[0] as Record<string, unknown>;
        expect(first).toHaveProperty("skill_id");
        expect(first).toHaveProperty("skill_name");
        expect(first).toHaveProperty("invocations");
        expect(first).toHaveProperty("session_count");
        expect(first).toHaveProperty("roles");
        expect(first).toHaveProperty("weight");
        expect(first).toHaveProperty("score");
    });

    it("includes doctor object", () => {
        const out = renderWeightedJson(twoClassified);
        const parsed = JSON.parse(out) as { doctor: unknown };
        expect(parsed).toHaveProperty("doctor");
        const doctor = parsed.doctor as Record<string, unknown>;
        expect(doctor).toHaveProperty("unclassified_count");
        expect(doctor).toHaveProperty("threshold");
        expect(doctor).toHaveProperty("advice");
    });

    it("doctor.advice is null when no advice", () => {
        const out = renderWeightedJson(twoClassified);
        const parsed = JSON.parse(out) as { doctor: { advice: unknown } };
        expect(parsed.doctor.advice).toBeNull();
    });

    it("doctor.advice is string when present", () => {
        const out = renderWeightedJson(withUnclassified);
        const parsed = JSON.parse(out) as { doctor: { advice: unknown } };
        expect(typeof parsed.doctor.advice).toBe("string");
    });

    it("roles is array", () => {
        const out = renderWeightedJson(twoClassified);
        const parsed = JSON.parse(out) as { rows: Array<{ roles: unknown[] }> };
        expect(Array.isArray(parsed.rows[0]!.roles)).toBe(true);
        expect(parsed.rows[0]!.roles).toContain("framing");
    });
});
