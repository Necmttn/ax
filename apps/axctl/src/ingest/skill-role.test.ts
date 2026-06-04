/**
 * Unit tests for relateSkillRoles (P3.2).
 *
 * All tests use a mock SurrealClientShape - no live DB required.
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { RecordId } from "surrealdb";
import { relateSkillRoles } from "./skill-role.ts";
import type { SurrealClientShape } from "@ax/lib/db";

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
            return Effect.void;
        },
        relate: () => Effect.void,
        putFile: () => Effect.void,
        getFile: () => Effect.succeed(""),
        raw: undefined as unknown as import("surrealdb").Surreal,
    };
    return { calls, db: impl };
}

const SKILL_ID = new RecordId("skill", "test-skill");
const SKILL_LIT = "skill:`test-skill`";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("relateSkillRoles", () => {
    test("single role: produces sweep DELETE + 1 role upsert + 1 plays_role edge", async () => {
        const { calls, db } = makeMockDb();

        const result = await Effect.runPromise(
            relateSkillRoles(db, {
                skillId: SKILL_ID,
                roles: ["framing"],
            }),
        );

        expect(result.rolesUpserted).toBe(1);
        expect(result.edgesWritten).toBe(1);

        const queryCalls = calls.filter((c): c is Extract<Call, { kind: "query" }> => c.kind === "query");

        // One UPSERT ... SET for the role node. SET (not CONTENT) so an
        // existing role's weight survives re-ingest.
        const roleUpserts = queryCalls.filter((c) => c.sql.includes("UPSERT role:"));
        expect(roleUpserts).toHaveLength(1);
        expect(roleUpserts[0]!.sql).toContain("role:`framing`");
        expect(roleUpserts[0]!.sql).toContain('SET name = "framing"');
        expect(roleUpserts[0]!.sql).not.toContain("CONTENT");

        // Sweep DELETE uses literal skill id, no $skill/$role placeholders
        const sweepDelete = queryCalls.find((c) =>
            c.sql.includes("DELETE plays_role") && c.sql.includes(SKILL_LIT),
        );
        expect(sweepDelete).toBeDefined();
        expect(sweepDelete!.sql).not.toContain("$skill");
        expect(sweepDelete!.sql).not.toContain("$role");

        // RELATE uses literal skill + role ids
        const relateCall = queryCalls.find((c) => c.sql.includes("RELATE"));
        expect(relateCall).toBeDefined();
        expect(relateCall!.sql).toContain(SKILL_LIT);
        expect(relateCall!.sql).toContain("role:`framing`");
        expect(relateCall!.sql).not.toContain("$skill");
        expect(relateCall!.sql).not.toContain("$role");
    });

    test("multi-role: sweep DELETE once, then 2 role upserts + 2 edges", async () => {
        const { calls, db } = makeMockDb();

        const result = await Effect.runPromise(
            relateSkillRoles(db, {
                skillId: SKILL_ID,
                roles: ["framing", "execution"],
            }),
        );

        expect(result.rolesUpserted).toBe(2);
        expect(result.edgesWritten).toBe(2);

        const roleUpserts = calls.filter(
            (c): c is Extract<Call, { kind: "query" }> =>
                c.kind === "query" && c.sql.includes("UPSERT role:"),
        );
        expect(roleUpserts).toHaveLength(2);
        const upsertedNames = roleUpserts.map((c) => c.sql.match(/SET name = "([^"]+)"/)?.[1]);
        expect(upsertedNames).toContain("framing");
        expect(upsertedNames).toContain("execution");

        // Exactly one sweep DELETE (outside the loop)
        const deleteCalls = calls.filter(
            (c): c is Extract<Call, { kind: "query" }> =>
                c.kind === "query" && c.sql.includes("DELETE plays_role"),
        );
        expect(deleteCalls).toHaveLength(1);

        const relateCalls = calls.filter(
            (c): c is Extract<Call, { kind: "query" }> =>
                c.kind === "query" && c.sql.includes("RELATE"),
        );
        expect(relateCalls).toHaveLength(2);
        // Each RELATE uses the correct role literal
        const relatedRoles = relateCalls.map((c) => {
            const m = c.sql.match(/role:`([^`]+)`/);
            return m?.[1];
        });
        expect(relatedRoles).toContain("framing");
        expect(relatedRoles).toContain("execution");
    });

    test("deduplication: roles=['framing', 'Framing', ' framing '] → 1 role upsert + 1 edge", async () => {
        const { calls, db } = makeMockDb();

        const result = await Effect.runPromise(
            relateSkillRoles(db, {
                skillId: SKILL_ID,
                roles: ["framing", "Framing", " framing "],
            }),
        );

        expect(result.rolesUpserted).toBe(1);
        expect(result.edgesWritten).toBe(1);

        const roleUpserts = calls.filter(
            (c): c is Extract<Call, { kind: "query" }> =>
                c.kind === "query" && c.sql.includes("UPSERT role:"),
        );
        expect(roleUpserts).toHaveLength(1);
        expect(roleUpserts[0]!.sql).toContain('SET name = "framing"');
    });

    test("idempotent: running twice issues DELETE then RELATE both times", async () => {
        const { calls, db } = makeMockDb();

        // First run: 1 sweep DELETE + 1 upsert + 1 RELATE = 3 calls
        await Effect.runPromise(
            relateSkillRoles(db, { skillId: SKILL_ID, roles: ["framing"] }),
        );
        const firstRunCallCount = calls.length;
        expect(firstRunCallCount).toBe(3);

        // Second run: same 3 calls
        await Effect.runPromise(
            relateSkillRoles(db, { skillId: SKILL_ID, roles: ["framing"] }),
        );
        expect(calls.length).toBe(firstRunCallCount * 2);

        const allDeleteCalls = calls.filter(
            (c): c is Extract<Call, { kind: "query" }> =>
                c.kind === "query" && c.sql.includes("DELETE plays_role"),
        );
        const allRelateCalls = calls.filter(
            (c): c is Extract<Call, { kind: "query" }> =>
                c.kind === "query" && c.sql.includes("RELATE"),
        );
        // 2 sweep DELETEs (once per run) + 2 RELATEs (once per run)
        expect(allDeleteCalls.length).toBe(2);
        expect(allRelateCalls.length).toBe(2);
    });

    test("SQL uses literal record ids: no $skill or $role placeholders anywhere", async () => {
        const { calls, db } = makeMockDb();

        await Effect.runPromise(
            relateSkillRoles(db, { skillId: SKILL_ID, roles: ["framing"] }),
        );

        const queryCalls = calls.filter((c): c is Extract<Call, { kind: "query" }> => c.kind === "query");
        for (const qc of queryCalls) {
            expect(qc.sql).not.toContain("$skill");
            expect(qc.sql).not.toContain("$role");
            // No bindings object passed for record-id queries
            expect(qc.bindings).toBeUndefined();
        }
    });

    test("empty roles: returns 0/0 and issues a sweep DELETE (no RELATE)", async () => {
        const { calls, db } = makeMockDb();

        const result = await Effect.runPromise(
            relateSkillRoles(db, { skillId: SKILL_ID, roles: [] }),
        );

        expect(result.rolesUpserted).toBe(0);
        expect(result.edgesWritten).toBe(0);

        // Should issue sweep DELETE using literal skill id
        const sweepDelete = calls.find(
            (c): c is Extract<Call, { kind: "query" }> =>
                c.kind === "query" &&
                c.sql.includes("DELETE plays_role") &&
                c.sql.includes(SKILL_LIT) &&
                c.sql.includes('source = "frontmatter"'),
        );
        expect(sweepDelete).toBeDefined();
        expect(sweepDelete!.sql).not.toContain("$skill");

        // No RELATE for empty roles
        const relateCall = calls.find(
            (c): c is Extract<Call, { kind: "query" }> => c.kind === "query" && c.sql.includes("RELATE"),
        );
        expect(relateCall).toBeUndefined();
    });

    test("source=frontmatter and confidence=1.0 set on RELATE query", async () => {
        const { calls, db } = makeMockDb();

        await Effect.runPromise(
            relateSkillRoles(db, { skillId: SKILL_ID, roles: ["framing"] }),
        );

        const relateCall = calls.find(
            (c): c is Extract<Call, { kind: "query" }> =>
                c.kind === "query" && c.sql.includes("RELATE"),
        );
        expect(relateCall).toBeDefined();
        expect(relateCall!.sql).toContain('source = "frontmatter"');
        expect(relateCall!.sql).toContain("confidence = 1.0");
    });

    test("invalid role name (backtick): skipped, not crashed; rolesSkipped incremented", async () => {
        const { calls, db } = makeMockDb();

        const result = await Effect.runPromise(
            relateSkillRoles(db, {
                skillId: SKILL_ID,
                roles: ["framing", "role`with`backtick", "execution"],
            }),
        );

        // backtick role is skipped; valid roles proceed normally
        expect(result.rolesUpserted).toBe(2);
        expect(result.edgesWritten).toBe(2);
        expect(result.rolesSkipped).toBe(1);

        // Only valid roles were upserted
        const roleUpserts = calls.filter(
            (c): c is Extract<Call, { kind: "query" }> =>
                c.kind === "query" && c.sql.includes("UPSERT role:"),
        );
        const upsertedNames = roleUpserts.map((c) => c.sql.match(/SET name = "([^"]+)"/)?.[1]);
        expect(upsertedNames).toContain("framing");
        expect(upsertedNames).toContain("execution");
        expect(upsertedNames).not.toContain("role`with`backtick");

        // No SQL with the backtick role was issued
        const queryCalls = calls.filter((c): c is Extract<Call, { kind: "query" }> => c.kind === "query");
        for (const qc of queryCalls) {
            expect(qc.sql).not.toContain("role`with`backtick");
        }
    });

    test("invalid role name (semicolon injection): skipped; no SQL injection", async () => {
        const { calls, db } = makeMockDb();

        const result = await Effect.runPromise(
            relateSkillRoles(db, {
                skillId: SKILL_ID,
                roles: ["framing;DROP TABLE role", "execution"],
            }),
        );

        expect(result.rolesSkipped).toBe(1);
        expect(result.rolesUpserted).toBe(1);
        expect(result.edgesWritten).toBe(1);

        const queryCalls = calls.filter((c): c is Extract<Call, { kind: "query" }> => c.kind === "query");
        for (const qc of queryCalls) {
            expect(qc.sql).not.toContain("DROP TABLE");
        }
    });

    test("all-invalid roles: sweep DELETE still issued, returns 0/0 + correct rolesSkipped", async () => {
        const { calls, db } = makeMockDb();

        const result = await Effect.runPromise(
            relateSkillRoles(db, {
                skillId: SKILL_ID,
                roles: ["bad role!", "another;bad", "also`bad"],
            }),
        );

        expect(result.rolesUpserted).toBe(0);
        expect(result.edgesWritten).toBe(0);
        expect(result.rolesSkipped).toBe(3);

        // Sweep DELETE still fires
        const sweepDelete = calls.find(
            (c): c is Extract<Call, { kind: "query" }> =>
                c.kind === "query" && c.sql.includes("DELETE plays_role"),
        );
        expect(sweepDelete).toBeDefined();

        // No RELATE issued
        const relateCall = calls.find(
            (c): c is Extract<Call, { kind: "query" }> => c.kind === "query" && c.sql.includes("RELATE"),
        );
        expect(relateCall).toBeUndefined();
    });

    test("stale-edge sweep: roles shrinking [framing,execution]→[framing] removes execution edge", async () => {
        const { calls, db } = makeMockDb();

        // First run with two roles
        await Effect.runPromise(
            relateSkillRoles(db, { skillId: SKILL_ID, roles: ["framing", "execution"] }),
        );

        calls.length = 0; // reset

        // Second run with one role - sweep DELETE fires once (covers both old edges)
        const result = await Effect.runPromise(
            relateSkillRoles(db, { skillId: SKILL_ID, roles: ["framing"] }),
        );
        expect(result.edgesWritten).toBe(1);

        const deleteCalls = calls.filter(
            (c): c is Extract<Call, { kind: "query" }> =>
                c.kind === "query" && c.sql.includes("DELETE plays_role"),
        );
        // One sweep DELETE - not one per role
        expect(deleteCalls).toHaveLength(1);
        expect(deleteCalls[0]!.sql).toContain(SKILL_LIT);
        expect(deleteCalls[0]!.sql).not.toContain("role:`");
    });
});
