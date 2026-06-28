/**
 * Generic single-process supervisor.
 *
 * Spawns one child process, drains its stdout/stderr into the
 * {@link DesktopBackendOutputLog}, waits for an HTTP readiness probe, and
 * restarts the child with exponential backoff if it exits while the supervisor
 * still wants it running.
 *
 * This module is intentionally free of any surreal / ax-serve specifics: the
 * caller supplies the executable, args, cwd, env, and a readiness URL. Task 2.3
 * instantiates this twice (surreal, ax-serve).
 *
 * The patterns (Scope / Fiber / Ref / Semaphore lifecycle, exponential backoff,
 * HTTP readiness via `HttpClient.filterStatusOk` + `Schedule.spaced`) mirror
 * t3code's `DesktopBackendManager`, but the bootstrap-fd JSON mechanism is
 * dropped - ax passes configuration via argv/env.
 */
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopObservability from "../app/DesktopObservability.ts";

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

export const INITIAL_RESTART_DELAY = Duration.millis(500);
export const MAX_RESTART_DELAY = Duration.seconds(10);
const DEFAULT_READINESS_INTERVAL = Duration.millis(100);
const DEFAULT_READINESS_REQUEST_TIMEOUT = Duration.seconds(1);
const DEFAULT_TERMINATE_GRACE = Duration.seconds(2);

// ---------------------------------------------------------------------------
// Config + public shapes
// ---------------------------------------------------------------------------

export interface SupervisedProcessConfig {
    readonly name: string;
    readonly executablePath: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly env: Record<string, string | undefined>;
    readonly readiness: {
        readonly url: URL;
        readonly timeout: Duration.Duration;
    };
    /**
     * Optional liveness watchdog. The startup readiness probe only fires once;
     * a child that comes up and later WEDGES (process alive, not answering -
     * the recurring SurrealDB failure) never exits, so the exit->restart path
     * never triggers and the daemon stays dead-but-running forever.
     *
     * When set, the supervisor runs `probe` every `interval` once the child is
     * ready, each capped at `timeout`. On `failureThreshold` CONSECUTIVE failed
     * or timed-out probes it classifies the child as wedged and SIGKILLs the
     * pid, which resolves its exitCode and feeds the existing exit->restart
     * backoff (LaunchAgent / SupervisedProcess respawn). One success resets the
     * counter. Keyed on probe timeouts, NOT CPU - a wedged daemon can sit at any
     * CPU level. The probe is supplied by the caller (so this module stays free
     * of surreal/ax-serve specifics) and must be fully provided (no env): e.g.
     * `HEAD /health` AND a tiny `RETURN 1` SQL round-trip, both with deadlines.
     */
    readonly liveness?: {
        readonly probe: Effect.Effect<void, unknown>;
        readonly interval: Duration.Duration;
        readonly timeout: Duration.Duration;
        readonly failureThreshold: number;
    };
}

export interface SupervisedProcessSnapshot {
    readonly ready: boolean;
    readonly activePid: number | null;
    readonly restartAttempt: number;
}

export type SupervisedProcessOutputStream = "stdout" | "stderr";

export interface SupervisedProcessHooks {
    readonly onReady?: () => Effect.Effect<void>;
    readonly onExit?: (info: {
        readonly pid: number | null;
        readonly reason: string;
    }) => Effect.Effect<void>;
}

export interface SupervisedProcess {
    readonly start: Effect.Effect<void>;
    readonly stop: (options?: {
        readonly timeout?: Duration.Duration;
    }) => Effect.Effect<void>;
    readonly snapshot: Effect.Effect<SupervisedProcessSnapshot>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SupervisedProcessTimeoutError extends Data.TaggedError(
    "SupervisedProcessTimeoutError",
)<{
    readonly url: URL;
}> {
    override get message() {
        return `Timed out waiting for process readiness at ${this.url.href}.`;
    }
}

class SupervisedProcessSpawnError extends Data.TaggedError(
    "SupervisedProcessSpawnError",
)<{
    readonly cause: PlatformError.PlatformError;
}> {
    override get message() {
        return `Failed to spawn supervised process: ${this.cause.message}`;
    }
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface ActiveRun {
    readonly id: number;
    readonly scope: Scope.Closeable;
    readonly fiber: Option.Option<Fiber.Fiber<void, never>>;
    readonly pid: Option.Option<number>;
}

interface SupervisorState {
    readonly desiredRunning: boolean;
    readonly ready: boolean;
    readonly active: Option.Option<ActiveRun>;
    readonly restartAttempt: number;
    readonly restartFiber: Option.Option<Fiber.Fiber<void, never>>;
    readonly nextRunId: number;
}

const initialState: SupervisorState = {
    desiredRunning: false,
    ready: false,
    active: Option.none(),
    restartAttempt: 0,
    restartFiber: Option.none(),
    nextRunId: 1,
};

const activePid = (active: Option.Option<ActiveRun>): Option.Option<number> =>
    Option.flatMap(active, (run) => run.pid);

const withActiveRun =
    (runId: number, f: (run: ActiveRun) => ActiveRun) =>
    (state: SupervisorState): SupervisorState => ({
        ...state,
        active: Option.map(state.active, (run) =>
            run.id === runId ? f(run) : run,
        ),
    });

const calculateRestartDelay = (attempt: number): Duration.Duration =>
    Duration.min(
        Duration.times(INITIAL_RESTART_DELAY, 2 ** attempt),
        MAX_RESTART_DELAY,
    );

const closeRun = (
    run: ActiveRun,
    options?: { readonly timeout?: Duration.Duration },
): Effect.Effect<void> => {
    const waitForFiber = Option.match(run.fiber, {
        onNone: () => Effect.void,
        onSome: (fiber) => Fiber.await(fiber).pipe(Effect.asVoid),
    });
    const close = Scope.close(run.scope, Exit.void).pipe(
        Effect.andThen(waitForFiber),
    );

    return (
        options?.timeout
            ? close.pipe(Effect.timeoutOption(options.timeout), Effect.asVoid)
            : close
    ).pipe(Effect.ignore);
};

// ---------------------------------------------------------------------------
// Readiness probe + child run
// ---------------------------------------------------------------------------

interface ProcessExit {
    readonly reason: string;
    readonly result: Result.Result<
        ChildProcessSpawner.ExitCode,
        PlatformError.PlatformError
    >;
}

const waitForHttpReady = Effect.fn("supervisedProcess.waitForHttpReady")(
    function* (
        url: URL,
        timeout: Duration.Duration,
    ): Effect.fn.Return<
        void,
        SupervisedProcessTimeoutError,
        HttpClient.HttpClient
    > {
        const client = (yield* HttpClient.HttpClient).pipe(
            HttpClient.filterStatusOk,
            HttpClient.transformResponse(
                Effect.timeout(DEFAULT_READINESS_REQUEST_TIMEOUT),
            ),
            HttpClient.retry(Schedule.spaced(DEFAULT_READINESS_INTERVAL)),
        );

        yield* client.get(url).pipe(
            Effect.asVoid,
            Effect.timeout(timeout),
            Effect.mapError(() => new SupervisedProcessTimeoutError({ url })),
        );
    },
);

function describeProcessExit(
    result: Result.Result<
        ChildProcessSpawner.ExitCode,
        PlatformError.PlatformError
    >,
): ProcessExit {
    if (Result.isSuccess(result)) {
        return { reason: `code=${result.success}`, result };
    }
    return { reason: result.failure.message, result };
}

function drainOutput(
    streamName: SupervisedProcessOutputStream,
    stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
    onOutput: (
        streamName: SupervisedProcessOutputStream,
        chunk: Uint8Array,
    ) => Effect.Effect<void>,
): Effect.Effect<void> {
    return stream.pipe(
        Stream.runForEach((chunk) => onOutput(streamName, chunk)),
        Effect.ignore,
    );
}

interface RunChildOptions {
    readonly config: SupervisedProcessConfig;
    readonly onStarted: (pid: number) => Effect.Effect<void>;
    readonly onReady: () => Effect.Effect<void>;
    readonly onReadinessFailure: (
        error: SupervisedProcessTimeoutError,
    ) => Effect.Effect<void>;
    readonly onOutput: (
        streamName: SupervisedProcessOutputStream,
        chunk: Uint8Array,
    ) => Effect.Effect<void>;
    /**
     * Reports each liveness watchdog outcome: a failed/timed-out probe
     * (`wedged: false` until the threshold, `wedged: true` on the kill) or a
     * recovery (`consecutive: 0`). No-op when no liveness config is set.
     */
    readonly onLivenessEvent: (info: {
        readonly consecutive: number;
        readonly wedged: boolean;
    }) => Effect.Effect<void>;
}

/**
 * Periodic liveness watchdog: probe every `interval` (each capped at
 * `timeout`); on `failureThreshold` CONSECUTIVE failures, SIGKILL the child so
 * its exitCode resolves and the supervisor's exit->restart path reaps the
 * wedged daemon. A single success resets the counter. Returns when it has
 * killed the child (or is interrupted by the run scope closing on stop/restart).
 */
const runLivenessWatchdog = (
    liveness: NonNullable<SupervisedProcessConfig["liveness"]>,
    handle: ChildProcessSpawner.ChildProcessHandle,
    onEvent: RunChildOptions["onLivenessEvent"],
): Effect.Effect<void> =>
    Effect.gen(function* () {
        const failures = yield* Ref.make(0);
        const loop: Effect.Effect<void> = Effect.suspend(() =>
            Effect.gen(function* () {
                yield* Effect.sleep(liveness.interval);
                // Any probe error OR a per-probe timeout counts as a failure.
                const failed = yield* liveness.probe.pipe(
                    Effect.timeout(liveness.timeout),
                    Effect.as(false),
                    Effect.catch(() => Effect.succeed(true)),
                );
                if (!failed) {
                    yield* Ref.set(failures, 0);
                    yield* onEvent({ consecutive: 0, wedged: false });
                    return yield* loop;
                }
                const n = yield* Ref.updateAndGet(failures, (x) => x + 1);
                const wedged = n >= liveness.failureThreshold;
                yield* onEvent({ consecutive: n, wedged });
                if (!wedged) return yield* loop;
                // Wedged: force-kill so the exit->restart path reaps it. SIGKILL
                // (not SIGTERM) because a wedged process may ignore graceful
                // signals - the whole point is that it stopped responding.
                yield* handle
                    .kill({ killSignal: "SIGKILL" })
                    .pipe(Effect.ignore);
            }),
        );
        yield* loop;
    });

const runChildProcess = Effect.fn("supervisedProcess.runChildProcess")(
    function* (
        options: RunChildOptions,
    ): Effect.fn.Return<
        ProcessExit,
        SupervisedProcessSpawnError,
        ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient | Scope.Scope
    > {
        const { config } = options;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const command = ChildProcess.make(config.executablePath, config.args, {
            cwd: config.cwd,
            env: config.env,
            extendEnv: true,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            killSignal: "SIGTERM",
            forceKillAfter: DEFAULT_TERMINATE_GRACE,
        });

        const handle = yield* spawner
            .spawn(command)
            .pipe(
                Effect.mapError(
                    (cause) => new SupervisedProcessSpawnError({ cause }),
                ),
            );

        yield* options.onStarted(handle.pid);
        yield* drainOutput("stdout", handle.stdout, options.onOutput).pipe(
            Effect.forkScoped,
        );
        yield* drainOutput("stderr", handle.stderr, options.onOutput).pipe(
            Effect.forkScoped,
        );
        yield* waitForHttpReady(
            config.readiness.url,
            config.readiness.timeout,
        ).pipe(
            Effect.tap(() => options.onReady()),
            // Once ready, keep probing for liveness so a wedged-but-alive child
            // gets reaped (it would otherwise never exit). Runs in the same run
            // scope, so stop/restart interrupts it.
            Effect.flatMap(() =>
                config.liveness
                    ? runLivenessWatchdog(
                          config.liveness,
                          handle,
                          options.onLivenessEvent,
                      )
                    : Effect.void,
            ),
            Effect.catch((error) => options.onReadinessFailure(error)),
            Effect.forkScoped,
        );

        return describeProcessExit(yield* Effect.result(handle.exitCode));
    },
);

// ---------------------------------------------------------------------------
// Supervisor factory
// ---------------------------------------------------------------------------

export const makeSupervisedProcess = Effect.fn("makeSupervisedProcess")(
    function* (
        config: SupervisedProcessConfig,
        hooks: SupervisedProcessHooks = {},
    ): Effect.fn.Return<
        SupervisedProcess,
        never,
        | ChildProcessSpawner.ChildProcessSpawner
        | HttpClient.HttpClient
        | DesktopObservability.DesktopBackendOutputLog
        | Scope.Scope
    > {
        const parentScope = yield* Scope.Scope;
        const backendOutputLog = yield* DesktopObservability.DesktopBackendOutputLog;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const httpClient = yield* HttpClient.HttpClient;
        const state = yield* Ref.make(initialState);
        const mutex = yield* Semaphore.make(1);

        const { logWarning, logError } =
            DesktopObservability.makeComponentLogger(
                `supervised-process:${config.name}`,
            );

        const updateActiveRun = (
            runId: number,
            f: (run: ActiveRun) => ActiveRun,
        ) => Ref.update(state, withActiveRun(runId, f));

        const snapshot = Ref.get(state).pipe(
            Effect.map(
                (current): SupervisedProcessSnapshot => ({
                    ready: current.ready,
                    activePid: Option.getOrNull(activePid(current.active)),
                    restartAttempt: current.restartAttempt,
                }),
            ),
        );

        const cancelRestart = Effect.gen(function* () {
            const restartFiber = yield* Ref.modify(state, (current) => [
                current.restartFiber,
                { ...current, restartFiber: Option.none() },
            ]);
            yield* Option.match(restartFiber, {
                onNone: () => Effect.void,
                onSome: (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid),
            });
        });

        // Forward declaration so `start` and `scheduleRestart` can refer to
        // each other.
        let scheduleRestart: (reason: string) => Effect.Effect<void>;

        const start: Effect.Effect<void> = Effect.suspend(() =>
            mutex.withPermits(1)(
                Effect.gen(function* () {
                    const current = yield* Ref.get(state);
                    if (Option.isSome(current.active)) {
                        return;
                    }

                    yield* cancelRestart;
                    yield* Ref.update(state, (latest) => ({
                        ...latest,
                        desiredRunning: true,
                        ready: false,
                    }));

                    const runScope = yield* Scope.make("sequential");
                    const runId = yield* Ref.modify(state, (latest) => [
                        latest.nextRunId,
                        {
                            ...latest,
                            active: Option.some({
                                id: latest.nextRunId,
                                scope: runScope,
                                fiber: Option.none(),
                                pid: Option.none(),
                            } satisfies ActiveRun),
                            nextRunId: latest.nextRunId + 1,
                        },
                    ]);

                    const finalizeRun = (reason: string) =>
                        mutex.withPermits(1)(
                            Effect.gen(function* () {
                                const { isCurrentRun, desiredRunning, pid } =
                                    yield* Ref.modify(
                                        state,
                                        (
                                            latest,
                                        ): readonly [
                                            {
                                                readonly isCurrentRun: boolean;
                                                readonly desiredRunning: boolean;
                                                readonly pid: Option.Option<number>;
                                            },
                                            SupervisorState,
                                        ] => {
                                            const currentRun =
                                                Option.getOrUndefined(
                                                    latest.active,
                                                );
                                            if (currentRun?.id !== runId) {
                                                return [
                                                    {
                                                        isCurrentRun: false,
                                                        desiredRunning:
                                                            latest.desiredRunning,
                                                        pid: Option.none<number>(),
                                                    },
                                                    latest,
                                                ] as const;
                                            }
                                            return [
                                                {
                                                    isCurrentRun: true,
                                                    desiredRunning:
                                                        latest.desiredRunning,
                                                    pid: currentRun.pid,
                                                },
                                                {
                                                    ...latest,
                                                    active: Option.none<ActiveRun>(),
                                                    ready: false,
                                                },
                                            ] as const;
                                        },
                                    );

                                if (!isCurrentRun) {
                                    return;
                                }

                                yield* backendOutputLog.writeSessionBoundary({
                                    phase: "END",
                                    details: `pid=${Option.getOrElse(
                                        pid,
                                        () => -1,
                                    )} ${reason}`,
                                });
                                yield* hooks.onExit?.({
                                    pid: Option.getOrNull(pid),
                                    reason,
                                }) ?? Effect.void;

                                if (desiredRunning) {
                                    yield* scheduleRestart(reason);
                                }
                            }),
                        );

                    const program = runChildProcess({
                        config,
                        onStarted: (pid) =>
                            Effect.gen(function* () {
                                yield* updateActiveRun(runId, (run) => ({
                                    ...run,
                                    pid: Option.some(pid),
                                }));
                                yield* backendOutputLog.writeSessionBoundary({
                                    phase: "START",
                                    details: `pid=${pid} cwd=${config.cwd}`,
                                });
                            }),
                        onReady: () =>
                            Effect.gen(function* () {
                                const isCurrentRun = yield* Ref.modify(
                                    state,
                                    (latest) => {
                                        const run = Option.getOrUndefined(
                                            latest.active,
                                        );
                                        if (run?.id !== runId) {
                                            return [false, latest] as const;
                                        }
                                        return [
                                            true,
                                            {
                                                ...latest,
                                                restartAttempt: 0,
                                                ready: true,
                                            },
                                        ] as const;
                                    },
                                );
                                if (!isCurrentRun) {
                                    return;
                                }
                                yield* hooks.onReady?.() ?? Effect.void;
                            }),
                        onReadinessFailure: (error) =>
                            logWarning(
                                "process readiness check failed during bootstrap",
                                { error: error.message },
                            ),
                        onOutput: (streamName, chunk) =>
                            backendOutputLog.writeOutputChunk(streamName, chunk),
                        onLivenessEvent: ({ consecutive, wedged }) =>
                            consecutive === 0
                                ? Effect.void // healthy probe: stay quiet
                                : wedged
                                  ? logError(
                                        "liveness probe wedged; SIGKILL to force restart",
                                        { consecutiveFailures: consecutive },
                                    )
                                  : logWarning("liveness probe failed", {
                                        consecutiveFailures: consecutive,
                                    }),
                    }).pipe(
                        Effect.provideService(
                            ChildProcessSpawner.ChildProcessSpawner,
                            spawner,
                        ),
                        Effect.provideService(
                            HttpClient.HttpClient,
                            httpClient,
                        ),
                        Scope.provide(runScope),
                        Effect.matchEffect({
                            onFailure: (error) => finalizeRun(error.message),
                            onSuccess: (exit) => finalizeRun(exit.reason),
                        }),
                        Effect.ensuring(
                            Scope.close(runScope, Exit.void).pipe(Effect.ignore),
                        ),
                    );

                    const fiber = yield* Effect.forkIn(program, parentScope);
                    yield* updateActiveRun(runId, (run) => ({
                        ...run,
                        fiber: Option.some(fiber),
                    }));
                }),
            ),
        );

        scheduleRestart = (reason: string) =>
            Effect.gen(function* () {
                const scheduled = yield* Ref.modify(state, (latest) => {
                    if (
                        !latest.desiredRunning ||
                        Option.isSome(latest.restartFiber)
                    ) {
                        return [
                            Option.none<Duration.Duration>(),
                            latest,
                        ] as const;
                    }
                    const delay = calculateRestartDelay(latest.restartAttempt);
                    return [
                        Option.some(delay),
                        {
                            ...latest,
                            restartAttempt: latest.restartAttempt + 1,
                        },
                    ] as const;
                });

                yield* Option.match(scheduled, {
                    onNone: () => Effect.void,
                    onSome: (delay) =>
                        Effect.gen(function* () {
                            yield* logError(
                                "process exited unexpectedly; restart scheduled",
                                {
                                    reason,
                                    delayMs: Duration.toMillis(delay),
                                },
                            );
                            const restartFiber = yield* Effect.forkIn(
                                Effect.sleep(delay).pipe(
                                    Effect.andThen(
                                        Ref.modify(state, (latest) => [
                                            latest.desiredRunning,
                                            {
                                                ...latest,
                                                restartFiber: Option.none(),
                                            },
                                        ]),
                                    ),
                                    Effect.flatMap((shouldRestart) =>
                                        shouldRestart ? start : Effect.void,
                                    ),
                                    Effect.catchCause((cause) =>
                                        logError("restart fiber failed", {
                                            cause: Cause.pretty(cause),
                                        }),
                                    ),
                                ),
                                parentScope,
                            );
                            yield* Ref.update(state, (latest) =>
                                Option.isNone(latest.restartFiber)
                                    ? {
                                          ...latest,
                                          restartFiber:
                                              Option.some(restartFiber),
                                      }
                                    : latest,
                            );
                        }),
                });
            });

        const stop: SupervisedProcess["stop"] = (options) =>
            Effect.gen(function* () {
                const { active, restartFiber } = yield* mutex.withPermits(1)(
                    Ref.modify(state, (latest) => [
                        {
                            active: latest.active,
                            restartFiber: latest.restartFiber,
                        },
                        {
                            ...latest,
                            desiredRunning: false,
                            ready: false,
                            active: Option.none<ActiveRun>(),
                            restartFiber:
                                Option.none<Fiber.Fiber<void, never>>(),
                        },
                    ]),
                );

                yield* Option.match(restartFiber, {
                    onNone: () => Effect.void,
                    onSome: (fiber) =>
                        Fiber.interrupt(fiber).pipe(Effect.asVoid),
                });
                yield* Option.match(active, {
                    onNone: () => Effect.void,
                    onSome: (run) => closeRun(run, options),
                });
            });

        yield* Effect.addFinalizer(() => stop());

        return { start, stop, snapshot } satisfies SupervisedProcess;
    },
);
