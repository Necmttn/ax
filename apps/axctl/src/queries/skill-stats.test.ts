import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { makeTestSurrealClient, type TestSurrealRows } from "@ax/lib/testing/surreal";
import {
    SKILL_STATS_SQL,
    dedupeRecentSessions,
    fetchSkillStats,
} from "./skill-stats.ts";

function makeMockDb(responses: Array<unknown>): SurrealClientShape {
    return makeTestSurrealClient({
        denyWrites: true,
        responses: responses as ReadonlyArray<TestSurrealRows>,
    }).client;
}

const runWithMock = <A>(
    db: SurrealClientShape,
    effect: Effect.Effect<A, unknown, SurrealClient>,
): Promise<A> =>
    Effect.runPromise(effect.pipe(Effect.provideService(SurrealClient, db)));

describe("SKILL_STATS_SQL", () => {
    test("binds by $name and covers 7/30/90d windows", () => {
        expect(SKILL_STATS_SQL).toContain("WHERE name = $name");
        expect(SKILL_STATS_SQL).toContain("time::now() - 7d");
        expect(SKILL_STATS_SQL).toContain("time::now() - 30d");
        expect(SKILL_STATS_SQL).toContain("time::now() - 90d");
    });

    test("recent sessions are ordered server-side and bounded", () => {
        expect(SKILL_STATS_SQL).toContain("ORDER BY ts DESC");
        expect(SKILL_STATS_SQL).toContain("LIMIT 50");
        expect(SKILL_STATS_SQL).toContain("in.session AS session_id");
        expect(SKILL_STATS_SQL).toContain("in.session.cwd AS cwd");
    });
});

describe("dedupeRecentSessions", () => {
    test("dedupes by session id and caps at 5", () => {
        const rows = Array.from({ length: 8 }, (_, i) => ({
            session_id: `session:s${i % 6}`, // s0..s5, s0/s1 repeat
            project_slug: "-Users-necmttn-Projects-ax",
            cwd: null,
            ts: `2026-06-0${(i % 6) + 1}T00:00:00.000Z`,
        }));
        const clean = dedupeRecentSessions(rows);
        expect(clean).toHaveLength(5);
        expect(new Set(clean.map((c) => c.ts)).size).toBe(5);
    });

    test("prefers cwd basename over project slug", () => {
        const clean = dedupeRecentSessions([
            {
                session_id: "session:a",
                project_slug: "-Users-necmttn-Projects-ax",
                cwd: "/Users/necmttn/Projects/ax",
                ts: "2026-06-01T00:00:00.000Z",
            },
        ]);
        expect(clean[0]!.project).toBe("ax");
    });

    test("unwraps array-valued cwd/slug projections", () => {
        const clean = dedupeRecentSessions([
            {
                session_id: "session:a",
                project_slug: ["-Users-necmttn-Projects-ax"],
                cwd: ["/Users/necmttn/Projects/ax"],
                ts: "2026-06-01T00:00:00.000Z",
            },
        ]);
        expect(clean[0]!.project).toBe("ax");
    });
});

describe("fetchSkillStats", () => {
    test("parses payload from the last non-null statement result", async () => {
        const payload = {
            skill: { name: "tdd", scope: "plugin", dir_path: "/tmp/tdd" },
            invocations: { total: 100, d7: 3, d30: 20, d90: 60, last: "2026-06-09T00:00:00.000Z" },
            recent_sessions: [
                { session_id: "session:a", project_slug: "-p-ax", cwd: "/p/ax", ts: "2026-06-09T00:00:00.000Z" },
                { session_id: "session:a", project_slug: "-p-ax", cwd: "/p/ax", ts: "2026-06-08T00:00:00.000Z" },
            ],
        };
        const db = makeMockDb([[null, payload]]);
        const result = await runWithMock(db, fetchSkillStats("tdd"));

        expect(result.skill?.name).toBe("tdd");
        expect(result.invocations).toEqual({
            total: 100, d7: 3, d30: 20, d90: 60, last: "2026-06-09T00:00:00.000Z",
        });
        expect(result.recent_sessions).toEqual([
            { project: "ax", ts: "2026-06-09T00:00:00.000Z" },
        ]);
    });

    test("missing skill yields null skill and zeroed invocations", async () => {
        const db = makeMockDb([[null, { skill: null, invocations: {}, recent_sessions: [] }]]);
        const result = await runWithMock(db, fetchSkillStats("ghost"));
        expect(result.skill).toBeNull();
        expect(result.invocations.total).toBe(0);
        expect(result.recent_sessions).toEqual([]);
    });
});
