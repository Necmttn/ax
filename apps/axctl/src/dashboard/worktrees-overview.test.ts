import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { publishCacheFixture, readThroughFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { fetchWorktreesOverview } from "./worktrees-overview.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("worktrees-overview", { requireFts: true });

const FIXTURE = (w: CacheWriteService) =>
    Effect.gen(function* () {
        yield* w.putMany("repository", [{ id: "r1", name: "ax" }]);
        yield* w.putMany("checkout", [
            { id: "a", repository: "r1", path: "/a", created_at: new Date("2026-01-01") },
            { id: "b", repository: "r1", path: "/b", created_at: new Date("2026-02-01") },
        ]);
        yield* w.putMany("session", [
            { id: "s1", checkout: "a", repository: "r1" },
            { id: "s2", checkout: "a", repository: "r1" },
            { id: "s3", checkout: null, repository: "r1" },
        ]);
        yield* w.putMany("turn", [
            { id: "t1", session: "s1", seq: 1, ts: new Date(), role: "user" },
            { id: "t2", session: "s1", seq: 2, ts: new Date(), role: "user" },
            { id: "t3", session: "s1", seq: 3, ts: new Date(), role: "user" },
            { id: "t4", session: "s1", seq: 4, ts: new Date(), role: "user" },
            { id: "t5", session: "s1", seq: 5, ts: new Date(), role: "user" },
            { id: "t6", session: "s1", seq: 6, ts: new Date(), role: "user" },
            { id: "t7", session: "s1", seq: 7, ts: new Date(), role: "user" },
            { id: "t8", session: "s1", seq: 8, ts: new Date(), role: "user" },
            { id: "t9", session: "s1", seq: 9, ts: new Date(), role: "user" },
            { id: "t10", session: "s1", seq: 10, ts: new Date(), role: "user" },
            { id: "t11", session: "s2", seq: 1, ts: new Date(), role: "user" },
            { id: "t12", session: "s2", seq: 2, ts: new Date(), role: "user" },
            { id: "t13", session: "s2", seq: 3, ts: new Date(), role: "user" },
            { id: "t14", session: "s2", seq: 4, ts: new Date(), role: "user" },
            { id: "t15", session: "s2", seq: 5, ts: new Date(), role: "user" },
        ]);
        // tool_call: s1 has 7 total, 2 with an error. s2 has 3 total, 0 errors.
        yield* w.putMany(
            "tool_call",
            Array.from({ length: 7 }, (_, i) => ({
                id: `tc-s1-${i}`,
                session: "s1",
                name: "Bash",
                ts: new Date(),
                has_error: i < 2,
            })).concat(
                Array.from({ length: 3 }, (_, i) => ({
                    id: `tc-s2-${i}`,
                    session: "s2",
                    name: "Bash",
                    ts: new Date(),
                    has_error: false,
                })),
            ),
        );
        yield* w.putMany("commit", [
            { id: "c1", sha: "c1", repo: "ax", ts: new Date(), repository: "r1" },
            { id: "c2", sha: "c2", repo: "ax", ts: new Date(), repository: "r1" },
        ]);
        // produced: s1 -> c1 (x4); commit -> checkout linkage rides on this
        // edge too (c1 -> checkout a). c2 has no produced edge (unproduced
        // commit whose touched edges still count for the repo).
        yield* w.putMany(
            "produced",
            Array.from({ length: 4 }, (_, i) => ({
                id: `p${i}`,
                in_id: "s1",
                out_id: "c1",
                checkout: "a",
                ts: new Date(),
            })),
        );
        yield* w.putMany(
            "touched",
            Array.from({ length: 9 }, (_, i) => ({ id: `to1-${i}`, in_id: "c1", out_id: `f${i}` })).concat(
                Array.from({ length: 2 }, (_, i) => ({ id: `to2-${i}`, in_id: "c2", out_id: `g${i}` })),
            ),
        );
    });

describe("fetchWorktreesOverview", () => {
    dtest("joins per-session aggregates up to checkouts and repositories", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-worktrees-overview-"), dylibPath, FIXTURE));
        const overview = await readThroughFixture(fixture, dylibPath, fetchWorktreesOverview(50));

        const a = overview.activity.find((c) => String(c.id) === "a");
        expect(a).toMatchObject({
            session_count: 2,
            turn_count: 15, // s1:10 + s2:5
            tool_call_count: 10, // s1:7 + s2:3
            tool_failure_count: 2, // s1:2
            produced_count: 4, // s1:4
            touched_count: 9,
        });
        const b = overview.activity.find((c) => String(c.id) === "b");
        expect(b).toMatchObject({ session_count: 0, turn_count: 0, touched_count: 0 });
        // Sort: active checkout first.
        expect(String(overview.activity[0]?.id)).toBe("a");

        const r1 = overview.git[0];
        expect(r1).toMatchObject({
            session_count: 3, // s1, s2, s3
            checkout_linked_session_count: 2, // s1, s2
            commit_count: 2,
            touched_count: 11, // c1:9 + c2:2 rolled up via commits
            produced_count: 4, // commit:c1's 4 edges
            checkout_count: 2,
        });
    });

    dtest("respects the row limit", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-worktrees-overview-limit-"), dylibPath, FIXTURE));
        const overview = await readThroughFixture(fixture, dylibPath, fetchWorktreesOverview(1));
        expect(overview.activity.length).toBe(1);
        expect(String(overview.activity[0]?.id)).toBe("a");
    });
});
