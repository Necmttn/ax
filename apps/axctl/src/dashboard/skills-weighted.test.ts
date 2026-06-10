/**
 * P3.6 tests: fetchSkillsWeighted data layer.
 *
 * Uses the shared mock SurrealClient factory (sequenced responses) to assert:
 * - The invocation query includes/omits a WHERE window clause.
 * - Rows are merged correctly (role weights summed, floor 1.0).
 * - Doctor count and advice trigger at the threshold.
 */
import { describe, it, expect } from "bun:test";
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { makeTestSurrealClient, type TestSurrealClient } from "@ax/lib/testing/surreal";
import { fetchSkillsWeighted } from "./skills-weighted.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Mock SurrealClient answering query() calls with `responses` in call order. */
const makeMockDb = (responses: Array<unknown>): TestSurrealClient =>
    makeTestSurrealClient({ denyWrites: true, responses: responses as Array<unknown[]> });

/** Run an Effect with the mock SurrealClient. */
const runWithMock = <A>(
    db: TestSurrealClient,
    effect: Effect.Effect<A, unknown, SurrealClient>,
): Promise<A> =>
    Effect.runPromise(effect.pipe(Effect.provide(db.layer)));

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

    // -----------------------------------------------------------------------
    // Provider-tool exclusion + name map (query order:
    // 0 inv, 1 role, 2 doctor, 3 deleted, 4 synthetic, 5 names)
    // -----------------------------------------------------------------------

    // inv rows: a real skill + a synthetic codex tool that would otherwise rank #1
    const invWithTool = [
        [
            { skill_id: "skill:v2__simplify__h1", invocations: 47, session_count: 33 },
            { skill_id: "skill:v2__codex_exec_command__h2", invocations: 90000, session_count: 600 },
        ],
    ];
    const synthIds = [["skill:v2__codex_exec_command__h2"]];
    const nameRows = [
        [
            { id: "skill:v2__simplify__h1", name: "simplify" },
            { id: "skill:v2__codex_exec_command__h2", name: "codex:exec_command" },
        ],
    ];

    it("excludes synthetic provider tools by default and uses the name field", async () => {
        const db = makeMockDb([
            invWithTool, mockRoleRows, mockDoctorBelow, [[]], synthIds, nameRows,
        ]);
        const result = await runWithMock(db, fetchSkillsWeighted());

        expect(result.rows.map((r) => r.skill_name)).toEqual(["simplify"]);
        expect(result.rows.some((r) => r.skill_name === "codex:exec_command")).toBe(false);
    });

    it("includeTools=true keeps tools and drops the synthetic doctor clause", async () => {
        const db = makeMockDb([
            invWithTool, mockRoleRows, mockDoctorBelow, [[]], synthIds, nameRows,
        ]);

        const result = await runWithMock(db, fetchSkillsWeighted({ includeTools: true }));

        // Tool is ranked (and named) when opted in.
        expect(result.rows[0]!.skill_name).toBe("codex:exec_command");
        // Doctor SQL (index 2) must NOT exclude synthetics when includeTools.
        expect(db.captured[2]).not.toContain('dir_path = "(synthetic)"');
    });

    it("doctor SQL excludes synthetics by default", async () => {
        const db = makeTestSurrealClient({ denyWrites: true });

        await runWithMock(db, fetchSkillsWeighted());
        expect(db.captured[2]).toContain('dir_path = "(synthetic)"');
    });

    it("includes window clause when windowDays is set", async () => {
        const db = makeTestSurrealClient({ denyWrites: true });

        await runWithMock(db, fetchSkillsWeighted({ windowDays: 30 }));
        // First SQL is the invocation query
        expect(db.captured[0]).toContain("ts >= time::now() - 30d");
    });

    it("omits window clause when windowDays is not set", async () => {
        const db = makeTestSurrealClient({ denyWrites: true });

        await runWithMock(db, fetchSkillsWeighted());
        expect(db.captured[0]).not.toContain("ts >= time::now()");
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
        expect(result.doctor.advice).toContain("axctl skills classify");
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
