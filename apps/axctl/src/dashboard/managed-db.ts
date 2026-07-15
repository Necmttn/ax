/**
 * Managed SurrealDB child-process supervisor for `ax serve --managed-db`.
 *
 * When the macOS background helper (SMAppService plist) invokes:
 *   bun <ax-src>/apps/axctl/src/cli/index.ts serve --managed-db --port=1738 --ingest-every=2m
 * this module spawns the bundled `surreal` binary as a supervised child,
 * waits for its HTTP readiness probe, and registers a Scope finalizer that
 * terminates it on shutdown.
 *
 * Bundle-location independence: `resolveManagedSurrealPath(process.execPath)`
 * resolves `surreal` as a sibling of the bun binary - both live in
 * `Contents/Resources/bin/<arch>/` inside the app bundle.
 */
import { Data, Duration, Effect, Ref, Schedule, Scope, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { posixPath } from "@ax/lib/shared/path";
import { makeSurrealWatchdog } from "./SurrealWatchdog.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ManagedDbError extends Data.TaggedError("ManagedDbError")<{
    readonly message: string;
    readonly cause?: unknown;
}> {}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the surreal binary path as a sibling of the bun execPath.
 *
 * In the app bundle both bun and surreal live in the same directory:
 *   `Contents/Resources/bin/<arch>/bun`
 *   `Contents/Resources/bin/<arch>/surreal`
 *
 * @example
 *   resolveManagedSurrealPath("/App.app/Contents/Resources/bin/arm64/bun")
 *   // => "/App.app/Contents/Resources/bin/arm64/surreal"
 */
export const resolveManagedSurrealPath = (execPath: string): string =>
    posixPath.join(posixPath.dirname(execPath), "surreal");

// ---------------------------------------------------------------------------
// Duration string parsing ("2m", "30s", "1h")
// ---------------------------------------------------------------------------

/**
 * Parse compact duration strings used in the `--ingest-every` flag.
 * Returns null for unrecognised formats.
 * Supported units: ms, s, m, h, d.
 */
export const parseDurationString = (s: string): Duration.Duration | null => {
    const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(s.trim());
    if (!match) return null;
    const n = Number(match[1]);
    switch (match[2]) {
        case "ms": return Duration.millis(n);
        case "s":  return Duration.seconds(n);
        case "m":  return Duration.minutes(n);
        case "h":  return Duration.hours(n);
        case "d":  return Duration.days(n);
        default:   return null;
    }
};

// ---------------------------------------------------------------------------
// Readiness probe constants
// ---------------------------------------------------------------------------

const READINESS_TIMEOUT = Duration.seconds(30);
const READINESS_INTERVAL = Duration.millis(250);
const READINESS_REQUEST_TIMEOUT = Duration.seconds(2);
const TERMINATE_GRACE = Duration.seconds(5);

/**
 * Short timeout for the pre-spawn idempotency probe.
 * Fail-closed: if nothing answers in 1 s we assume "not listening" and spawn.
 */
const PRE_SPAWN_PROBE_TIMEOUT = Duration.seconds(1);

// ---------------------------------------------------------------------------
// Watchdog constants
// ---------------------------------------------------------------------------

/**
 * How long to wait between each SQL probe round-trip.
 * 15 s is conservative but fast enough to detect a 4-day stall in <1 min.
 */
const WATCHDOG_INTERVAL = Duration.seconds(15);

/**
 * How many consecutive probe failures before we declare a wedge and
 * force-restart.  3 × 15 s = 45 s before triggering a restart.
 */
const WATCHDOG_FAILURES_TO_TRIP = 3;

// ---------------------------------------------------------------------------
// makeManagedDb
// ---------------------------------------------------------------------------

/**
 * Spawn a bundled `surreal` process, wait for its HTTP health probe, and
 * register a Scope finalizer that terminates it.
 *
 * Requirements:
 *   - `Scope.Scope`            - finalizer is registered here; the caller owns
 *                                the scope lifetime (close it to kill surreal).
 *   - `ChildProcessSpawner`    - platform spawn implementation (BunChildProcessSpawner).
 *   - `HttpClient`             - for the `/health` readiness probe.
 *
 * The effect resolves as `void` once surreal is ready to accept connections.
 * Shutting down the enclosing scope sends SIGTERM then (after grace) SIGKILL.
 */
export const makeManagedDb = (opts: {
    readonly surrealPath: string;
    readonly host: string;
    readonly port: number;
    readonly dataDir: string;
}): Effect.Effect<
    void,
    ManagedDbError,
    Scope.Scope | ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient
> =>
    Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const httpClient = yield* HttpClient.HttpClient;

        // Move healthUrl up here so the pre-spawn probe can use it.
        const healthUrl = new URL(`http://${opts.host}:${opts.port}/health`);

        // ---------------------------------------------------------------------------
        // Pre-spawn idempotency check (restart-storm guard)
        // ---------------------------------------------------------------------------
        // If a healthy surreal is already listening on host:port, attach to it
        // instead of spawning a new one.
        //
        // Failure mode prevented: helper crash → SIGKILL → launchd restarts
        // helper → new surreal collides with orphan (rocksdb-locked) →
        // 30-s readiness timeout → exit → restart → storm.
        //
        // Fail-closed: timeout / connection error → false → proceed to spawn.
        // In the attach case we do NOT register a finalizer or start the
        // watchdog - we didn't spawn the process so we must not kill or
        // monitor it.
        const alreadyHealthy = yield* httpClient.pipe(HttpClient.filterStatusOk)
            .get(healthUrl)
            .pipe(
                Effect.timeout(PRE_SPAWN_PROBE_TIMEOUT),
                Effect.map(() => true as boolean),
                Effect.orElseSucceed(() => false as boolean),
            );

        if (alreadyHealthy) {
            yield* Effect.logInfo(
                `[managed-db] surreal already healthy on ${opts.host}:${opts.port} - attaching, not spawning`,
            );
            return; // no spawn, no finalizer, no watchdog - we don't own this process
        }

        const args = [
            "start",
            "--user", "root",
            "--pass", "root",
            "--bind", `${opts.host}:${opts.port}`,
            "--log", "info",
            "--allow-experimental=files",
            `rocksdb://${opts.dataDir}/db`,
        ];

        yield* Effect.logInfo(`[managed-db] spawning surreal`, {
            path: opts.surrealPath,
            bind: `${opts.host}:${opts.port}`,
            dataDir: opts.dataDir,
        });

        const command = ChildProcess.make(opts.surrealPath, args, {
            cwd: opts.dataDir,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
        });

        // HTTP readiness probe: poll /health until surreal is ready.
        const readyClient = httpClient.pipe(
            HttpClient.filterStatusOk,
            HttpClient.transformResponse(Effect.timeout(READINESS_REQUEST_TIMEOUT)),
            HttpClient.retry(Schedule.spaced(READINESS_INTERVAL)),
        );

        const probeHealth = readyClient.get(healthUrl).pipe(
            Effect.asVoid,
            Effect.timeout(READINESS_TIMEOUT),
            Effect.mapError(() =>
                new ManagedDbError({
                    message: `Timed out waiting for surreal at ${healthUrl.href} (${Duration.toSeconds(READINESS_TIMEOUT)}s)`,
                }),
            ),
        );

        // Capture the managed-db scope so that spawnAndReady can register the
        // spawner's scope finalizer in it even when called from onWedged (which
        // has no Scope in its own R type).
        const managedDbScope = yield* Effect.scope;

        // ---------------------------------------------------------------------------
        // Spawn helper: spawn surreal, drain output streams, wait for readiness.
        // Returns a handle; registers the spawner's SIGTERM finalizer in the
        // managed-db scope so that ALL spawned processes are cleaned up when the
        // overall scope closes.
        //
        // Scope is provided via `provideService` so `spawnAndReady` has no Scope
        // in its own R type, allowing it to be called from `onWedged` (which must
        // have R = never to satisfy SurrealWatchdogOpts).
        // ---------------------------------------------------------------------------
        const spawnAndReady: Effect.Effect<
            ChildProcessSpawner.ChildProcessHandle,
            ManagedDbError
        > = Effect.gen(function* () {
            // Spawn the child. The ChildProcessSpawner registers a scope finalizer
            // (SIGTERM) in managedDbScope when the enclosing scope closes.
            const handle = yield* spawner.spawn(command).pipe(
                Effect.mapError((cause) =>
                    new ManagedDbError({
                        message: `Failed to spawn surreal: ${String(cause.message ?? cause)}`,
                        cause,
                    }),
                ),
            );

            yield* Effect.logInfo(`[managed-db] surreal spawned`, { pid: handle.pid });

            // Drain stdout/stderr in background (prevent pipe-buffer stall).
            // Effect.ignore swallows failures from the stream (e.g. if surreal
            // exits before we drain), so these don't surface as errors.
            // forkDetach so drain fibers have no Scope requirement; they terminate
            // naturally when the process exits (pipe closes).
            yield* handle.stdout.pipe(Stream.runDrain, Effect.ignore, Effect.forkDetach);
            yield* handle.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkDetach);

            yield* probeHealth;

            return handle;
        }).pipe(
            // Provide the managed-db scope so spawner.spawn can register its
            // finalizer there without Scope appearing in spawnAndReady's own R type.
            Effect.provideService(Scope.Scope, managedDbScope),
        );

        // Initial spawn.
        const initialHandle = yield* spawnAndReady;

        // Track the *current* handle in a Ref so the finalizer and watchdog
        // always operate on the live process, not the originally-spawned one.
        const handleRef = yield* Ref.make(initialHandle);

        // Explicit finalizer: graceful SIGTERM → wait → SIGKILL.
        // Reads from handleRef so it always targets the most-recently spawned pid.
        // The ChildProcessSpawner's own scope finalizers also fire, but those may
        // target stale pids (already killed by the watchdog); Effect.ignore makes
        // those no-ops.
        yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
                yield* Effect.logInfo("[managed-db] shutting down surreal (SIGTERM)");
                const handle = yield* Ref.get(handleRef);
                yield* handle.kill({ killSignal: "SIGTERM" }).pipe(Effect.ignore);
                yield* Effect.sleep(TERMINATE_GRACE);
                yield* handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore);
            }),
        );

        // ---------------------------------------------------------------------------
        // Watchdog: detect a wedged SurrealDB via a real SELECT 1 round-trip.
        //
        // `/health` passes on a wedge (socket open, process alive).  An actual SQL
        // query is the only reliable signal that the DB is serving queries.
        //
        // On trip: SIGKILL (not SIGTERM - SIGTERM was ignored in the incident),
        // then respawn + re-probe health.  Logged as a structured warning.
        // ---------------------------------------------------------------------------
        const sqlUrl = new URL(`http://${opts.host}:${opts.port}/sql`);
        const watchdogProbe: Effect.Effect<boolean> = httpClient.execute(
            HttpClientRequest.post(sqlUrl).pipe(
                HttpClientRequest.basicAuth("root", "root"),
                HttpClientRequest.bodyText("SELECT 1", "text/plain"),
            ),
        ).pipe(
            Effect.timeout(Duration.seconds(1)),
            Effect.map(() => true as boolean),
            Effect.orElseSucceed(() => false as boolean),
        );

        const onWedged: Effect.Effect<void> = Effect.gen(function* () {
            yield* Effect.logWarning(
                "[managed-db] watchdog: surreal wedge detected - SIGKILLing and respawning",
            );
            const staleHandle = yield* Ref.get(handleRef);
            // Go straight to SIGKILL - the incident showed SIGTERM was ignored.
            yield* staleHandle.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore);
            // Respawn and wait for readiness before re-arming the watchdog counter.
            const newHandle = yield* spawnAndReady;
            yield* Ref.set(handleRef, newHandle);
            yield* Effect.logInfo("[managed-db] watchdog: surreal restarted and ready");
        }).pipe(
            // Don't let restart errors propagate to the watchdog loop - the loop
            // re-arms and will try again after the next trip.
            Effect.ignore,
        );

        yield* Effect.forkScoped(
            makeSurrealWatchdog({
                probe: watchdogProbe,
                onWedged,
                interval: WATCHDOG_INTERVAL,
                failuresToTrip: WATCHDOG_FAILURES_TO_TRIP,
            }),
        );

        yield* Effect.logInfo("[managed-db] surreal is ready");
    });
