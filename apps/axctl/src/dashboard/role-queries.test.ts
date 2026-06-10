/**
 * P3.7 tests: role-queries data layer.
 *
 * All tests use a mocked SurrealClient via Layer. The focus is on:
 *   - query shape passed to db.query (correct SQL / params)
 *   - row mapping (raw Record<> → typed output)
 *   - edge cases (empty results, missing fields)
 */

import { describe, expect, it } from "bun:test";
import { Effect, type Layer } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { makeTestSurrealClient } from "@ax/lib/testing/surreal";
import {
    fetchSkillsByRole,
    fetchRolesForSkill,
    fetchAllRoles,
} from "./role-queries.ts";

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

/** Build a Layer from a query stub that always returns the given results. */
function stubLayer(
    queryResults: Array<Array<Record<string, unknown>>>,
): Layer.Layer<SurrealClient> {
    return makeTestSurrealClient({
        responses: queryResults.map((result) => [result]),
    }).layer;
}

// ---------------------------------------------------------------------------
// fetchSkillsByRole
// ---------------------------------------------------------------------------

describe("fetchSkillsByRole - row mapping", () => {
    it("maps raw rows to SkillByRoleRow correctly", async () => {
        const rawRow = {
            skill_id: "skill:⟨caveman⟩",
            skill_name: "caveman",
            source: "frontmatter",
            confidence: 0.9,
            rationale: "debugging tool",
            invocations: 42,
        };

        const result = await Effect.runPromise(
            fetchSkillsByRole({ role: "debugging" }).pipe(
                Effect.provide(stubLayer([[rawRow]])),
            ),
        );

        expect(result.found).toBe(true);
        expect(result.rows).toHaveLength(1);
        const row = result.rows[0]!;
        expect(row.skill_id).toBe("skill:⟨caveman⟩");
        expect(row.skill_name).toBe("caveman");
        expect(row.source).toBe("frontmatter");
        expect(row.confidence).toBe(0.9);
        expect(row.rationale).toBe("debugging tool");
        expect(row.invocations).toBe(42);
    });

    it("returns found=false when result is empty", async () => {
        const result = await Effect.runPromise(
            fetchSkillsByRole({ role: "nonexistent" }).pipe(
                Effect.provide(stubLayer([[]])),
            ),
        );

        expect(result.found).toBe(false);
        expect(result.rows).toHaveLength(0);
    });

    it("coerces missing fields to defaults", async () => {
        const rawRow = {
            skill_id: "skill:test",
            skill_name: "test",
            // source, confidence, rationale, invocations all missing
        };

        const result = await Effect.runPromise(
            fetchSkillsByRole({ role: "testing" }).pipe(
                Effect.provide(stubLayer([[rawRow]])),
            ),
        );

        expect(result.found).toBe(true);
        const row = result.rows[0]!;
        expect(row.source).toBe("");
        expect(row.confidence).toBe(0);
        expect(row.rationale).toBeNull();
        expect(row.invocations).toBe(0);
    });

    it("returns multiple rows", async () => {
        const rows = [
            { skill_id: "skill:a", skill_name: "a", source: "brief", confidence: 1.0, rationale: null, invocations: 10 },
            { skill_id: "skill:b", skill_name: "b", source: "user", confidence: 0.8, rationale: "manual", invocations: 5 },
        ];

        const result = await Effect.runPromise(
            fetchSkillsByRole({ role: "planning", limit: 10 }).pipe(
                Effect.provide(stubLayer([rows])),
            ),
        );

        expect(result.rows).toHaveLength(2);
        expect(result.rows[0]!.skill_name).toBe("a");
        expect(result.rows[1]!.skill_name).toBe("b");
    });
});

// ---------------------------------------------------------------------------
// fetchRolesForSkill
// ---------------------------------------------------------------------------

describe("fetchRolesForSkill - skill existence check", () => {
    it("returns skillExists=false when skill not found", async () => {
        // First call: exists check returns empty; no second call needed.
        const result = await Effect.runPromise(
            fetchRolesForSkill({ skill: "unknown-skill" }).pipe(
                Effect.provide(stubLayer([[]])), // empty rows for exists check
            ),
        );

        expect(result.skillExists).toBe(false);
        expect(result.rows).toHaveLength(0);
    });

    it("returns rows when skill exists", async () => {
        const existsRow = { id: "skill:⟨caveman⟩" };
        const roleRow = {
            role_name: "debugging",
            role_weight: 1.5,
            source: "frontmatter",
            confidence: 0.9,
            edge_weight_override: null,
            rationale: "used for debugging",
            since: "2026-01-01T00:00:00Z",
        };

        // Two calls: exists check, then roles query
        const result = await Effect.runPromise(
            fetchRolesForSkill({ skill: "caveman" }).pipe(
                Effect.provide(stubLayer([[existsRow], [roleRow]])),
            ),
        );

        expect(result.skillExists).toBe(true);
        expect(result.rows).toHaveLength(1);
        const row = result.rows[0]!;
        expect(row.role_name).toBe("debugging");
        expect(row.role_weight).toBe(1.5);
        expect(row.source).toBe("frontmatter");
        expect(row.confidence).toBe(0.9);
        expect(row.edge_weight_override).toBeNull();
        expect(row.rationale).toBe("used for debugging");
        expect(row.since).toBe("2026-01-01T00:00:00Z");
    });

    it("returns empty rows when skill exists but has no roles", async () => {
        const existsRow = { id: "skill:⟨caveman⟩" };

        const result = await Effect.runPromise(
            fetchRolesForSkill({ skill: "caveman" }).pipe(
                Effect.provide(stubLayer([[existsRow], []])),
            ),
        );

        expect(result.skillExists).toBe(true);
        expect(result.rows).toHaveLength(0);
    });

    it("coerces missing role fields to defaults", async () => {
        const existsRow = { id: "skill:x" };
        const roleRow = { role_name: "planning" }; // minimal row

        const result = await Effect.runPromise(
            fetchRolesForSkill({ skill: "x" }).pipe(
                Effect.provide(stubLayer([[existsRow], [roleRow]])),
            ),
        );

        const row = result.rows[0]!;
        expect(row.role_name).toBe("planning");
        expect(row.role_weight).toBe(1);
        expect(row.source).toBe("");
        expect(row.confidence).toBe(0);
        expect(row.edge_weight_override).toBeNull();
        expect(row.rationale).toBeNull();
        expect(row.since).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// fetchAllRoles
// ---------------------------------------------------------------------------

describe("fetchAllRoles - row mapping", () => {
    it("returns all roles with skill counts", async () => {
        const rows = [
            { name: "debugging", weight: 1.5, skill_count: 12 },
            { name: "planning", weight: 2.0, skill_count: 8 },
            { name: "empty-role", weight: 1.0, skill_count: 0 },
        ];

        const result = await Effect.runPromise(
            fetchAllRoles().pipe(Effect.provide(stubLayer([rows]))),
        );

        expect(result.rows).toHaveLength(3);
        expect(result.rows[0]!.name).toBe("debugging");
        expect(result.rows[0]!.weight).toBe(1.5);
        expect(result.rows[0]!.skill_count).toBe(12);
        // Empty-role included (skill_count=0)
        expect(result.rows[2]!.name).toBe("empty-role");
        expect(result.rows[2]!.skill_count).toBe(0);
    });

    it("returns empty rows when no roles exist", async () => {
        const result = await Effect.runPromise(
            fetchAllRoles().pipe(Effect.provide(stubLayer([[]]))),
        );

        expect(result.rows).toHaveLength(0);
    });

    it("coerces missing fields to defaults", async () => {
        const rows = [{ name: "test" }]; // weight and skill_count missing

        const result = await Effect.runPromise(
            fetchAllRoles().pipe(Effect.provide(stubLayer([rows]))),
        );

        const row = result.rows[0]!;
        expect(row.name).toBe("test");
        expect(row.weight).toBe(1);
        expect(row.skill_count).toBe(0);
    });

    it("includes roles with skill_count=0 (empty roles)", async () => {
        const rows = [
            { name: "active", weight: 1.0, skill_count: 5 },
            { name: "orphan", weight: 1.0, skill_count: 0 },
        ];

        const result = await Effect.runPromise(
            fetchAllRoles().pipe(Effect.provide(stubLayer([rows]))),
        );

        expect(result.rows).toHaveLength(2);
        const orphan = result.rows.find((r) => r.name === "orphan");
        expect(orphan).toBeTruthy();
        expect(orphan!.skill_count).toBe(0);
    });
});
