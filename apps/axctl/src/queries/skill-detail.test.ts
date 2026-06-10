import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import {
    SKILL_DETAIL_SQL,
    fetchSkillDetail,
    mapSkillPairRow,
    mapSkillProposalRow,
    mapSkillRecentRow,
} from "./skill-detail.ts";
import { SKILL_DETAIL_SQL as TUI_SKILL_DETAIL_SQL } from "../tui/queries.ts";

/** Mock SurrealClientShape returning canned responses per query() call,
 *  copied from dashboard/skills-weighted.test.ts. */
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

const runWithMock = <A>(
    db: SurrealClientShape,
    effect: Effect.Effect<A, unknown, SurrealClient>,
): Promise<A> =>
    Effect.runPromise(effect.pipe(Effect.provideService(SurrealClient, db)));

describe("SKILL_DETAIL_SQL", () => {
    test("binds the skill by $name", () => {
        expect(SKILL_DETAIL_SQL).toContain("WHERE name = $name");
    });

    test("includes the TUI daily buckets (last 30 days, ascending)", () => {
        expect(SKILL_DETAIL_SQL).toContain("daily:");
        expect(SKILL_DETAIL_SQL).toMatch(
            /daily:\s*\(\s*SELECT ts FROM invoked\s*WHERE out = \$s\.id AND ts > time::now\(\) - 30d\s*ORDER BY ts ASC\s*\)/,
        );
    });

    test("includes the dashboard evidence blocks", () => {
        expect(SKILL_DETAIL_SQL).toContain("corrections:");
        expect(SKILL_DETAIL_SQL).toContain("proposals:");
        expect(SKILL_DETAIL_SQL).toContain("paired:");
        expect(SKILL_DETAIL_SQL).toContain("turn_has_error");
    });

    test("TUI re-exports the canonical SQL (no fork)", () => {
        expect(TUI_SKILL_DETAIL_SQL).toBe(SKILL_DETAIL_SQL);
    });
});

describe("skill-detail row mappers", () => {
    test("mapSkillRecentRow keeps ts/project and optional turn_has_error", () => {
        expect(
            mapSkillRecentRow({
                ts: "2026-06-01T00:00:00.000Z",
                project: "-Users-necmttn-Projects-ax",
                turn_has_error: true,
            }),
        ).toEqual({
            ts: "2026-06-01T00:00:00.000Z",
            project: "-Users-necmttn-Projects-ax",
            turn_has_error: true,
        });
        expect(mapSkillRecentRow({ project: "x" })).toBeNull(); // no ts
        expect(mapSkillRecentRow(null)).toBeNull();
    });

    test("mapSkillPairRow requires a partner", () => {
        expect(
            mapSkillPairRow({ partner: "tdd", count: 4, last_seen: "2026-06-01T00:00:00.000Z" }),
        ).toEqual({ partner: "tdd", count: 4, last_seen: "2026-06-01T00:00:00.000Z" });
        expect(mapSkillPairRow({ count: 4 })).toBeNull();
    });

    test("mapSkillProposalRow requires ts", () => {
        expect(
            mapSkillProposalRow({ ts: "2026-06-01T00:00:00.000Z", project: null, context_excerpt: "..." }),
        ).toEqual({ ts: "2026-06-01T00:00:00.000Z", project: null, context_excerpt: "..." });
        expect(mapSkillProposalRow({ project: "x" })).toBeNull();
    });
});

describe("fetchSkillDetail", () => {
    test("parses the RETURN block (last non-null statement result)", async () => {
        // db.query returns one entry per statement: LET → null, RETURN → payload.
        const payload = {
            skill: { name: "tdd", scope: "plugin", description: "d", dir_path: "/tmp/tdd" },
            invocations: { total: 12, d7: 2, d30: 9, last: "2026-06-09T00:00:00.000Z" },
            recent: [{ ts: "2026-06-09T00:00:00.000Z", project: "p", turn_has_error: false }],
            corrections: [],
            proposals: [{ ts: "2026-06-01T00:00:00.000Z", project: "p", context_excerpt: "e" }],
            paired: [{ partner: "caveman", count: 3, last_seen: "2026-06-08T00:00:00.000Z" }],
        };
        const db = makeMockDb([[null, payload]]);
        const result = await runWithMock(db, fetchSkillDetail("tdd"));

        expect(result.name).toBe("tdd");
        expect(result.scope).toBe("plugin");
        expect(result.invocations).toEqual({
            total: 12, d7: 2, d30: 9, last: "2026-06-09T00:00:00.000Z",
        });
        expect(result.recent).toHaveLength(1);
        expect(result.proposals).toHaveLength(1);
        expect(result.paired[0]!.partner).toBe("caveman");
    });

    test("degrades to empty payload when the skill row is missing", async () => {
        const db = makeMockDb([[null, { skill: null, invocations: {}, recent: [], corrections: [], proposals: [], paired: [] }]]);
        const result = await runWithMock(db, fetchSkillDetail("ghost"));
        expect(result.scope).toBeNull();
        expect(result.invocations.total).toBe(0);
        expect(result.recent).toEqual([]);
    });
});
