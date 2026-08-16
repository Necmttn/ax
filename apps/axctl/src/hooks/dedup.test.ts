import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { publishCacheFixture, readFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { buildRecentInjectsQuery, findRecentInjects } from "./dedup.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("hook dedup", { requireFts: true });

describe("buildRecentInjectsQuery", () => {
    test("includes the session, inject=true, file_path IN list, and window", () => {
        const before = Date.now();
        const query = buildRecentInjectsQuery({
            sessionRid: "session:abc",
            filePaths: ["src/a.ts", "src/b.ts"],
            windowMinutes: 30,
        });
        const after = Date.now();
        expect(query.sql).toContain("session = ?");
        expect(query.sql).toContain("inject = true");
        expect(query.sql).toContain("file_path IN (?, ?)");
        expect(query.sql).toContain("ts >= ?");
        expect(query.params).toHaveLength(4);
        expect(query.params.slice(0, 3)).toEqual(["session:abc", "src/a.ts", "src/b.ts"]);
        // The window cutoff is computed in JS and bound as a plain timestamp
        // (not an INTERVAL expression - DuckDB has no `-(TIMESTAMPTZ, INTERVAL)`
        // overload for an untyped placeholder multiplied into an INTERVAL).
        const since = query.params[3];
        expect(since).toBeInstanceOf(Date);
        const sinceMs = (since as Date).getTime();
        expect(sinceMs).toBeGreaterThanOrEqual(before - 30 * 60_000);
        expect(sinceMs).toBeLessThanOrEqual(after - 30 * 60_000);
    });

    test("binds file paths that contain single quotes", () => {
        const query = buildRecentInjectsQuery({
            sessionRid: "session:abc",
            filePaths: ["src/user's-file.ts"],
            windowMinutes: 30,
        });
        expect(query.sql).not.toContain("user's-file");
        expect(query.params).toContain("src/user's-file.ts");
    });
});

describe("findRecentInjects", () => {
    dtest("reads recent injected paths from the published cache", async () => {
        const now = new Date();
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-hook-dedup-"), dylibPath, (write) =>
                Effect.gen(function* () {
                    for (const [id, filePath, inject] of [
                        ["recent-a", "src/a.ts", true],
                        ["recent-b", "src/b.ts", false],
                    ] as const) {
                        yield* write.put("hook_fire", {
                            id,
                            ts: now,
                            kind: "hook_fire",
                            session: "session:abc",
                            file: null,
                            file_path: filePath,
                            harness: "claude",
                            ok: true,
                            latency_ms: 1,
                            event: "pre-edit",
                            inject,
                            reason: inject ? "high_signal" : "low_signal_only",
                            prior_sessions_considered: 1,
                            task_excerpt: "test",
                            top_prior_sessions: "[]",
                            injected_titles: "[]",
                        });
                    }
                }),
            ),
        );

        const result = await Effect.runPromise(
            findRecentInjects({
                sessionId: "session:abc",
                filePaths: ["src/a.ts", "src/b.ts"],
                windowMinutes: 30,
            }).pipe(Effect.provide(readFixture(fixture.snapshotPath, dylibPath)), Effect.scoped),
        );
        expect([...result]).toEqual(["src/a.ts"]);
    });

    test("returns an empty set before it resolves the cache", async () => {
        const missingSession = await Effect.runPromise(findRecentInjects({
            sessionId: undefined,
            filePaths: ["src/a.ts"],
            windowMinutes: 30,
        }).pipe(Effect.provide(readFixture("/missing/snapshot.duckdb", dylibPath)), Effect.scoped));
        const missingFiles = await Effect.runPromise(findRecentInjects({
            sessionId: "session:abc",
            filePaths: [],
            windowMinutes: 30,
        }).pipe(Effect.provide(readFixture("/missing/snapshot.duckdb", dylibPath)), Effect.scoped));
        expect(missingSession.size).toBe(0);
        expect(missingFiles.size).toBe(0);
    });
});
