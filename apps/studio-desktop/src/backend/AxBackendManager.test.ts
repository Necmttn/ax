import { expect, test } from "bun:test";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
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
 * Build a stub `makeProcess` factory that records start/stop ordering across
 * every supervised process it vends, and never touches a real OS process.
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

const arbitrationLayer = (decision: ArbitrationDecision) =>
    Layer.succeed(
        AxBackendManager.AxArbitration,
        AxBackendManager.AxArbitration.of({ probe: Effect.succeed(decision) }),
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
