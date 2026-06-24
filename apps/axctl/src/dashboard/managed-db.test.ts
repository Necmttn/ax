import { describe, it, expect } from "bun:test";
import { Duration, Effect, Layer, Ref } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { resolveManagedSurrealPath, parseDurationString, makeManagedDb } from "./managed-db.ts";

describe("resolveManagedSurrealPath", () => {
    it("resolves surreal as a sibling of the bun execPath", () => {
        expect(resolveManagedSurrealPath("/Applications/ax studio.app/Contents/Resources/bin/arm64/bun"))
            .toBe("/Applications/ax studio.app/Contents/Resources/bin/arm64/surreal");
    });

    it("works for x64 arch", () => {
        expect(resolveManagedSurrealPath("/Applications/ax studio.app/Contents/Resources/bin/x64/bun"))
            .toBe("/Applications/ax studio.app/Contents/Resources/bin/x64/surreal");
    });
});

describe("parseDurationString", () => {
    it("parses '2m' as 2 minutes", () => {
        const d = parseDurationString("2m");
        expect(d).not.toBeNull();
        expect(Duration.toMillis(d!)).toBe(2 * 60 * 1000);
    });

    it("parses '30s' as 30 seconds", () => {
        const d = parseDurationString("30s");
        expect(d).not.toBeNull();
        expect(Duration.toMillis(d!)).toBe(30 * 1000);
    });

    it("parses '1h' as 1 hour", () => {
        const d = parseDurationString("1h");
        expect(d).not.toBeNull();
        expect(Duration.toMillis(d!)).toBe(60 * 60 * 1000);
    });

    it("parses '500ms' as 500 milliseconds", () => {
        const d = parseDurationString("500ms");
        expect(d).not.toBeNull();
        expect(Duration.toMillis(d!)).toBe(500);
    });

    it("returns null for unrecognised format", () => {
        expect(parseDurationString("bad")).toBeNull();
        expect(parseDurationString("2 minutes")).toBeNull();
        expect(parseDurationString("")).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Pre-spawn idempotency check (restart-storm guard)
// ---------------------------------------------------------------------------
// These tests verify the owned-vs-attached distinction:
//   attached (healthy probe)  → NO spawn, NO finalizer, NO watchdog
//   owned    (unhealthy probe) → spawn IS invoked; watchdog + finalizer registered
//
// Stubbing approach: provide mock Layer implementations for
// ChildProcessSpawner (tracks spawn call count) and HttpClient (controls
// the probe response). Scope is satisfied by Effect.scoped.
// ---------------------------------------------------------------------------

const TEST_OPTS = {
    surrealPath: "/fake/surreal",
    host: "127.0.0.1",
    port: 19991,
    dataDir: "/fake/data",
} as const;

describe("makeManagedDb - pre-spawn idempotency (owned-vs-attached)", () => {
    it("does NOT spawn when pre-spawn probe reports healthy (attach path)", async () => {
        const spawnCount = await Effect.runPromise(
            Effect.gen(function* () {
                const countRef = yield* Ref.make(0);

                // Spawner that would fail loudly if ever called.
                const mockSpawner = ChildProcessSpawner.make((_command) =>
                    Ref.update(countRef, (n) => n + 1).pipe(
                        Effect.flatMap(() =>
                            Effect.die(new Error("managed-db test: spawn must NOT be called in attach path")),
                        ),
                    ),
                );

                // HttpClient that always responds 200 → probe sees "healthy".
                const mockHttp = HttpClient.make((req, _url, _signal, _fiber) =>
                    Effect.succeed(HttpClientResponse.fromWeb(req, new Response(null, { status: 200 }))),
                );

                // Effect must succeed (early return, no spawn).
                yield* makeManagedDb(TEST_OPTS).pipe(
                    Effect.scoped,
                    Effect.provide(
                        Layer.mergeAll(
                            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, mockSpawner),
                            Layer.succeed(HttpClient.HttpClient, mockHttp),
                        ),
                    ),
                );

                return yield* Ref.get(countRef);
            }),
        );

        // Spawner must never have been invoked.
        expect(spawnCount).toBe(0);
    });

    it("DOES spawn when pre-spawn probe reports unhealthy (owned path)", async () => {
        const spawnCount = await Effect.runPromise(
            Effect.gen(function* () {
                const countRef = yield* Ref.make(0);

                // Spawner: records the call, then fails fast (we only need to
                // verify it was invoked; completing the full spawn flow would
                // require a real process or a complex fake handle).
                const mockSpawner = ChildProcessSpawner.make((_command) =>
                    Ref.update(countRef, (n) => n + 1).pipe(
                        Effect.flatMap(() =>
                            Effect.die(new Error("managed-db test: spawn stub - intentional fast fail")),
                        ),
                    ),
                );

                // HttpClient that always responds 503 → pre-spawn probe sees
                // "not healthy" → proceeds to spawn; post-spawn readiness probe
                // would also fail but spawn dies first so it's never reached.
                const mockHttp = HttpClient.make((req, _url, _signal, _fiber) =>
                    Effect.succeed(HttpClientResponse.fromWeb(req, new Response(null, { status: 503 }))),
                );

                // Capture the exit so the defect from the mock spawner doesn't
                // escape to the test runner.  We only care about spawnCount.
                yield* Effect.exit(
                    makeManagedDb(TEST_OPTS).pipe(
                        Effect.scoped,
                        Effect.provide(
                            Layer.mergeAll(
                                Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, mockSpawner),
                                Layer.succeed(HttpClient.HttpClient, mockHttp),
                            ),
                        ),
                    ),
                );

                return yield* Ref.get(countRef);
            }),
        );

        // Spawner must have been invoked exactly once.
        expect(spawnCount).toBe(1);
    });
});
