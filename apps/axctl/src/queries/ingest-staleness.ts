/**
 * Stale-graph warning for read commands (#697).
 *
 * `ax dispatches` / `ax cost` returned empty for two weeks while ingest was
 * dead, and nothing said so - an empty table reads as "you have no data", not
 * "your data stopped 13 days ago". Doctor knew, but only when run by hand.
 *
 * So every DB-backed command pays one indexed query (`status = 'ok'` ORDER BY
 * the indexed `started_at`, LIMIT 1) and prints at most one stderr line. It is
 * wired into `withDb` (cli/index.ts) rather than per-command, so a new read
 * command inherits it without knowing this exists.
 *
 * Fail-open: an unreachable DB prints nothing (the command's own error already
 * says that) and a warning never touches stdout, so `--json` stays machine-clean.
 */
import { Context, Effect, FileSystem, Layer, Schema } from "effect";
import { homedir } from "node:os";
import { jsonField } from "@ax/lib/decode";
import { TimestampColumn } from "@ax/lib/duckdb/columns";
import { CacheRead, type CacheReadError } from "@ax/lib/duckdb/seam";
import { prettyPrint } from "@ax/lib/json";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { nonNegativeNumberEnv } from "@ax/lib/shared/env-number";
import { posixPath } from "@ax/lib/shared/path";
import {
    formatStaleIngestWarning,
    FRESHNESS_SPAWN_DEBOUNCE_MS,
    shouldSpawnBackgroundIngest,
    STALE_INGEST_AFTER_HOURS,
} from "@ax/lib/shared/ingest-staleness";

/** Age past which the graph is called stale. `AX_STALE_INGEST_HOURS`; 0
 *  disables the warning. A blank value (unset-but-exported) falls back to
 *  the default rather than reading as an explicit 0 - see
 *  {@link nonNegativeNumberEnv}. Exported for tests. */
export const staleIngestThresholdMs = (env: NodeJS.ProcessEnv = process.env): number =>
    nonNegativeNumberEnv(env.AX_STALE_INGEST_HOURS, STALE_INGEST_AFTER_HOURS) * 3_600_000;

/** Hard cap on the probe. A wedged DB must not add latency to a command that
 *  is already failing - the warning is a courtesy, not a feature. */
const PROBE_TIMEOUT_MS = 2_000;

const LastOkRunRow = Schema.Struct({
    ended_at: Schema.NullOr(TimestampColumn),
    started_at: TimestampColumn,
});

/**
 * Epoch ms of the newest ingest that finished with status "ok", or null when
 * there is none (or its timestamps are unreadable). Hits the
 * `ingest_run_status_started` index: equality on `status`, ordered by the
 * indexed `started_at`. Reads `ended_at` as the completion instant, falling
 * back to `started_at` for rows written before `ended_at` existed.
 */
export const fetchLastSuccessfulIngestAt: Effect.Effect<number | null, CacheReadError, CacheRead> =
    Effect.gen(function* () {
        const cache = yield* CacheRead;
        const rows = yield* cache.rows(
            LastOkRunRow,
            "SELECT ended_at, started_at FROM ingest_run WHERE status = 'ok' ORDER BY started_at DESC LIMIT 1;",
        );
        const row = rows[0];
        if (row === undefined) return null;
        return (row.ended_at ?? row.started_at).getTime();
    });

/**
 * Print the stale-graph warning to stderr if the graph is out of date. Never
 * fails, never throws, never writes to stdout.
 */
export const warnIfIngestStale: Effect.Effect<void, never, CacheRead> = Effect.gen(
    function* () {
        const thresholdMs = staleIngestThresholdMs();
        if (thresholdMs <= 0) return;
        const lastOkMs = yield* fetchLastSuccessfulIngestAt;
        const warning = formatStaleIngestWarning({ lastOkMs, nowMs: Date.now(), thresholdMs });
        if (warning === null) return;
        yield* Effect.sync(() => process.stderr.write(`${warning}\n`));
    },
).pipe(
    Effect.timeoutOption(PROBE_TIMEOUT_MS),
    // `ignore` only matches the error channel (E) - a defect (e.g. EPIPE from
    // process.stderr.write when a piped reader closes early, `ax cost 2>&1 |
    // head -1`) rides the Cause untouched and would fail a successful command
    // via `ensuring`. `ignoreCause` matches on the whole Cause, so defects and
    // interruptions are swallowed too - the only way to honor "never fails."
    Effect.ignoreCause,
);

// ---------------------------------------------------------------------------
// Freshness drive (#daemon-subtraction) - with no ax-watch LaunchAgent
// tailing transcripts in the background, a stale graph now has nothing else
// standing between "the user ran `ax cost`" and "the graph fixes itself".
// A read command that finds the graph stale forks a background `ax ingest`
// itself, debounced so a burst of commands doesn't fork one ingest each.
// ---------------------------------------------------------------------------

/**
 * Spawns the background ingest. Injected as a service - not called directly
 * - so tests can assert a spawn actually HAPPENED (a fake recording the
 * call) instead of racing a real detached subprocess. This is the exact
 * silent-failure trap named in the wave-3 brief: "a debounce that never
 * fires is invisible."
 */
export class BackgroundIngestSpawner extends Context.Service<
    BackgroundIngestSpawner,
    { readonly spawn: () => Effect.Effect<void> }
>()("ax/BackgroundIngestSpawner") {}

/**
 * Re-invoke the SAME axctl executable this process is running as, the way
 * `cli/retro-reflect.ts`'s `runImproveSubcmd` does: a compiled SEA binary's
 * `argv[0]`/`argv[1]` is a `/$bunfs/...` VFS path that cannot be re-spawned,
 * so `process.execPath` is the real on-disk binary there; in dev
 * (`bun run src/cli/index.ts`) `execPath` IS the bun binary and `argv[1]`
 * (the script path) must ride along.
 */
const selfInvokeCommand = (args: readonly string[]): string[] => {
    const exec = process.execPath;
    return exec.endsWith("/bun") || exec === "bun"
        ? [exec, process.argv[1] ?? "", ...args]
        : [exec, ...args];
};

/**
 * Live spawner: a detached, output-silenced `ax ingest --since=1`. Never
 * awaited by the caller - `unref()` lets the parent CLI process exit without
 * waiting on it. A spawn failure (missing binary, sandboxed env) is
 * best-effort and must never surface to the command that triggered it.
 */
export const BackgroundIngestSpawnerLive: Layer.Layer<BackgroundIngestSpawner> = Layer.succeed(
    BackgroundIngestSpawner,
    {
        spawn: () =>
            Effect.sync(() => {
                const child = Bun.spawn(
                    selfInvokeCommand(["ingest", "--since=1", "--progress=off"]),
                    { stdio: ["ignore", "ignore", "ignore"] },
                );
                child.unref();
            }),
    },
);

/** `AX_NO_AUTO_INGEST=1` or `AX_AUTO_INGEST=off` disables the drive while
 *  leaving the stderr staleness warning intact - mirrors the `AX_NO_NUDGE`
 *  knob on the star nudge (`cli/star-nudge.ts`). */
const freshnessAutoIngestDisabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
    env.AX_NO_AUTO_INGEST === "1" || (env.AX_AUTO_INGEST ?? "").toLowerCase() === "off";

const dataDir = (): string => process.env.AX_DATA_DIR ?? posixPath.join(homedir(), ".local", "share", "ax");
const freshnessStatePath = (): string => posixPath.join(dataDir(), "freshness-drive-state.json");
const freshnessClaimPath = (): string => posixPath.join(dataDir(), "freshness-drive-claim");

interface FreshnessState {
    readonly lastSpawnAtMs?: number;
}

const freshnessStateField = jsonField(
    Schema.Struct({ lastSpawnAtMs: Schema.optionalKey(Schema.Number) }),
);

const readFreshnessState = (): Effect.Effect<FreshnessState, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const raw = yield* fs.readFileString(freshnessStatePath()).pipe(orAbsent<string | null>(null));
        return freshnessStateField.decode(raw) ?? {};
    });

const writeFreshnessState = (next: FreshnessState): Effect.Effect<void, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // best-effort; a read-only data dir must not break the CLI
        yield* fs.makeDirectory(dataDir(), { recursive: true }).pipe(orAbsent<void>(undefined));
        yield* fs
            .writeFileString(freshnessStatePath(), `${prettyPrint(next)}\n`)
            .pipe(orAbsent<void>(undefined));
    });

/** Atomically claim the right to spawn. `wx` maps to O_EXCL, so only one
 *  process can pass this point. The caller always removes its claim. */
const tryClaimFreshnessSpawn = (): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(dataDir(), { recursive: true }).pipe(orAbsent<void>(undefined));
        return yield* fs
            .writeFileString(freshnessClaimPath(), `${process.pid}\n`, { flag: "wx" })
            .pipe(Effect.as(true), orAbsent(false));
    });

const releaseFreshnessSpawnClaim: Effect.Effect<void, never, FileSystem.FileSystem> =
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(freshnessClaimPath(), { force: true }).pipe(Effect.ignore);
    });

/**
 * When the graph is stale (same condition that trips {@link warnIfIngestStale})
 * and the debounce window has elapsed, fork a background ingest and record
 * the attempt. Fail-open and time-boxed exactly like the warning: this is a
 * courtesy, not a feature a broken cache/fs may block on.
 */
export const maybeSpawnBackgroundIngest: Effect.Effect<
    void,
    never,
    CacheRead | FileSystem.FileSystem | BackgroundIngestSpawner
> = Effect.gen(function* () {
    if (freshnessAutoIngestDisabled()) return;
    const thresholdMs = staleIngestThresholdMs();
    if (thresholdMs <= 0) return;
    const lastOkMs = yield* fetchLastSuccessfulIngestAt;
    const nowMs = Date.now();
    const warning = formatStaleIngestWarning({ lastOkMs, nowMs, thresholdMs });
    if (warning === null) return; // graph is current - nothing to drive

    const state = yield* readFreshnessState();
    if (
        !shouldSpawnBackgroundIngest({
            lastSpawnAtMs: state.lastSpawnAtMs ?? null,
            nowMs,
            debounceMs: FRESHNESS_SPAWN_DEBOUNCE_MS,
        })
    ) {
        return;
    }

    const claimed = yield* tryClaimFreshnessSpawn();
    if (!claimed) return;

    yield* Effect.gen(function* () {
        // Another process can finish between our first state read and this
        // claim. Recheck while the exclusive claim is held.
        const claimedState = yield* readFreshnessState();
        if (
            !shouldSpawnBackgroundIngest({
                lastSpawnAtMs: claimedState.lastSpawnAtMs ?? null,
                nowMs,
                debounceMs: FRESHNESS_SPAWN_DEBOUNCE_MS,
            })
        ) {
            return;
        }

        const spawner = yield* BackgroundIngestSpawner;
        yield* spawner.spawn();
        yield* writeFreshnessState({ ...claimedState, lastSpawnAtMs: nowMs });
    }).pipe(Effect.ensuring(releaseFreshnessSpawnClaim));
}).pipe(
    Effect.timeoutOption(PROBE_TIMEOUT_MS),
    // Same "never fails" contract as warnIfIngestStale - a defect (EPIPE, a
    // read-only fs) must not fail the command that only wanted to run.
    Effect.ignoreCause,
);

/**
 * Run the stale-graph probe (and the freshness drive it now feeds) before a
 * DB-backed command. This must be a preflight rather than a finalizer: some
 * legacy handlers call `process.exit` directly, so no finalizer gets a
 * chance to run on their failure paths.
 */
export const withIngestStalenessPreflight = <A, E, R>(
    command: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | CacheRead | FileSystem.FileSystem | BackgroundIngestSpawner> =>
    warnIfIngestStale.pipe(
        Effect.andThen(maybeSpawnBackgroundIngest),
        Effect.andThen(command),
    );
