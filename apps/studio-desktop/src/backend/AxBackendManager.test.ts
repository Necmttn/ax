import { expect, test } from "bun:test";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { backendOutputLogNoopLayer } from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as AxBackendManager from "./AxBackendManager.ts";
import type { ArbitrationDecision } from "./AxDaemonArbitration.ts";
import type {
    SupervisedProcess,
    SupervisedProcessConfig,
    SupervisedProcessHooks,
    SupervisedProcessSnapshot,
} from "./SupervisedProcess.ts";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeProcessEvent {
    readonly name: string;
    readonly action: "start" | "stop";
}

/**
 * Build a stub `makeProcess` factory that records start/stop ordering across
 * every supervised process it vends, and never touches a real OS process. Also
 * captures the lifecycle `hooks` passed for each process so a test can fire
 * them (e.g. simulate surreal's `onExit` -> ax-serve bounce).
 */
const makeFakeProcessFactory = Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<FakeProcessEvent>>([]);
    const configs = yield* Ref.make<ReadonlyArray<SupervisedProcessConfig>>([]);
    const hooksByName = yield* Ref.make<
        Readonly<Record<string, SupervisedProcessHooks | undefined>>
    >({});

    const factory: AxBackendManager.MakeSupervisedProcess = (config, hooks) =>
        Effect.sync(() => {
            const proc: SupervisedProcess = {
                start: Ref.update(events, (xs) => [
                    ...xs,
                    { name: config.name, action: "start" } satisfies FakeProcessEvent,
                ]).pipe(Effect.asVoid),
                stop: () =>
                    Ref.update(events, (xs) => [
                        ...xs,
                        { name: config.name, action: "stop" } satisfies FakeProcessEvent,
                    ]).pipe(Effect.asVoid),
                snapshot: Effect.succeed({
                    ready: true,
                    activePid: 1234,
                    restartAttempt: 0,
                } satisfies SupervisedProcessSnapshot),
            };
            return proc;
        }).pipe(
            Effect.tap(() => Ref.update(configs, (xs) => [...xs, config])),
            Effect.tap(() =>
                Ref.update(hooksByName, (m) => ({ ...m, [config.name]: hooks })),
            ),
        );

    /** Fire the captured `onExit` hook for a process, if any (simulates crash). */
    const fireExit = (name: string) =>
        Ref.get(hooksByName).pipe(
            Effect.flatMap((m) =>
                m[name]?.onExit?.({ pid: 1234, reason: "code=1" }) ?? Effect.void,
            ),
        );

    return {
        factory,
        events: Ref.get(events),
        configs: Ref.get(configs),
        fireExit,
    } as const;
});

/** A DesktopState whose `backendReady` ref the test can read directly. */
const makeFakeState = Effect.gen(function* () {
    const backendReady = yield* Ref.make(false);
    const quitting = yield* Ref.make(false);
    const layer = Layer.succeed(
        DesktopState.DesktopState,
        DesktopState.DesktopState.of({ backendReady, quitting }),
    );
    return { layer, backendReady: Ref.get(backendReady) } as const;
});

/** A DesktopWindow stub that records whether the window was opened. */
const makeFakeWindow = Effect.gen(function* () {
    const opened = yield* Ref.make(0);
    const layer = Layer.succeed(
        DesktopWindow.DesktopWindow,
        DesktopWindow.DesktopWindow.of({
            handleBackendReady: Ref.update(opened, (n) => n + 1).pipe(Effect.asVoid),
            activate: Effect.void,
            syncAppearance: Effect.void,
        }),
    );
    return { layer, openCount: Ref.get(opened) } as const;
});

const arbitrationLayer = (
    decision: ArbitrationDecision,
    probeDaemon: Effect.Effect<boolean> = Effect.succeed(true),
) =>
    Layer.succeed(
        AxBackendManager.AxArbitration,
        AxBackendManager.AxArbitration.of({
            probe: Effect.succeed(decision),
            probeDaemon,
        }),
    );

const testEnv = {
    surrealBinaryPath: "/opt/ax/surreal",
    bunBinaryPath: "/opt/ax/bun",
    axSourceEntry: "/repo/apps/axctl/src/cli/index.ts",
    axDataDir: "/data/ax",
    axSourceRoot: "/repo",
} satisfies AxBackendManager.AxBackendEnvironment;

const envLayer = Layer.succeed(
    AxBackendManager.AxBackendEnvironmentTag,
    AxBackendManager.AxBackendEnvironmentTag.of(testEnv),
);

// The injected stub factory never touches these, but the manager fetches them
// from context to feed the (production) supervised-process factory. Trivial
// stubs keep the layer satisfied without spawning anything.
const platformStubLayer = Layer.mergeAll(
    Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
            Effect.die("stub spawner: should not spawn in unit tests"),
        ),
    ),
    Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
            Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })),
            ),
        ),
    ),
    backendOutputLogNoopLayer,
);

// ---------------------------------------------------------------------------
// (a) spawn: surreal readiness gates ax-serve start (ordering)
// ---------------------------------------------------------------------------

test("spawn mode starts surreal before ax serve (ordering)", async () => {
    const program = Effect.gen(function* () {
        const fakeProc = yield* makeFakeProcessFactory;
        const fakeWindow = yield* makeFakeWindow;

        yield* Effect.scoped(
            Effect.gen(function* () {
                const manager = yield* AxBackendManager.AxBackendManager;
                yield* manager.start;
            }).pipe(
                Effect.provide(
                    AxBackendManager.layer(fakeProc.factory).pipe(
                        Layer.provide(arbitrationLayer({ mode: "spawn" })),
                        Layer.provide(fakeWindow.layer),
                        Layer.provide(DesktopState.layer),
                        Layer.provide(envLayer),
                        Layer.provide(platformStubLayer),
                    ),
                ),
            ),
        );

        return {
            events: yield* fakeProc.events,
            configs: yield* fakeProc.configs,
            opened: yield* fakeWindow.openCount,
        };
    });

    const out = await Effect.runPromise(program);

    const startOrder = out.events
        .filter((e) => e.action === "start")
        .map((e) => e.name);
    expect(startOrder).toEqual(["surreal", "ax-serve"]);
    expect(out.opened).toBe(1);

    // surreal config sanity
    const surrealCfg = out.configs.find((c) => c.name === "surreal");
    expect(surrealCfg?.executablePath).toBe("/opt/ax/surreal");
    expect(surrealCfg?.args).toContain("rocksdb:///data/ax/db");
    expect(surrealCfg?.readiness.url.href).toBe("http://127.0.0.1:8521/health");

    // ax-serve config sanity
    const axCfg = out.configs.find((c) => c.name === "ax-serve");
    expect(axCfg?.executablePath).toBe("/opt/ax/bun");
    expect(axCfg?.args).toEqual([
        "/repo/apps/axctl/src/cli/index.ts",
        "serve",
        "--port=1738",
    ]);
    expect(axCfg?.cwd).toBe("/repo");
    expect(axCfg?.env.AX_DB_URL).toBe("ws://127.0.0.1:8521");
    expect(axCfg?.env.AX_DB_NS).toBe("ax");
    expect(axCfg?.env.AX_DB_DB).toBe("main");
    expect(axCfg?.readiness.url.href).toBe("http://127.0.0.1:1738/api/version");
});

// ---------------------------------------------------------------------------
// (b) attach mode opens the window without spawning
// ---------------------------------------------------------------------------

test("attach mode opens window without spawning processes", async () => {
    const program = Effect.gen(function* () {
        const fakeProc = yield* makeFakeProcessFactory;
        const fakeWindow = yield* makeFakeWindow;
        const fakeState = yield* makeFakeState;

        // Read backendReady INSIDE the scope - the scope-close finalizer (stop)
        // resets it to false, so reading after close would observe the reset.
        const backendReady = yield* Effect.scoped(
            Effect.gen(function* () {
                const manager = yield* AxBackendManager.AxBackendManager;
                yield* manager.start;
                return yield* fakeState.backendReady;
            }).pipe(
                Effect.provide(
                    AxBackendManager.layer(fakeProc.factory).pipe(
                        Layer.provide(arbitrationLayer({ mode: "attach" })),
                        Layer.provide(fakeWindow.layer),
                        Layer.provide(fakeState.layer),
                        Layer.provide(envLayer),
                        Layer.provide(platformStubLayer),
                    ),
                ),
            ),
        );

        return {
            events: yield* fakeProc.events,
            opened: yield* fakeWindow.openCount,
            backendReady,
        };
    });

    const out = await Effect.runPromise(program);

    expect(out.events).toEqual([]);
    expect(out.opened).toBe(1);
    expect(out.backendReady).toBe(true);
});

// ---------------------------------------------------------------------------
// (c) stop tears down in reverse order (ax serve before surreal)
// ---------------------------------------------------------------------------

test("stop tears down ax serve before surreal (reverse order)", async () => {
    const program = Effect.gen(function* () {
        const fakeProc = yield* makeFakeProcessFactory;
        const fakeWindow = yield* makeFakeWindow;

        yield* Effect.scoped(
            Effect.gen(function* () {
                const manager = yield* AxBackendManager.AxBackendManager;
                yield* manager.start;
                yield* manager.stop();
            }).pipe(
                Effect.provide(
                    AxBackendManager.layer(fakeProc.factory).pipe(
                        Layer.provide(arbitrationLayer({ mode: "spawn" })),
                        Layer.provide(fakeWindow.layer),
                        Layer.provide(DesktopState.layer),
                        Layer.provide(envLayer),
                        Layer.provide(platformStubLayer),
                    ),
                ),
            ),
        );

        return { events: yield* fakeProc.events };
    });

    const out = await Effect.runPromise(program);

    const stopOrder = out.events
        .filter((e) => e.action === "stop")
        .map((e) => e.name);
    expect(stopOrder).toEqual(["ax-serve", "surreal"]);
});

// ---------------------------------------------------------------------------
// (d) spawn-ax-only skips surreal, still starts ax serve + opens window
// ---------------------------------------------------------------------------

test("spawn-ax-only skips surreal but starts ax serve", async () => {
    const program = Effect.gen(function* () {
        const fakeProc = yield* makeFakeProcessFactory;
        const fakeWindow = yield* makeFakeWindow;

        yield* Effect.scoped(
            Effect.gen(function* () {
                const manager = yield* AxBackendManager.AxBackendManager;
                yield* manager.start;
            }).pipe(
                Effect.provide(
                    AxBackendManager.layer(fakeProc.factory).pipe(
                        Layer.provide(arbitrationLayer({ mode: "spawn-ax-only" })),
                        Layer.provide(fakeWindow.layer),
                        Layer.provide(DesktopState.layer),
                        Layer.provide(envLayer),
                        Layer.provide(platformStubLayer),
                    ),
                ),
            ),
        );

        return {
            events: yield* fakeProc.events,
            opened: yield* fakeWindow.openCount,
        };
    });

    const out = await Effect.runPromise(program);

    const startOrder = out.events
        .filter((e) => e.action === "start")
        .map((e) => e.name);
    expect(startOrder).toEqual(["ax-serve"]);
    expect(out.opened).toBe(1);
});

// ---------------------------------------------------------------------------
// (e) conflict mode does NOT start or open the window
// ---------------------------------------------------------------------------

test("conflict mode neither spawns nor opens the window", async () => {
    const program = Effect.gen(function* () {
        const fakeProc = yield* makeFakeProcessFactory;
        const fakeWindow = yield* makeFakeWindow;

        yield* Effect.scoped(
            Effect.gen(function* () {
                const manager = yield* AxBackendManager.AxBackendManager;
                yield* manager.start;
            }).pipe(
                Effect.provide(
                    AxBackendManager.layer(fakeProc.factory).pipe(
                        Layer.provide(arbitrationLayer({ mode: "conflict" })),
                        Layer.provide(fakeWindow.layer),
                        Layer.provide(DesktopState.layer),
                        Layer.provide(envLayer),
                        Layer.provide(platformStubLayer),
                    ),
                ),
            ),
        );

        return {
            events: yield* fakeProc.events,
            opened: yield* fakeWindow.openCount,
        };
    });

    const out = await Effect.runPromise(program);

    expect(out.events).toEqual([]);
    expect(out.opened).toBe(0);
});

// ---------------------------------------------------------------------------
// (f) surreal restart (onExit) after both running bounces ax-serve
// ---------------------------------------------------------------------------

test("surreal restart bounces ax serve (stop then start)", async () => {
    const program = Effect.gen(function* () {
        const fakeProc = yield* makeFakeProcessFactory;
        const fakeWindow = yield* makeFakeWindow;

        // Read events INSIDE the scope: the scope-close finalizer (stop) appends
        // its own stop events, which would otherwise pollute the assertion.
        const events = yield* Effect.scoped(
            Effect.gen(function* () {
                const manager = yield* AxBackendManager.AxBackendManager;
                yield* manager.start;
                // Both processes are up. Simulate surreal crashing/exiting (the
                // supervisor would self-restart); the manager's onExit hook
                // should bounce ax-serve.
                yield* fakeProc.fireExit("surreal");
                return yield* fakeProc.events;
            }).pipe(
                Effect.provide(
                    AxBackendManager.layer(fakeProc.factory).pipe(
                        Layer.provide(arbitrationLayer({ mode: "spawn" })),
                        Layer.provide(fakeWindow.layer),
                        Layer.provide(DesktopState.layer),
                        Layer.provide(envLayer),
                        Layer.provide(platformStubLayer),
                    ),
                ),
            ),
        );

        return { events };
    });

    const out = await Effect.runPromise(program);

    // Initial: surreal start, ax-serve start. Then bounce: ax-serve stop + start.
    expect(out.events).toEqual([
        { name: "surreal", action: "start" },
        { name: "ax-serve", action: "start" },
        { name: "ax-serve", action: "stop" },
        { name: "ax-serve", action: "start" },
    ]);
});

// ---------------------------------------------------------------------------
// (g) NO bounce when surreal exit happens during/after manager stop (teardown)
// ---------------------------------------------------------------------------

test("surreal exit during teardown does NOT respawn ax serve", async () => {
    const program = Effect.gen(function* () {
        const fakeProc = yield* makeFakeProcessFactory;
        const fakeWindow = yield* makeFakeWindow;

        const events = yield* Effect.scoped(
            Effect.gen(function* () {
                const manager = yield* AxBackendManager.AxBackendManager;
                yield* manager.start;
                // Tear down, THEN fire surreal's exit hook (mirrors a surreal
                // SIGTERM landing as the manager shuts down). The bounce must
                // bail: no ax-serve respawn after teardown.
                yield* manager.stop();
                yield* fakeProc.fireExit("surreal");
                return yield* fakeProc.events;
            }).pipe(
                Effect.provide(
                    AxBackendManager.layer(fakeProc.factory).pipe(
                        Layer.provide(arbitrationLayer({ mode: "spawn" })),
                        Layer.provide(fakeWindow.layer),
                        Layer.provide(DesktopState.layer),
                        Layer.provide(envLayer),
                        Layer.provide(platformStubLayer),
                    ),
                ),
            ),
        );

        return { events };
    });

    const out = await Effect.runPromise(program);

    // start surreal, start ax-serve, then reverse-order teardown. No further
    // ax-serve start after the teardown stops.
    expect(out.events).toEqual([
        { name: "surreal", action: "start" },
        { name: "ax-serve", action: "start" },
        { name: "ax-serve", action: "stop" },
        { name: "surreal", action: "stop" },
    ]);
});

// ---------------------------------------------------------------------------
// (h) NO bounce on surreal's initial boot (only onExit, never onReady)
// ---------------------------------------------------------------------------

test("surreal initial boot does not bounce ax serve", async () => {
    const program = Effect.gen(function* () {
        const fakeProc = yield* makeFakeProcessFactory;
        const fakeWindow = yield* makeFakeWindow;

        const events = yield* Effect.scoped(
            Effect.gen(function* () {
                const manager = yield* AxBackendManager.AxBackendManager;
                yield* manager.start;
                // No exit fired: the manager only reacts to surreal `onExit`, so
                // a clean initial boot must leave ax-serve untouched (one start).
                return yield* fakeProc.events;
            }).pipe(
                Effect.provide(
                    AxBackendManager.layer(fakeProc.factory).pipe(
                        Layer.provide(arbitrationLayer({ mode: "spawn" })),
                        Layer.provide(fakeWindow.layer),
                        Layer.provide(DesktopState.layer),
                        Layer.provide(envLayer),
                        Layer.provide(platformStubLayer),
                    ),
                ),
            ),
        );

        return { events };
    });

    const out = await Effect.runPromise(program);

    expect(out.events).toEqual([
        { name: "surreal", action: "start" },
        { name: "ax-serve", action: "start" },
    ]);
});

// ---------------------------------------------------------------------------
// (i) attach mode: poller stays quiet while the external daemon stays healthy
// ---------------------------------------------------------------------------

test("attach mode does NOT transition while the attached daemon stays healthy", async () => {
    const program = Effect.gen(function* () {
        const fakeProc = yield* makeFakeProcessFactory;
        const fakeWindow = yield* makeFakeWindow;

        const events = yield* Effect.scoped(
            Effect.gen(function* () {
                const manager = yield* AxBackendManager.AxBackendManager;
                yield* manager.start;
                // Drive several poll cycles (grace + 5 intervals) with a healthy
                // probe. No spawn should ever happen.
                yield* TestClock.adjust(Duration.seconds(5 + 5 * 5));
                return yield* fakeProc.events;
            }).pipe(
                Effect.provide(
                    AxBackendManager.layer(fakeProc.factory).pipe(
                        // Probe always healthy.
                        Layer.provide(
                            arbitrationLayer({ mode: "attach" }, Effect.succeed(true)),
                        ),
                        Layer.provide(fakeWindow.layer),
                        Layer.provide(DesktopState.layer),
                        Layer.provide(envLayer),
                        Layer.provide(platformStubLayer),
                    ),
                ),
            ),
        );

        return { events };
    }).pipe(Effect.provide(TestClock.layer()));

    const out = await Effect.runPromise(program);

    // Healthy attach: nothing spawned.
    expect(out.events).toEqual([]);
});

// ---------------------------------------------------------------------------
// (j) attach mode: sustained probe failure transitions attach -> spawn
// ---------------------------------------------------------------------------

test("attach mode transitions to spawn after the attached daemon dies", async () => {
    const program = Effect.gen(function* () {
        const fakeProc = yield* makeFakeProcessFactory;
        const fakeWindow = yield* makeFakeWindow;
        // Probe healthy until the test flips it unhealthy.
        const healthy = yield* Ref.make(true);

        const events = yield* Effect.scoped(
            Effect.gen(function* () {
                const manager = yield* AxBackendManager.AxBackendManager;
                yield* manager.start;
                // Window opened against the external daemon; nothing spawned yet.
                expect(yield* fakeProc.events).toEqual([]);
                expect(yield* fakeWindow.openCount).toBe(1);

                // Daemon dies. The next two consecutive probes fail (threshold 2),
                // triggering the attach -> spawn takeover.
                yield* Ref.set(healthy, false);
                // grace -> first failing tick (failures=1)
                yield* TestClock.adjust(Duration.seconds(5));
                // one interval -> second failing tick (failures=2 -> transition)
                yield* TestClock.adjust(Duration.seconds(5));
                // let the spawn path settle (its readiness gate uses the clock)
                yield* TestClock.adjust(Duration.seconds(1));
                return yield* fakeProc.events;
            }).pipe(
                Effect.provide(
                    AxBackendManager.layer(fakeProc.factory).pipe(
                        Layer.provide(
                            arbitrationLayer({ mode: "attach" }, Ref.get(healthy)),
                        ),
                        Layer.provide(fakeWindow.layer),
                        Layer.provide(DesktopState.layer),
                        Layer.provide(envLayer),
                        Layer.provide(platformStubLayer),
                    ),
                ),
            ),
        );

        return { events };
    }).pipe(Effect.provide(TestClock.layer()));

    const out = await Effect.runPromise(program);

    // The takeover ran the spawn path: surreal then ax-serve.
    const startOrder = out.events
        .filter((e) => e.action === "start")
        .map((e) => e.name);
    expect(startOrder).toEqual(["surreal", "ax-serve"]);
});

// ---------------------------------------------------------------------------
// (k) attach mode: poller torn down by stop -> no transition after stop
// ---------------------------------------------------------------------------

test("attach mode poller does NOT transition after stop (torn down)", async () => {
    const program = Effect.gen(function* () {
        const fakeProc = yield* makeFakeProcessFactory;
        const fakeWindow = yield* makeFakeWindow;
        const healthy = yield* Ref.make(true);

        const events = yield* Effect.scoped(
            Effect.gen(function* () {
                const manager = yield* AxBackendManager.AxBackendManager;
                yield* manager.start;
                // Stop the manager FIRST (latches `stopping`), then make the
                // daemon die and advance well past the failure threshold. The
                // poller must bail without spawning anything.
                yield* manager.stop();
                yield* Ref.set(healthy, false);
                yield* TestClock.adjust(Duration.seconds(5 + 5 * 5));
                return yield* fakeProc.events;
            }).pipe(
                Effect.provide(
                    AxBackendManager.layer(fakeProc.factory).pipe(
                        Layer.provide(
                            arbitrationLayer({ mode: "attach" }, Ref.get(healthy)),
                        ),
                        Layer.provide(fakeWindow.layer),
                        Layer.provide(DesktopState.layer),
                        Layer.provide(envLayer),
                        Layer.provide(platformStubLayer),
                    ),
                ),
            ),
        );

        return { events };
    }).pipe(Effect.provide(TestClock.layer()));

    const out = await Effect.runPromise(program);

    // No spawn after stop: poller was torn down / guarded by `stopping`.
    expect(out.events).toEqual([]);
});
