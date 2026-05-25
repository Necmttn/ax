import { describe, expect, test } from "bun:test";
import { recommendForSkill } from "./triage.ts";
import type { SkillRow } from "../lib/shared/dashboard-types.ts";

const baseRow = (overrides: Partial<SkillRow> = {}): SkillRow => ({
    name: "test-skill",
    scope: "user",
    description: null,
    dir_path: null,
    bytes: null,
    total_inv: 0,
    inv_7d: 0,
    inv_30d: 0,
    last_used: null,
    last_project: null,
    corrections: 0,
    proposals: 0,
    commits_after: 0,
    taste_score: 0,
    ...overrides,
});

describe("recommendForSkill", () => {
    test("proposed-only skill is archive", () => {
        const rec = recommendForSkill(baseRow({ total_inv: 0, proposals: 3 }));
        expect(rec.recommendation).toBe("archive");
        expect(rec.reason).toContain("dead weight");
    });

    test("stale skill (no recent + old last_used) is archive", () => {
        const oldIso = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
        const rec = recommendForSkill(
            baseRow({ total_inv: 10, inv_30d: 0, last_used: oldIso }),
        );
        expect(rec.recommendation).toBe("archive");
        expect(rec.reason).toContain("unused");
    });

    test("never used (total_inv 0, no proposals) is archive via stale path", () => {
        const rec = recommendForSkill(baseRow({ total_inv: 0 }));
        expect(rec.recommendation).toBe("archive");
    });

    test("high-correction skill flagged review", () => {
        const rec = recommendForSkill(
            baseRow({
                total_inv: 30,
                inv_30d: 20,
                corrections: 8,
                taste_score: 14,
                last_used: new Date().toISOString(),
            }),
        );
        expect(rec.recommendation).toBe("review");
        expect(rec.reason).toContain("corrected");
    });

    test("single correction does NOT trip 'misfiring' branch on small inv_30d", () => {
        const rec = recommendForSkill(
            baseRow({
                total_inv: 10,
                inv_30d: 5,
                corrections: 1,
                taste_score: 3,
                last_used: new Date().toISOString(),
            }),
        );
        // Falls into the moderate-use review bucket (not the misfiring branch).
        expect(rec.reason).not.toContain("misfiring");
    });

    test("strong taste score => keep", () => {
        const rec = recommendForSkill(
            baseRow({
                total_inv: 80,
                inv_30d: 30,
                taste_score: 75,
                corrections: 1,
                last_used: new Date().toISOString(),
            }),
        );
        expect(rec.recommendation).toBe("keep");
        expect(rec.reason).toContain("load-bearing");
    });

    test("rare-use skill flagged review with explicit hint", () => {
        const rec = recommendForSkill(
            baseRow({
                total_inv: 5,
                inv_30d: 2,
                taste_score: 4,
                corrections: 0,
                last_used: new Date().toISOString(),
            }),
        );
        expect(rec.recommendation).toBe("review");
        expect(rec.reason).toContain("rare use");
        expect(rec.reason).toContain("2 hits/30d");
    });

    test("moderate-use skill flagged review with hits + score", () => {
        const rec = recommendForSkill(
            baseRow({
                total_inv: 12,
                inv_30d: 5,
                taste_score: 10,
                corrections: 0,
                last_used: new Date().toISOString(),
            }),
        );
        expect(rec.recommendation).toBe("review");
        expect(rec.reason).toContain("5 hits/30d");
        expect(rec.reason).toContain("verify intent");
    });

    test("staple skill (10+ hits, low correction) is keep even with low score", () => {
        const rec = recommendForSkill(
            baseRow({
                total_inv: 14,
                inv_30d: 12,
                taste_score: 12,
                corrections: 0,
                last_used: new Date().toISOString(),
            }),
        );
        expect(rec.recommendation).toBe("keep");
        expect(rec.reason).toContain("staple");
        expect(rec.reason).toContain("12 hits/30d");
    });

    test("staple rule does not override high-correction review", () => {
        const rec = recommendForSkill(
            baseRow({
                total_inv: 20,
                inv_30d: 15,
                corrections: 6,
                taste_score: 8,
                last_used: new Date().toISOString(),
            }),
        );
        expect(rec.recommendation).toBe("review");
        expect(rec.reason).toContain("corrected");
    });

    test("rare-use reason includes last_project when known", () => {
        const rec = recommendForSkill(
            baseRow({
                total_inv: 3,
                inv_30d: 1,
                taste_score: 4,
                last_project: "-Users-necmttn-Projects-myapp",
                last_used: new Date().toISOString(),
            }),
        );
        expect(rec.reason).toContain("on myapp");
    });

    test("staple reason omits last_project when null", () => {
        const rec = recommendForSkill(
            baseRow({
                total_inv: 14,
                inv_30d: 12,
                taste_score: 12,
                last_project: null,
                last_used: new Date().toISOString(),
            }),
        );
        expect(rec.reason).not.toContain(" on ");
    });
});
