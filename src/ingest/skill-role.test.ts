/**
 * Unit tests for relateSkillRoles (P3.2).
 *
 * All tests use a mock SurrealClientShape - no live DB required.
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { RecordId } from "surrealdb";
import { relateSkillRoles } from "./skill-role.ts";
import type { SurrealClientShape } from "../lib/db.ts";

// ---------------------------------------------------------------------------
// Mock DB helpers
// ---------------------------------------------------------------------------

type Call =
    | { kind: "query"; sql: string; bindings?: Record<string, unknown> }
    | { kind: "upsert"; id: RecordId; content: Record<string, unknown> };

function makeMockDb() {
    const calls: Call[] = [];
    const impl: SurrealClientShape = {
        query: <T extends unknown[] = unknown[]>(
            sql: string,
            bindings?: Record<string, unknown>,
        ) => {
            calls.push(bindings !== undefined ? { kind: "query", sql, bindings } : { kind: "query", sql });
            return Effect.succeed([[]] as unknown as T);
        },
        upsert: (id: RecordId, content: Record<string, unknown>) => {
            calls.push({ kind: "upsert", id, content });
            return Effect.succeed(undefined);
        },
        relate: () => Effect.void,
        putFile: () => Effect.void,
        getFile: () => Effect.succeed(""),
        raw: undefined as unknown as import("surrealdb").Surreal,
    };
    return { calls, db: impl };
}

const SKILL_ID = new RecordId("skill", "test-skill");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("relateSkillRoles", () => {
    test("single role: produces 1 role upsert + 1 plays_role edge", async () => {
        const { calls, db } = makeMockDb();

        const result = await Effect.runPromise(
            relateSkillRoles(db, {
                skillId: SKILL_ID,
                skillName: "test-skill",
                roles: ["framing"],
            }),
        );

        expect(result.rolesUpserted).toBe(1);
        expect(result.edgesWritten).toBe(1);

        // One upsert for the role node
        const upsertCalls = calls.filter((c): c is Extract<Call, { kind: "upsert" }> => c.kind === "upsert");
        expect(upsertCalls).toHaveLength(1);
        expect(upsertCalls[0]!.content).toEqual({ name: "framing" });

        // DELETE + RELATE queries for the one role
        const queryCalls = calls.filter((c): c is Extract<Call, { kind: "query" }> => c.kind === "query");
        const deleteCall = queryCalls.find((c) => c.sql.includes("DELETE plays_role") && c.sql.includes("out = $role"));
        const relateCall = queryCalls.find((c) => c.sql.includes("RELATE"));
        expect(deleteCall).toBeDefined();
        expect(relateCall).toBeDefined();
    });

    test("multi-role: produces 2 role upserts + 2 edges", async () => {
        const { calls, db } = makeMockDb();

        const result = await Effect.runPromise(
            relateSkillRoles(db, {
                skillId: SKILL_ID,
                skillName: "test-skill",
                roles: ["framing", "execution"],
            }),
        );

        expect(result.rolesUpserted).toBe(2);
        expect(result.edgesWritten).toBe(2);

        const upsertCalls = calls.filter((c): c is Extract<Call, { kind: "upsert" }> => c.kind === "upsert");
        expect(upsertCalls).toHaveLength(2);
        const upsertedNames = upsertCalls.map((c) => (c.content as { name: string }).name);
        expect(upsertedNames).toContain("framing");
        expect(upsertedNames).toContain("execution");

        const relateCalls = calls.filter(
            (c): c is Extract<Call, { kind: "query" }> =>
                c.kind === "query" && c.sql.includes("RELATE"),
        );
        expect(relateCalls).toHaveLength(2);
    });

    test("deduplication: roles=['framing', 'Framing', ' framing '] → 1 role upsert + 1 edge", async () => {
        const { calls, db } = makeMockDb();

        const result = await Effect.runPromise(
            relateSkillRoles(db, {
                skillId: SKILL_ID,
                skillName: "test-skill",
                roles: ["framing", "Framing", " framing "],
            }),
        );

        expect(result.rolesUpserted).toBe(1);
        expect(result.edgesWritten).toBe(1);

        const upsertCalls = calls.filter((c): c is Extract<Call, { kind: "upsert" }> => c.kind === "upsert");
        expect(upsertCalls).toHaveLength(1);
        expect(upsertCalls[0]!.content).toEqual({ name: "framing" });
    });

    test("idempotent: running twice issues DELETE then RELATE both times", async () => {
        const { calls, db } = makeMockDb();

        // First run
        await Effect.runPromise(
            relateSkillRoles(db, {
                skillId: SKILL_ID,
                skillName: "test-skill",
                roles: ["framing"],
            }),
        );
        const firstRunCallCount = calls.length;

        // Second run
        await Effect.runPromise(
            relateSkillRoles(db, {
                skillId: SKILL_ID,
                skillName: "test-skill",
                roles: ["framing"],
            }),
        );

        // Each run should issue: 1 upsert + 1 DELETE + 1 RELATE = 3 calls
        expect(calls.length).toBe(firstRunCallCount * 2);

        const allDeleteCalls = calls.filter(
            (c): c is Extract<Call, { kind: "query" }> =>
                c.kind === "query" && c.sql.includes("DELETE plays_role") && c.sql.includes("out = $role"),
        );
        const allRelateCalls = calls.filter(
            (c): c is Extract<Call, { kind: "query" }> =>
                c.kind === "query" && c.sql.includes("RELATE"),
        );
        // 2 DELETE (once per run) + 2 RELATE (once per run)
        expect(allDeleteCalls.length).toBe(2);
        expect(allRelateCalls.length).toBe(2);
    });

    test("parameter binding: bindings carry RecordId for $skill and $role (not strings)", async () => {
        const { calls, db } = makeMockDb();

        await Effect.runPromise(
            relateSkillRoles(db, {
                skillId: SKILL_ID,
                skillName: "test-skill",
                roles: ["framing"],
            }),
        );

        const queryCalls = calls.filter((c): c is Extract<Call, { kind: "query" }> => c.kind === "query");

        // DELETE query bindings
        const deleteCall = queryCalls.find(
            (c) => c.sql.includes("DELETE plays_role") && c.sql.includes("out = $role"),
        );
        expect(deleteCall).toBeDefined();
        expect(deleteCall!.bindings!["skill"]).toBeInstanceOf(RecordId);
        expect(deleteCall!.bindings!["role"]).toBeInstanceOf(RecordId);

        // RELATE query bindings
        const relateCall = queryCalls.find((c) => c.sql.includes("RELATE"));
        expect(relateCall).toBeDefined();
        expect(relateCall!.bindings!["skill"]).toBeInstanceOf(RecordId);
        expect(relateCall!.bindings!["role"]).toBeInstanceOf(RecordId);
    });

    test("empty roles: returns 0/0 and issues a sweep DELETE for stale frontmatter edges", async () => {
        const { calls, db } = makeMockDb();

        const result = await Effect.runPromise(
            relateSkillRoles(db, {
                skillId: SKILL_ID,
                skillName: "test-skill",
                roles: [],
            }),
        );

        expect(result.rolesUpserted).toBe(0);
        expect(result.edgesWritten).toBe(0);

        // Should issue a sweep DELETE for stale edges
        const sweepDelete = calls.find(
            (c): c is Extract<Call, { kind: "query" }> =>
                c.kind === "query" &&
                c.sql.includes("DELETE plays_role") &&
                c.sql.includes('source = "frontmatter"') &&
                !c.sql.includes("out = $role"),
        );
        expect(sweepDelete).toBeDefined();
        expect(sweepDelete!.bindings!["skill"]).toBeInstanceOf(RecordId);
    });

    test("source=frontmatter and confidence=1.0 set on RELATE query", async () => {
        const { calls, db } = makeMockDb();

        await Effect.runPromise(
            relateSkillRoles(db, {
                skillId: SKILL_ID,
                skillName: "test-skill",
                roles: ["framing"],
            }),
        );

        const relateCall = calls.find(
            (c): c is Extract<Call, { kind: "query" }> =>
                c.kind === "query" && c.sql.includes("RELATE"),
        );
        expect(relateCall).toBeDefined();
        expect(relateCall!.sql).toContain('source = "frontmatter"');
        expect(relateCall!.sql).toContain("confidence = 1.0");
    });
});
