import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { publishCacheFixture, readFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import {
    SKILL_STATS_SQL,
    dedupeRecentSessions,
    fetchSkillStats,
} from "./skill-stats.ts";

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

// ---------------------------------------------------------------------------
// fetchSkillStats over a real published DuckDB snapshot
// ---------------------------------------------------------------------------

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("skill stats", { requireFts: true });

const SESSION = "019e2531-b552-7b53-a029-c780adbb6560";
const TURN = "019e2531-b552-7b53-a029-c780adbb6561";
const TDD_ID = "skill:tdd";

// d7/d30/d90 windows are relative to the real clock.
const hoursAgo = (h: number): Date => new Date(Date.now() - h * 60 * 60 * 1000);
const INVOKED_TS = hoursAgo(1);

const seedTddInvocations = (write: Parameters<Parameters<typeof publishCacheFixture>[2]>[0]) =>
    Effect.gen(function* () {
        yield* write.put("session", { id: SESSION, project: "-p-ax", cwd: "/p/ax", source: "claude" });
        yield* write.put("turn", { id: TURN, session: SESSION, seq: 1n, ts: hoursAgo(2), role: "assistant" });
        yield* write.put("skill", {
            id: TDD_ID, name: "tdd", scope: "plugin", dir_path: "/tmp/tdd", description: null,
            content_hash: "h1",
        });
        // Same session invoked twice - recent_sessions must dedupe to one entry.
        yield* write.put("invoked", {
            id: "invoked:1", in_id: TURN, out_id: TDD_ID, ts: INVOKED_TS, session: SESSION,
            turn_has_error: false, was_corrected: false,
        });
        yield* write.put("invoked", {
            id: "invoked:2", in_id: TURN, out_id: TDD_ID, ts: hoursAgo(3), session: SESSION,
            turn_has_error: false, was_corrected: false,
        });
    });

describe("fetchSkillStats", () => {
    dtest("assembles invocation counts + deduped recent sessions", async () => {
        const dir = tempDir("skill-stats");
        const fixture = await runWithPlatform(publishCacheFixture(dir, dylibPath, seedTddInvocations));
        const layer = readFixture(fixture.snapshotPath, dylibPath);

        const result = await Effect.runPromise(fetchSkillStats("tdd").pipe(Effect.provide(layer)));

        expect(result.skill?.name).toBe("tdd");
        expect(result.invocations).toEqual({
            total: 2, d7: 2, d30: 2, d90: 2, last: INVOKED_TS.toISOString(),
        });
        // Both invocations share one session - dedupeRecentSessions caps it to one.
        expect(result.recent_sessions).toEqual([{ project: "ax", ts: INVOKED_TS.toISOString() }]);
    });

    dtest("missing skill yields null skill and zeroed invocations", async () => {
        // `skill === null` doubles as the existence signal: cmdStats folds
        // its unknown-skill error onto this instead of a separate
        // skillExists roundtrip.
        const dir = tempDir("skill-stats-missing");
        const fixture = await runWithPlatform(publishCacheFixture(dir, dylibPath, () => Effect.void));
        const layer = readFixture(fixture.snapshotPath, dylibPath);

        const result = await Effect.runPromise(fetchSkillStats("ghost").pipe(Effect.provide(layer)));
        expect(result.skill).toBeNull();
        expect(result.invocations.total).toBe(0);
        expect(result.recent_sessions).toEqual([]);
    });
});
