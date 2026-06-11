/**
 * Tests for `ax skills tag <skill> <role>` (P3.4).
 *
 * Mock strategy: stub SurrealClientShape so we can inspect the SQL
 * statements issued without hitting a real DB. Process.exit is captured
 * via a thrown Error so assertions remain synchronous.
 */
import { describe, test, expect, mock } from "bun:test";
import { Effect } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import {
    makeTestSurrealClient,
    type TestSurrealQueryCall,
    type TestSurrealUpsertCall,
} from "@ax/lib/testing/surreal";
import { cmdSkillsTag } from "./skills-tag.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMockDb(overrides: {
    skillExists?: boolean;
    queryResults?: unknown[][];
}): { db: SurrealClientShape; calls: TestSurrealQueryCall[]; upserts: TestSurrealUpsertCall[] } {
    const queryResults = overrides.queryResults ?? [];

    const tc = makeTestSurrealClient({
        responses: [
            // First call is the skill lookup: a skill row with a record id, or empty.
            overrides.skillExists === false
                ? []
                : [[{ id: { tb: "skill", id: "composto" } }]],
            // For subsequent calls, return from provided queryResults...
            ...queryResults.map((result) => [result]),
        ],
        // ...or empty arrays.
        fallback: [[]],
    });

    return { db: tc.client, calls: tc.calls, upserts: tc.upserts };
}

function runTag(
    opts: Parameters<typeof cmdSkillsTag>[0],
    db: SurrealClientShape,
): Promise<void> {
    return Effect.runPromise(
        cmdSkillsTag(opts).pipe(
            Effect.provideService(SurrealClient, db),
        ),
    );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cmdSkillsTag", () => {
    test("1. Tags a new role on a skill: DELETE issued, RELATE issued with source=user", async () => {
        const { db, calls, upserts } = buildMockDb({ skillExists: true });
        await runTag(
            { skillName: "composto", roleName: "framing", confidence: 1.0, rationale: undefined, remove: false },
            db,
        );

        const queryCalls = calls;
        // call 0: skill lookup
        expect(queryCalls[0]?.sql).toContain("SELECT id FROM skill WHERE name = $name");
        // call 1: upsert role (via db.upsert, not query)
        expect(upserts.length).toBe(1);
        // call 2: DELETE
        const deleteSql = queryCalls.find((c) => c.sql.includes("DELETE plays_role"));
        expect(deleteSql?.sql).toContain(`source = "user"`);
        expect(deleteSql?.sql).toContain(`role:\`framing\``);
        // call 3: RELATE
        const relateSql = queryCalls.find((c) => c.sql.includes("RELATE"));
        expect(relateSql?.sql).toContain(`->plays_role->`);
        expect(relateSql?.sql).toContain(`source = "user"`);
        expect(relateSql?.sql).toContain(`role:\`framing\``);
    });

    test("2. --remove: DELETE issued, no RELATE", async () => {
        const { db, calls } = buildMockDb({ skillExists: true });
        await runTag(
            { skillName: "composto", roleName: "framing", confidence: 1.0, rationale: undefined, remove: true },
            db,
        );

        const queryCalls = calls;
        const deleteSql = queryCalls.find((c) => c.sql.includes("DELETE plays_role"));
        expect(deleteSql).toBeDefined();

        const relateSql = queryCalls.find((c) => c.sql.includes("RELATE"));
        expect(relateSql).toBeUndefined();
    });

    test("3. Unknown skill: lookup query issued, error path taken (process.exit(2))", async () => {
        const { db, calls } = buildMockDb({ skillExists: false });
        const exitSpy = mock(() => { throw new Error("process.exit(2)"); });
        const origExit = process.exit;
        process.exit = exitSpy as unknown as typeof process.exit;

        try {
            await runTag(
                { skillName: "nonexistent-skill", roleName: "framing", confidence: 1.0, rationale: undefined, remove: false },
                db,
            );
            expect(true).toBe(false); // should not reach here
        } catch (err) {
            expect((err as Error).message).toBe("process.exit(2)");
        } finally {
            process.exit = origExit;
        }

        // The lookup query was issued
        const queryCalls = calls;
        expect(queryCalls.length).toBe(1);
        expect(queryCalls[0]?.sql).toContain("SELECT id FROM skill WHERE name = $name");

        // No RELATE or DELETE issued after failed lookup
        const relateSql = queryCalls.find((c) => c.sql.includes("RELATE"));
        expect(relateSql).toBeUndefined();
    });

    test("4. Custom confidence + rationale appear in RELATE SET clause", async () => {
        const { db, calls } = buildMockDb({ skillExists: true });
        await runTag(
            {
                skillName: "composto",
                roleName: "execution",
                confidence: 0.8,
                rationale: "drives code generation loops",
                remove: false,
            },
            db,
        );

        const relateSql = calls.find((c) => c.sql.includes("RELATE"));
        expect(relateSql?.sql).toContain("0.8");
        expect(relateSql?.sql).toContain("drives code generation loops");
    });

    test("5. Idempotent: running twice issues DELETE + RELATE both times", async () => {
        const { db: db1, calls: calls1 } = buildMockDb({ skillExists: true });
        await runTag(
            { skillName: "composto", roleName: "framing", confidence: 1.0, rationale: undefined, remove: false },
            db1,
        );

        const { db: db2, calls: calls2 } = buildMockDb({ skillExists: true });
        await runTag(
            { skillName: "composto", roleName: "framing", confidence: 1.0, rationale: undefined, remove: false },
            db2,
        );

        // Both runs: DELETE issued
        for (const qCalls of [calls1, calls2]) {
            const deleteSql = qCalls.find((c) => c.sql.includes("DELETE plays_role"));
            expect(deleteSql).toBeDefined();
            const relateSql = qCalls.find((c) => c.sql.includes("RELATE"));
            expect(relateSql).toBeDefined();
        }
    });

    test("6. Role name normalized lowercase + trimmed", async () => {
        const { db, calls, upserts } = buildMockDb({ skillExists: true });
        await runTag(
            { skillName: "composto", roleName: "  FRAMING  ", confidence: 1.0, rationale: undefined, remove: false },
            db,
        );

        // The upsert receives the trimmed+lowercased role name
        const content = upserts[0]?.content;
        expect(content?.["name"]).toBe("framing");

        // The SQL uses the lowercased role literal
        const relateSql = calls.find((c) => c.sql.includes("RELATE"));
        expect(relateSql?.sql).toContain("role:`framing`");
        expect(relateSql?.sql).not.toContain("FRAMING");
    });

    test("7. Invalid role name (backtick) → exit 2, no DB calls", async () => {
        const { db, calls, upserts } = buildMockDb({ skillExists: true });
        const exitSpy = mock(() => { throw new Error("process.exit(2)"); });
        const origExit = process.exit;
        process.exit = exitSpy as unknown as typeof process.exit;

        try {
            await runTag(
                { skillName: "composto", roleName: "bad`role", confidence: 1.0, rationale: undefined, remove: false },
                db,
            );
            expect(true).toBe(false); // unreachable
        } catch (err) {
            expect((err as Error).message).toBe("process.exit(2)");
        } finally {
            process.exit = origExit;
        }

        // No DB queries issued (validation fires before lookup)
        expect(calls.length + upserts.length).toBe(0);
    });

    test("8. Invalid role name (semicolon injection) → exit 2, no DB calls", async () => {
        const { db, calls, upserts } = buildMockDb({ skillExists: true });
        const exitSpy = mock(() => { throw new Error("process.exit(2)"); });
        const origExit = process.exit;
        process.exit = exitSpy as unknown as typeof process.exit;

        try {
            await runTag(
                {
                    skillName: "composto",
                    roleName: "framing;DROP TABLE role",
                    confidence: 1.0,
                    rationale: undefined,
                    remove: false,
                },
                db,
            );
            expect(true).toBe(false); // unreachable
        } catch (err) {
            expect((err as Error).message).toBe("process.exit(2)");
        } finally {
            process.exit = origExit;
        }

        expect(calls.length + upserts.length).toBe(0);
    });

    test("9. Invalid skill name (backtick) → exit 2, no DB calls", async () => {
        const { db, calls, upserts } = buildMockDb({ skillExists: true });
        const exitSpy = mock(() => { throw new Error("process.exit(2)"); });
        const origExit = process.exit;
        process.exit = exitSpy as unknown as typeof process.exit;

        try {
            await runTag(
                { skillName: "bad`skill", roleName: "framing", confidence: 1.0, rationale: undefined, remove: false },
                db,
            );
            expect(true).toBe(false); // unreachable
        } catch (err) {
            expect((err as Error).message).toBe("process.exit(2)");
        } finally {
            process.exit = origExit;
        }

        // Validation fires before any DB lookup
        expect(calls.length + upserts.length).toBe(0);
    });

    test("10. Invalid skill name (spaces) → exit 2, no DB calls", async () => {
        const { db, calls, upserts } = buildMockDb({ skillExists: true });
        const exitSpy = mock(() => { throw new Error("process.exit(2)"); });
        const origExit = process.exit;
        process.exit = exitSpy as unknown as typeof process.exit;

        try {
            await runTag(
                { skillName: "bad skill name", roleName: "framing", confidence: 1.0, rationale: undefined, remove: false },
                db,
            );
            expect(true).toBe(false); // unreachable
        } catch (err) {
            expect((err as Error).message).toBe("process.exit(2)");
        } finally {
            process.exit = origExit;
        }

        expect(calls.length + upserts.length).toBe(0);
    });
});
