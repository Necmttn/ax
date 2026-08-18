/**
 * `fetchMemoryOps` against a REAL published snapshot.
 *
 * This replaces an assertion-free stub test that ran the effect and expected
 * nothing, and it exists to pin one specific defect class: the path predicate.
 *
 * `file` is keyed `(repo, path)`, so `file.path` is repo-RELATIVE in the general
 * case. Filtering on it drops every memory edit whose file row is stored
 * relative - a smaller result set, never an error, and therefore invisible to a
 * stubbed seam and to any SQL-text assertion. The filter reads
 * `edited.absolute_path_seen` instead, and the fixture below contains one row of
 * each shape so a regression to `file.path` fails here.
 */
import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { publishCacheFixture, readFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { fetchMemoryOps } from "./memory-ops.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("memory ops", { requireFts: true });

const SESSION = "019e2531-b552-7b53-a029-c780adbb6560";
const hoursAgo = (h: number): Date => new Date(Date.now() - h * 60 * 60 * 1000);

describe("fetchMemoryOps over a published snapshot", () => {
    dtest("filters on the ABSOLUTE path, and windows by sinceDays", async () => {
        const dir = tempDir("memory-ops");
        const fixture = await runWithPlatform(
            publishCacheFixture(dir, dylibPath, (write) =>
                Effect.gen(function* () {
                    yield* write.put("session", {
                        id: SESSION,
                        source: "claude",
                        project: "ax",
                    });
                    yield* write.put("turn", {
                        id: "turn:1",
                        session: SESSION,
                        seq: 1,
                        ts: hoursAgo(2),
                        role: "assistant",
                    });

                    // (a) A REAL memory write whose `file.path` is repo-RELATIVE.
                    // This is the row a `file.path` filter silently loses.
                    // Dated 3 days back so the narrow-window assertion at the
                    // end of this test can actually exclude it.
                    yield* write.put("file", { id: "file:mem", repo: "ax", path: "memory/MEMORY.md" });
                    yield* write.put("edited", {
                        id: "edited:mem",
                        in_id: "turn:1",
                        out_id: "file:mem",
                        tool: "Write",
                        ts: hoursAgo(72),
                        path_seen: "memory/MEMORY.md",
                        absolute_path_seen: "/Users/dev/.claude/projects/ax/memory/MEMORY.md",
                    });

                    // (b) A repo's OWN src/memory/ dir - must NOT match, because
                    // it is not under /.claude/. Guards the two-part predicate.
                    yield* write.put("file", { id: "file:src", repo: "ax", path: "src/memory/store.ts" });
                    yield* write.put("edited", {
                        id: "edited:src",
                        in_id: "turn:1",
                        out_id: "file:src",
                        tool: "Edit",
                        ts: hoursAgo(2),
                        path_seen: "src/memory/store.ts",
                        absolute_path_seen: "/Users/dev/code/ax/src/memory/store.ts",
                    });

                    // (c) A memory write OUTSIDE the window - must not match.
                    yield* write.put("file", { id: "file:old", repo: "ax", path: "memory/OLD.md" });
                    yield* write.put("edited", {
                        id: "edited:old",
                        in_id: "turn:1",
                        out_id: "file:old",
                        tool: "Write",
                        ts: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
                        path_seen: "memory/OLD.md",
                        absolute_path_seen: "/Users/dev/.claude/projects/ax/memory/OLD.md",
                    });
                }),
            ),
        );
        const layer = readFixture(fixture.snapshotPath, dylibPath);

        const result = await Effect.runPromise(
            fetchMemoryOps({ sinceDays: 30 }).pipe(Effect.provide(layer)),
        );

        // Only (a). (b) is not under /.claude/, (c) is outside the window.
        expect(result.events).toHaveLength(1);
        expect(result.events[0]!.path).toBe("/Users/dev/.claude/projects/ax/memory/MEMORY.md");
        expect(result.events[0]!.tool).toBe("Write");
        expect(result.totals.ops).toBe(1);
        expect(result.files).toHaveLength(1);

        // A one-day window excludes (a) too - proof the day bound is applied and
        // not merely present in the SQL text.
        const narrow = await Effect.runPromise(
            fetchMemoryOps({ sinceDays: 1 }).pipe(Effect.provide(layer)),
        );
        expect(narrow.events).toHaveLength(0);
    });
});
