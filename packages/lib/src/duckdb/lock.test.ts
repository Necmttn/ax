import { BunFileSystem } from "@effect/platform-bun";
import { afterAll, describe, expect, test } from "bun:test";
import { Effect, FileSystem, Layer, Option, PlatformError } from "effect";
import {
    existsSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    unlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeLockPayload, encodeLockPayload } from "./lock-state.ts";
import {
    base,
    IngestLock,
    IngestLockLayer,
    type IngestLockHandle,
    type IngestLockService,
} from "./lock.ts";

// Finding 4 (final fix round): every dir this suite creates - via the two
// helpers below AND the one inline `mkdtempSync` further down - is collected
// here and removed in one afterAll. See dylib.test.ts for the measured leak
// this closes.
const createdTempDirs: string[] = [];
const newTempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "ax-ingest-lock-"));
    createdTempDirs.push(dir);
    return dir;
};

afterAll(() => {
    for (const dir of createdTempDirs) rmSync(dir, { recursive: true, force: true });
});

const lockPath = () => join(newTempDir(), "ingest.lock");

const lockDir = () => newTempDir();

/**
 * Every terminating path in `lock.ts` is bounded by an absolute deadline that
 * these tests keep well under a second, so an acquire still running after this
 * window is a HANG, not a slow machine. `Effect.timeoutOption` INTERRUPTS the
 * source fiber and yields `Option.none`, so a regression fails an assertion
 * instead of wedging the whole suite the way the real bug wedged `ax ingest`.
 */
const HANG_GUARD_MS = 2_000;

type AcquiredHandle = IngestLockHandle;

const boundedAcquire = (lock: IngestLockService, options?: Parameters<IngestLockService["acquire"]>[0]) =>
    Effect.timeoutOption(Effect.result(lock.acquire(options)), HANG_GUARD_MS);

/** Unwrap a `boundedAcquire` outcome, asserting first that it TERMINATED. */
const terminated = <A>(outcome: Option.Option<A>): A => {
    expect(outcome._tag).toBe("Some"); // None here means acquire() never returned.
    return Option.getOrThrow(outcome);
};

const withLock = <A>(
    path: string,
    body: (lock: IngestLockService) => Effect.Effect<A, unknown>,
) =>
    Effect.runPromise(
        Effect.gen(function* () {
            const lock = yield* IngestLock;
            return yield* body(lock);
        }).pipe(Effect.provide(IngestLockLayer(path))) as Effect.Effect<A>,
    );

/**
 * Like `withLock`, but the `FileSystem` underneath is Bun's real
 * implementation with ONE operation intercepted by `decorate` - the seam
 * `base` (exported from `lock.ts` for exactly this reason) makes available.
 * This is what makes the steal-token race deterministically testable: a
 * decorated `readFileString`/`rename` can inject "what another racer would
 * have done at this exact instant" without a real multi-process harness or
 * timing-dependent sleeps.
 */
const withDecoratedLock = <A>(
    path: string,
    decorate: (real: FileSystem.FileSystem) => Partial<FileSystem.FileSystem>,
    body: (lock: IngestLockService) => Effect.Effect<A, unknown>,
) => {
    const decoratedFsLayer = Layer.effect(FileSystem.FileSystem)(
        Effect.map(FileSystem.FileSystem, (real) => ({ ...real, ...decorate(real) })),
    ).pipe(Layer.provide(BunFileSystem.layer));

    return Effect.runPromise(
        Effect.gen(function* () {
            const lock = yield* IngestLock;
            return yield* body(lock);
        }).pipe(Effect.provide(base(path).pipe(Layer.provide(decoratedFsLayer)))) as Effect.Effect<A>,
    );
};

describe("IngestLock", () => {
    test("acquire writes a lock file holding our pid, release removes it", async () => {
        const path = lockPath();
        await withLock(path, (lock) =>
            Effect.gen(function* () {
                const handle = yield* lock.acquire();
                expect(existsSync(path)).toBe(true);
                expect((yield* lock.holder)?.pid).toBe(process.pid);
                yield* handle.release;
                expect(existsSync(path)).toBe(false);
            }),
        );
    });

    test("a second acquire while a LIVE holder owns the lock fails fast", async () => {
        const path = lockPath();
        // A live foreign holder: pid 1 always exists and is never us.
        writeFileSync(path, encodeLockPayload({ pid: 1, started_at: new Date().toISOString() }));
        const started = Date.now();
        const result = await withLock(path, (lock) => Effect.result(lock.acquire()));
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
            const failure = result.failure as { _tag: string; pid: number };
            expect(failure._tag).toBe("IngestLockHeldError");
            expect(failure.pid).toBe(1);
        }
        expect(Date.now() - started).toBeLessThan(1000); // fail-fast, not a wait
    });

    test("wait mode gives up with the same typed error after the timeout", async () => {
        const path = lockPath();
        writeFileSync(path, encodeLockPayload({ pid: 1, started_at: new Date().toISOString() }));
        const started = Date.now();
        const result = await withLock(path, (lock) =>
            Effect.result(lock.acquire({ wait: true, timeoutMs: 250, pollMs: 25 })),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
            expect((result.failure as { _tag: string })._tag).toBe("IngestLockHeldError");
        }
        expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    });

    test("wait mode succeeds once the holder releases", async () => {
        const path = lockPath();
        writeFileSync(path, encodeLockPayload({ pid: 1, started_at: new Date().toISOString() }));
        setTimeout(() => {
            try {
                unlinkSync(path);
            } catch {
                /* already gone */
            }
        }, 120);
        const handle = await withLock(path, (lock) =>
            lock.acquire({ wait: true, timeoutMs: 3000, pollMs: 25 }),
        );
        expect(existsSync(path)).toBe(true);
        await Effect.runPromise(handle.release);
    });

    test("takes over a lock whose holder is dead", async () => {
        const path = lockPath();
        writeFileSync(
            path,
            encodeLockPayload({ pid: 2 ** 22 - 1, started_at: "2020-01-01T00:00:00.000Z" }),
        );
        const handle = await withLock(path, (lock) => lock.acquire());
        expect(existsSync(path)).toBe(true);
        await Effect.runPromise(handle.release);
        expect(existsSync(path)).toBe(false);
    });

    test("release is idempotent and never removes someone else's lock", async () => {
        const path = lockPath();
        const handle = await withLock(path, (lock) => lock.acquire());
        await Effect.runPromise(handle.release);
        // someone else takes it
        writeFileSync(path, encodeLockPayload({ pid: 1, started_at: new Date().toISOString() }));
        await Effect.runPromise(handle.release);
        expect(existsSync(path)).toBe(true);
    });

    // IMPORTANT 1 (review, fix rounds 1-2): what actually arbitrates a stale
    // takeover is the STEAL TOKEN plus the confirm-then-act re-read
    // (`stealStale`/`confirmAndTakeOver` in lock.ts) - NOT the rename by
    // itself. A bare `rename` (round 1's mistake, corrected by ruling R13)
    // moves whatever currently sits at the source path with no identity
    // check, so it does not arbitrate anything on its own; it is only safe
    // here because only the token holder ever reaches it for a `stale`
    // takeover, after confirming the payload has not changed underneath it.
    // This particular test does NOT exercise a second racer at all - it
    // pins the single-acquirer MECHANISM only: the token+rename+cleanup
    // leaves no `<path>.steal` or `<path>.stale.<pid>.<nonce>` sibling
    // behind, and the file left at `path` is provably the successor's own
    // payload. The actual multi-racer arbitration claim is pinned
    // deterministically below, via a decorated `FileSystem` that injects a
    // second racer's write at the exact instant that matters (see
    // "the interleave that matters" and "the loser branch" further down).
    test("stale takeover leaves no token or staging file behind", async () => {
        const dir = newTempDir();
        const path = join(dir, "ingest.lock");
        writeFileSync(
            path,
            encodeLockPayload({ pid: 2 ** 22 - 1, started_at: "2020-01-01T00:00:00.000Z" }),
        );
        const handle = await withLock(path, (lock) => lock.acquire());
        // exactly one file remains in the lock dir - no leaked staging sibling.
        expect(readdirSync(dir)).toEqual(["ingest.lock"]);
        const onDisk = decodeLockPayload(readFileSync(path, "utf8"));
        expect(onDisk?.pid).toBe(process.pid);
        await Effect.runPromise(handle.release);
    });

    // IMPORTANT 2 (review, fix round 1; hoisting confirmed fix round 2): two
    // `acquire()` calls for the SAME path must not let the second call
    // silently steal the first's still-open lock - even across separate
    // `IngestLock` layer instances, since `ax` may build a fresh `AppLayer`
    // per `run(provide(...))` call (the `ax serve`-forking-`runIngest`
    // shape). The in-process holding state lives in a module-level map keyed
    // by the resolved path (`inProcessHolders` in lock.ts), not a per-layer
    // `Ref`, so it is shared here too even though both `.acquire()` calls
    // happen to go through the one `lock` the `withLock` body receives.
    test("a second acquire on the SAME in-process service, while the first handle is open, fails instead of clobbering it", async () => {
        const path = lockPath();
        await withLock(path, (lock) =>
            Effect.gen(function* () {
                const first = yield* lock.acquire();
                const result = yield* Effect.result(lock.acquire());
                expect(result._tag).toBe("Failure");
                if (result._tag === "Failure") {
                    const failure = result.failure as { _tag: string; pid: number };
                    expect(failure._tag).toBe("IngestLockHeldError");
                    expect(failure.pid).toBe(process.pid);
                }
                // the second attempt must not have touched the first's lock.
                expect(existsSync(path)).toBe(true);
                expect((yield* lock.holder)?.pid).toBe(process.pid);

                yield* first.release;
                // releasing clears the in-process holding state, so the same
                // service can legitimately acquire again afterward - the fix
                // must not permanently wedge a process against itself.
                const second = yield* lock.acquire();
                expect(existsSync(path)).toBe(true);
                yield* second.release;
            }),
        );
    });

    // "Also fix" (review, fix round 2): the in-process holding state must be
    // PROCESS-scoped, not per-layer-instance - `ax` can build a fresh
    // `AppLayer` (and hence a fresh `IngestLock` layer) per
    // `run(provide(...))` call, so two SEPARATE layer instances for the SAME
    // path must still see each other. This is the test the prior round's
    // single-layer-instance test could not have caught.
    test("a second acquire through a SEPARATE layer instance for the SAME path still fails instead of clobbering it", async () => {
        const path = lockPath();
        const firstLayer = IngestLockLayer(path);
        const secondLayer = IngestLockLayer(path);

        const first = await Effect.runPromise(
            Effect.gen(function* () {
                const lock = yield* IngestLock;
                return yield* lock.acquire();
            }).pipe(Effect.provide(firstLayer)) as Effect.Effect<{
                readonly path: string;
                readonly release: Effect.Effect<void>;
            }>,
        );

        const result = await Effect.runPromise(
            Effect.gen(function* () {
                const lock = yield* IngestLock;
                return yield* Effect.result(lock.acquire());
            }).pipe(Effect.provide(secondLayer)) as Effect.Effect<unknown>,
        );
        expect((result as { _tag: string })._tag).toBe("Failure");
        const failure = (result as { failure: { _tag: string; pid: number } }).failure;
        expect(failure._tag).toBe("IngestLockHeldError");
        expect(failure.pid).toBe(process.pid);
        expect(existsSync(path)).toBe(true);

        await Effect.runPromise(first.release);
        // after release, a THIRD, also-separate layer instance for the same
        // path can legitimately acquire - the process-scoped state must not
        // wedge every future layer instance against this one forever.
        const third = await Effect.runPromise(
            Effect.gen(function* () {
                const lock = yield* IngestLock;
                return yield* lock.acquire();
            }).pipe(Effect.provide(IngestLockLayer(path))) as Effect.Effect<{
                readonly path: string;
                readonly release: Effect.Effect<void>;
            }>,
        );
        expect(existsSync(path)).toBe(true);
        await Effect.runPromise(third.release);
    });

    // IMPORTANT 1, ruling R13 - "the loser branch": force the rename inside
    // `confirmAndTakeOver` to fail with `NotFound` on its first call (a
    // TOCTOU the confirm-read alone cannot close), and - as part of that same
    // injected failure - write a LIVE foreign-pid payload to `path` for real.
    // Pins the actual claim (the loop-back correctly detects the new live
    // holder and fails with `IngestLockHeldError`), not just "it does not
    // crash" or "it does not throw an unhandled defect".
    test("stale takeover: losing the confirmed rename to NotFound re-decides and correctly detects the winner", async () => {
        const path = lockPath();
        writeFileSync(
            path,
            encodeLockPayload({ pid: 2 ** 22 - 1, started_at: "2020-01-01T00:00:00.000Z" }),
        );

        let renameCalls = 0;
        const result = await withDecoratedLock(
            path,
            (real) => ({
                rename: (from: string, to: string) => {
                    renameCalls += 1;
                    if (renameCalls === 1 && from === path) {
                        // Simulate the confirmed-stale file vanishing out from
                        // under this exact rename, AND a live foreign holder
                        // showing up for real, on disk, at `path`.
                        writeFileSync(
                            path,
                            encodeLockPayload({ pid: 1, started_at: new Date().toISOString() }),
                        );
                        return Effect.fail(
                            PlatformError.systemError({
                                _tag: "NotFound",
                                module: "FileSystem",
                                method: "rename",
                                pathOrDescriptor: from,
                            }),
                        );
                    }
                    return real.rename(from, to);
                },
            }),
            (lock) => Effect.result(lock.acquire()),
        );

        expect((result as { _tag: string })._tag).toBe("Failure");
        const failure = (result as { failure: { _tag: string; pid: number } }).failure;
        expect(failure._tag).toBe("IngestLockHeldError");
        expect(failure.pid).toBe(1);
        expect(renameCalls).toBe(1); // the loop-back re-decided as `held`, never attempting a second rename.
    });

    // IMPORTANT 1, ruling R13 - "the interleave that matters": this is the
    // ACTUAL bug from round 1 (rename-only) reproduced deterministically.
    // The classify-read (inside `attempt`) sees the real stale payload; every
    // SUBSEQUENT read of `path` is intercepted to report a live foreign
    // holder instead - simulating a second racer's `"wx"`-create having
    // ALREADY completed between our classify-read and our confirm re-read,
    // without physically touching disk (so it is provable that the
    // classify-read really did see the stale payload, and only the
    // confirm-read saw the swap).
    //
    // This test is RED against the round-1 (bare-rename, no token, no
    // confirm-read) implementation: that code renames whatever is REALLY on
    // disk (still the untouched stale payload, since this decorator never
    // writes to disk) without ever re-reading `path` first, so it wins the
    // takeover and returns a Success handle - clobbering the "winner" this
    // test is modeling. Under the current (R13) implementation, the
    // confirm-read (call #2) sees the swapped live payload, does not match
    // the originally-classified stale text, and loops back - the fresh
    // classify-read on that loop (call #3+) also sees the (still-swapped)
    // live payload and correctly reports `held`.
    test("stale takeover: a live lock installed between classify-read and confirm re-read is detected, not clobbered", async () => {
        const path = lockPath();
        writeFileSync(
            path,
            encodeLockPayload({ pid: 2 ** 22 - 1, started_at: "2020-01-01T00:00:00.000Z" }),
        );
        const liveForeignText = encodeLockPayload({ pid: 1, started_at: new Date().toISOString() });

        let readCallsOnPath = 0;
        const result = await withDecoratedLock(
            path,
            (real) => ({
                // `lock.ts`'s `readLockText` is a single hoisted `const`,
                // built from ONE call to `fs.readFileString(path)` at service
                // construction time - so a plain-function override here would
                // only ever be INVOKED once (its branch baked permanently
                // into the returned Effect value) even though that value is
                // legitimately RE-RUN once per logical read. `Effect.suspend`
                // defers the branching itself into the run, so it
                // re-evaluates - and the counter genuinely advances - on
                // every actual read, matching how the real (Bun) FileSystem
                // implementation behaves.
                readFileString: (target: string, encoding?: string) =>
                    Effect.suspend(() => {
                        if (target !== path) return real.readFileString(target, encoding);
                        readCallsOnPath += 1;
                        if (readCallsOnPath === 1) return real.readFileString(target, encoding);
                        return Effect.succeed(liveForeignText);
                    }),
            }),
            (lock) => Effect.result(lock.acquire()),
        );

        expect((result as { _tag: string })._tag).toBe("Failure");
        const failure = (result as { failure: { _tag: string; pid: number } }).failure;
        expect(failure._tag).toBe("IngestLockHeldError");
        expect(failure.pid).toBe(1);
        expect(readCallsOnPath).toBeGreaterThanOrEqual(2); // classify-read, then the confirm re-read that catches the swap.
    });

    // ---------------------------------------------------------------------
    // Fix round 4: three REACHABLE HANGS in the steal-token paths. Each one
    // was reproduced against the round-3 code as an acquire() that never
    // returned - a hot loop at roughly 8,000 syscalls/second with no sleep,
    // no deadline, and no error. `<path>.steal` is ONE machine-wide path, so
    // a single leaked token wedged every later `ax ingest` on the box with
    // nothing naming the file to delete. `boundedAcquire` turns each of these
    // into an assertion instead of a wedged suite.
    // ---------------------------------------------------------------------

    // HANG 1: a leaked token whose pid is ALIVE. A stealer crashes between
    // token-create and token-remove and the OS later reuses its pid (or the
    // token-remove failed for a reason other than NotFound, which the code
    // swallows). The dead-pid reclaim then declines FOREVER, because the pid
    // genuinely reads alive. Bounding it needs an AGE fallback plus a
    // fail-fast on real contention - `pid: 1` is alive on every unix box, so
    // no pid check can ever free this path on its own.
    test("token contention: a leaked steal token whose pid is ALIVE fails fast naming the token, not forever", async () => {
        const path = lockPath();
        const tokenPath = `${path}.steal`;
        writeFileSync(
            path,
            encodeLockPayload({ pid: 2 ** 22 - 1, started_at: "2020-01-01T00:00:00.000Z" }),
        );
        writeFileSync(tokenPath, encodeLockPayload({ pid: 1, started_at: new Date().toISOString() }));

        const started = Date.now();
        const outcome = await withLock(path, (lock) => boundedAcquire(lock));
        const result = terminated(outcome as Option.Option<{ _tag: string; failure: unknown }>);

        expect(result._tag).toBe("Failure");
        const failure = result.failure as { _tag: string; path: string };
        expect(failure._tag).toBe("IngestLockError");
        // The operator has to be told WHICH file to delete - a bare "lock
        // busy" is what made this wedge undiagnosable in the first place.
        expect(failure.path).toBe(tokenPath);
        expect(Date.now() - started).toBeLessThan(1000); // no-wait means no polling
    });

    // HANG 2: a leaked token that is EMPTY. `writeFileString(..., {flag:"wx"})`
    // is create-then-write, so a crash in that window leaves a zero-byte
    // token. `decodeLockPayload` returns null, so there is no pid to probe and
    // the dead-pid reclaim can never fire at all - a permanent wedge with no
    // pid reuse needed. Bounded here by the same fail-fast.
    test("token contention: a leaked EMPTY steal token fails fast naming the token, not forever", async () => {
        const path = lockPath();
        const tokenPath = `${path}.steal`;
        writeFileSync(
            path,
            encodeLockPayload({ pid: 2 ** 22 - 1, started_at: "2020-01-01T00:00:00.000Z" }),
        );
        writeFileSync(tokenPath, ""); // crashed between the wx open and the write

        const outcome = await withLock(path, (lock) => boundedAcquire(lock));
        const result = terminated(outcome as Option.Option<{ _tag: string; failure: unknown }>);

        expect(result._tag).toBe("Failure");
        const failure = result.failure as { _tag: string; path: string };
        expect(failure._tag).toBe("IngestLockError");
        expect(failure.path).toBe(tokenPath);
    });

    // The other half of the HANG 2 fix: failing fast is only acceptable
    // because the wedge SELF-HEALS. An unparseable token older than
    // STALE_RECLAIM_AGE_MS is reclaimed by age (removed tolerantly, then the
    // caller loops back and re-races the token create), so a crash costs the
    // machine one threshold, not every future `ax ingest`.
    test("token contention: an AGED leaked steal token is reclaimed by age, so a crash cannot wedge the path forever", async () => {
        const dir = lockDir();
        const path = join(dir, "ingest.lock");
        const tokenPath = `${path}.steal`;
        writeFileSync(
            path,
            encodeLockPayload({ pid: 2 ** 22 - 1, started_at: "2020-01-01T00:00:00.000Z" }),
        );
        writeFileSync(tokenPath, "");
        const longAgo = new Date(Date.now() - 10 * 60_000);
        utimesSync(tokenPath, longAgo, longAgo);

        const outcome = await withLock(path, (lock) => boundedAcquire(lock));
        const result = terminated(outcome as Option.Option<{ _tag: string; success: AcquiredHandle }>);

        expect(result._tag).toBe("Success");
        expect(decodeLockPayload(readFileSync(path, "utf8"))?.pid).toBe(process.pid);
        // the reclaimed token and the staging sibling are both gone.
        expect(readdirSync(dir)).toEqual(["ingest.lock"]);
        await Effect.runPromise(result.success.release);
    });

    // HANG 3: `createExclusive`'s AlreadyExists branch re-DECIDED under our
    // own token. Sequence: confirm matches -> rename -> a THIRD acquirer wins
    // the wx create in that window -> the old code looped straight back into
    // `attempt` WHILE our token was still held -> that acquirer's lock reads
    // back stale -> `stealStale` -> wx on OUR OWN token fails AlreadyExists ->
    // reclaim declines its own live pid -> forever. The fix returns the same
    // "retry" sentinel `confirmAndTakeOver` already used, so the token is
    // released by `Effect.ensuring` BEFORE any loop-back runs - and the second
    // pass then legitimately succeeds.
    test("createExclusive losing the wx create UNDER the steal token releases it before looping back", async () => {
        const dir = lockDir();
        const path = join(dir, "ingest.lock");
        writeFileSync(
            path,
            encodeLockPayload({ pid: 2 ** 22 - 1, started_at: "2020-01-01T00:00:00.000Z" }),
        );

        let exclusiveCreates = 0;
        const outcome = await withDecoratedLock(
            path,
            (real) => ({
                writeFileString: (
                    target: string,
                    data: string,
                    options?: { readonly flag?: FileSystem.OpenFlag | undefined; readonly mode?: number | undefined },
                ) =>
                    Effect.suspend(() => {
                        if (target !== path || options?.flag !== "wx") {
                            return real.writeFileString(target, data, options);
                        }
                        exclusiveCreates += 1;
                        if (exclusiveCreates > 1) return real.writeFileString(target, data, options);
                        // A third acquirer wins this create - and its own
                        // holder is ALREADY dead, so the loop-back re-decides
                        // `stale` and re-enters the steal path, which is the
                        // only way to reach the self-block.
                        writeFileSync(
                            path,
                            encodeLockPayload({ pid: 2 ** 22 - 2, started_at: "2020-01-01T00:00:00.000Z" }),
                        );
                        return Effect.fail(
                            PlatformError.systemError({
                                _tag: "AlreadyExists",
                                module: "FileSystem",
                                method: "writeFileString",
                                pathOrDescriptor: target,
                            }),
                        );
                    }),
            }),
            (lock) => boundedAcquire(lock),
        );
        const result = terminated(outcome as Option.Option<{ _tag: string; success: AcquiredHandle }>);

        expect(result._tag).toBe("Success");
        expect(exclusiveCreates).toBe(2); // the injected loss, then the real win
        expect(decodeLockPayload(readFileSync(path, "utf8"))?.pid).toBe(process.pid);
        expect(readdirSync(dir)).toEqual(["ingest.lock"]); // no leaked token
        await Effect.runPromise(result.success.release);
    });

    // The empty/unparseable-lock confirm gate. `writeFileString(..., "wx")` is
    // create-then-write, so a LIVE holder is briefly a zero-byte file.
    // `decideLock` calls that `stale`, and two racers reading inside that
    // window would both compare "" === "" and both confirm-and-take-over a
    // live lock. Empty/unparseable content is therefore NOT confirmable until
    // it has aged past STALE_RECLAIM_AGE_MS - below that, the token is
    // released and the acquire loops back rather than seizing.
    test("an empty lock file younger than the reclaim age is NOT confirmable", async () => {
        const path = lockPath();
        writeFileSync(path, ""); // a live holder's wx-create, mid-write

        const outcome = await withLock(path, (lock) => boundedAcquire(lock));
        const result = terminated(outcome as Option.Option<{ _tag: string; failure: unknown }>);

        expect(result._tag).toBe("Failure");
        const failure = result.failure as { _tag: string; path: string };
        expect(failure._tag).toBe("IngestLockError");
        expect(failure.path).toBe(path);
        expect(readFileSync(path, "utf8")).toBe(""); // untouched - not seized
    });

    // ---------------------------------------------------------------------
    // Cross-review fixes: P1-3 (create/register race), P1-4 (a stale handle
    // deleting its successor), P1-5 (path aliasing), P2-3 (pid reuse), P2-5
    // (release errors reported as success).
    // ---------------------------------------------------------------------

    // P1-3: `createExclusive` wrote the lock file and only THEN registered
    // `selfHolds`. A second fiber scheduled in that gap read a file naming
    // OUR pid with `selfHolds` still false - which `decideLock` calls `stale`
    // - and stole the lock the first fiber had just won. Both fibers ended up
    // with a handle. The decorated `writeFileString` below makes that gap
    // deterministic by holding the first winner inside the write for 50ms.
    test("two concurrent same-process acquires: exactly one wins, the other is told it is held", async () => {
        const path = lockPath();
        let delayedWrite = false;
        const results = await withDecoratedLock(
            path,
            (real) => ({
                writeFileString: (
                    target: string,
                    data: string,
                    options?: {
                        readonly flag?: FileSystem.OpenFlag | undefined;
                        readonly mode?: number | undefined;
                    },
                ) =>
                    Effect.suspend(() => {
                        const write = real.writeFileString(target, data, options);
                        if (target !== path || options?.flag !== "wx" || delayedWrite) return write;
                        delayedWrite = true;
                        // The winner is descheduled AFTER its file exists but
                        // BEFORE it can return - the exact interleave.
                        return write.pipe(Effect.tap(() => Effect.sleep(50)));
                    }),
            }),
            (lock) =>
                Effect.all([Effect.result(lock.acquire()), Effect.result(lock.acquire())], {
                    concurrency: "unbounded",
                }),
        );

        const outcomes = results as ReadonlyArray<{
            readonly _tag: string;
            readonly failure?: { readonly _tag: string; readonly pid: number };
            readonly success?: AcquiredHandle;
        }>;
        const winners = outcomes.filter((r) => r._tag === "Success");
        expect(winners.length).toBe(1);
        const loser = outcomes.find((r) => r._tag === "Failure")!;
        expect(loser.failure?._tag).toBe("IngestLockHeldError");
        expect(loser.failure?.pid).toBe(process.pid);
        expect(existsSync(path)).toBe(true);

        await Effect.runPromise(Effect.orDie(winners[0]!.success!.release));
        expect(existsSync(path)).toBe(false);
    });

    // P1-4: release checked only "does the file name my pid". Every handle
    // from THIS process passes that check, so a late release of an already
    // released handle deleted whatever this process had acquired SINCE -
    // unlocking a live ingest run without anyone noticing. Each acquire now
    // stamps a random token into the payload and release removes the file
    // only when the bytes on disk are still exactly the ones it wrote.
    test("releasing a stale handle does not delete the successor's lock", async () => {
        const path = lockPath();
        await withLock(path, (lock) =>
            Effect.gen(function* () {
                const first = yield* lock.acquire();
                yield* first.release;

                const second = yield* lock.acquire();
                const secondText = readFileSync(path, "utf8");

                // The stale handle releases again - a no-op success.
                yield* first.release;

                expect(existsSync(path)).toBe(true);
                expect(readFileSync(path, "utf8")).toBe(secondText);
                // ... and the successor is still the registered in-process
                // holder, so a third acquire is still correctly rejected.
                const third = yield* Effect.result(lock.acquire());
                expect(third._tag).toBe("Failure");
                if (third._tag === "Failure") {
                    expect((third.failure as { _tag: string })._tag).toBe("IngestLockHeldError");
                }

                yield* second.release;
                expect(existsSync(path)).toBe(false);
            }),
        );
    });

    test("two acquires of the same path never write the same payload bytes", async () => {
        const path = lockPath();
        const texts = await withLock(path, (lock) =>
            Effect.gen(function* () {
                const first = yield* lock.acquire();
                const a = readFileSync(path, "utf8");
                yield* first.release;
                const second = yield* lock.acquire();
                const b = readFileSync(path, "utf8");
                yield* second.release;
                return [a, b] as const;
            }),
        );
        expect(texts[0]).not.toBe(texts[1]);
    });

    // P1-5: process-local state was keyed by the STRING the caller passed, so
    // the same file under two names (symlinked dir, relative vs absolute)
    // looked like two different locks - and the second name stole the first
    // one's live lock. State is now keyed by the canonical path.
    test("a symlinked alias of the lock directory is recognised as the SAME lock", async () => {
        const realDir = newTempDir();
        const aliasDir = join(newTempDir(), "alias");
        symlinkSync(realDir, aliasDir, "dir");

        const realPath = join(realDir, "ingest.lock");
        const aliasPath = join(aliasDir, "ingest.lock");

        const first = await Effect.runPromise(
            Effect.gen(function* () {
                const lock = yield* IngestLock;
                return yield* lock.acquire();
            }).pipe(Effect.provide(IngestLockLayer(realPath))) as Effect.Effect<AcquiredHandle>,
        );

        const result = await Effect.runPromise(
            Effect.gen(function* () {
                const lock = yield* IngestLock;
                return yield* Effect.result(lock.acquire());
            }).pipe(Effect.provide(IngestLockLayer(aliasPath))) as Effect.Effect<unknown>,
        );

        expect((result as { _tag: string })._tag).toBe("Failure");
        const failure = (result as { failure: { _tag: string; pid: number } }).failure;
        expect(failure._tag).toBe("IngestLockHeldError");
        expect(failure.pid).toBe(process.pid);
        expect(existsSync(realPath)).toBe(true);

        await Effect.runPromise(Effect.orDie(first.release));
    });

    test("a relative spelling of the lock path is recognised as the SAME lock", async () => {
        const dir = newTempDir();
        const absolute = join(dir, "ingest.lock");
        const cwd = process.cwd();
        try {
            process.chdir(dir);
            const first = await Effect.runPromise(
                Effect.gen(function* () {
                    const lock = yield* IngestLock;
                    return yield* lock.acquire();
                }).pipe(Effect.provide(IngestLockLayer("ingest.lock"))) as Effect.Effect<AcquiredHandle>,
            );

            const result = await Effect.runPromise(
                Effect.gen(function* () {
                    const lock = yield* IngestLock;
                    return yield* Effect.result(lock.acquire());
                }).pipe(Effect.provide(IngestLockLayer(absolute))) as Effect.Effect<unknown>,
            );
            expect((result as { _tag: string })._tag).toBe("Failure");
            expect((result as { failure: { _tag: string } }).failure._tag).toBe("IngestLockHeldError");

            await Effect.runPromise(Effect.orDie(first.release));
        } finally {
            process.chdir(cwd);
        }
    });

    // P2-3: pid liveness alone cannot tell "the holder is still running" from
    // "the OS handed that pid to something unrelated". The payload now
    // carries the holder's process start time (best effort); a live pid whose
    // start time no longer matches is a corpse, not a holder.
    test("a live pid whose recorded start time no longer matches is stale, not held", async () => {
        const path = lockPath();
        writeFileSync(
            path,
            encodeLockPayload({
                pid: 1,
                started_at: new Date().toISOString(),
                proc_started_at: "Thu Jan  1 00:00:00 1970",
            }),
        );

        const outcome = await withLock(path, (lock) => boundedAcquire(lock));
        const result = terminated(outcome as Option.Option<{ _tag: string; success: AcquiredHandle }>);
        expect(result._tag).toBe("Success");
        expect(decodeLockPayload(readFileSync(path, "utf8"))?.pid).toBe(process.pid);
        await Effect.runPromise(Effect.orDie(result.success.release));
    });

    test("a live pid whose recorded start time still matches stays held", async () => {
        const path = lockPath();
        const ps = Bun.spawnSync(["ps", "-o", "lstart=", "-p", "1"]);
        const fingerprint = ps.stdout.toString().trim();
        expect(fingerprint.length).toBeGreaterThan(0); // ps must work for this test to mean anything
        writeFileSync(
            path,
            encodeLockPayload({
                pid: 1,
                started_at: new Date().toISOString(),
                proc_started_at: fingerprint,
            }),
        );

        const outcome = await withLock(path, (lock) => boundedAcquire(lock));
        const result = terminated(outcome as Option.Option<{ _tag: string; failure: unknown }>);
        expect(result._tag).toBe("Failure");
        expect((result.failure as { _tag: string })._tag).toBe("IngestLockHeldError");
    });

    test("an acquired lock records the holder's process start time", async () => {
        const path = lockPath();
        await withLock(path, (lock) =>
            Effect.gen(function* () {
                const handle = yield* lock.acquire();
                const payload = decodeLockPayload(readFileSync(path, "utf8"));
                expect(payload?.proc_started_at?.length ?? 0).toBeGreaterThan(0);
                yield* handle.release;
            }),
        );
    });

    // P2-5: release swallowed EVERY error, so a permission failure on the
    // unlink reported success while the lock file stayed on disk - every
    // other process then saw a live holder forever. Only the benign
    // already-gone case is silent now.
    test("a failing removal during release surfaces as IngestLockError", async () => {
        const path = lockPath();
        const outcome = await withDecoratedLock(
            path,
            (real) => ({
                remove: (
                    target: string,
                    options?: { readonly recursive?: boolean | undefined; readonly force?: boolean | undefined },
                ) =>
                    target === path
                        ? Effect.fail(
                              PlatformError.systemError({
                                  _tag: "PermissionDenied",
                                  module: "FileSystem",
                                  method: "remove",
                                  pathOrDescriptor: target,
                              }),
                          )
                        : real.remove(target, options),
            }),
            (lock) =>
                Effect.gen(function* () {
                    const handle = yield* lock.acquire();
                    return yield* Effect.result(handle.release);
                }),
        );

        expect((outcome as { _tag: string })._tag).toBe("Failure");
        expect((outcome as { failure: { _tag: string } }).failure._tag).toBe("IngestLockError");
        // the file really is still there - which is exactly why the caller
        // has to hear about it.
        expect(existsSync(path)).toBe(true);
        unlinkSync(path);
    });

    test("releasing an already-removed lock is a silent success", async () => {
        const path = lockPath();
        await withLock(path, (lock) =>
            Effect.gen(function* () {
                const handle = yield* lock.acquire();
                unlinkSync(path); // somebody cleaned up behind us
                const result = yield* Effect.result(handle.release);
                expect(result._tag).toBe("Success");
            }),
        );
    });

    // ...but an empty lock file that has aged out IS a genuine corpse, and
    // must not be a permanent wedge either (this is what `decideLock`'s
    // "an unreadable lock file is stale, not a permanent wedge" test means
    // once it reaches the filesystem).
    test("an empty lock file older than the reclaim age IS taken over", async () => {
        const dir = lockDir();
        const path = join(dir, "ingest.lock");
        writeFileSync(path, "");
        const longAgo = new Date(Date.now() - 10 * 60_000);
        utimesSync(path, longAgo, longAgo);

        const outcome = await withLock(path, (lock) => boundedAcquire(lock));
        const result = terminated(outcome as Option.Option<{ _tag: string; success: AcquiredHandle }>);

        expect(result._tag).toBe("Success");
        expect(decodeLockPayload(readFileSync(path, "utf8"))?.pid).toBe(process.pid);
        expect(readdirSync(dir)).toEqual(["ingest.lock"]);
        await Effect.runPromise(result.success.release);
    });
});
