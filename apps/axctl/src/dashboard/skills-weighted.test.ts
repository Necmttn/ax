/**
 * P3.6 tests: fetchSkillsWeighted data layer.
 *
 * Uses the shared mock SurrealClient factory (sequenced responses) to assert:
 * - The invocation query includes/omits a WHERE window clause.
 * - Rows are merged correctly (role weights summed, floor 1.0).
 * - Doctor count and advice trigger at the threshold.
 * - Spar sessions are excluded from the weighted ranking.
 *
 * Query order (call index):
 *   0 → fetchSparSessionIds (spar exclusion ids)
 *   1 → invocation aggregate (pass 1)
 *   2 → role weights (pass 2)
 *   3 → doctor query
 *   4 → deleted skill ids
 *   5 → synthetic skill ids
 *   6 → skill names
 */
import { describe, it, expect } from "bun:test";
import { RecordId } from "surrealdb";
import { makeMockDb, runWithMock } from "@ax/lib/testing/surreal";
import { fetchSkillsWeighted } from "./skills-weighted.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Empty spar-session result - prepend to every positional response list. */
const noSparSessions = [[]];

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
        const db = makeMockDb([noSparSessions, mockInvRows, mockRoleRows, mockDoctorBelow]);
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
        const db = makeMockDb([noSparSessions, mockInvRows, mockRoleRows, mockDoctorBelow]);
        const result = await runWithMock(db, fetchSkillsWeighted());

        const tdd = result.rows.find((r) => r.skill_name === "superpowers:tdd")!;
        expect(tdd.weight).toBe(2.0);
        expect(tdd.roles).toEqual(["framing", "execution"]);
    });

    it("gives unclassified skills weight 1.0", async () => {
        const db = makeMockDb([noSparSessions, mockInvRows, mockRoleRows, mockDoctorBelow]);
        const result = await runWithMock(db, fetchSkillsWeighted());

        const worktree = result.rows.find((r) => r.skill_name === "worktree-read-strategy")!;
        expect(worktree.weight).toBe(1.0);
        expect(worktree.roles).toEqual([]);
    });

    it("respects limit param", async () => {
        const db = makeMockDb([noSparSessions, mockInvRows, mockRoleRows, mockDoctorBelow]);
        const result = await runWithMock(db, fetchSkillsWeighted({ limit: 2 }));
        expect(result.rows.length).toBe(2);
    });

    // -----------------------------------------------------------------------
    // Provider-tool exclusion + name map (query order:
    // 0 spar, 1 inv, 2 role, 3 doctor, 4 deleted, 5 synthetic, 6 names)
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
            noSparSessions, invWithTool, mockRoleRows, mockDoctorBelow, [[]], synthIds, nameRows,
        ]);
        const result = await runWithMock(db, fetchSkillsWeighted());

        expect(result.rows.map((r) => r.skill_name)).toEqual(["simplify"]);
        expect(result.rows.some((r) => r.skill_name === "codex:exec_command")).toBe(false);
    });

    it("includeTools=true keeps tools and drops the synthetic doctor clause", async () => {
        const db = makeMockDb([
            noSparSessions, invWithTool, mockRoleRows, mockDoctorBelow, [[]], synthIds, nameRows,
        ]);

        const result = await runWithMock(db, fetchSkillsWeighted({ includeTools: true }));

        // Tool is ranked (and named) when opted in.
        expect(result.rows[0]!.skill_name).toBe("codex:exec_command");
        // Doctor SQL (index 3) must NOT exclude synthetics when includeTools.
        expect(db.captured[3]).not.toContain('dir_path = "(synthetic)"');
    });

    it("doctor SQL excludes synthetics by default", async () => {
        const db = makeMockDb();

        await runWithMock(db, fetchSkillsWeighted());
        // Doctor query is at index 3 (after spar query at 0, inv at 1, role at 2)
        expect(db.captured[3]).toContain('dir_path = "(synthetic)"');
    });

    it("includes window clause when windowDays is set", async () => {
        const db = makeMockDb();

        await runWithMock(db, fetchSkillsWeighted({ windowDays: 30 }));
        // Invocation query is at index 1 (after spar query at 0)
        expect(db.captured[1]).toContain("ts >= time::now() - 30d");
    });

    it("omits window clause when windowDays is not set", async () => {
        const db = makeMockDb();

        await runWithMock(db, fetchSkillsWeighted());
        // Invocation query at index 1 must not have a time window
        expect(db.captured[1]).not.toContain("ts >= time::now()");
    });

    it("doctor: no advice when count < threshold", async () => {
        const db = makeMockDb([noSparSessions, mockInvRows, mockRoleRows, mockDoctorBelow]);
        const result = await runWithMock(db, fetchSkillsWeighted({ doctorThreshold: 5 }));
        expect(result.doctor.advice).toBeNull();
        expect(result.doctor.unclassified_count).toBe(3);
    });

    it("doctor: advice present when count >= threshold", async () => {
        const db = makeMockDb([noSparSessions, mockInvRows, mockRoleRows, mockDoctorAbove]);
        const result = await runWithMock(db, fetchSkillsWeighted({ doctorThreshold: 5 }));
        expect(result.doctor.advice).not.toBeNull();
        expect(result.doctor.advice).toContain("axctl skills classify");
        expect(result.doctor.unclassified_count).toBe(7);
    });

    it("handles empty invocation result gracefully", async () => {
        const db = makeMockDb([noSparSessions, [[]], [[]], [[{ n: 0 }]]]);
        const result = await runWithMock(db, fetchSkillsWeighted());
        expect(result.rows).toHaveLength(0);
        expect(result.doctor.unclassified_count).toBe(0);
        expect(result.doctor.advice).toBeNull();
    });

    // -----------------------------------------------------------------------
    // Spar exclusion
    //
    // NOTE: the mock layer never evaluates SurrealQL, so these stubs CANNOT
    // verify that NOT IN actually excludes spar rows. They assert the
    // STRUCTURAL contract that makes the exclusion fire on the live DB:
    //   (1) the SQL contains `session NOT IN $sparSessions`, and
    //   (2) the bound $sparSessions values are RecordId instances (record-typed),
    //       NOT strings - a string[] binding makes NOT IN a silent no-op
    //       (record<session> NOT IN [<string>...] is always TRUE).
    // True semantic validation is the live-DB before/after check in the
    // spar-exclusion design (a tagged session's skill counts must drop).
    // -----------------------------------------------------------------------

    it("invocation SQL contains NOT IN $sparSessions clause", async () => {
        const db = makeMockDb();
        await runWithMock(db, fetchSkillsWeighted());
        // Invocation query at index 1
        expect(db.captured[1]).toContain("session NOT IN $sparSessions");
    });

    it("binds $sparSessions as RecordId values (record-typed, not strings)", async () => {
        // Spar query (index 0) returns raw RecordIds via SELECT VALUE id; assert
        // they are passed through to the invocation call's binding unchanged and
        // are RecordId instances - the only form NOT IN actually evaluates.
        const sparRid = new RecordId("session", "spar-abc");
        const db = makeMockDb([[[sparRid]], mockInvRows, mockRoleRows, mockDoctorBelow]);
        await runWithMock(db, fetchSkillsWeighted());
        const invCall = db.calls[1];
        const bound = invCall?.bindings?.sparSessions as unknown[];
        expect(Array.isArray(bound)).toBe(true);
        expect(bound).toHaveLength(1);
        // Record-typed contract: the binding MUST be a RecordId, not a string.
        expect(bound[0]).toBeInstanceOf(RecordId);
        expect(String(bound[0])).toBe("session:⟨spar-abc⟩");
    });

    it("wires the spar query's RecordIds into the invocation binding", async () => {
        // End-to-end (within the stub): the RecordIds emitted by the spar
        // query (call 0) appear verbatim as $sparSessions on the invocation
        // query (call 1). On the live DB this is what drops spar invocations.
        const sparRid = new RecordId("session", "spar-variant");
        const db = makeMockDb([[[sparRid]], mockInvRows, mockRoleRows, mockDoctorBelow]);
        await runWithMock(db, fetchSkillsWeighted());
        const invCall = db.calls[1];
        const bound = invCall?.bindings?.sparSessions as unknown[];
        expect(bound.some((b) => b instanceof RecordId && String(b) === "session:⟨spar-variant⟩")).toBe(true);
    });
});
