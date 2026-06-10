import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { makeTestSurrealClient, type TestSurrealRows } from "@ax/lib/testing/surreal";
import {
    UNUSED_RECENT_SQL,
    UNUSED_SUMMARY_SQL,
    UNUSED_SKILL_ROWS_SQL,
    UNUSED_NEVER_INVOKED_SQL,
    normalizeLastUsed,
    mergeUnusedRows,
    fetchUnusedSkills,
} from "./unused-skills.ts";

function makeMockDb(responses: Array<unknown>): SurrealClientShape {
    return makeTestSurrealClient({
        responses: responses as ReadonlyArray<TestSurrealRows>,
    }).client;
}

const runWithMock = <A>(
    db: SurrealClientShape,
    effect: Effect.Effect<A, unknown, SurrealClient>,
): Promise<A> =>
    Effect.runPromise(effect.pipe(Effect.provideService(SurrealClient, db)));

describe("unused-skills SQL", () => {
    test("recent scan splices a validated day window and groups by out", () => {
        const sql = UNUSED_RECENT_SQL(7);
        expect(sql).toContain("time::now() - 7d");
        expect(sql).toContain("GROUP BY out");
        expect(sql).toContain("FROM invoked");
    });

    test("recent scan rejects non-positive / non-integer day windows", () => {
        expect(() => UNUSED_RECENT_SQL(0)).toThrow(RangeError);
        expect(() => UNUSED_RECENT_SQL(-3)).toThrow(RangeError);
        expect(() => UNUSED_RECENT_SQL(1.5)).toThrow(RangeError);
    });

    test("summary aggregates over the edge table only (issue #34)", () => {
        expect(UNUSED_SUMMARY_SQL).toContain("GROUP BY out");
        expect(UNUSED_SUMMARY_SQL).not.toContain("out.name");
    });

    test("never-invoked scan excludes tombstoned skills", () => {
        expect(UNUSED_NEVER_INVOKED_SQL).toContain("array::len(<-invoked) = 0");
        expect(UNUSED_NEVER_INVOKED_SQL).toContain("deleted_at IS NONE");
    });

    test("skill rows query is a cheap projection", () => {
        expect(UNUSED_SKILL_ROWS_SQL).toContain("SELECT id, name, scope FROM skill");
    });
});

describe("normalizeLastUsed", () => {
    test("null / -Infinity (empty math::max group) → null", () => {
        expect(normalizeLastUsed(null)).toBeNull();
        expect(normalizeLastUsed(undefined)).toBeNull();
        expect(normalizeLastUsed(Number.NEGATIVE_INFINITY)).toBeNull();
    });
    test("string passthrough, Date → ISO", () => {
        expect(normalizeLastUsed("2026-06-01T00:00:00.000Z")).toBe("2026-06-01T00:00:00.000Z");
        expect(normalizeLastUsed(new Date("2026-06-01T00:00:00.000Z"))).toBe("2026-06-01T00:00:00.000Z");
    });
    test("toJSON objects (SurrealDB DateTime) → ISO", () => {
        expect(normalizeLastUsed({ toJSON: () => "2026-06-01T00:00:00.000Z" })).toBe(
            "2026-06-01T00:00:00.000Z",
        );
    });
    test("junk objects / non-datetime values → null (never '[object Object]')", () => {
        expect(normalizeLastUsed({})).toBeNull();
        expect(normalizeLastUsed({ foo: 1 })).toBeNull();
        expect(normalizeLastUsed({ toJSON: () => 42 })).toBeNull();
        expect(normalizeLastUsed(12345)).toBeNull();
        expect(normalizeLastUsed(true)).toBeNull();
    });
});

describe("mergeUnusedRows", () => {
    const skills = [
        { id: "skill:a", name: "alpha", scope: "user" },
        { id: "skill:b", name: "beta", scope: "plugin" },
        { id: "skill:c", name: "gamma", scope: "user" },
    ];

    test("anti-joins recent-active skills out and sorts by total then name", () => {
        const rows = mergeUnusedRows({
            recent: [{ skill_id: "skill:a" }],
            summary: [
                { skill_id: "skill:a", total_inv: 50, last_used: "2026-06-09T00:00:00.000Z" },
                { skill_id: "skill:b", total_inv: 9, last_used: "2026-04-01T00:00:00.000Z" },
                { skill_id: "skill:c", total_inv: 2, last_used: "2026-03-01T00:00:00.000Z" },
            ],
            skills,
            neverInvoked: [],
        });
        expect(rows.map((r) => r.name)).toEqual(["gamma", "beta"]);
        expect(rows[0]!.last_used).toBe("2026-03-01T00:00:00.000Z");
    });

    test("drops orphan invocation groups whose skill row is missing", () => {
        const rows = mergeUnusedRows({
            recent: [],
            summary: [{ skill_id: "skill:ghost", total_inv: 4, last_used: null }],
            skills,
            neverInvoked: [],
        });
        expect(rows).toEqual([]);
    });

    test("appends never-invoked skills with zero totals and null last_used", () => {
        const rows = mergeUnusedRows({
            recent: [],
            summary: [],
            skills,
            neverInvoked: [{ name: "delta", scope: "user" }],
        });
        expect(rows).toEqual([
            { name: "delta", scope: "user", total_inv: 0, last_used: null },
        ]);
    });
});

describe("fetchUnusedSkills", () => {
    test("runs the 4 scans and merges", async () => {
        const db = makeMockDb([
            [[{ skill_id: "skill:a", recent: 3 }]],                                            // recent
            [[
                { skill_id: "skill:a", total_inv: 50, last_used: "2026-06-09T00:00:00.000Z" },
                { skill_id: "skill:b", total_inv: 9, last_used: "2026-04-01T00:00:00.000Z" },
            ]],                                                                                 // summary
            [[
                { id: "skill:a", name: "alpha", scope: "user" },
                { id: "skill:b", name: "beta", scope: "plugin" },
            ]],                                                                                 // skill rows
            [[{ name: "delta", scope: "user" }]],                                               // never invoked
        ]);
        const rows = await runWithMock(db, fetchUnusedSkills({ days: 7 }));
        expect(rows.map((r) => r.name)).toEqual(["delta", "beta"]);
        expect(rows[0]).toEqual({ name: "delta", scope: "user", total_inv: 0, last_used: null });
    });
});
