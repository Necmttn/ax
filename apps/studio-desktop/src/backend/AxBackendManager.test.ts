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
 * Build a stub `makeProcess` factory that records start/stop ordering and
 * never touches a real OS process.
 */
const makeFakeProcessFactory = Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<FakeProcessEvent>>([]);
    const configs = yield* Ref.make<ReadonlyArray<SupervisedProcessConfig>>([]);

    const factory: AxBackendManager.MakeSupervisedProcess = (config) =>
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
        }).pipe(Effect.tap(() => Ref.update(configs, (xs) => [...xs, config])));

    return {
        factory,
        events: Ref.get(events),
        configs: Ref.get(configs),
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
    probeStudio: Effect.Effect<boolean> = Effect.succeed(true),
) =>
    Layer.succeed(
        AxBackendManager.AxArbitration,
        AxBackendManager.AxArbitration.of({
            probe: Effect.succeed(decision),
            probeStudio,
        }),
    );

const testEnv = {
    bunBinaryPath: "/opt/ax/bun",
    axSourceEntry: "/repo/apps/axctl/src/cli/index.ts",
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
// (a) spawn: starts ax-studio and opens the window
// ---------------------------------------------------------------------------

test("spawn mode starts ax studio and opens the window", async () => {
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
    expect(startOrder).toEqual(["ax-studio"]);
    expect(out.opened).toBe(1);

    const studioCfg = out.configs.find((c) => c.name === "ax-studio");
    expect(studioCfg?.executablePath).toBe("/opt/ax/bun");
    expect(studioCfg?.args).toEqual([
        "/repo/apps/axctl/src/cli/index.ts",
        "studio",
        "--port=1738",
    ]);
    expect(studioCfg?.cwd).toBe("/repo");
    expect(studioCfg?.readiness.url.href).toBe("http://127.0.0.1:1738/api/version");
});

// ---------------------------------------------------------------------------
// (b) attach mode opens the window without spawning
// ---------------------------------------------------------------------------

test("attach mode opens window without spawning a process", async () => {
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
// (c) stop tears down the spawned process
// ---------------------------------------------------------------------------

test("stop tears down the spawned ax studio process", async () => {
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
    expect(stopOrder).toEqual(["ax-studio"]);
});

// ---------------------------------------------------------------------------
// (d) attach mode: poller stays quiet while the attached process stays healthy
// ---------------------------------------------------------------------------

test("attach mode does NOT transition while the attached process stays healthy", async () => {
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
// (e) attach mode: sustained probe failure transitions attach -> spawn
// ---------------------------------------------------------------------------

test("attach mode transitions to spawn after the attached process dies", async () => {
    const program = Effect.gen(function* () {
        const fakeProc = yield* makeFakeProcessFactory;
        const fakeWindow = yield* makeFakeWindow;
        // Probe healthy until the test flips it unhealthy.
        const healthy = yield* Ref.make(true);

        const events = yield* Effect.scoped(
            Effect.gen(function* () {
                const manager = yield* AxBackendManager.AxBackendManager;
                yield* manager.start;
                // Window opened against the external process; nothing spawned yet.
                expect(yield* fakeProc.events).toEqual([]);
                expect(yield* fakeWindow.openCount).toBe(1);

                // The attached process dies. The next two consecutive probes
                // fail (threshold 2), triggering the attach -> spawn takeover.
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

    // The takeover ran the spawn path.
    const startOrder = out.events
        .filter((e) => e.action === "start")
        .map((e) => e.name);
    expect(startOrder).toEqual(["ax-studio"]);
});

// ---------------------------------------------------------------------------
// (f) attach mode: poller torn down by stop -> no transition after stop
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
                // process die and advance well past the failure threshold. The
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
