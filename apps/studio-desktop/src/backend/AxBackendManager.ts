/**
 * Phase 2 / Task 2.3 - single-process backend supervisor.
 *
 * `ax studio` is one ephemeral process that reads a published DuckDB
 * snapshot and self-exits when idle (see
 * `apps/axctl/src/dashboard/server.ts`). `AxBackendManager` owns exactly ONE
 * {@link SupervisedProcess}. On `start` it runs the attach-vs-spawn
 * arbitration ({@link AxDaemonArbitration}) and then:
 *
 * - `attach` -> a healthy `ax studio` is already answering on the port
 *               (another desktop instance, or a manual CLI run). Do NOT
 *               spawn a second one; mark ready and open the window against
 *               it.
 * - `spawn`  -> nothing is answering; spawn our own supervised `ax studio`,
 *               await its readiness, then mark ready and open the window.
 *
 * There is no other process to sequence in front of it, no schema to apply (a
 * published DuckDB snapshot already carries its schema - see
 * `packages/lib/src/duckdb/schema.duckdb.sql`), and no "spawn-ax-only" /
 * "conflict" split: a spawned process that never reports ready within its
 * timeout already IS the conflict signal (see `abortNotReady` below).
 *
 * Attach -> spawn live transition: in `attach` mode we reuse an external
 * `ax studio` process we do NOT supervise. After opening the window the
 * manager forks a readiness poller (into its own scope) that re-probes the
 * attached process every {@link ATTACH_POLL_INTERVAL}; on
 * {@link ATTACH_FAILURE_THRESHOLD} consecutive failed probes (debounced
 * against a transient blip) it logs the takeover and spawns our own
 * supervised process ({@link startSpawn}), then stops polling
 * (`SupervisedProcess` crash-restart covers further failures). The
 * transition is latched (runs at most once), bails during
 * `stopping`/`quitting`, and the poller fiber is torn down by the manager's
 * `stop`/scope so it never leaks or races teardown.
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
    AX_STUDIO_PORT,
    type ArbitrationDecision,
    probeArbitration,
    probeStudio,
} from "./AxDaemonArbitration.ts";
import {
    makeSupervisedProcess,
    type SupervisedProcess,
    type SupervisedProcessConfig,
    type SupervisedProcessHooks,
    type SupervisedProcessSnapshot,
} from "./SupervisedProcess.ts";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** `ax studio` boot can be slow the first time it opens a cold snapshot; give it a full minute. */
const READINESS_TIMEOUT = Duration.seconds(60);

/**
 * Attach-mode readiness poller cadence + debounce. After attaching to an
 * external `ax studio` we re-probe it on this interval; once this many probes
 * fail back-to-back we treat it as gone and transition attach -> spawn. A
 * small grace before the first probe avoids racing a process that is mid-boot.
 */
const ATTACH_POLL_INTERVAL = Duration.seconds(5);
const ATTACH_POLL_INITIAL_GRACE = Duration.seconds(5);
const ATTACH_FAILURE_THRESHOLD = 2;

// ---------------------------------------------------------------------------
// Injectable seams
// ---------------------------------------------------------------------------

/**
 * The factory used to vend the supervised process. Defaults to
 * {@link makeSupervisedProcess}; tests inject a stub that records start/stop
 * without launching a real process.
 */
export type MakeSupervisedProcess = (
    config: SupervisedProcessConfig,
    hooks?: SupervisedProcessHooks,
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
 * probe; tests inject a fixed decision.
 *
 * `probeStudio` is the health probe the attach-mode readiness poller re-runs
 * to detect the external `ax studio` process going away (separate from the
 * boot-time `probe` that turns it into a decision). Exposed on the seam so
 * tests can stub it (healthy -> unhealthy) without hitting the network.
 */
export interface AxArbitrationShape {
    readonly probe: Effect.Effect<ArbitrationDecision, never, HttpClient.HttpClient>;
    readonly probeStudio: Effect.Effect<boolean, never, HttpClient.HttpClient>;
}

export class AxArbitration extends Context.Service<AxArbitration, AxArbitrationShape>()(
    "@ax/studio-desktop/backend/AxArbitration",
) {}

export const arbitrationLayer = Layer.succeed(
    AxArbitration,
    AxArbitration.of({ probe: probeArbitration, probeStudio }),
);

/**
 * Minimal environment the manager needs to build the process config. Derived
 * from {@link DesktopEnvironment} in the live layer; supplied directly in
 * tests so the manager can be exercised without an Electron `app`.
 */
export interface AxBackendEnvironment {
    readonly bunBinaryPath: string;
    readonly axSourceEntry: string;
    /** cwd for `ax studio` (the ax source root: repo root in dev, `ax-src` packaged). */
    readonly axSourceRoot: string;
}

export class AxBackendEnvironmentTag extends Context.Service<
    AxBackendEnvironmentTag,
    AxBackendEnvironment
>()("@ax/studio-desktop/backend/AxBackendEnvironment") {}

/**
 * Derive the ax source root (cwd for `ax studio`) from `axSourceEntry`.
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
            bunBinaryPath: environment.bunBinaryPath,
            axSourceEntry: environment.axSourceEntry,
            axSourceRoot: deriveAxSourceRoot(environment.axSourceEntry, environment.path),
        });
    }),
);

// ---------------------------------------------------------------------------
// Config builder
// ---------------------------------------------------------------------------

/**
 * `ax studio` process config. Runs the ax CLI source through `bun`, reading
 * the published DuckDB snapshot directly (no `AX_DB_*` connection env - there
 * is no daemon to point at any more).
 */
export const makeAxStudioConfig = (env: AxBackendEnvironment): SupervisedProcessConfig => ({
    name: "ax-studio",
    executablePath: env.bunBinaryPath,
    args: [env.axSourceEntry, "studio", `--port=${AX_STUDIO_PORT}`],
    cwd: env.axSourceRoot,
    env: {},
    readiness: {
        url: new URL(`http://127.0.0.1:${AX_STUDIO_PORT}/api/version`),
        timeout: READINESS_TIMEOUT,
    },
});

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface AxBackendManagerSnapshot {
    readonly mode: ArbitrationDecision["mode"] | null;
    readonly studio: SupervisedProcessSnapshot | null;
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
        const studioProc = yield* Ref.make<SupervisedProcess | null>(null);
        // Latched true for the lifetime of `stop`/teardown so the attach
        // poller never spawns while the manager is shutting down.
        const stopping = yield* Ref.make(false);
        // Latched true once the attach -> spawn transition has fired so it can
        // never run twice (the poller stops itself after winning the latch, but
        // the CAS makes the guard robust even if two checks interleave).
        const transitioned = yield* Ref.make(false);

        // Provide the supervised-process deps once; the factory's `Scope` is the
        // manager's parent scope so the process lives as long as the manager.
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

        // Conservative bail when the spawned process never reports ready: log
        // loudly and leave the window closed. A timeout here IS the "something
        // occupies the port and we don't understand it" signal the old
        // arbitration's separate `conflict` mode used to report. Never throws.
        const abortNotReady = logError(
            "ax studio did not report ready within timeout; not opening window",
            { studioPort: AX_STUDIO_PORT },
        );

        const startSpawn = Effect.gen(function* () {
            const studio = yield* buildProcess(makeAxStudioConfig(env));
            yield* Ref.set(studioProc, studio);
            yield* studio.start;
            const ready = yield* awaitReady(studio);
            if (!ready) {
                yield* abortNotReady;
                return;
            }
            yield* markReadyAndOpenWindow;
        });

        // ---- Attach -> spawn live transition -------------------------------
        //
        // In `attach` mode we reuse the external `ax studio` process and own
        // none of its lifecycle; if it dies the window is pointed at a dead
        // backend. The poller below re-probes it and, on a sustained failure,
        // takes over by spawning our own supervised process.

        // Run the takeover at most once. Wins the `transitioned` latch via CAS
        // (compare-and-set); if it was already set, another path beat us - no-op.
        const transitionAttachToSpawn = Effect.gen(function* () {
            if (yield* Ref.get(stopping)) {
                return false;
            }
            if (yield* Ref.get(desktopState.quitting)) {
                return false;
            }
            const won = yield* Ref.modify(transitioned, (already) =>
                already ? [false, already] : [true, true],
            );
            if (!won) {
                return false;
            }
            yield* logInfo("attached ax studio went away; transitioning attach->spawn", {
                studioPort: AX_STUDIO_PORT,
            });
            yield* Ref.set(mode, "spawn");
            // Bring up our own supervised process. From here SupervisedProcess
            // crash-restart covers further failures, so the caller stops the
            // poller once this returns true.
            yield* startSpawn;
            return true;
        });

        // One poll tick: re-probe the attached process, tracking consecutive
        // failures in `failures`. Returns `true` once the transition has fired
        // (signals the repeat loop to stop). Probe failures are total (the probe
        // collapses errors to `false`), so this never fails the fiber.
        const pollTick = (failures: Ref.Ref<number>): Effect.Effect<boolean> =>
            Effect.gen(function* () {
                if (yield* Ref.get(stopping)) {
                    return true;
                }
                if (yield* Ref.get(desktopState.quitting)) {
                    return true;
                }
                const healthy = yield* arbitration.probeStudio.pipe(
                    Effect.provideService(HttpClient.HttpClient, httpClient),
                );
                if (healthy) {
                    yield* Ref.set(failures, 0);
                    return false;
                }
                const consecutive = yield* Ref.updateAndGet(failures, (n) => n + 1);
                yield* logInfo("attached ax studio probe failed", {
                    consecutive,
                    threshold: ATTACH_FAILURE_THRESHOLD,
                });
                if (consecutive < ATTACH_FAILURE_THRESHOLD) {
                    return false;
                }
                return yield* transitionAttachToSpawn;
            });

        // The full poller: an initial grace, then repeat `pollTick` on a fixed
        // cadence until it returns `true` (transition fired or teardown began).
        // Forked into the manager's parent scope so `stop`/scope-close interrupts
        // it cleanly (no leaked fiber); the repeat is naturally interruptible at
        // every `sleep`.
        const attachReadinessPoller = Effect.gen(function* () {
            const failures = yield* Ref.make(0);
            yield* Effect.sleep(ATTACH_POLL_INITIAL_GRACE);
            yield* pollTick(failures).pipe(
                Effect.repeat({
                    schedule: Schedule.spaced(ATTACH_POLL_INTERVAL),
                    until: (done) => done,
                }),
            );
        }).pipe(
            Effect.catchCause((cause) =>
                logError("attach readiness poller failed", { cause: String(cause) }),
            ),
        );

        const start: Effect.Effect<void> = Effect.gen(function* () {
            const decision = yield* arbitration.probe.pipe(
                Effect.provideService(HttpClient.HttpClient, httpClient),
            );
            yield* Ref.set(mode, decision.mode);
            yield* logInfo("arbitration decided", { mode: decision.mode });

            switch (decision.mode) {
                case "attach":
                    // A healthy ax studio already owns the port. We do not own
                    // its lifecycle, so attach the window to it AND fork a
                    // readiness poller that takes over (attach -> spawn) if it
                    // dies. Forked into the manager's parent scope so
                    // `stop`/scope-close interrupts it (no leaked fiber).
                    yield* markReadyAndOpenWindow;
                    yield* Effect.forkIn(attachReadinessPoller, parentScope);
                    return;
                case "spawn":
                    yield* startSpawn;
                    return;
            }
        }).pipe(Effect.withSpan("ax.backendManager.start"));

        const stop: AxBackendManagerShape["stop"] = (options) =>
            Effect.gen(function* () {
                // Latch the teardown flag first so a concurrent attach poller
                // tick bails instead of transitioning mid-shutdown.
                yield* Ref.set(stopping, true);
                // Take + clear the handle atomically so the scope-close finalizer
                // can't double-stop after an explicit stop (idempotent).
                const current = yield* Ref.getAndSet(studioProc, null);
                yield* Ref.set(desktopState.backendReady, false);
                if (current) {
                    yield* current.stop(options);
                }
            }).pipe(Effect.withSpan("ax.backendManager.stop"));

        const snapshot: Effect.Effect<AxBackendManagerSnapshot> = Effect.gen(
            function* () {
                const current = yield* Ref.get(studioProc);
                return {
                    mode: yield* Ref.get(mode),
                    studio: current ? yield* current.snapshot : null,
                } satisfies AxBackendManagerSnapshot;
            },
        );

        // Drain on scope close (quit).
        yield* Effect.addFinalizer(() => stop());

        return AxBackendManager.of({ start, stop, snapshot });
    });

/** Poll interval + cap for the readiness gate while spawning. */
const READINESS_POLL_INTERVAL = Duration.millis(100);
const READINESS_POLL_TIMEOUT = Duration.seconds(65);

/**
 * Await the supervised process becoming ready. `SupervisedProcess` forks its
 * own readiness probe + flips `ready` on its snapshot; here we poll that
 * snapshot.
 *
 * Bounded by {@link READINESS_POLL_TIMEOUT} (slightly above the process's own
 * 60s readiness timeout). Returns `true` once it reports ready, or `false` if
 * it never does within the timeout (the caller gates progression on this so a
 * never-ready process does not open the window over a dead backend). Never
 * fails.
 */
const awaitReady = (proc: SupervisedProcess): Effect.Effect<boolean> =>
    proc.snapshot.pipe(
        Effect.flatMap((snap) =>
            snap.ready ? Effect.void : Effect.fail(new Error("ax studio not ready yet")),
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
export const liveLayer = layer(makeSupervisedProcess).pipe(
    Layer.provide(arbitrationLayer),
    Layer.provide(environmentLayer),
);
