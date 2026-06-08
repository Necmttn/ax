import { expect, test } from "bun:test";

import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Sink from "effect/Sink";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import {
    ChildProcess,
    ChildProcessSpawner,
} from "effect/unstable/process";

import { backendOutputLogNoopLayer } from "../app/DesktopObservability.ts";
import {
    INITIAL_RESTART_DELAY,
    makeSupervisedProcess,
    type SupervisedProcessConfig,
} from "./SupervisedProcess.ts";

// ---------------------------------------------------------------------------
// Stub child process spawner
// ---------------------------------------------------------------------------

interface FakeChildController {
    /** Resolve the current child's exitCode effect, simulating an exit. */
    readonly emitExit: (code: number) => Effect.Effect<void>;
    /** Number of times `spawn` was invoked. */
    readonly spawnCount: Effect.Effect<number>;
    /** Kill signals captured across all spawned children, in order. */
    readonly killSignals: Effect.Effect<ReadonlyArray<string>>;
}

const makeStubSpawner = Effect.gen(function* () {
    const spawns = yield* Ref.make(0);
    const kills = yield* Ref.make<ReadonlyArray<string>>([]);
    // Deferred for the most-recently-spawned child's exit code.
    const currentExit = yield* Ref.make<Deferred.Deferred<number> | null>(null);
    let nextPid = 1000;

    const spawnerService = ChildProcessSpawner.make((_command: ChildProcess.Command) =>
        Effect.gen(function* () {
            yield* Ref.update(spawns, (n) => n + 1);
            const exit = yield* Deferred.make<number>();
            yield* Ref.set(currentExit, exit);
            const pid = nextPid++;

            // Real spawners kill the child + resolve its exit when the spawn
            // scope closes. Model that so `Scope.close(runScope)` (in stop /
            // closeRun) unblocks the run fiber that awaits `exitCode`.
            yield* Effect.addFinalizer(() =>
                Effect.gen(function* () {
                    yield* Ref.update(kills, (xs) => [...xs, "SIGTERM"]);
                    yield* Deferred.succeed(exit, 0);
                }),
            );

            const handle: ChildProcessSpawner.ChildProcessHandle =
                ChildProcessSpawner.makeHandle({
                    pid: ChildProcessSpawner.ProcessId(pid),
                    exitCode: Deferred.await(exit).pipe(
                        Effect.map((code) => ChildProcessSpawner.ExitCode(code)),
                    ),
                    isRunning: Deferred.await(exit).pipe(
                        Effect.as(false),
                        Effect.raceFirst(Effect.succeed(true)),
                    ),
                    kill: (options) =>
                        Effect.gen(function* () {
                            yield* Ref.update(kills, (xs) => [
                                ...xs,
                                options?.killSignal ?? "SIGTERM",
                            ]);
                            yield* Deferred.succeed(exit, 0);
                        }),
                    stdin: Sink.drain,
                    stdout: Stream.empty,
                    stderr: Stream.empty,
                    all: Stream.empty,
                    getInputFd: () => Sink.drain,
                    getOutputFd: () => Stream.empty,
                    unref: Effect.succeed(Effect.void),
                });

            return handle;
        }),
    );

    const controller: FakeChildController = {
        emitExit: (code) =>
            Effect.gen(function* () {
                const exit = yield* Ref.get(currentExit);
                if (exit !== null) {
                    yield* Deferred.succeed(exit, code);
                }
            }),
        spawnCount: Ref.get(spawns),
        killSignals: Ref.get(kills),
    };

    const layer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        spawnerService,
    );

    return { layer, controller } as const;
});

// ---------------------------------------------------------------------------
// Stub HTTP client (controllable readiness)
// ---------------------------------------------------------------------------

const makeStubHttpClient = Effect.gen(function* () {
    // true => readiness probe returns 200; false => 503
    const ok = yield* Ref.make(true);

    const client = HttpClient.make((request) =>
        Ref.get(ok).pipe(
            Effect.map((isOk) =>
                HttpClientResponse.fromWeb(
                    request,
                    new Response(null, { status: isOk ? 200 : 503 }),
                ),
            ),
        ),
    );

    const layer = Layer.succeed(HttpClient.HttpClient, client);

    return { layer, setOk: (value: boolean) => Ref.set(ok, value) } as const;
});

// ---------------------------------------------------------------------------
// Test config
// ---------------------------------------------------------------------------

const testConfig: SupervisedProcessConfig = {
    name: "test-proc",
    executablePath: "/usr/bin/true",
    args: [],
    cwd: "/tmp",
    env: {},
    readiness: {
        url: new URL("http://127.0.0.1:9999/health"),
        timeout: Duration.seconds(30),
    },
};

// ---------------------------------------------------------------------------
// (a) start resolves ready once the readiness probe returns ok
// ---------------------------------------------------------------------------

test("start resolves ready once HTTP readiness returns ok", async () => {
    const program = Effect.gen(function* () {
        const stubSpawner = yield* makeStubSpawner;
        const stubHttp = yield* makeStubHttpClient;

        return yield* Effect.scoped(
            Effect.gen(function* () {
                const proc = yield* makeSupervisedProcess(testConfig);
                yield* proc.start;
                // give the forked readiness probe a tick to resolve
                yield* TestClock.adjust(Duration.millis(200));
                const snap = yield* proc.snapshot;
                yield* proc.stop({ timeout: Duration.seconds(1) });
                return snap;
            }),
        ).pipe(
            Effect.provide(stubSpawner.layer),
            Effect.provide(stubHttp.layer),
            Effect.provide(backendOutputLogNoopLayer),
        );
    });

    const snap = await Effect.runPromise(
        program.pipe(Effect.provide(TestClock.layer())),
    );

    expect(snap.ready).toBe(true);
    expect(snap.activePid).not.toBeNull();
});

// ---------------------------------------------------------------------------
// (b) child exit while desiredRunning schedules a restart after backoff
// ---------------------------------------------------------------------------

test("child exit while desiredRunning schedules a restart after backoff", async () => {
    const program = Effect.gen(function* () {
        const stubSpawner = yield* makeStubSpawner;
        const stubHttp = yield* makeStubHttpClient;

        return yield* Effect.scoped(
            Effect.gen(function* () {
                const proc = yield* makeSupervisedProcess(testConfig);
                yield* proc.start;
                yield* TestClock.adjust(Duration.millis(200)); // becomes ready
                const spawnsAfterStart =
                    yield* stubSpawner.controller.spawnCount;

                // Simulate a crash.
                yield* stubSpawner.controller.emitExit(1);
                // Let the exit be observed and a restart scheduled.
                yield* TestClock.adjust(Duration.millis(1));
                const snapAfterCrash = yield* proc.snapshot;
                // The respawn must be GATED behind the backoff delay: with the
                // clock only advanced 1ms (< INITIAL_RESTART_DELAY) no new spawn
                // should have happened yet. This pins the backoff timing - an
                // impl that respawned with zero delay would fail here.
                const spawnsBeforeBackoff =
                    yield* stubSpawner.controller.spawnCount;

                // Advance past the first backoff delay (500ms) to respawn.
                yield* TestClock.adjust(INITIAL_RESTART_DELAY);
                yield* TestClock.adjust(Duration.millis(200)); // re-ready
                const spawnsAfterRestart =
                    yield* stubSpawner.controller.spawnCount;
                const snapAfterRestart = yield* proc.snapshot;

                yield* proc.stop({ timeout: Duration.seconds(1) });
                return {
                    spawnsAfterStart,
                    snapAfterCrash,
                    spawnsBeforeBackoff,
                    spawnsAfterRestart,
                    snapAfterRestart,
                };
            }),
        ).pipe(
            Effect.provide(stubSpawner.layer),
            Effect.provide(stubHttp.layer),
            Effect.provide(backendOutputLogNoopLayer),
        );
    });

    const out = await Effect.runPromise(
        program.pipe(Effect.provide(TestClock.layer())),
    );

    expect(out.spawnsAfterStart).toBe(1);
    expect(out.snapAfterCrash.restartAttempt).toBeGreaterThanOrEqual(1);
    // Backoff timing: no respawn before the delay elapses, exactly one after.
    expect(out.spawnsBeforeBackoff).toBe(1);
    expect(out.spawnsAfterRestart).toBe(2);
});

// ---------------------------------------------------------------------------
// (c) stop cancels a pending restart and closes the scope (SIGTERM observed)
// ---------------------------------------------------------------------------

test("stop cancels pending restart, sends SIGTERM, no respawn after stop", async () => {
    const program = Effect.gen(function* () {
        const stubSpawner = yield* makeStubSpawner;
        const stubHttp = yield* makeStubHttpClient;

        return yield* Effect.scoped(
            Effect.gen(function* () {
                const proc = yield* makeSupervisedProcess(testConfig);
                yield* proc.start;
                yield* TestClock.adjust(Duration.millis(200)); // ready

                // Stop while running -> should SIGTERM the child.
                yield* proc.stop({ timeout: Duration.seconds(1) });
                const killsAfterStop =
                    yield* stubSpawner.controller.killSignals;
                const spawnsAfterStop =
                    yield* stubSpawner.controller.spawnCount;

                // Advance past any backoff window -> no respawn should occur.
                yield* TestClock.adjust(Duration.seconds(30));
                const spawnsLater = yield* stubSpawner.controller.spawnCount;
                const snap = yield* proc.snapshot;

                return { killsAfterStop, spawnsAfterStop, spawnsLater, snap };
            }),
        ).pipe(
            Effect.provide(stubSpawner.layer),
            Effect.provide(stubHttp.layer),
            Effect.provide(backendOutputLogNoopLayer),
        );
    });

    const out = await Effect.runPromise(
        program.pipe(Effect.provide(TestClock.layer())),
    );

    expect(out.killsAfterStop).toContain("SIGTERM");
    expect(out.spawnsAfterStop).toBe(1);
    expect(out.spawnsLater).toBe(1);
    expect(out.snap.ready).toBe(false);
});
