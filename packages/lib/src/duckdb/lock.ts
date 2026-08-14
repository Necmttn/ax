/**
 * The ingest lockfile: the thing that stops two `ax ingest` runs from
 * corrupting the live database. In the v2 architecture, reads go through a
 * read-only handle on a published snapshot; WRITES only ever happen inside
 * ingest, under this lock.
 *
 * The lock is a small JSON file (`lock-state.ts`'s `LockPayload`) holding the
 * writer's pid and start time. `decideLock` (pure, tested in isolation)
 * classifies what's on disk into `free` / `held` / `stale` given a liveness
 * probe; this module supplies that probe (`process.kill(pid, 0)`), the real
 * filesystem operations, and the acquire/release lifecycle around them.
 *
 * The exclusive create (`"wx"`) is what actually breaks a race between two
 * simultaneous acquirers: `decideLock` can agree "free"/"stale" for both, but
 * only one `"wx"` write wins - the loser's failure is `AlreadyExists`, and
 * `createExclusive` (below) reports it back as a `"retry"` sentinel rather
 * than throwing or looping itself.
 *
 * WHAT IS BOUNDED, precisely (fix round 4). Every loop-back in this module is
 * one of exactly two kinds, and each kind has ONE bound. Nothing else loops.
 *
 *  - POLL loop-backs, for a condition only somebody ELSE can clear: the main
 *    lock is `held`; a live, young steal token holds the takeover; the lock
 *    file is empty-but-too-young to be a corpse. Three sites, all guarded by
 *    `ctx.waitUntil !== null && Date.now() < ctx.waitUntil` and all sleeping
 *    `ctx.pollMs` first. In no-wait mode `waitUntil` is `null`, so they do not
 *    loop AT ALL - they fail immediately, with a typed error naming the file.
 *  - RETRY loop-backs, for a condition that has already CHANGED under us: a
 *    lost `"wx"` create, a reclaimed leaked token, a confirm mismatch, a
 *    rename TOCTOU. Three sites, and all three go through `retryOrGiveUp`,
 *    which checks `ctx.deadline` and backs off `RETRY_BACKOFF_MS`.
 *    `acquire()` sets that deadline unconditionally - `timeoutMs` in wait
 *    mode, `NO_WAIT_RETRY_BUDGET_MS` otherwise - so a NO-WAIT acquire is
 *    bounded too, which is what rounds 2-3 lacked.
 *
 * So the guarantee is a DEADLINE, not a structural argument. Earlier drafts of
 * this comment argued instead that the loop "cannot spin ... each iteration
 * either wins the write, or lands on a decision of 'held'"; that was true only
 * of the plain `"wx"`-on-`path` loop and FALSE of the steal-token loops, which
 * is how three reachable, permanent hangs survived two review rounds.
 * Structural arguments are used below only to explain why a loop normally
 * finishes in ONE iteration - never as the reason it terminates.
 *
 * Taking over a `stale` file is ALSO a race, and NEITHER an unconditional
 * `remove` NOR a bare `rename` can arbitrate it on their own (fix round 1,
 * review IMPORTANT 1; the rename-only version of round 1 was ALSO wrong -
 * ruling R13). `rename(from, to)` moves whatever currently sits at `from`,
 * unconditionally - it has exactly one winner for "did a rename land", but it
 * proves nothing about WHAT got moved. Two racers A and B can both read the
 * same stale payload and both decide "stale"; if A wins first (rename, clean
 * up, `"wx"`-create its own live lock) and B was merely descheduled, B's
 * rename now moves A's freshly-written LIVE lock - rename does not check
 * identity, so it succeeds anyway, and B goes on to also "win" its own
 * `"wx"`-create. Two live handles, exactly the bug this module exists to
 * prevent.
 *
 * The actual fix is a STEAL TOKEN plus a confirm-then-act re-read
 * (`stealStale`/`confirmAndTakeOver` below):
 *   1. `"wx"`-create `<path>.steal`. Atomic - exactly one stealer proceeds.
 *      What the loser (`AlreadyExists`) does is NOT an unconditional
 *      loop-back; see "TOKEN LIVENESS" below, which is where rounds 2-3 hung.
 *   2. Under the token, RE-READ `path` and confirm its payload is still
 *      BYTE-IDENTICAL to the one just classified `stale`. If it changed,
 *      someone else already installed a fresh lock while we held nothing but
 *      the token - release the token and loop back (that re-decide will
 *      correctly see it as `held`).
 *   3. Only after that confirmation does it rename `path` away and
 *      `"wx"`-create it with our own payload. Only the token holder reaches
 *      this step for a `stale` takeover - so AS LONG AS exactly one process
 *      holds the token, no second racer can rename the same confirmed-fresh
 *      file out from under a live winner. That premise is NOT unconditional:
 *      residuals (1) and (2) below are the two ways two processes can both
 *      believe they hold it.
 *   4. The token is removed under `Effect.ensuring`, on every exit path.
 * While the token is genuinely held by ONE process, this closes the interleave
 * the bare rename could not: B cannot reach step 3 while A holds the token,
 * and when B finally gets the token, its re-read sees A's LIVE payload - which
 * differs from the stale payload B originally classified - so B loops back
 * instead of touching anything. Read that together with residuals (1) and (2),
 * which are the cases where the "ONE process" premise fails.
 *
 * TOKEN LIVENESS (fix round 4). `<path>.steal` is ONE machine-wide path, so a
 * leaked token wedges every later `ax ingest` and the LaunchAgent watcher on
 * the box. Rounds 2-3 had the token loser loop back to `attempt`
 * UNCONDITIONALLY, which produced three reachable, PERMANENT hangs, all three
 * reproduced as an `acquire()` that never returned:
 *   1. A leaked token whose pid is ALIVE - a crash plus pid reuse, or a
 *      non-`NotFound` token removal the code swallows. A dead-pid check
 *      declines forever.
 *   2. A leaked token that is EMPTY or unparseable - a crash between the
 *      `"wx"` open and the write. There is no pid to probe at all, so no pid
 *      check can ever free it. No pid reuse needed.
 *   3. `createExclusive`'s `AlreadyExists` branch re-deciding while still
 *      nested UNDER a token we ourselves held: it re-entered `stealStale`,
 *      lost the `"wx"` on its OWN token, saw its own live pid, and never made
 *      progress.
 * The deadline did not save any of them, because it was only consulted on the
 * `held` branch - `acquire({ wait: true, timeoutMs: 300 })` hung too. Rounds
 * 2-3 documented these loops as bounded ("the caller's loop-back will just
 * retry shortly"); round 3 went further and described the fix below as if it
 * were already written when the file still contained none of it. That is
 * recorded here because a false safety claim is what removed the reason to
 * look again.
 *
 * The fix has three parts:
 *  - `reclaimStaleToken`: a token loser reads the existing token and reclaims
 *    it - NEVER seizes it - when the pid inside is DEAD, or when the token is
 *    older than `STALE_RECLAIM_AGE_MS` regardless of parseability or pid
 *    liveness. Age comes from `mtime`, not from the payload, so it still
 *    applies to an empty token (hang 2) and to a reused pid (hang 1).
 *  - When reclaim DECLINES (a live, young stealer genuinely holds the token),
 *    that is real contention and is bounded exactly like a `held` main lock:
 *    no-wait fails immediately with a typed `IngestLockError` naming the TOKEN
 *    path; wait mode sleeps `pollMs` and retries until `timeoutMs`.
 *  - `createExclusive` returns the `"retry"` sentinel instead of looping
 *    itself (hang 3), so `stealStale`'s `Effect.ensuring` releases the token
 *    BEFORE any loop-back runs, from every branch without exception.
 * On top of all three, every surviving loop-back goes through `retryOrGiveUp`
 * and therefore through `AttemptCtx.deadline`.
 *
 * The CONFIRM step has the same empty-file problem as the token, and is closed
 * the same way. `writeFileString(..., { flag: "wx" })` is create-then-write, so
 * a LIVE holder is briefly a zero-byte file. `decideLock` calls unparseable
 * content `stale`, and two racers reading inside that window would both compare
 * `"" === ""` and both "confirm" a live lock. `confirmAndTakeOver` therefore
 * treats empty/unparseable content as NOT confirmable until it has aged past
 * `STALE_RECLAIM_AGE_MS`; below that the token is released and the call is
 * bounded as CONTENTION (fail fast / poll), not retried - only the holder can
 * clear that condition, so a retry against it is a busy-wait by construction.
 *
 * Residual, stated precisely rather than assumed away:
 *  1. `reclaimStaleToken` removes the token BY PATH; it never confirms that
 *     the file it removes is the file it classified. Two losers can observe
 *     the SAME reclaimable token, and the second one's remove can land AFTER
 *     a third contender has already `"wx"`-created a FRESH, LIVE token - so it
 *     deletes a live token rather than a corpse. Two processes then hold "the
 *     token" concurrently, both reach `confirmAndTakeOver`, and the two-winner
 *     rename outcome from the pre-token design is reachable again.
 *     This needs NO 60s suspension. A few milliseconds of deschedule between
 *     the read at the top of `reclaimStaleToken` and its remove is enough, and
 *     a GC pause or a loaded machine supplies that.
 *     An earlier version of this comment called the double reclaim "harmless -
 *     removing an already-removed file is a no-op". That is FALSE. A fix-round-5
 *     reviewer verified it false on BOTH reclaim branches (dead-pid and age):
 *     with a fresh live token installed between classify and remove, the fresh
 *     live token did not survive. The read-then-remove gap itself pre-dates the
 *     age branch; what is retracted here is the certification that it was
 *     harmless. The precondition is still a LEAKED token plus concurrent
 *     acquirers, so this is not an everyday path - but it is not arbitrated.
 *     A pre-rename token-ownership re-check does NOT fix it: that moves the
 *     window from (confirm-read -> rename) to (re-check -> rename). Every step
 *     in this module is check-then-act on a PATH, and no additional re-check
 *     closes that. See residual (5).
 *  2. The age-based reclaim is a TIMEOUT-based liveness heuristic, not a
 *     proof. A process merely SUSPENDED (not dead) for longer than
 *     `STALE_RECLAIM_AGE_MS` mid-steal can have its token reclaimed by a new
 *     contender; if it then resumes and completes its rename without
 *     re-checking token ownership (this module does not re-check), two winners
 *     are possible again. That needs a process stalled longer than
 *     `STALE_RECLAIM_AGE_MS` mid-steal PLUS a contender racing into that
 *     window. The stall does NOT require slow syscalls: `SIGSTOP`,
 *     suspend-to-RAM, a VM snapshot restore, and a forward NTP step all
 *     satisfy an `mtime`-relative 60s with no syscall involved.
 *  3. Nothing REAPS a `<path>.steal` or `<path>.stale.<pid>.<nonce>` sibling
 *     proactively; they are only cleaned up by the next acquirer that trips
 *     over them (deferred, out of scope for this fix).
 *  4. A non-`NotFound` failure removing the token is swallowed by
 *     `Effect.ensuring`'s infallible finalizer. That leak is no longer
 *     permanent - it ages out - but it does cost one threshold.
 *  5. The only primitives that actually arbitrate residuals (1) and (2) are an
 *     OS advisory lock (`flock`/`fcntl`) held ACROSS the takeover, or a design
 *     that never removes a foreign file. Both are out of scope for this chunk
 *     and are raised to the v2-duckdb epic, gated on wiring this module into
 *     `ax ingest` - nothing imports it outside its own test today.
 *  6. `confirmAndTakeOver` folds "the lock file VANISHED between the confirm
 *     read and the `stat`" (`age === null`) into `"unconfirmable"` rather than
 *     `"retry"`. The lock is actually FREE at that instant, so a no-wait caller
 *     gets a spurious failure whose message ("empty or unparseable and too
 *     recent to be a corpse") is factually wrong for that state. Bounded, and
 *     it self-corrects in wait mode. Known; deliberately not changed in a
 *     documentation-only round.
 * Points 1, 2 and 4 are the limit of what a plain lockfile with no external
 * coordinator (no fcntl advisory lock, no lease service) can arbitrate; (5) is
 * what would actually close them.
 *
 * `decideLock` cannot classify our own pid from `isAlive` alone (fix round 1,
 * review IMPORTANT 2): our own pid is by definition always alive, so without
 * more information a second `acquire()` call in the SAME process (e.g. two
 * in-process `ax serve` ingest requests) would see the first's still-open,
 * valid lock and misclassify it as a stale leftover from a pid the OS
 * reused - then delete and steal it out from under the first caller. The fix
 * threads a `selfHolds` boolean into `decideLock` so "our pid, and we hold
 * it" (a genuine second in-process acquirer - reject it) is distinguished
 * from "our pid, and we do NOT hold it" (a genuine crashed-run leftover -
 * take it over). That state must be PROCESS-scoped, not per-layer-instance
 * (fix round 2, review "also fix"): `ax` can build a fresh `AppLayer` (and
 * hence a fresh `IngestLock` layer) per `run(provide(...))` call, so a Ref
 * closed over by one layer instance is invisible to a second in-process
 * acquirer that goes through a DIFFERENT layer instance for the SAME path -
 * exactly the `ax serve`-forking-`runIngest` shape this module is built for.
 * `inProcessHolders` below is a module-level `Map<path, boolean>`, the one
 * piece of truly global state in this file, scoped by the resolved lock path
 * so it is correct regardless of how many layer instances a consumer builds.
 *
 * RULING R6: this is a runtime module under `packages/lib/src/`, so
 * `node:fs` / `node:path` are banned (`check:no-node-fs`). Filesystem access
 * goes through `FileSystem.FileSystem`, acquired once in the layer and closed
 * over by every method - so `IngestLockService`'s signatures keep `R = never`,
 * exactly as declared. Path joins go through `posixPath`
 * (`@ax/lib/shared/path`, mirroring `dylib.ts`). `node:os#homedir` is not
 * banned and stays.
 */
import { BunFileSystem } from "@effect/platform-bun";
import { Context, Effect, FileSystem, Layer, Option, type PlatformError } from "effect";
import { homedir } from "node:os";
import { skipNotFound } from "../shared/fs-error.ts";
import { posixPath } from "../shared/path.ts";
import { IngestLockError, IngestLockHeldError } from "./errors.ts";
import { decideLock, decodeLockPayload, encodeLockPayload, type LockPayload } from "./lock-state.ts";

export interface IngestLockHandle {
    readonly path: string;
    readonly release: Effect.Effect<void>;
}

export interface AcquireOptions {
    /**
     * `true` polls a held lock until `timeoutMs`. `false` (the default) does
     * not WAIT on a held lock - a `held` decision fails immediately with
     * `IngestLockHeldError`.
     *
     * `false` bounds WAITING, not wall-clock. Loop-backs that are genuine
     * progress rather than waiting - a reclaimed leaked token, a racer
     * changing the file under us - still run in no-wait mode, each backing off
     * `RETRY_BACKOFF_MS`, against a total budget of `NO_WAIT_RETRY_BUDGET_MS`
     * (2s). So under pathological churn a no-wait `acquire()` can take up to
     * ~2s before failing with a typed error naming the file that blocked it.
     * Ordinary contention against a held lock still returns in ~1ms.
     */
    readonly wait?: boolean;
    /** Deadline for the `held` poll loop in wait mode. Default `DEFAULT_TIMEOUT_MS` (30s). */
    readonly timeoutMs?: number;
    /** Poll interval for the `held` loop in wait mode. Default `DEFAULT_POLL_MS` (100ms). */
    readonly pollMs?: number;
}

export interface IngestLockService {
    readonly acquire: (
        options?: AcquireOptions,
    ) => Effect.Effect<IngestLockHandle, IngestLockHeldError | IngestLockError>;
    readonly holder: Effect.Effect<LockPayload | null, IngestLockError>;
}

export class IngestLock extends Context.Service<IngestLock, IngestLockService>()(
    "ax/IngestLock",
) {}

/** `~/.ax/ingest.lock`, overridable for tests/alternate data dirs. */
export const ingestLockPath = (): string => {
    const override = process.env.AX_INGEST_LOCK?.trim();
    return override ? override : posixPath.join(homedir(), ".ax", "ingest.lock");
};

/** `process.kill(pid, 0)` probes liveness without sending a real signal.
 *  `EPERM` means the process exists but belongs to another user - still
 *  alive, just not ours to see into. Any other thrown error (e.g. `ESRCH`)
 *  means the pid is gone. */
const isAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 100;

/**
 * How old a steal token (or an empty/unparseable lock file) must be before it
 * is treated as a corpse and reclaimed regardless of what its pid says.
 *
 * Why 60s specifically:
 * - A LIVE stealer holds the token across four local syscalls (one read of
 *   `path`, one rename, one remove, one `"wx"` write) - sub-millisecond in
 *   practice. 60s is ~5 orders of magnitude of headroom, far beyond any
 *   plausible page-fault, disk, or scheduler blip.
 * - It is deliberately LONGER than `DEFAULT_TIMEOUT_MS` (30s), so a single
 *   `acquire({ wait: true })` AT THE DEFAULT TIMEOUT gives up before it could
 *   age out a token created after that acquire started. `timeoutMs` is a
 *   caller-supplied public option, so this does NOT hold in general:
 *   `acquire({ wait: true, timeoutMs: 120_000 })` outlives the threshold and
 *   can age out such a token.
 * - The alternative is what this replaces: a leaked token wedging every later
 *   `ax ingest` on the machine FOREVER. A bounded 60s of self-healing beats
 *   an unbounded wedge, and 60s is short enough that an operator waiting on a
 *   crashed ingest does not conclude the tool is broken.
 * This is a TIMEOUT-based liveness heuristic, not a proof - see the module
 * doc comment's residual (2) for what it costs.
 */
const STALE_RECLAIM_AGE_MS = 60_000;

/**
 * Absolute budget for the internal loop-backs of a NO-WAIT `acquire()`.
 * No-wait callers never poll (a `held` lock fails immediately), but some
 * loop-backs are genuine progress rather than waiting - a reclaimed leaked
 * token, or a racer changing the file under us - and those must still be able
 * to run. They get this budget instead of `timeoutMs`, and every one of them
 * is checked against it, so no retry path can loop without a deadline. In the
 * ordinary case exactly one retry happens and costs one `RETRY_BACKOFF_MS`
 * hop; this budget only ever runs out against pathological churn, and when it
 * does it fails with a typed error naming the file that blocked.
 */
const NO_WAIT_RETRY_BUDGET_MS = 2_000;

/**
 * A loop-back always waits at least this long. Every remaining retry cause is
 * "another process mutated the file under us", which normally resolves on the
 * first re-decide, so the cost is one 5ms hop. The point is that a deadline
 * alone still permits thousands of syscalls per second against it - the round-3
 * hangs burned ~8,000 iterations/second - and a bounded busy-wait is still a
 * busy-wait. This caps a pathological retry storm at a few hundred iterations.
 * The `held` fail-fast path never reaches here and never sleeps.
 */
const RETRY_BACKOFF_MS = 5;

/**
 * The bounds that govern one `acquire()` call, threaded through every loop in
 * this module so none of them can spin.
 */
interface AttemptCtx {
    /** Absolute `Date.now()` deadline for the `held` POLL loop, or `null` in
     *  no-wait mode (where a `held` decision fails immediately). */
    readonly waitUntil: number | null;
    /** Absolute `Date.now()` backstop for EVERY loop-back in this call,
     *  including the ones no-wait mode would otherwise retry unbounded. */
    readonly deadline: number;
    readonly pollMs: number;
}

const toLockError = (path: string, err: PlatformError.PlatformError): IngestLockError =>
    new IngestLockError({ path, message: err.message });

const isAlreadyExists = (err: PlatformError.PlatformError): boolean =>
    err.reason._tag === "AlreadyExists";

const isNotFoundError = (err: PlatformError.PlatformError): boolean =>
    err.reason._tag === "NotFound";

/**
 * Process-wide (deliberately NOT per-layer-instance) in-process holding
 * state, keyed by the resolved lock path - see the module doc comment for
 * why a `Ref` closed over by one layer instance is not enough. The only
 * reader/writer of this map is `selfHoldsFor`/`setSelfHolds` below; nothing
 * else touches it. Plain synchronous `Map` mutation is safe here: Effect
 * fibers only interleave at yield points, and every read/write of a single
 * entry below happens inside one synchronous statement, never straddling a
 * yield.
 */
const inProcessHolders = new Map<string, boolean>();

const selfHoldsFor = (path: string): boolean => inProcessHolders.get(path) ?? false;

const setSelfHolds = (path: string, value: boolean): void => {
    if (value) inProcessHolders.set(path, true);
    else inProcessHolders.delete(path);
};

/** Build the `IngestLockService` over an already-acquired `FileSystem`. */
const makeService = (fs: FileSystem.FileSystem, path: string): IngestLockService => {
    /** `null` when the file is not there (ENOENT); every other read failure
     *  becomes `IngestLockError`. */
    const readTolerant = (target: string) =>
        fs
            .readFileString(target)
            .pipe(
                skipNotFound(null as string | null),
                Effect.mapError((err) => toLockError(target, err)),
            );

    /** Built ONCE, deliberately: `lock.test.ts`'s `readFileString` decorator
     *  relies on this being a re-runnable Effect value rather than a fresh
     *  call per read. */
    const readLockText = readTolerant(path);

    /** Age of `target` in milliseconds, `null` when it no longer exists.
     *  A file with NO timestamp at all reads as infinitely old: the whole
     *  point of the age fallback is that nothing wedges forever, and every
     *  platform this runs on reports `mtime`, so the unreachable branch is
     *  resolved toward self-healing rather than toward a permanent wedge. */
    const fileAgeMs = (target: string): Effect.Effect<number | null, IngestLockError> =>
        fs
            .stat(target)
            .pipe(
                Effect.map((info) => {
                    const stamp = Option.getOrUndefined(info.mtime) ?? Option.getOrUndefined(info.birthtime);
                    return stamp === undefined ? Number.POSITIVE_INFINITY : Date.now() - stamp.getTime();
                }),
                skipNotFound(null as number | null),
                Effect.mapError((err) => toLockError(target, err)),
            );

    /** Remove a file, tolerating "already gone" (a concurrent racer beat us
     *  to it, or a `release` racing this same removal). */
    const removeTolerant = (target: string) =>
        fs
            .remove(target)
            .pipe(
                Effect.catchTag("PlatformError", (err) =>
                    isNotFoundError(err) ? Effect.void : Effect.fail(toLockError(target, err)),
                ),
            );

    const holder: Effect.Effect<LockPayload | null, IngestLockError> = readLockText.pipe(
        Effect.map((text) =>
            text === null ? null : (decideLock(text, isAlive, process.pid, selfHoldsFor(path)).holder ?? null),
        ),
    );

    /**
     * One attempt: decide against what's currently on disk, take the lock if
     * `free`, steal it if `stale`, wait-and-retry or fail-fast if `held`.
     */
    const attempt = (
        ctx: AttemptCtx,
    ): Effect.Effect<IngestLockHandle, IngestLockHeldError | IngestLockError> =>
        Effect.gen(function* () {
            yield* fs
                .makeDirectory(posixPath.dirname(path), { recursive: true })
                .pipe(Effect.mapError((err) => toLockError(path, err)));

            const text = yield* readLockText;
            const decision = decideLock(text, isAlive, process.pid, selfHoldsFor(path));

            if (decision.kind === "held") {
                // `decideLock` always attaches `holder` on a "held" decision.
                const heldHolder = decision.holder!;
                if (ctx.waitUntil !== null && Date.now() < ctx.waitUntil) {
                    yield* Effect.sleep(ctx.pollMs);
                    return yield* attempt(ctx);
                }
                return yield* new IngestLockHeldError({
                    path,
                    pid: heldHolder.pid,
                    startedAt: heldHolder.started_at,
                });
            }

            if (decision.kind === "stale") {
                // `text` is what we classified `stale` FROM - `stealStale`
                // re-reads and confirms against this exact string before
                // touching anything (ruling R13; see the module doc comment
                // for why a bare rename cannot arbitrate this on its own).
                // `decideLock` only ever returns "stale" from a non-null
                // `text` (the `text === null` case is always "free").
                return yield* stealStale(text!, ctx);
            }

            const created = yield* createExclusive();
            if (created === "retry") {
                return yield* retryOrGiveUp(
                    ctx,
                    path,
                    "kept losing the exclusive lock-file create to racing writers",
                );
            }
            return created;
        });

    /**
     * The one place a RETRY loop-back happens - "something changed under us,
     * go re-decide". All three retry sites funnel through here, so none of
     * them can loop without a deadline, which is exactly what the three
     * round-3 hangs had in common.
     *
     * This is NOT every loop-back in the module: the three POLL loop-backs
     * (`held`, declined token contention, `unconfirmable`) are bounded
     * separately by `ctx.waitUntil` and sleep `ctx.pollMs` - see the module
     * doc comment. Do not read this as covering them.
     *
     * Past the deadline it fails with a typed `IngestLockError` NAMING
     * `blocker`: the file the operator has to look at (often `<path>.steal`,
     * which is one machine-wide path, so a leak there wedges every later
     * `ax ingest` and an unnamed error leaves nothing to act on).
     */
    const retryOrGiveUp = (
        ctx: AttemptCtx,
        blocker: string,
        why: string,
    ): Effect.Effect<IngestLockHandle, IngestLockHeldError | IngestLockError> =>
        Effect.gen(function* () {
            if (Date.now() < ctx.deadline) {
                yield* Effect.sleep(RETRY_BACKOFF_MS);
                return yield* attempt(ctx);
            }
            return yield* new IngestLockError({
                path: blocker,
                message: `${why}; gave up on ${path} after the acquire deadline. Inspect ${blocker} and remove it if no ingest is running.`,
            });
        });

    /**
     * `"wx"`-create `path` with our own payload. Losing the create to a
     * racing writer (`AlreadyExists`) is NOT an error and NOT a recursion:
     * it returns the `"retry"` sentinel, so the caller decides when to loop
     * back. That matters because one caller (`confirmAndTakeOver`) reaches
     * here while HOLDING the steal token, and a loop-back from inside that
     * scope was hang #3 - it could re-enter `stealStale` and then block on
     * its own, still-held token forever. Every caller now loops back only
     * after the token has been released, and only against `ctx.deadline`.
     */
    const createExclusive = (): Effect.Effect<IngestLockHandle | "retry", IngestLockError> =>
        Effect.gen(function* () {
            const payload = encodeLockPayload({ pid: process.pid, started_at: new Date().toISOString() });
            const written = yield* Effect.result(fs.writeFileString(path, payload, { flag: "wx" }));

            if (written._tag === "Success") {
                setSelfHolds(path, true);
                return { path, release: releaseHandle };
            }

            if (isAlreadyExists(written.failure)) {
                return "retry" as const;
            }

            return yield* toLockError(path, written.failure);
        });

    /**
     * Take the steal token (`<path>.steal`, `"wx"`-created - exactly one
     * stealer proceeds). What happens to the LOSER is the part that used to
     * hang: it now asks `reclaimStaleToken` whether the token is a corpse.
     *  - Reclaimed (dead pid, or aged past `STALE_RECLAIM_AGE_MS`, or already
     *    gone): loop back through `retryOrGiveUp`, so even a pathological
     *    reclaim-then-lose cycle is bounded by `ctx.deadline`.
     *  - Declined (a live, YOUNG stealer legitimately holds it): that is real
     *    contention, and it is bounded exactly like a `held` main lock -
     *    no-wait fails immediately, wait mode sleeps `pollMs` and retries
     *    until `waitUntil`. Either way the failure NAMES the token path.
     * Token contention surfaces as `IngestLockError`, not
     * `IngestLockHeldError`, because a token is not a lock holder: it carries
     * no committed pid/started_at claim about who owns the database, and an
     * empty token carries no pid at all.
     */
    const stealStale = (
        staleText: string,
        ctx: AttemptCtx,
    ): Effect.Effect<IngestLockHandle, IngestLockHeldError | IngestLockError> =>
        Effect.gen(function* () {
            const tokenPath = `${path}.steal`;
            const tokenPayload = encodeLockPayload({ pid: process.pid, started_at: new Date().toISOString() });
            const tokenCreated = yield* Effect.result(fs.writeFileString(tokenPath, tokenPayload, { flag: "wx" }));

            if (tokenCreated._tag === "Failure") {
                if (!isAlreadyExists(tokenCreated.failure)) {
                    return yield* toLockError(tokenPath, tokenCreated.failure);
                }
                const reclaimed = yield* reclaimStaleToken(tokenPath);
                if (reclaimed) {
                    return yield* retryOrGiveUp(
                        ctx,
                        tokenPath,
                        "kept losing the steal token immediately after reclaiming it",
                    );
                }
                if (ctx.waitUntil !== null && Date.now() < ctx.waitUntil) {
                    yield* Effect.sleep(ctx.pollMs);
                    return yield* attempt(ctx);
                }
                return yield* new IngestLockError({
                    path: tokenPath,
                    message: `another process is taking over the stale lock at ${path}. If none is running, this token leaked - remove ${tokenPath} (it is reclaimed automatically once it is ${STALE_RECLAIM_AGE_MS}ms old).`,
                });
            }

            // We hold the token. Confirm-then-act, and ALWAYS release the
            // token on the way out (success, failure, or a mismatch/TOCTOU
            // that needs a retry). Ruling R13 step 2 is "release the token
            // AND loop back" - strictly sequential - so `confirmAndTakeOver`
            // never recurses into `attempt` itself, and neither does
            // `createExclusive` underneath it: both return the "retry"
            // sentinel, and the actual loop-back happens HERE, only after
            // `Effect.ensuring` has finished releasing the token. Looping
            // back while still nested inside our own still-held token was
            // hang #3, and it was reachable: a re-decide that landed on
            // `stale` again would try to `"wx"`-create a token we ourselves
            // already hold, find our own pid alive, and never make progress.
            // `Effect.ensuring` requires an infallible finalizer, so a
            // genuine (non-`NotFound`) failure removing the token is
            // deliberately swallowed (`Effect.ignore`) rather than masking
            // the primary result. That leak is no longer permanent: the
            // token now ages out after `STALE_RECLAIM_AGE_MS`.
            const outcome = yield* confirmAndTakeOver(staleText).pipe(
                Effect.ensuring(removeTolerant(tokenPath).pipe(Effect.ignore)),
            );
            if (outcome === "unconfirmable") {
                // The file is empty/unparseable and YOUNG: overwhelmingly a
                // live holder caught mid-`"wx"`-write, not a corpse. That is
                // the same situation as `held`, so it gets the same bounds -
                // no-wait fails immediately, wait mode polls - rather than a
                // retry storm against a condition only the holder can clear.
                if (ctx.waitUntil !== null && Date.now() < ctx.waitUntil) {
                    yield* Effect.sleep(ctx.pollMs);
                    return yield* attempt(ctx);
                }
                return yield* new IngestLockError({
                    path,
                    message: `the lock file at ${path} is empty or unparseable and too recent to be a corpse - another process is most likely writing it right now. It becomes reclaimable once it is ${STALE_RECLAIM_AGE_MS}ms old.`,
                });
            }
            if (outcome === "retry") {
                return yield* retryOrGiveUp(
                    ctx,
                    path,
                    `could not confirm the stale lock at ${path} long enough to take it over`,
                );
            }
            return outcome;
        });

    /**
     * A `"wx"`-create of the steal token lost to `AlreadyExists`. Decide
     * whether that token is a corpse. Returns `true` when the token is gone
     * (we removed it, or it had already vanished) so the caller may loop
     * back; `false` when a live, young stealer legitimately holds it.
     *
     * It never SEIZES the token - seizing would move the same two-winner race
     * up one level. Two conditions make a token reclaimable:
     *  1. Its pid is DEAD. Unambiguous.
     *  2. It is older than `STALE_RECLAIM_AGE_MS`, whatever its content says.
     *     This is the case a pid check cannot reach, and it covers both
     *     round-3 hangs: an EMPTY/unparseable token (a crash between the
     *     `"wx"` open and the write - no pid to probe at all) and a token
     *     whose pid the OS has since REUSED (reads alive forever).
     * Age comes from the filesystem (`mtime`), not from the payload's
     * `started_at`, precisely so an unparseable token still has an age.
     */
    const reclaimStaleToken = (tokenPath: string): Effect.Effect<boolean, IngestLockError> =>
        Effect.gen(function* () {
            const tokenText = yield* readTolerant(tokenPath);
            if (tokenText === null) return true; // already gone
            const tokenHolder = decodeLockPayload(tokenText);
            if (tokenHolder !== null && !isAlive(tokenHolder.pid)) {
                yield* removeTolerant(tokenPath);
                return true;
            }
            const age = yield* fileAgeMs(tokenPath);
            if (age === null) return true; // vanished under us
            if (age < STALE_RECLAIM_AGE_MS) return false; // live and young: real contention
            yield* removeTolerant(tokenPath);
            return true;
        });

    /**
     * Holding the steal token, re-read `path` and confirm it is still
     * BYTE-IDENTICAL to `staleText` - the exact payload just classified
     * `stale`. A mismatch means someone else installed a fresh lock (or
     * otherwise changed `path`) while we held nothing but the token: return
     * the `"retry"` sentinel rather than recursing into `attempt` directly -
     * `stealStale` (the caller) releases the token FIRST and only then loops
     * back, so no re-decide runs while we still nominally hold the token.
     * The same sentinel covers the narrower TOCTOU where the confirmed
     * payload vanishes between this re-read and the rename below, and the
     * `AlreadyExists` a third acquirer can hand `createExclusive` after the
     * rename.
     *
     * Byte identity is NOT sufficient on its own when the bytes are empty or
     * unparseable. `writeFileString(..., { flag: "wx" })` is create-then-
     * write, so a LIVE holder is briefly a zero-byte file; two racers reading
     * inside that window both classify `stale` and both compare `"" === ""`,
     * which "confirms" a lock that is very much alive. So unparseable content
     * is only confirmable once it has aged past `STALE_RECLAIM_AGE_MS` - far
     * longer than any create-then-write window. Below that it returns the
     * DISTINCT `"unconfirmable"` sentinel, which the caller releases the token
     * for and then treats as contention (fail fast / poll), not as a retry:
     * only the holder can clear this condition, so retrying against it is a
     * busy-wait by construction. Above the threshold the file is a genuine
     * corpse and must not wedge the path forever.
     */
    const confirmAndTakeOver = (
        staleText: string,
    ): Effect.Effect<IngestLockHandle | "retry" | "unconfirmable", IngestLockError> =>
        Effect.gen(function* () {
            const reread = yield* readLockText;
            if (reread !== staleText) {
                return "retry" as const;
            }

            if (decodeLockPayload(reread) === null) {
                const age = yield* fileAgeMs(path);
                if (age === null || age < STALE_RECLAIM_AGE_MS) {
                    return "unconfirmable" as const;
                }
            }

            const stagingPath = `${path}.stale.${process.pid}.${crypto.randomUUID()}`;
            const renamed = yield* Effect.result(fs.rename(path, stagingPath));
            if (renamed._tag === "Failure") {
                if (isNotFoundError(renamed.failure)) {
                    // The confirmed payload vanished between our re-read and
                    // this rename - a narrower TOCTOU window the confirm-read
                    // alone cannot close. Same sentinel, same reasoning.
                    return "retry" as const;
                }
                return yield* toLockError(path, renamed.failure);
            }
            // Clean up the renamed-away evidence (best-effort; the staging
            // name is nonce'd, so nothing else should be racing it).
            yield* removeTolerant(stagingPath);

            return yield* createExclusive();
        });

    /**
     * Re-read the file and unlink only when the payload's pid is ours - a
     * late/idempotent release must never delete a successor's lock. Uses
     * `decodeLockPayload` directly (not `decideLock`) because release only
     * cares "does the file currently name our pid", not the held/stale
     * classification. Always clears the in-process holding state for `path`,
     * whether or not the on-disk file was ours to remove - once `release` is
     * called, THIS process no longer considers itself the holder, full stop.
     * The `IngestLockHandle` contract (matching `close` in `client.ts`) gives
     * `release` no error channel, so any failure here (e.g. permission denied
     * on the unlink) is swallowed rather than propagated - release is always
     * best-effort.
     */
    const releaseHandle: Effect.Effect<void> = readLockText.pipe(
        Effect.flatMap((text) => {
            if (text === null) return Effect.void;
            const current = decodeLockPayload(text);
            if (current?.pid !== process.pid) return Effect.void;
            return removeTolerant(path);
        }),
        Effect.ensuring(Effect.sync(() => setSelfHolds(path, false))),
        Effect.ignore,
    );

    const acquire: IngestLockService["acquire"] = (options) => {
        const wait = options?.wait ?? false;
        const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const pollMs = options?.pollMs ?? DEFAULT_POLL_MS;
        const now = Date.now();
        // Wait mode: one deadline governs both the `held` poll loop and the
        // internal loop-backs. No-wait mode: `held` fails immediately
        // (`waitUntil === null`), but the internal loop-backs - which are
        // progress, not waiting - still get a bounded budget so nothing can
        // spin. The fast paths reach neither.
        const waitUntil = wait ? now + timeoutMs : null;
        const deadline = now + (wait ? timeoutMs : NO_WAIT_RETRY_BUDGET_MS);
        return attempt({ waitUntil, deadline, pollMs });
    };

    return { acquire, holder };
};

/** Exported (not just internal) so tests can inject a decorated `FileSystem`
 *  that overrides one operation - the seam that makes the steal-token race
 *  deterministically testable without a real multi-process harness. */
export const base = (path: string): Layer.Layer<IngestLock, never, FileSystem.FileSystem> =>
    Layer.effect(IngestLock)(
        Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            return makeService(fs, path);
        }),
    );

/** Layer over an explicit lock file path - the injection point for tests. */
export const IngestLockLayer = (path: string): Layer.Layer<IngestLock> =>
    base(path).pipe(Layer.provide(BunFileSystem.layer));

/** Default layer: `~/.ax/ingest.lock` (or `AX_INGEST_LOCK`). */
export const IngestLockLive: Layer.Layer<IngestLock> = IngestLockLayer(ingestLockPath());
