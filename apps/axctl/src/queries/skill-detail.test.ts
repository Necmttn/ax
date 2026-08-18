import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { publishCacheFixture, readFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import {
    fetchSkillDetail,
    mapSkillPairRow,
    mapSkillProposalRow,
    mapSkillRecentRow,
} from "./skill-detail.ts";

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

// ---------------------------------------------------------------------------
// fetchSkillDetail over a real published DuckDB snapshot
// ---------------------------------------------------------------------------

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("skill detail", { requireFts: true });

const SESSION = "019e2531-b552-7b53-a029-c780adbb6560";
const TURN = "019e2531-b552-7b53-a029-c780adbb6561";
const TDD_ID = "skill:tdd";
const CAVEMAN_ID = "skill:caveman";

// d7/d30 windows are relative to the real clock, so fixture timestamps must
// be relative too (a fixed past date silently falls outside the window).
const hoursAgo = (h: number): Date => new Date(Date.now() - h * 60 * 60 * 1000);
const INVOKED_RECENT_TS = hoursAgo(1);
const INVOKED_CORRECTED_TS = hoursAgo(2);
const PROPOSED_TS = hoursAgo(3);
const PAIRED_LAST_SEEN = hoursAgo(2);

const seedTddWithEvidence = (write: Parameters<Parameters<typeof publishCacheFixture>[2]>[0]) =>
    Effect.gen(function* () {
        yield* write.put("session", { id: SESSION, project: "-Users-necmttn-Projects-ax", source: "claude" });
        yield* write.put("turn", {
            id: TURN, session: SESSION, seq: 1n, ts: hoursAgo(5), role: "assistant",
        });
        yield* write.put("skill", {
            id: TDD_ID, name: "tdd", scope: "plugin", dir_path: "/tmp/tdd", description: "d",
            content_hash: "h1",
        });
        yield* write.put("skill", {
            id: CAVEMAN_ID, name: "caveman", scope: "user", dir_path: "/tmp/caveman", description: null,
            content_hash: "h2",
        });
        // Two invocations: one plain (recent), one corrected.
        yield* write.put("invoked", {
            id: "invoked:1", in_id: TURN, out_id: TDD_ID, ts: INVOKED_RECENT_TS,
            session: SESSION, turn_has_error: false, was_corrected: false,
        });
        yield* write.put("invoked", {
            id: "invoked:2", in_id: TURN, out_id: TDD_ID, ts: INVOKED_CORRECTED_TS,
            session: SESSION, turn_has_error: true, was_corrected: true,
        });
        yield* write.put("proposed", {
            id: "proposed:1", in_id: TURN, out_id: TDD_ID, ts: PROPOSED_TS,
            context_excerpt: "e",
        });
        yield* write.put("skill_paired", {
            id: "skill_paired:1", in_id: TDD_ID, out_id: CAVEMAN_ID, count: 3n,
            last_seen: PAIRED_LAST_SEEN,
        });
    });

describe("fetchSkillDetail", () => {
    dtest("assembles the full detail payload (invocations, recent, corrections, proposals, paired)", async () => {
        const dir = tempDir("skill-detail");
        const fixture = await runWithPlatform(publishCacheFixture(dir, dylibPath, seedTddWithEvidence));
        const layer = readFixture(fixture.snapshotPath, dylibPath);

        const result = await Effect.runPromise(fetchSkillDetail("tdd").pipe(Effect.provide(layer)));

        expect(result.name).toBe("tdd");
        expect(result.scope).toBe("plugin");
        expect(result.description).toBe("d");
        expect(result.dir_path).toBe("/tmp/tdd");
        expect(result.invocations.total).toBe(2);
        expect(result.invocations.d7).toBe(2);
        expect(result.invocations.d30).toBe(2);
        expect(result.invocations.last).toBe(INVOKED_RECENT_TS.toISOString());
        // Both invocations land in `recent`; only the corrected one in `corrections`.
        expect(result.recent).toHaveLength(2);
        expect(result.corrections).toHaveLength(1);
        expect(result.proposals).toHaveLength(1);
        expect(result.proposals[0]!.context_excerpt).toBe("e");
        expect(result.paired).toHaveLength(1);
        expect(result.paired[0]!.partner).toBe("caveman");
        expect(result.paired[0]!.count).toBe(3);
    });

    dtest("degrades to an empty payload when the skill row is missing", async () => {
        const dir = tempDir("skill-detail-missing");
        const fixture = await runWithPlatform(publishCacheFixture(dir, dylibPath, () => Effect.void));
        const layer = readFixture(fixture.snapshotPath, dylibPath);

        const result = await Effect.runPromise(fetchSkillDetail("ghost").pipe(Effect.provide(layer)));
        expect(result.scope).toBeNull();
        expect(result.invocations.total).toBe(0);
        expect(result.recent).toEqual([]);
        expect(result.paired).toEqual([]);
    });
});
