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
import { Data, Duration, Effect, Schedule, Scope, Stream } from "effect";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { posixPath } from "@ax/lib/shared/path";

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

        // Spawn the child. The ChildProcessSpawner registers a scope finalizer
        // that sends the configured killSignal (SIGTERM by default) when the
        // enclosing scope closes.
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
        yield* handle.stdout.pipe(
            Stream.runDrain,
            Effect.ignore,
            Effect.forkScoped,
        );
        yield* handle.stderr.pipe(
            Stream.runDrain,
            Effect.ignore,
            Effect.forkScoped,
        );

        // Explicit finalizer: graceful SIGTERM, then SIGKILL after grace period.
        // The ChildProcessSpawner's own scope finalizer also fires, but explicit
        // ordering (SIGTERM → sleep → SIGKILL) is cleaner for a DB.
        yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
                yield* Effect.logInfo("[managed-db] shutting down surreal (SIGTERM)");
                yield* handle.kill({ killSignal: "SIGTERM" }).pipe(Effect.ignore);
                yield* Effect.sleep(TERMINATE_GRACE);
                yield* handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore);
            }),
        );

        // HTTP readiness probe: poll /health until surreal is ready.
        const healthUrl = new URL(`http://${opts.host}:${opts.port}/health`);
        const readyClient = httpClient.pipe(
            HttpClient.filterStatusOk,
            HttpClient.transformResponse(Effect.timeout(READINESS_REQUEST_TIMEOUT)),
            HttpClient.retry(Schedule.spaced(READINESS_INTERVAL)),
        );

        yield* readyClient.get(healthUrl).pipe(
            Effect.asVoid,
            Effect.timeout(READINESS_TIMEOUT),
            Effect.mapError(() =>
                new ManagedDbError({
                    message: `Timed out waiting for surreal at ${healthUrl.href} (${Duration.toSeconds(READINESS_TIMEOUT)}s)`,
                }),
            ),
        );

        yield* Effect.logInfo("[managed-db] surreal is ready");
    });
