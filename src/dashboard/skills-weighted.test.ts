/**
 * P3.6 tests: fetchSkillsWeighted data layer.
 *
 * Uses a mock SurrealClient (Effect.succeed per call) to assert:
 * - The invocation query includes/omits a WHERE window clause.
 * - Rows are merged correctly (role weights summed, floor 1.0).
 * - Doctor count and advice trigger at the threshold.
 */
import { describe, it, expect } from "bun:test";
import { Effect } from "effect";
import { SurrealClient, type SurrealClientShape } from "../lib/db.ts";
import { fetchSkillsWeighted } from "./skills-weighted.ts";
import { DbError } from "../lib/errors.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock SurrealClientShape that returns responses in order per call.
 * query() returns Effect.succeed(...) so it integrates with Effect.all.
 */
function makeMockDb(responses: Array<unknown>): SurrealClientShape {
    let callIndex = 0;
    return {
        query: <T extends unknown[] = unknown[]>(
            _sql: string,
            _bindings?: Record<string, unknown>,
        ): Effect.Effect<T, DbError> => {
            const resp = responses[callIndex] ?? [[]];
            callIndex++;
            return Effect.succeed(resp as unknown as T);
        },
        upsert: () => Effect.void,
        relate: () => Effect.void,
        putFile: () => Effect.void,
        getFile: () => Effect.succeed(""),
        raw: {} as never,
    } as unknown as SurrealClientShape;
}

/** Run an Effect with mock SurrealClient. */
const runWithMock = <A>(
    db: SurrealClientShape,
    effect: Effect.Effect<A, unknown, SurrealClient>,
): Promise<A> =>
    Effect.runPromise(
        effect.pipe(Effect.provideService(SurrealClient, db)),
    );

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// invocation response (pass 1)
const mockInvRows = [
    [
        { skill_id: "skill:⟨superpowers:tdd⟩", invocations: 124, session_count: 45 },
        { skill_id: "skill:⟨caveman⟩", invocations: 87, session_count: 30 },
        { skill_id: "skill:⟨worktree-read-strategy⟩", invocations: 62, session_count: 12 },
    ],
];

// role response (pass 2) - tdd has two roles, caveman one, worktree-read-strategy none
const mockRoleRows = [
    [
        { skill_id: "skill:⟨superpowers:tdd⟩", role_name: "framing", effective_weight: 1.0 },
        { skill_id: "skill:⟨superpowers:tdd⟩", role_name: "execution", effective_weight: 1.0 },
        { skill_id: "skill:⟨caveman⟩", role_name: "execution-mode", effective_weight: 1.0 },
    ],
];

// doctor response - 3 unclassified (below threshold=5)
const mockDoctorBelow = [[{ n: 3 }]];

// doctor response - 7 unclassified (above threshold=5)
const mockDoctorAbove = [[{ n: 7 }]];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fetchSkillsWeighted", () => {
    it("returns rows sorted by score DESC", async () => {
        const db = makeMockDb([mockInvRows, mockRoleRows, mockDoctorBelow]);
        const result = await runWithMock(db, fetchSkillsWeighted());

        // tdd: 124 × 2.0 = 248, caveman: 87 × 1.0 = 87, worktree: 62 × 1.0 = 62
        expect(result.rows[0]!.skill_name).toBe("superpowers:tdd");
        expect(result.rows[0]!.score).toBe(248);
        expect(result.rows[1]!.skill_name).toBe("caveman");
        expect(result.rows[1]!.score).toBe(87);
        expect(result.rows[2]!.skill_name).toBe("worktree-read-strategy");
        expect(result.rows[2]!.score).toBe(62);
    });

    it("sums role weights for multi-role skills", async () => {
        const db = makeMockDb([mockInvRows, mockRoleRows, mockDoctorBelow]);
        const result = await runWithMock(db, fetchSkillsWeighted());

        const tdd = result.rows.find((r) => r.skill_name === "superpowers:tdd")!;
        expect(tdd.weight).toBe(2.0);
        expect(tdd.roles).toEqual(["framing", "execution"]);
    });

    it("gives unclassified skills weight 1.0", async () => {
        const db = makeMockDb([mockInvRows, mockRoleRows, mockDoctorBelow]);
        const result = await runWithMock(db, fetchSkillsWeighted());

        const worktree = result.rows.find((r) => r.skill_name === "worktree-read-strategy")!;
        expect(worktree.weight).toBe(1.0);
        expect(worktree.roles).toEqual([]);
    });

    it("respects limit param", async () => {
        const db = makeMockDb([mockInvRows, mockRoleRows, mockDoctorBelow]);
        const result = await runWithMock(db, fetchSkillsWeighted({ limit: 2 }));
        expect(result.rows.length).toBe(2);
    });

    it("includes window clause when windowDays is set", async () => {
        const capturedSqls: string[] = [];
        const db: SurrealClientShape = {
            query: <T extends unknown[] = unknown[]>(sql: string): Effect.Effect<T, DbError> => {
                capturedSqls.push(sql);
                return Effect.succeed([[]] as unknown as T);
            },
            upsert: () => Effect.void,
            relate: () => Effect.void,
            putFile: () => Effect.void,
            getFile: () => Effect.succeed(""),
            raw: {} as never,
        } as unknown as SurrealClientShape;

        await runWithMock(db, fetchSkillsWeighted({ windowDays: 30 }));
        // First SQL is the invocation query
        expect(capturedSqls[0]).toContain("ts >= time::now() - 30d");
    });

    it("omits window clause when windowDays is not set", async () => {
        const capturedSqls: string[] = [];
        const db: SurrealClientShape = {
            query: <T extends unknown[] = unknown[]>(sql: string): Effect.Effect<T, DbError> => {
                capturedSqls.push(sql);
                return Effect.succeed([[]] as unknown as T);
            },
            upsert: () => Effect.void,
            relate: () => Effect.void,
            putFile: () => Effect.void,
            getFile: () => Effect.succeed(""),
            raw: {} as never,
        } as unknown as SurrealClientShape;

        await runWithMock(db, fetchSkillsWeighted());
        expect(capturedSqls[0]).not.toContain("ts >= time::now()");
    });

    it("doctor: no advice when count < threshold", async () => {
        const db = makeMockDb([mockInvRows, mockRoleRows, mockDoctorBelow]);
        const result = await runWithMock(db, fetchSkillsWeighted({ doctorThreshold: 5 }));
        expect(result.doctor.advice).toBeNull();
        expect(result.doctor.unclassified_count).toBe(3);
    });

    it("doctor: advice present when count >= threshold", async () => {
        const db = makeMockDb([mockInvRows, mockRoleRows, mockDoctorAbove]);
        const result = await runWithMock(db, fetchSkillsWeighted({ doctorThreshold: 5 }));
        expect(result.doctor.advice).not.toBeNull();
        expect(result.doctor.advice).toContain("ax skills classify");
        expect(result.doctor.unclassified_count).toBe(7);
    });

    it("handles empty invocation result gracefully", async () => {
        const db = makeMockDb([[[]], [[]], [[{ n: 0 }]]]);
        const result = await runWithMock(db, fetchSkillsWeighted());
        expect(result.rows).toHaveLength(0);
        expect(result.doctor.unclassified_count).toBe(0);
        expect(result.doctor.advice).toBeNull();
    });
});
