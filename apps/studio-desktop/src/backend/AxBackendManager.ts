/**
 * Phase 2 / Task 2.3 - two-process backend supervisor.
 *
 * `AxBackendManager` owns the ax daemon pair for the desktop app. On `start` it
 * runs the attach-vs-spawn arbitration ({@link AxDaemonArbitration}) and then:
 *
 * - `attach`        -> a healthy CLI daemon pair is already running; do NOT
 *                      spawn anything. Mark the backend ready and open the
 *                      window against the existing pair.
 * - `spawn`         -> nothing is listening; spawn `surreal` then (once it is
 *                      HTTP-ready) `ax serve`, then mark ready + open the window.
 * - `spawn-ax-only` -> an existing healthy `surreal` is up but `ax serve` is
 *                      down; spawn only `ax serve` against the existing surreal.
 * - `conflict`      -> the ports are taken by something we don't understand; do
 *                      NOT stomp it. Log + leave the window closed (no dialog in
 *                      v0 - see the conflict branch below).
 *
 * Each daemon is an independent {@link SupervisedProcess} (spawn + HTTP
 * readiness + exponential-backoff restart). The manager sequences them
 * (surreal gates ax-serve) and tears them down in REVERSE order on `stop`
 * (ax serve before surreal) so ax serve closes its DB connection before the DB
 * disappears.
 *
 * The two supervised processes are vended through an injectable factory
 * ({@link MakeSupervisedProcess}, defaulting to {@link makeSupervisedProcess})
 * so unit tests can stub start/stop without launching real OS processes.
 *
 * Crash-restart ordering: each `SupervisedProcess` restarts itself on crash. ax
 * serve reconnects to surreal on boot, so a surreal restart does not require a
 * manual ax-serve bounce in the steady state. A belt-and-suspenders surreal
 * `onExit` hook that proactively bounces ax serve is NOT wired yet - it is
 * deferred (see TODO in `startSpawn`) because `MakeSupervisedProcess` does not
 * accept lifecycle hooks. Steady-state recovery therefore relies on each
 * process's own self-restart plus ax-serve's reconnect-on-boot.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import {
    AX_SERVE_PORT,
    type ArbitrationDecision,
    probeArbitration,
    SURREAL_PORT,
} from "./AxDaemonArbitration.ts";
import {
    makeSupervisedProcess,
    type SupervisedProcess,
    type SupervisedProcessConfig,
    type SupervisedProcessSnapshot,
} from "./SupervisedProcess.ts";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Daemon boot can be slow on a cold rocksdb; give each process a full minute. */
const READINESS_TIMEOUT = Duration.seconds(60);

// ---------------------------------------------------------------------------
// Injectable seams
// ---------------------------------------------------------------------------

/**
 * The factory used to vend a single supervised process. Defaults to
 * {@link makeSupervisedProcess}; tests inject a stub that records start/stop
 * without launching a real process.
 */
export type MakeSupervisedProcess = (
    config: SupervisedProcessConfig,
) => Effect.Effect<
    SupervisedProcess,
    never,
    | ChildProcessSpawner.ChildProcessSpawner
    | HttpClient.HttpClient
    | DesktopObservability.DesktopBackendOutputLog
    | Scope.Scope
>;

/**
 * Arbitration seam. The live layer runs the real {@link probeArbitration}
 * probes; tests inject a fixed decision.
 */
export interface AxArbitrationShape {
    readonly probe: Effect.Effect<ArbitrationDecision, never, HttpClient.HttpClient>;
}

export class AxArbitration extends Context.Service<AxArbitration, AxArbitrationShape>()(
    "@ax/studio-desktop/backend/AxArbitration",
) {}

export const arbitrationLayer = Layer.succeed(
    AxArbitration,
    AxArbitration.of({ probe: probeArbitration }),
);

/**
 * Minimal environment the manager needs to build the two process configs.
 * Derived from {@link DesktopEnvironment} in the live layer; supplied directly
 * in tests so the manager can be exercised without an Electron `app`.
 */
export interface AxBackendEnvironment {
    readonly surrealBinaryPath: string;
    readonly bunBinaryPath: string;
    readonly axSourceEntry: string;
    readonly axDataDir: string;
    /** cwd for `ax serve` (the ax source root: repo root in dev, `ax-src` packaged). */
    readonly axSourceRoot: string;
}

export class AxBackendEnvironmentTag extends Context.Service<
    AxBackendEnvironmentTag,
    AxBackendEnvironment
>()("@ax/studio-desktop/backend/AxBackendEnvironment") {}

/**
 * Derive the ax source root (cwd for `ax serve`) from `axSourceEntry`.
 * `<root>/apps/axctl/src/cli/index.ts` -> up four dirs from `dirname` -> `<root>`.
 */
export const deriveAxSourceRoot = (
    axSourceEntry: string,
    path: DesktopEnvironment.DesktopEnvironmentShape["path"],
): string => path.resolve(path.dirname(axSourceEntry), "..", "..", "..", "..");

export const environmentLayer = Layer.effect(
    AxBackendEnvironmentTag,
    Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        return AxBackendEnvironmentTag.of({
            surrealBinaryPath: environment.surrealBinaryPath,
            bunBinaryPath: environment.bunBinaryPath,
            axSourceEntry: environment.axSourceEntry,
            axDataDir: environment.axDataDir,
            axSourceRoot: deriveAxSourceRoot(environment.axSourceEntry, environment.path),
        });
    }),
);

// ---------------------------------------------------------------------------
// Config builders
// ---------------------------------------------------------------------------

/**
 * surreal process config. `--allow-experimental=files` is required for ax's v3
 * file buckets; rocksdb lives at `<axDataDir>/db`, agreeing with the CLI daemon
 * (`scripts/db-start.sh`).
 */
export const makeSurrealConfig = (env: AxBackendEnvironment): SupervisedProcessConfig => ({
    name: "surreal",
    executablePath: env.surrealBinaryPath,
    args: [
        "start",
        "--user",
        "root",
        "--pass",
        "root",
        "--bind",
        `127.0.0.1:${SURREAL_PORT}`,
        "--log",
        "info",
        "--allow-experimental=files",
        `rocksdb://${env.axDataDir}/db`,
    ],
    cwd: env.axSourceRoot,
    env: {},
    readiness: {
        url: new URL(`http://127.0.0.1:${SURREAL_PORT}/health`),
        timeout: READINESS_TIMEOUT,
    },
});

/**
 * `ax serve` process config. Runs the ax CLI source through `bun`, pointed at
 * the surreal we (or the existing daemon) brought up via the canonical
 * `AX_DB_*` env defaults from `@ax/lib`.
 */
export const makeAxServeConfig = (env: AxBackendEnvironment): SupervisedProcessConfig => ({
    name: "ax-serve",
    executablePath: env.bunBinaryPath,
    args: [env.axSourceEntry, "serve", `--port=${AX_SERVE_PORT}`],
    cwd: env.axSourceRoot,
    env: {
        // Mirror packages/lib/src/db.ts envConfig() defaults so ax serve and the
        // surreal we spawn agree on the connection.
        AX_DB_URL: `ws://127.0.0.1:${SURREAL_PORT}`,
        AX_DB_NS: "ax",
        AX_DB_DB: "main",
    },
    readiness: {
        url: new URL(`http://127.0.0.1:${AX_SERVE_PORT}/api/version`),
        timeout: READINESS_TIMEOUT,
    },
});

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface AxBackendManagerSnapshot {
    readonly mode: ArbitrationDecision["mode"] | null;
    readonly surreal: SupervisedProcessSnapshot | null;
    readonly axServe: SupervisedProcessSnapshot | null;
}

export interface AxBackendManagerShape {
    readonly start: Effect.Effect<void>;
    readonly stop: (options?: {
        readonly timeout?: Duration.Duration;
    }) => Effect.Effect<void>;
    readonly snapshot: Effect.Effect<AxBackendManagerSnapshot>;
}

export class AxBackendManager extends Context.Service<
    AxBackendManager,
    AxBackendManagerShape
>()("@ax/studio-desktop/backend/AxBackendManager") {}

const { logInfo, logError } =
    DesktopObservability.makeComponentLogger("ax-backend-manager");

interface ManagerProcesses {
    readonly surreal: SupervisedProcess | null;
    readonly axServe: SupervisedProcess | null;
}

const make = (makeProcess: MakeSupervisedProcess) =>
    Effect.gen(function* () {
        const parentScope = yield* Scope.Scope;
        const arbitration = yield* AxArbitration;
        const env = yield* AxBackendEnvironmentTag;
        const desktopState = yield* DesktopState.DesktopState;
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const httpClient = yield* HttpClient.HttpClient;
        const backendOutputLog = yield* DesktopObservability.DesktopBackendOutputLog;

        const mode = yield* Ref.make<ArbitrationDecision["mode"] | null>(null);
        const procs = yield* Ref.make<ManagerProcesses>({
            surreal: null,
            axServe: null,
        });

        // Provide the supervised-process deps once; the factory's `Scope` is the
        // manager's parent scope so processes live as long as the manager.
        const buildProcess = (config: SupervisedProcessConfig) =>
            makeProcess(config).pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                Effect.provideService(HttpClient.HttpClient, httpClient),
                Effect.provideService(
                    DesktopObservability.DesktopBackendOutputLog,
                    backendOutputLog,
                ),
                Scope.provide(parentScope),
            );

        const markReadyAndOpenWindow = Effect.gen(function* () {
            yield* Ref.set(desktopState.backendReady, true);
            yield* desktopWindow.handleBackendReady.pipe(
                Effect.catch((error) =>
                    logError("failed to open main window after backend readiness", {
                        message: error.message,
                    }),
                ),
            );
        });

        // Conservative bail when a spawned process never reports ready: log
        // loudly and leave the window closed (mirrors the `conflict` branch's
        // handling). We do NOT start downstream processes or open the window
        // over a backend that never came up. Never throws.
        const abortNotReady = (name: string) =>
            logError(
                "backend process did not report ready within timeout; not opening window",
                { process: name, surrealPort: SURREAL_PORT, axServePort: AX_SERVE_PORT },
            );

        const startSpawn = (withSurreal: boolean) =>
            Effect.gen(function* () {
                let surreal: SupervisedProcess | null = null;
                if (withSurreal) {
                    surreal = yield* buildProcess(makeSurrealConfig(env));
                    yield* Ref.update(procs, (p) => ({ ...p, surreal }));
                    // Start surreal and await its readiness before ax serve so
                    // ax serve never races a missing DB. If surreal never
                    // reports ready, bail conservatively: do not start ax serve,
                    // do not open the window over a dead backend.
                    yield* surreal.start;
                    const surrealReady = yield* awaitReady(surreal, "surreal");
                    if (!surrealReady) {
                        yield* abortNotReady("surreal");
                        return;
                    }
                }

                const axServe = yield* buildProcess(makeAxServeConfig(env));
                yield* Ref.update(procs, (p) => ({ ...p, axServe }));
                yield* axServe.start;
                const axServeReady = yield* awaitReady(axServe, "ax-serve");
                if (!axServeReady) {
                    yield* abortNotReady("ax-serve");
                    return;
                }

                yield* markReadyAndOpenWindow;

                // TODO(phase-2): crash-restart ordering refinements.
                //  1. surreal-crash -> ax-serve bounce. Each SupervisedProcess
                //     already self-restarts on crash, and ax serve reconnects to
                //     surreal on boot, so the steady state recovers without help.
                //     A belt-and-suspenders bounce (surreal `onExit` hook ->
                //     axServe.stop()+start) would need `makeProcess` to accept
                //     SupervisedProcessHooks; deferred to keep the test seam thin.
                //  2. attach -> spawn live transition. AxDaemonArbitration's
                //     residual note: if an ATTACHED CLI daemon dies, a periodic
                //     re-probe should fall back to spawn. Not wired yet.
            });

        const start: Effect.Effect<void> = Effect.gen(function* () {
            const decision = yield* arbitration.probe.pipe(
                Effect.provideService(HttpClient.HttpClient, httpClient),
            );
            yield* Ref.set(mode, decision.mode);
            yield* logInfo("arbitration decided", { mode: decision.mode });

            switch (decision.mode) {
                case "attach":
                    // A healthy CLI daemon pair already owns the ports. We do not
                    // own its lifecycle (see AxDaemonArbitration residual note);
                    // just attach the window to it.
                    yield* markReadyAndOpenWindow;
                    return;
                case "spawn":
                    yield* startSpawn(true);
                    return;
                case "spawn-ax-only":
                    yield* startSpawn(false);
                    return;
                case "conflict":
                    // Ports occupied by something unhealthy we don't understand.
                    // Conservative: surface it loudly and leave the window closed.
                    // No ElectronDialog service exists in v0; a minimal error
                    // dialog is deferred (Task 2.4 manual gate / future work).
                    yield* logError(
                        "daemon arbitration conflict: ports occupied by an unhealthy process; not starting backend",
                        { surrealPort: SURREAL_PORT, axServePort: AX_SERVE_PORT },
                    );
                    return;
            }
        }).pipe(Effect.withSpan("ax.backendManager.start"));

        const stop: AxBackendManagerShape["stop"] = (options) =>
            Effect.gen(function* () {
                // Take + clear the handles atomically so the scope-close finalizer
                // can't double-stop after an explicit stop (idempotent).
                const current = yield* Ref.getAndSet(procs, {
                    surreal: null,
                    axServe: null,
                });
                yield* Ref.set(desktopState.backendReady, false);
                // Reverse order: ax serve closes its DB connection before surreal
                // (the DB) goes away.
                if (current.axServe) {
                    yield* current.axServe.stop(options);
                }
                if (current.surreal) {
                    yield* current.surreal.stop(options);
                }
            }).pipe(Effect.withSpan("ax.backendManager.stop"));

        const snapshot: Effect.Effect<AxBackendManagerSnapshot> = Effect.gen(
            function* () {
                const current = yield* Ref.get(procs);
                return {
                    mode: yield* Ref.get(mode),
                    surreal: current.surreal ? yield* current.surreal.snapshot : null,
                    axServe: current.axServe ? yield* current.axServe.snapshot : null,
                } satisfies AxBackendManagerSnapshot;
            },
        );

        // Drain both on scope close (quit) - ax serve before surreal.
        yield* Effect.addFinalizer(() => stop());

        return AxBackendManager.of({ start, stop, snapshot });
    });

/** Poll interval + cap for the readiness gate between surreal and ax serve. */
const READINESS_POLL_INTERVAL = Duration.millis(100);
const READINESS_POLL_TIMEOUT = Duration.seconds(65);

/**
 * Await a supervised process becoming ready. The SupervisedProcess forks its
 * own readiness probe + flips `ready` on its snapshot; here we poll that
 * snapshot so the manager can SEQUENCE surreal -> ax serve.
 *
 * Bounded by {@link READINESS_POLL_TIMEOUT} (slightly above the process's own
 * 60s readiness timeout). Returns `true` once the process reports ready, or
 * `false` if it never does within the timeout (the caller gates progression on
 * this so a never-ready daemon does not open the window over a dead backend).
 * Never fails.
 */
const awaitReady = (
    proc: SupervisedProcess,
    name: string,
): Effect.Effect<boolean> =>
    proc.snapshot.pipe(
        Effect.flatMap((snap) =>
            snap.ready
                ? Effect.void
                : Effect.fail(new Error(`${name} not ready yet`)),
        ),
        Effect.retry(Schedule.spaced(READINESS_POLL_INTERVAL)),
        Effect.timeout(READINESS_POLL_TIMEOUT),
        Effect.as(true),
        Effect.orElseSucceed(() => false),
    );

/**
 * Public layer constructor. Pass a custom {@link MakeSupervisedProcess} for
 * tests; production omits it (defaults to {@link makeSupervisedProcess}).
 *
 * Requires `AxArbitration`, `AxBackendEnvironmentTag`, `DesktopState`,
 * `DesktopWindow`, `ChildProcessSpawner`, `HttpClient`, and
 * `DesktopBackendOutputLog` to be provided by the caller. The {@link liveLayer}
 * bundles the live arbitration + environment derivations.
 */
export const layer = (makeProcess: MakeSupervisedProcess = makeSupervisedProcess) =>
    Layer.effect(AxBackendManager, make(makeProcess));

/**
 * Live layer: the real supervisor wired with live arbitration + the
 * `DesktopEnvironment`-derived backend environment. Leaves the platform deps
 * (`ChildProcessSpawner`, `HttpClient`, `DesktopBackendOutputLog`,
 * `DesktopState`, `DesktopWindow`, `DesktopEnvironment`) to `main.ts`.
 */
export const liveLayer = layer().pipe(
    Layer.provide(arbitrationLayer),
    Layer.provide(environmentLayer),
);
