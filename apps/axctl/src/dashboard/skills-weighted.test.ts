/**
 * P3.6 tests: fetchSkillsWeighted data layer.
 *
 * Uses the shared mock SurrealClient factory (sequenced responses) to assert:
 * - The invocation query includes/omits a WHERE window clause.
 * - Rows are merged correctly (role weights summed, floor 1.0).
 * - Doctor count and advice trigger at the threshold.
 * - Spar sessions are excluded from the weighted ranking.
 * - Recovery latency (lens E): median_recovery_ms from recovered_by edges.
 *
 * Query order (call index):
 *   0 → fetchSparSessionIds (spar exclusion ids)
 *   1 → invocation aggregate (pass 1)
 * Role weights and spar labels come from the judgment test service.
 *   1 → doctor query
 *   2 → deleted skill ids
 *   3 → synthetic skill ids
 *   4 → skill names
 *   5 → recovered_by edges (skill → session mapping)
 * Recovery latency comes from the DuckDB cache, not a positional response.
 */
import { describe, it, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { RecordId } from "surrealdb";
import { makeMockDb as makeSurrealMockDb, type TestSurrealClient } from "@ax/lib/testing/surreal";
import { cacheReadTestLayer, judgmentTestLayer } from "../testing/judgment-test-layer.ts";
import type { SurrealClient } from "@ax/lib/db";
import type { CacheRead } from "@ax/lib/duckdb/seam";
import type { Judgment } from "@ax/lib/sqlite";
import { buildInvocationSql, fetchSkillsWeighted } from "./skills-weighted.ts";

/**
 * The doctor count delegates to `fetchSkillHygiene`, whose counts + catalog now
 * come from the CACHE, not from a SurrealQL statement. So the fixture at index 1
 * of every response list is peeled off here and handed to a `CacheRead` stub -
 * which also keeps the remaining positional Surreal responses aligned with the
 * calls that are still SurrealQL.
 */
const hygieneByDb = new WeakMap<TestSurrealClient, ReadonlyArray<ReadonlyArray<unknown>>>();

const makeMockDb = (responses: ReadonlyArray<ReadonlyArray<unknown>> = []) => {
    const [inv, hygiene, ...rest] = responses;
    const db = makeSurrealMockDb(
        (inv === undefined ? [] : [inv, ...rest]) as never,
    );
    const pair = (hygiene ?? []) as ReadonlyArray<ReadonlyArray<Record<string, unknown>>>;
    const counts = pair[0] ?? [];
    const skills = pair[1] ?? [];
    // The stub answers the seam directly (no schema decode), so these are the
    // DECODED row shapes - plain numbers, not the BIGINTs DuckDB would return.
    hygieneByDb.set(db, [counts, skills.map((sk) => ({ content_hash: null, ...sk }))]);
    return db;
};

const runWithMock = <A, E>(
    db: TestSurrealClient,
    effect: Effect.Effect<A, E, SurrealClient | Judgment | CacheRead>,
    sparSessions: readonly string[] = [],
    // Recovery latency now comes from the published DuckDB cache
    // (`sessionTelemetryLatency` reads `otel_log_event` through `CacheRead`),
    // NOT from a positional SurrealDB response - hence its own stub here.
    latencyRows: ReadonlyArray<Record<string, unknown>> = [],
) => Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(
    db.layer,
    judgmentTestLayer((sql) => {
        if (sql.includes("FROM session_label")) return sparSessions.map((session_id) => ({ session_id }));
        if (sql.includes("JOIN role")) return mockRoleRows[0];
        return [];
    }),
    // ONE cache stub answers every `CacheRead` on this path, dispatched by SQL
    // text rather than call order: two of the three reads are the hygiene pair
    // (`invoked` counts + the `skill` catalog) this chunk ported, the third is
    // the telemetry latency the live-reads chunk moved onto the cache. A
    // positional stub cannot serve both - the two features interleave.
    cacheReadTestLayer((sql) => {
        if (sql.includes("otel_log_event")) return latencyRows;
        const [counts, skills] = hygieneByDb.get(db) ?? [[], []];
        if (sql.includes("FROM invoked")) return counts as ReadonlyArray<Record<string, unknown>>;
        if (sql.includes("FROM skill")) return skills as ReadonlyArray<Record<string, unknown>>;
        return [];
    }),
))));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Empty spar-session result - prepend to every positional response list. */

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

// The doctor count now delegates to fetchSkillHygiene (#481), whose graph query
// returns invocation counts and skill rows. Role decisions come from SQLite.
// Build N distinct unclassified skills (≥3 invocations, real dir_path, unique
// content_hash, none classified) so the hygiene join yields exactly N rows.
function hygieneResp(n: number): unknown[] {
    const counts = Array.from({ length: n }, (_, i) => ({ sid: `skill:u${i}`, invocations: 5, sessions: 4 }));
    const skills = Array.from({ length: n }, (_, i) => ({ id: `skill:u${i}`, name: `u${i}`, dir_path: "/skills", content_hash: `h${i}` }));
    return [counts, skills];
}

// doctor response - 3 unclassified (below threshold=5)
const mockDoctorBelow = hygieneResp(3);

// doctor response - 7 unclassified (above threshold=5)
const mockDoctorAbove = hygieneResp(7);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fetchSkillsWeighted", () => {
    it("returns rows sorted by score DESC", async () => {
        const db = makeMockDb([mockInvRows, mockDoctorBelow]);
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
        const db = makeMockDb([mockInvRows, mockDoctorBelow]);
        const result = await runWithMock(db, fetchSkillsWeighted());

        const tdd = result.rows.find((r) => r.skill_name === "superpowers:tdd")!;
        expect(tdd.weight).toBe(2.0);
        expect(tdd.roles).toEqual(["framing", "execution"]);
    });

    it("gives unclassified skills weight 1.0", async () => {
        const db = makeMockDb([mockInvRows, mockDoctorBelow]);
        const result = await runWithMock(db, fetchSkillsWeighted());

        const worktree = result.rows.find((r) => r.skill_name === "worktree-read-strategy")!;
        expect(worktree.weight).toBe(1.0);
        expect(worktree.roles).toEqual([]);
    });

    it("respects limit param", async () => {
        const db = makeMockDb([mockInvRows, mockDoctorBelow]);
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
            invWithTool, mockDoctorBelow, [[]], synthIds, nameRows,
        ]);
        const result = await runWithMock(db, fetchSkillsWeighted());

        expect(result.rows.map((r) => r.skill_name)).toEqual(["simplify"]);
        expect(result.rows.some((r) => r.skill_name === "codex:exec_command")).toBe(false);
    });

    it("includeTools=true keeps tools in the ranking", async () => {
        const db = makeMockDb([
            invWithTool, mockDoctorBelow, [[]], synthIds, nameRows,
        ]);

        const result = await runWithMock(db, fetchSkillsWeighted({ includeTools: true }));

        // Tool is ranked (and named) when opted in.
        expect(result.rows[0]!.skill_name).toBe("codex:exec_command");
    });

    it("doctor count excludes synthetic provider tools by default (#481)", async () => {
        // Doctor delegates to fetchSkillHygiene, which drops synthetic skills
        // (dir_path == "(synthetic)") in JS rather than via a doctor-SQL clause.
        const counts = [
            { sid: "skill:real", invocations: 5, sessions: 4 },
            { sid: "skill:synthtool", invocations: 9, sessions: 6 },
        ];
        const skills = [
            { id: "skill:real", name: "real", dir_path: "/skills", content_hash: "h1" },
            { id: "skill:synthtool", name: "tool", dir_path: "(synthetic)", content_hash: "h2" },
        ];
        const db = makeMockDb([mockInvRows, [counts, skills]]);
        const result = await runWithMock(db, fetchSkillsWeighted());
        // Only the real unclassified skill counts; the synthetic tool is excluded.
        expect(result.doctor.unclassified_count).toBe(1);
    });

    it("includeTools=true counts synthetic tools in the doctor count (#481)", async () => {
        // Mirrors the exclusion test, but opts in: includeTools must thread to
        // hygiene's includeSynthetic so the synthetic tool is now counted too.
        const counts = [
            { sid: "skill:real", invocations: 5, sessions: 4 },
            { sid: "skill:synthtool", invocations: 9, sessions: 6 },
        ];
        const skills = [
            { id: "skill:real", name: "real", dir_path: "/skills", content_hash: "h1" },
            { id: "skill:synthtool", name: "tool", dir_path: "(synthetic)", content_hash: "h2" },
        ];
        const db = makeMockDb([mockInvRows, [counts, skills]]);
        const result = await runWithMock(db, fetchSkillsWeighted({ includeTools: true }));
        expect(result.doctor.unclassified_count).toBe(2);
    });

    // The previous versions of these two cases ran the full effect through the
    // mock and asserted on `db.captured[0]` - a SQL-text assertion on a string
    // the mock never executes, so it could not tell a correct window filter
    // from a typo'd one (the same class of bug the CURRENT_TIMESTAMP fix above
    // survived two sibling chunks' green suites by hiding behind). The real
    // fix - asserting through a real database - is not available here:
    // `fetchSkillsWeighted` is still SurrealClient-backed (it depends on
    // `queries/telemetry-rollup.ts`, a `w2-live-reads` module that has not
    // landed yet), so there is no DuckDB fixture to route this through, and
    // porting the source is explicitly out of this task's scope. Instead,
    // `buildInvocationSql` - the pure function that actually decides the
    // clause - is exported and asserted on DIRECTLY, which is a real
    // assertion on the thing that produces the behavior rather than an
    // inference through an unexecuted mock capture.
    it("buildInvocationSql includes the window clause when windowDays is set", () => {
        expect(buildInvocationSql(30)).toContain("ts >= time::now() - 30d");
    });

    it("buildInvocationSql omits the window clause when windowDays is undefined", () => {
        expect(buildInvocationSql(undefined)).not.toContain("ts >= time::now()");
    });

    it("buildInvocationSql omits the window clause when windowDays is 0 or negative", () => {
        // The source guards on `windowDays > 0`; a 0 or negative value must
        // fall through the same as `undefined`, not emit `- 0d` / `- -5d`.
        expect(buildInvocationSql(0)).not.toContain("ts >= time::now()");
        expect(buildInvocationSql(-5)).not.toContain("ts >= time::now()");
    });

    it("doctor: no advice when count < threshold", async () => {
        const db = makeMockDb([mockInvRows, mockDoctorBelow]);
        const result = await runWithMock(db, fetchSkillsWeighted({ doctorThreshold: 5 }));
        expect(result.doctor.advice).toBeNull();
        expect(result.doctor.unclassified_count).toBe(3);
    });

    it("doctor: advice present when count >= threshold", async () => {
        const db = makeMockDb([mockInvRows, mockDoctorAbove]);
        const result = await runWithMock(db, fetchSkillsWeighted({ doctorThreshold: 5 }));
        expect(result.doctor.advice).not.toBeNull();
        expect(result.doctor.advice).toContain("axctl skills classify");
        expect(result.doctor.unclassified_count).toBe(7);
    });

    it("handles empty invocation result gracefully", async () => {
        const db = makeMockDb([[[]], hygieneResp(0)]);
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
        expect(db.captured[0]).toContain("session NOT IN $sparSessions");
    });

    it("binds $sparSessions as RecordId values (record-typed, not strings)", async () => {
        // Spar query (index 0) returns raw RecordIds via SELECT VALUE id; assert
        // they are passed through to the invocation call's binding unchanged and
        // are RecordId instances - the only form NOT IN actually evaluates.
        const db = makeMockDb([mockInvRows, mockDoctorBelow]);
        await runWithMock(db, fetchSkillsWeighted(), ["spar-abc"]);
        const invCall = db.calls[0];
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
        const db = makeMockDb([mockInvRows, mockDoctorBelow]);
        await runWithMock(db, fetchSkillsWeighted(), ["spar-variant"]);
        const invCall = db.calls[0];
        const bound = invCall?.bindings?.sparSessions as unknown[];
        expect(bound.some((b) => b instanceof RecordId && String(b) === "session:⟨spar-variant⟩")).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Recovery latency (lens E)
// ---------------------------------------------------------------------------

describe("recovery latency (lens E)", () => {
    // recovered_by edges: tdd recovered 2 sessions; caveman has none.
    const mockRecoveryEdges = [
        [
            { skill: "skill:⟨superpowers:tdd⟩", session: "session:sess-abc" },
            { skill: "skill:⟨superpowers:tdd⟩", session: "session:sess-def" },
        ],
    ];

    // otel_log_event latency for the two recovery sessions
    const mockLatencyRows = [
        [
            { session_id: "sess-abc", d: 4000, n: 5 },
            { session_id: "sess-def", d: 6000, n: 8 },
        ],
    ];

    it("computes median_recovery_ms as median of recovery session durations", async () => {
        const db = makeMockDb([
            mockInvRows,       // 1 - invocation aggregate
            mockDoctorBelow,   // 2 - doctor
            [[]],              // 3 - deleted
            [[]],              // 4 - synthetic
            [[]],              // 5 - names
            mockRecoveryEdges, // 6 - recovered_by
        ]);

        const result = await runWithMock(db, fetchSkillsWeighted(), [], mockLatencyRows[0]!);
        const tdd = result.rows.find((r) => r.skill_name === "superpowers:tdd")!;

        // median of [4000, 6000] (sorted) = (4000+6000)/2 = 5000
        expect(tdd.median_recovery_ms).toBe(5000);
    });

    it("sets median_recovery_ms=null for skills with no recovery edges", async () => {
        const db = makeMockDb([
            mockInvRows,
            mockDoctorBelow,
            [[]],
            [[]],
            [[]],
            mockRecoveryEdges, // only tdd in edges; caveman absent
        ]);

        const result = await runWithMock(db, fetchSkillsWeighted(), [], mockLatencyRows[0]!);
        const caveman = result.rows.find((r) => r.skill_name === "caveman")!;

        expect(caveman.median_recovery_ms).toBeNull();
    });

    it("sets median_recovery_ms=null for all rows when no recovery edges exist", async () => {
        const db = makeMockDb([
            mockInvRows,
            mockDoctorBelow,
            [[]],
            [[]],
            [[]],
            [[]], // empty recovered_by - sessionTelemetryLatency exits early
        ]);

        const result = await runWithMock(db, fetchSkillsWeighted());

        for (const row of result.rows) {
            expect(row.median_recovery_ms).toBeNull();
        }
    });

    it("recovered_by is issued as its own SurrealQL pass", async () => {
        const db = makeMockDb([
            mockInvRows,
            mockDoctorBelow,
        ]);

        await runWithMock(db, fetchSkillsWeighted());

        // Asserted by CONTENT, not by call index: the doctor count and the role
        // weights have both left the SurrealQL path (cache and sidecar), so a
        // pinned index only records how many passes happen to precede it today.
        expect(db.captured.filter((sql) => sql.includes("recovered_by"))).toHaveLength(1);
    });

    it("single recovery session: median_recovery_ms equals its duration", async () => {
        const singleEdge = [[{ skill: "skill:⟨superpowers:tdd⟩", session: "session:only-one" }]];
        const singleLatency = [[{ session_id: "only-one", d: 3750, n: 2 }]];

        const db = makeMockDb([
            mockInvRows,
            mockDoctorBelow,
            [[]],
            [[]],
            [[]],
            singleEdge,
        ]);

        const result = await runWithMock(db, fetchSkillsWeighted(), [], singleLatency[0]!);
        const tdd = result.rows.find((r) => r.skill_name === "superpowers:tdd")!;

        expect(tdd.median_recovery_ms).toBe(3750);
    });

    it("sessions with no telemetry data do not contribute to median", async () => {
        // 3 edges for tdd; only 2 have latency data
        const edges = [[
            { skill: "skill:⟨superpowers:tdd⟩", session: "session:s1" },
            { skill: "skill:⟨superpowers:tdd⟩", session: "session:s2" },
            { skill: "skill:⟨superpowers:tdd⟩", session: "session:s3-no-telemetry" },
        ]];
        // s3-no-telemetry is absent from otel_log_event
        const latency = [[
            { session_id: "s1", d: 1000, n: 1 },
            { session_id: "s2", d: 3000, n: 3 },
        ]];

        const db = makeMockDb([
            mockInvRows,
            mockDoctorBelow,
            [[]],
            [[]],
            [[]],
            edges,
        ]);

        const result = await runWithMock(db, fetchSkillsWeighted(), [], latency[0]!);
        const tdd = result.rows.find((r) => r.skill_name === "superpowers:tdd")!;

        // median of [1000, 3000] = 2000 (s3 absent → not counted)
        expect(tdd.median_recovery_ms).toBe(2000);
    });
});
