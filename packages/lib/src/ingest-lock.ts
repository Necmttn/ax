/**
 * The ingest lock: the single-flight advisory lock that stops two ax ingests
 * from writing the cache at once. In the v2 architecture it is also the WRITE
 * CAPABILITY - `withCacheWrite` (`@ax/lib/duckdb`) refuses to open the live
 * database unless this process holds this lock, so "writes only happen inside
 * ingest, under the lock" is machine-checked rather than merely documented.
 *
 * WHY IT EXISTS. The ax-watch LaunchAgent runs an ingest on every transcript
 * write, so while a long session is being written it fires repeatedly. With no
 * coordination, piled-up ingests contend on the database, each holding a write
 * transaction; one wedged ingest then pegs it for minutes-to-hours (observed: a
 * watcher ingest stuck 5h, leaking transactions). It also collides with a manual
 * `ax sessions here` auto-backfill running at the same moment. While one run
 * holds the lock, another SKIPS - the watcher re-fires soon anyway, so dropping a
 * redundant run is correct.
 *
 * WHAT THE FILE SAYS. A single JSON object: the writer's pid, when it took the
 * lock, the command that took it, a per-acquire random `token`, and the holder
 * process's start time.
 *
 * THE FIVE INVARIANTS, and what each one is for:
 *
 *  1. ATOMIC ACQUIRE. The lock is taken with an exclusive create (`"wx"`), so two
 *     runs racing the same instant cannot both win. An earlier read-then-write
 *     version could, which recreated the exact contention this exists to prevent.
 *
 *  2. PER-ACQUIRE TOKEN. `release` removes the file only when the bytes on disk
 *     are still EXACTLY the ones it wrote, token included. Without that, "does
 *     the file name our pid" was the test - which EVERY handle from this process
 *     passes - so acquire A -> release A -> acquire B -> release A (a duplicated
 *     or late release) deleted B's live lock, silently unlocking a running
 *     ingest. A superseded handle's release is a no-op success.
 *
 *  3. PROCESS FINGERPRINT. A pid is reused freely by the OS, so "the pid is
 *     alive" is not "the holder is alive" - an unrelated long-lived process can
 *     hold the ingest lock hostage until it exits. The payload records the
 *     holder's start time (`ps -o lstart=`), and a live pid whose fingerprint no
 *     longer matches is a corpse. Best-effort by design: `ps` can be missing or
 *     sandboxed, and a `null` there degrades exactly to pid-only liveness rather
 *     than failing an ingest.
 *
 *  4. CANONICAL-PATH IDENTITY. All process-local state is keyed by the canonical
 *     path, never by the string the caller passed: `ingest.lock`,
 *     `/abs/ingest.lock` and a symlinked alias of the directory all name ONE
 *     file, and keying by the raw string made the second spelling look like a
 *     different lock - so it stole the first one's live lock. File OPERATIONS
 *     still use the path as given; only IDENTITY is canonical.
 *
 *  5. CONFIRM-THEN-REMOVE. Taking over a stale lock is itself a race. Two racers
 *     can both read the same stale payload and both decide "stale"; if A wins
 *     and installs its own live lock, a merely-descheduled B would delete A's
 *     LIVE lock and install its own - two winners, the exact bug this module
 *     exists to prevent. So a takeover RE-READS the file and proceeds only when
 *     the bytes are still byte-identical to the payload it classified stale;
 *     anything else means someone got there first, and the caller is reported
 *     busy instead.
 *
 * SELF-HOLD. Our own pid is by definition always alive, so liveness alone cannot
 * tell a genuine second in-process acquirer (reject it) from a leftover of a
 * crashed earlier run under a pid the OS reused (take it over). `inProcessHolders`
 * - module-level, canonical-path keyed - answers that. It is deliberately NOT
 * per-layer-instance: ax builds a fresh layer per `run(provide(...))` call, so a
 * Ref closed over by one instance is invisible to a second acquirer going through
 * another, which is exactly the `ax serve`-forking-an-ingest shape. Acquires for
 * one canonical path are additionally serialized by a per-path semaphore, so no
 * fiber can observe the window between "the lock file exists" and "this process
 * is registered as its holder". The semaphore covers the ACQUIRE only, never the
 * work: a second in-process ingest must skip as busy, not queue.
 *
 * TIMEOUT / INTERRUPT. On normal completion (or a normal error) the lock is
 * released. On TIMEOUT or INTERRUPT it is deliberately LEFT in place: interrupting
 * the fiber does not prove the in-flight work stopped, so the stale lock becomes a
 * cooldown window - the next ingest skips until it ages past `staleMs`, giving
 * things time to settle. A hard process crash (no finalizer) is recovered by the
 * dead-pid / staleness takeover.
 *
 * TWO RESIDUALS - what a plain lockfile cannot arbitrate (issue #789):
 *  1. The takeover removes BY PATH. Invariant 5 closes the common interleave, but
 *     not the window between the confirm re-read and the remove itself: a racer
 *     descheduled inside it can still delete a lock installed after its read. No
 *     additional re-check closes this - every step here is check-then-act on a
 *     path, so another check only moves the window.
 *  2. `staleMs` is a TIMEOUT-based liveness heuristic, not a proof. A process
 *     merely SUSPENDED past the window - `SIGSTOP`, suspend-to-RAM, a VM snapshot
 *     restore, a forward NTP step - can have its live lock taken over.
 * Only an OS advisory lock (`flock`/`fcntl`) held ACROSS the takeover, or a design
 * that never removes a foreign file, actually closes either. Both are out of scope
 * here and tracked on #789.
 *
 * RULING R6: this is a runtime module under `packages/lib/src/`, so `node:fs` /
 * `node:path` are banned. Filesystem access goes through `FileSystem.FileSystem`.
 */
import { Effect, Exit, FileSystem, Option, Path, Semaphore } from "effect";
import { canonicalPath } from "./duckdb/canonical-path.ts";
import { safeJsonParse } from "./shared/safe-json.ts";

/**
 * Extra grace beyond the hard ingest timeout (`AxConfig.knobs.ingestTimeoutSeconds`)
 * before a held lock is deemed stale and taken over: the owner should have
 * self-cancelled at the timeout, so anything older is genuinely dead.
 */
export const INGEST_LOCK_STALE_GRACE_MS = 60_000;

export interface IngestLockInfo {
    readonly pid: number;
    /** epoch ms when the lock was acquired */
    readonly startedAt: number;
    readonly command: string;
    /** Random, per ACQUIRE - invariant 2. Absent in a payload from an older build. */
    readonly token?: string;
    /** The HOLDER's process start time (`ps -o lstart=`) - invariant 3.
     *  Absent when `ps` was unavailable. */
    readonly procStartedAt?: string;
}

/**
 * Discriminated result of {@link withIngestLock}, so callers can tell a
 * timed-out run apart from a busy skip or a completed run. The distinction is
 * load-bearing: `ax ingest` must exit non-zero on timeout (#265) while a busy
 * skip stays exit 0 (the watcher re-fires anyway). An earlier version collapsed
 * timeout into `undefined`, which read as success.
 */
export type IngestLockOutcome<A, A2> =
    | { readonly _tag: "completed"; readonly value: A }
    | { readonly _tag: "busy"; readonly value: A2 }
    | { readonly _tag: "timeout" };

/**
 * The `lockPath` + `command` + `staleMs` trio every `withIngestLock` caller
 * builds - previously copy-pasted across `cli/commands/ingest.ts`,
 * `share/recover.ts`, and `dashboard/ingest-workflow.ts`.
 *
 * `dataDir` is `AxConfig.paths.dataDir`, and `<dataDir>/ingest.lock` is THE one
 * lock path in v2 - there is no environment override and no second default.
 *
 * `timeoutSeconds` here only SIZES the staleness grace window - it is
 * deliberately not itself part of the returned object. A caller that wants
 * `work` bounded spreads this alongside its own `timeoutSeconds`; a caller that
 * wants `work` unbounded (the dashboard's live-ingest path) spreads this and
 * stops there, still sizing `staleMs` off the same number so a would-be timeout
 * leaves a lock that ages out on the same schedule a bounded run's would have.
 */
export const ingestLockOptions = (
    path: Path.Path,
    dataDir: string,
    command: string,
    timeoutSeconds: number,
): { readonly lockPath: string; readonly command: string; readonly staleMs: number } => ({
    lockPath: path.join(dataDir, "ingest.lock"),
    command,
    staleMs: timeoutSeconds * 1000 + INGEST_LOCK_STALE_GRACE_MS,
});

export const encodeLockPayload = (info: IngestLockInfo): string => JSON.stringify(info);

/** An optional string field: present-and-non-empty, or absent. Anything else (a
 *  number, an empty string, null) makes the whole payload corrupt rather than
 *  silently dropping the field. */
const optionalText = (
    value: unknown,
): { readonly ok: true; readonly value: string | undefined } | { readonly ok: false } => {
    if (value === undefined) return { ok: true, value: undefined };
    if (typeof value === "string" && value.length > 0) return { ok: true, value };
    return { ok: false };
};

export const decodeLockPayload = (text: string): IngestLockInfo | null => {
    const parsed = safeJsonParse<unknown>(text);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { pid, startedAt, command, token, procStartedAt } = parsed as Record<string, unknown>;
    if (typeof pid !== "number" || !Number.isInteger(pid)) return null;
    // pid 0 and negative pids are not process ids, and they are not harmless:
    // `process.kill(0, 0)` signals the CALLER'S OWN process group and succeeds,
    // so a corrupt `"pid": 0` reads back as a LIVE holder and wedges the lock
    // permanently. Corrupt input must decode as corrupt, never as a holder.
    if (pid <= 0) return null;
    if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
    if (typeof command !== "string") return null;
    const decodedToken = optionalText(token);
    if (!decodedToken.ok) return null;
    const decodedStart = optionalText(procStartedAt);
    if (!decodedStart.ok) return null;
    return {
        pid,
        startedAt,
        command,
        ...(decodedToken.value === undefined ? {} : { token: decodedToken.value }),
        ...(decodedStart.value === undefined ? {} : { procStartedAt: decodedStart.value }),
    };
};

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

/** The process start time `ps` reports, or `null` when `ps` cannot answer
 *  (missing, sandboxed, unexpected format) - invariant 3's best-effort half. */
const processStartedAt = (pid: number): string | null => {
    try {
        const probe = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)]);
        if (probe.exitCode !== 0) return null;
        const text = probe.stdout.toString().trim();
        return text.length === 0 ? null : text;
    } catch {
        return null;
    }
};

/**
 * Is the process named by `holder` STILL the process that took the lock?
 * A missing fingerprint (older payload, or `ps` unavailable when it was written)
 * degrades to the pid probe alone; a failed probe NOW keeps the previous answer
 * (alive), so an unreadable start time can never turn a live holder into a corpse.
 */
const holderIsLive = (holder: IngestLockInfo): boolean => {
    if (!isProcessAlive(holder.pid)) return false;
    if (holder.procStartedAt === undefined) return true;
    const current = processStartedAt(holder.pid);
    return current === null || current === holder.procStartedAt;
};

/**
 * Process-wide (deliberately NOT per-layer-instance) in-process holding state,
 * keyed by CANONICAL lock path. The value is the current holder's ACQUIRE TOKEN,
 * not a boolean: a boolean cannot tell "the handle clearing this is the one that
 * set it" from "a stale handle from two acquires ago is clearing a successor's
 * ownership", and the latter silently un-registers a live holder.
 *
 * Plain synchronous `Map` mutation is safe here: Effect fibers only interleave at
 * yield points, and every read/write below happens inside one synchronous
 * statement, never straddling a yield.
 */
const inProcessHolders = new Map<string, string>();

/** One acquire-critical-section mutex per canonical lock path. Module-level for
 *  the same reason `inProcessHolders` is. */
const acquireMutexes = new Map<string, Semaphore.Semaphore>();

const acquireMutexFor = (key: string): Semaphore.Semaphore => {
    const existing = acquireMutexes.get(key);
    if (existing !== undefined) return existing;
    const created = Semaphore.makeUnsafe(1);
    acquireMutexes.set(key, created);
    return created;
};

/**
 * Does THIS process currently hold the ingest lock at `lockPath`? The write seam
 * asks this before opening the live database, which is what makes "writes only
 * under the lock" checkable. Canonical-path keyed (invariant 4), so a caller
 * spelling the path differently still gets the right answer.
 *
 * BOTH HALVES ARE CHECKED, and the file half is not optional. The registry
 * alone answers "did this process take a lock at this path and not release it" -
 * which is NOT the same question. Between the acquire and the write, invariant
 * 5's takeover (or a `staleMs` misjudgement, or a stray `rm`) can hand the lock
 * to someone else, and the registry cannot see that happen: it holds the token
 * WE minted, so a replaced lock file still read as "held here" and the seam
 * opened the live database while another process owned it - two writers, the
 * exact outcome this lock exists to prevent. So the on-disk token must still be
 * the one this process registered; a missing, corrupt, or foreign-token file is
 * `false`. This is a re-check at write time, not a guarantee for the duration of
 * the write - see the two flock-class residuals in the module header.
 */
export const ingestLockHeldHere = (
    lockPath: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const key = yield* canonicalPath(fs, lockPath);
        const registered = inProcessHolders.get(key);
        if (registered === undefined) return false;
        const text = yield* readLockText(lockPath);
        if (text === null) return false;
        return decodeLockPayload(text)?.token === registered;
    });

/** Best-effort raw read: a missing or unreadable lock file is `null` ("no
 *  holder"), so a transient filesystem error can never block ingestion. The RAW
 *  text (not the parsed payload) is what invariant 5 compares. */
const readLockText = (
    lockPath: string,
): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.readFileString(lockPath).pipe(Effect.orElseSucceed<string | null>(() => null));
    });

const UNKNOWN_HOLDER = (now: number): IngestLockInfo => ({ pid: -1, startedAt: now, command: "unknown" });

/**
 * Run `work` while holding the ingest lock. If a fresh lock owned by a live
 * process is already held, run `onBusy(holder)` instead and skip `work`.
 *
 * Returns `{ _tag: "completed", value }` with the work's value on success,
 * `{ _tag: "busy", value }` with the `onBusy` value when skipped, or
 * `{ _tag: "timeout" }` when `work` timed out (the lock is then left to age out
 * as a cooldown).
 */
export const withIngestLock = <A, E, R, A2, E2, R2, R3 = never>(
    opts: {
        readonly lockPath: string;
        readonly command: string;
        /** a lock older than this (ms) is considered stale and taken over */
        readonly staleMs: number;
        /** hard wall-clock cap on `work`; omitted = no timeout */
        readonly timeoutSeconds?: number;
        readonly now?: () => number;
        readonly onBusy: (holder: IngestLockInfo) => Effect.Effect<A2, E2, R2>;
        /** run when `work` exceeds `timeoutSeconds` (lock left to age) - e.g.
         *  finalize the run row + tell the user; runs AFTER the interrupted
         *  work's own finalizers have completed */
        readonly onTimeout?: () => Effect.Effect<void, never, never>;
        /**
         * Runs once `work` completes successfully, still holding the lock, but
         * NOT subject to `timeoutSeconds` - a slow-but-harmless follow-up (e.g.
         * best-effort maintenance) can never retroactively flip a genuinely
         * completed `work` into a `"timeout"` outcome. Errors must be handled by
         * the caller (this signature has no error channel) so a maintenance fault
         * can't fail the whole lock; an interrupt during `afterWork` still leaves
         * the lock in place, same as an interrupt during `work`.
         */
        readonly afterWork?: (value: A) => Effect.Effect<void, never, R3>;
    },
    work: Effect.Effect<A, E, R>,
): Effect.Effect<IngestLockOutcome<A, A2>, E | E2, R | R2 | R3 | FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const now = opts.now ?? (() => Date.now());
        const lockPath = opts.lockPath;

        yield* fs.makeDirectory(path.dirname(lockPath), { recursive: true }).pipe(Effect.ignore);
        const key = yield* canonicalPath(fs, lockPath);

        /** The exact bytes this acquire wrote, so `release` can compare them. */
        const mintPayload = (): string => {
            const procStartedAt = processStartedAt(process.pid);
            return encodeLockPayload({
                pid: process.pid,
                startedAt: now(),
                command: opts.command,
                token: crypto.randomUUID(),
                ...(procStartedAt === null ? {} : { procStartedAt }),
            });
        };

        /** Invariant 1: `"wx"` fails if the file exists, so exactly one racer
         *  wins. Returns the payload we wrote, or `null` if we lost. */
        const tryCreate = (): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
            Effect.suspend(() => {
                const payload = mintPayload();
                return fs.writeFileString(lockPath, payload, { flag: "wx" }).pipe(
                    Effect.as<string | null>(payload),
                    Effect.orElseSucceed<string | null>(() => null),
                );
            });

        /** Would a holder described by `text` block us right now? */
        const blockedBy = (text: string | null): IngestLockInfo | null => {
            if (text === null) return null;
            const holder = decodeLockPayload(text);
            if (holder === null) return null; // corrupt => take it over
            if (now() - holder.startedAt >= opts.staleMs) return null; // aged out
            if (holder.pid === process.pid && !inProcessHolders.has(key)) {
                // Our own pid, but this process is not holding it: a leftover
                // from a crashed earlier run, or a pid the OS reused. Liveness
                // cannot tell us that - our pid is always alive - so the
                // in-process registry does.
                return null;
            }
            return holderIsLive(holder) ? holder : null;
        };

        /**
         * Take the lock, or report who is holding it. Runs under the per-path
         * mutex (invariant 4/self-hold), so the create-then-register window is
         * never observable by another fiber of this process.
         */
        const acquire: Effect.Effect<
            { readonly payload: string } | { readonly heldBy: IngestLockInfo },
            never,
            FileSystem.FileSystem
        > = Effect.gen(function* () {
            const first = yield* tryCreate();
            if (first !== null) return { payload: first };

            const text = yield* readLockText(lockPath);
            const blocker = blockedBy(text);
            if (blocker !== null) return { heldBy: blocker };

            // Stale, dead, corrupt or unreadable. Invariant 5: confirm the file
            // is still EXACTLY what we classified before removing it, so a lock
            // installed under us is never deleted.
            const reread = yield* readLockText(lockPath);
            if (reread !== text) {
                const raced = reread === null ? null : decodeLockPayload(reread);
                return { heldBy: raced ?? UNKNOWN_HOLDER(now()) };
            }

            yield* fs.remove(lockPath).pipe(Effect.ignore);
            const second = yield* tryCreate();
            if (second !== null) return { payload: second };

            // Another process won the re-create; fail closed and skip.
            const after = yield* readLockText(lockPath);
            const winner = after === null ? null : decodeLockPayload(after);
            return { heldBy: winner ?? UNKNOWN_HOLDER(now()) };
        });

        const outcome = yield* acquireMutexFor(key).withPermits(1)(
            Effect.gen(function* () {
                const result = yield* acquire;
                if ("payload" in result) {
                    // Invariant 2: register under the token we just wrote, in the
                    // SAME critical section that created the file.
                    const token = decodeLockPayload(result.payload)?.token;
                    if (token !== undefined) inProcessHolders.set(key, token);
                }
                return result;
            }),
        );

        if ("heldBy" in outcome) {
            return { _tag: "busy", value: yield* opts.onBusy(outcome.heldBy) } as IngestLockOutcome<A, A2>;
        }

        const ourPayload = outcome.payload;
        const ourToken = decodeLockPayload(ourPayload)?.token;

        /**
         * Invariant 2: unlink only when the bytes on disk are still exactly the
         * ones this handle wrote. A superseded handle's release is a SUCCESS that
         * touches nothing, and it must not clear the CURRENT holder's
         * registration either - hence the token-matched de-registration.
         */
        const release = Effect.gen(function* () {
            const current = yield* readLockText(lockPath);
            if (current === ourPayload) yield* fs.remove(lockPath).pipe(Effect.ignore);
        }).pipe(
            Effect.ensuring(
                Effect.sync(() => {
                    if (ourToken !== undefined && inProcessHolders.get(key) === ourToken) {
                        inProcessHolders.delete(key);
                    }
                }),
            ),
        );

        const timed =
            opts.timeoutSeconds !== undefined
                ? work.pipe(Effect.timeoutOption(`${opts.timeoutSeconds} seconds`))
                : work.pipe(Effect.map(Option.some));

        // `afterWork` is sequenced AFTER the timeout check resolves, so it is
        // never raced against `timeoutSeconds` - only genuinely-timed-out work
        // skips it. It still runs before `release` below (see the combined
        // effect's own onExit), so it stays "under the lock".
        const timedThenAfter = Effect.gen(function* () {
            const settled = yield* timed;
            if (Option.isSome(settled) && opts.afterWork) yield* opts.afterWork(settled.value);
            return settled;
        });

        const result = yield* timedThenAfter.pipe(
            Effect.onExit((exit) =>
                Exit.hasInterrupts(exit)
                    ? Effect.void
                    : Exit.isSuccess(exit) && Option.isNone(exit.value)
                      ? Effect.void
                      : release,
            ),
        );

        if (Option.isNone(result)) {
            if (opts.onTimeout) yield* opts.onTimeout();
            return { _tag: "timeout" } as IngestLockOutcome<A, A2>;
        }
        return { _tag: "completed", value: result.value } as IngestLockOutcome<A, A2>;
    });
