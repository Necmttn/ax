/**
 * ingest-lock.ts - single-flight advisory lock for CLI ingests.
 *
 * The ax-watch LaunchAgent runs `axctl ingest --since=1` on every transcript
 * write. While a long session is being written, that fires repeatedly and -
 * with no coordination - piled-up ingests contend on SurrealDB, each holding a
 * write transaction. One wedged ingest then pegs the DB for minutes-to-hours
 * (observed: a watcher ingest stuck 5h, leaking transactions). It also collides
 * with a manual `ax sessions here` auto-backfill running at the same moment.
 *
 * This lock makes CLI ingests single-flight: while one holds the lock, another
 * SKIPS (the watcher re-fires soon anyway, so dropping a redundant run is
 * correct). Acquisition is ATOMIC - an exclusive `wx` create, so two ingests
 * racing the same instant cannot both win (an earlier read-then-write version
 * could, recreating the contention this exists to prevent). A lock whose owner
 * has died, or that is older than `staleMs`, is stolen so a crash can never
 * wedge ingestion permanently.
 *
 * Timeout / interrupt semantics: when `timeoutSeconds` is set, the work is
 * timeboxed. On NORMAL completion (or a normal error) the lock is released. On
 * TIMEOUT or INTERRUPT the lock is deliberately LEFT in place: interrupting the
 * Effect fiber does not prove SurrealDB stopped the in-flight work server-side,
 * so the stale lock becomes a cooldown window - the next ingest skips until the
 * lock ages past `staleMs`, giving the DB time to settle. A hard process crash
 * (no finalizer) is still recovered via the dead-pid / staleness steal.
 */
import { Effect, Exit, FileSystem, Option, Path } from "effect";
import { safeJsonParse } from "@ax/lib/shared/safe-json";

export interface IngestLockInfo {
    readonly pid: number;
    /** epoch ms when the lock was acquired */
    readonly startedAt: number;
    readonly command: string;
}

/**
 * Is `pid` a live process this user could signal? `kill(pid, 0)` sends no
 * signal; it only probes existence. ESRCH => gone; EPERM => alive but owned by
 * another user (still "alive" for our purposes).
 */
const isProcessAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
};

// Best-effort read: a missing, unreadable, or malformed lock file is treated
// as "no holder" so a transient FS error can never block ingestion.
const readHolder = (
    lockPath: string,
): Effect.Effect<Option.Option<IngestLockInfo>, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const raw = yield* fs.readFileString(lockPath).pipe(
            Effect.orElseSucceed<string | null>(() => null),
        );
        if (raw === null) return Option.none();
        const parsed = safeJsonParse<IngestLockInfo>(raw);
        return parsed === null ? Option.none() : Option.some(parsed);
    });

/**
 * Run `work` while holding the ingest lock. If a fresh lock owned by a live
 * process is already held, run `onBusy(holder)` instead and skip `work`.
 *
 * Returns the work's value on success, the `onBusy` value when busy, or
 * `undefined` when `work` timed out (the lock is then left to age out).
 */
export const withIngestLock = <A, E, R, A2, E2, R2>(
    opts: {
        readonly lockPath: string;
        readonly command: string;
        /** a lock older than this (ms) is considered stale and stolen */
        readonly staleMs: number;
        /** hard wall-clock cap on `work`; omitted = no timeout */
        readonly timeoutSeconds?: number;
        readonly now?: () => number;
        readonly onBusy: (holder: IngestLockInfo) => Effect.Effect<A2, E2, R2>;
        /** logged when `work` exceeds `timeoutSeconds` (lock left to age) */
        readonly onTimeout?: () => Effect.Effect<void, never, never>;
    },
    work: Effect.Effect<A, E, R>,
): Effect.Effect<A | A2 | undefined, E | E2, R | R2 | FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const now = opts.now ?? (() => Date.now());

        const ownerJson = () =>
            JSON.stringify({ pid: process.pid, startedAt: now(), command: opts.command } satisfies IngestLockInfo);

        // Atomic acquire: `wx` fails if the file already exists, so exactly one
        // racer wins. Returns true iff WE created it.
        const tryCreate = (): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
            fs.writeFileString(opts.lockPath, ownerJson(), { flag: "wx" }).pipe(
                Effect.as(true),
                Effect.orElseSucceed(() => false),
            );

        yield* fs.makeDirectory(path.dirname(opts.lockPath), { recursive: true }).pipe(Effect.ignore);

        let owned = yield* tryCreate();
        if (!owned) {
            // Someone holds it. Binding only if fresh AND owner alive.
            const holder = yield* readHolder(opts.lockPath);
            if (Option.isSome(holder)) {
                const h = holder.value;
                if (now() - h.startedAt < opts.staleMs && isProcessAlive(h.pid)) {
                    return yield* opts.onBusy(h);
                }
            }
            // Stale / dead / unreadable: steal it, then re-create atomically. If
            // another process wins that race we fail closed (skip via onBusy).
            yield* fs.remove(opts.lockPath).pipe(Effect.ignore);
            owned = yield* tryCreate();
            if (!owned) {
                const h2 = yield* readHolder(opts.lockPath);
                return yield* opts.onBusy(
                    Option.getOrElse(h2, () => ({ pid: -1, startedAt: now(), command: "unknown" })),
                );
            }
        }

        // We own the lock. Release on normal completion/error; KEEP on timeout
        // or interrupt (see file header). `deleteLock` no-ops unless we still
        // own the file, so a stolen lock is never deleted out from under its
        // new owner.
        const deleteLock = Effect.gen(function* () {
            const current = yield* readHolder(opts.lockPath);
            if (Option.isSome(current) && current.value.pid === process.pid) {
                yield* fs.remove(opts.lockPath).pipe(Effect.ignore);
            }
        });

        const timed = opts.timeoutSeconds !== undefined
            ? work.pipe(Effect.timeoutOption(`${opts.timeoutSeconds} seconds`))
            : work.pipe(Effect.map(Option.some));

        const result = yield* timed.pipe(
            Effect.onExit((exit) =>
                Exit.hasInterrupts(exit)
                    ? Effect.void
                    : Exit.isSuccess(exit) && Option.isNone(exit.value)
                        ? Effect.void
                        : deleteLock,
            ),
        );

        if (Option.isNone(result)) {
            if (opts.onTimeout) yield* opts.onTimeout();
            return undefined;
        }
        return result.value;
    });
