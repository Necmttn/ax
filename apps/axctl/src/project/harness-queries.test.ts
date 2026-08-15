/**
 * The two graph reads inside the project harness report, against a REAL cache.
 *
 * They are exported for this file alone. Both changed shape in the port - one
 * moved a `??` out of JS and into the GROUP BY, the other turned a Surreal
 * record deref into a JOIN - and both are the kind of change that produces a
 * plausible WRONG NUMBER rather than an error, which is precisely what a
 * SQL-text assertion cannot catch.
 */
import { describe, expect } from "bun:test";
import { Effect } from "effect";
import type { CacheRead } from "@ax/lib/duckdb/seam";
import { publishCacheFixture, readFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { fetchMainBranchGraphEvidence, fetchObservedTooling } from "./harness.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("project harness queries", {
    requireFts: true,
});

const recently = new Date(Date.now() - 60_000);
const longAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

const overCache = <A, E>(snapshotPath: string, effect: Effect.Effect<A, E, CacheRead>): Promise<A> =>
    Effect.runPromise(
        effect.pipe(Effect.provide(readFixture(snapshotPath, dylibPath))) as Effect.Effect<A, E>,
    );

describe("fetchObservedTooling", () => {
    dtest("groups by the normalized command, counting a tool ONCE", async () => {
        // The bug this pins: grouping by (command_norm, name) and collapsing to
        // `command_norm ?? name` afterwards splits one tool across two rows the
        // moment some of its calls normalized and others did not - and then
        // ranks the halves separately, so a heavily-used tool can fall out of
        // the top 25 entirely.
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-harness-tools-"), dylibPath, (w) =>
                Effect.gen(function* () {
                    yield* w.put("session", { id: "s1", project: "ax" });
                    yield* w.putMany("turn", [
                        { id: "t1", session: "s1", seq: 1n, role: "assistant", ts: recently },
                    ]);
                    yield* w.putMany("tool_call", [
                        { id: "c1", turn: "t1", session: "s1", seq: 1n, name: "Bash", command_norm: "rg", ts: recently },
                        { id: "c2", turn: "t1", session: "s1", seq: 2n, name: "Bash", command_norm: "rg", ts: recently },
                        { id: "c3", turn: "t1", session: "s1", seq: 3n, name: "Bash", command_norm: null, ts: recently },
                        { id: "c4", turn: "t1", session: "s1", seq: 4n, name: "Read", command_norm: null, ts: recently },
                        // Outside the 30-day window.
                        { id: "c5", turn: "t1", session: "s1", seq: 5n, name: "Read", command_norm: null, ts: longAgo },
                    ]);
                }),
            ),
        );

        const signals = await overCache(fixture.snapshotPath, fetchObservedTooling());
        const byName = new Map(signals.map((s) => [s.name, s]));

        expect(byName.get("rg")?.evidence).toBe("2 observed calls in 30d");
        // "Bash" with no normalization is its own tool, counted once; the
        // 90-day-old Read call is not counted at all.
        expect(byName.get("Bash")?.evidence).toBe("1 observed calls in 30d");
        expect(byName.get("Read")?.evidence).toBe("1 observed calls in 30d");
        expect(byName.get("rg")?.layer).toBe("perception");
        expect(byName.get("rg")?.source).toBe("observed");
    });

    dtest("an empty cache yields no signals rather than failing", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-harness-tools-empty-"), dylibPath, () => Effect.void),
        );

        expect(await overCache(fixture.snapshotPath, fetchObservedTooling())).toEqual([]);
    });
});

describe("fetchMainBranchGraphEvidence", () => {
    dtest("counts only the edits and commits whose CHECKOUT is on the trunk", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-harness-main-"), dylibPath, (w) =>
                Effect.gen(function* () {
                    yield* w.put("repository", { id: "repo1", name: "ax" });
                    yield* w.putMany("checkout", [
                        { id: "co-main", repository: "repo1", path: "/w/ax", branch: "main" },
                        { id: "co-feat", repository: "repo1", path: "/w/ax-feat", branch: "feat/x" },
                    ]);
                    yield* w.putMany("edited", [
                        { id: "e1", in_id: "t1", out_id: "f1", tool: "Edit", ts: recently, checkout: "co-main", path_seen: "src/a.ts" },
                        { id: "e2", in_id: "t2", out_id: "f2", tool: "Edit", ts: new Date(Date.now() - 30_000), checkout: "co-main", path_seen: "src/newest.ts" },
                        { id: "e3", in_id: "t3", out_id: "f3", tool: "Edit", ts: recently, checkout: "co-feat", path_seen: "src/b.ts" },
                        // A dangling checkout ref must not be counted as trunk work.
                        { id: "e4", in_id: "t4", out_id: "f4", tool: "Edit", ts: recently, checkout: null, path_seen: "src/c.ts" },
                    ]);
                    yield* w.putMany("produced", [
                        { id: "p1", in_id: "s1", out_id: "c1", checkout: "co-main", ts: recently },
                        { id: "p2", in_id: "s1", out_id: "c2", checkout: "co-feat", ts: recently },
                    ]);
                }),
            ),
        );

        const evidence = await overCache(fixture.snapshotPath, fetchMainBranchGraphEvidence());

        expect(evidence.editedOnMain).toBe(2);
        expect(evidence.commitsFromMain).toBe(1);
        // The newest trunk edit, by ts - not merely the first row returned.
        expect(evidence.latestEditedPath).toBe("src/newest.ts");
    });

    dtest("a cache with no trunk work reports zeroes and no path", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-harness-main-empty-"), dylibPath, () => Effect.void),
        );

        expect(await overCache(fixture.snapshotPath, fetchMainBranchGraphEvidence())).toEqual({
            editedOnMain: 0,
            commitsFromMain: 0,
            latestEditedPath: null,
        });
    });
});
