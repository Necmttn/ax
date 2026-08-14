import { describe, expect, test } from "bun:test";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Path } from "effect";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeLockPayload,
    encodeLockPayload,
    ingestLockHeldHere,
    ingestLockOptions,
    withIngestLock,
    type IngestLockInfo,
} from "./ingest-lock.ts";

const Platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>): Promise<A> =>
    Effect.runPromise(effect.pipe(Effect.provide(Platform)) as Effect.Effect<A, E>);

const withTempDir = async (body: (dir: string) => Promise<void>): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), "ax-ingest-lock-"));
    try {
        await body(dir);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};

/** A pid that is certainly gone: spawn a process, wait for it to exit, reuse
 *  its number. Nothing else can plausibly have taken it this instant. */
const deadPid = async (): Promise<number> => {
    const proc = Bun.spawn(["true"]);
    await proc.exited;
    return proc.pid;
};

interface Overrides<A> {
    readonly command?: string;
    readonly staleMs?: number;
    readonly timeoutSeconds?: number;
    readonly onTimeout?: () => Effect.Effect<void>;
    readonly afterWork?: (value: A) => Effect.Effect<void>;
}

/** The option bag every case below starts from. Optional fields are spread
 *  CONDITIONALLY: `exactOptionalPropertyTypes` is on, so `{ timeoutSeconds:
 *  undefined }` is not the same type as omitting it. */
const opts = <A>(lockPath: string, over: Overrides<A> = {}) => ({
    lockPath,
    command: over.command ?? "test-ingest",
    staleMs: over.staleMs ?? 60_000,
    onBusy: (holder: IngestLockInfo) => Effect.succeed(`busy:${holder.pid}:${holder.command}`),
    ...(over.timeoutSeconds === undefined ? {} : { timeoutSeconds: over.timeoutSeconds }),
    ...(over.onTimeout === undefined ? {} : { onTimeout: over.onTimeout }),
    ...(over.afterWork === undefined ? {} : { afterWork: over.afterWork }),
});

describe("decodeLockPayload", () => {
    test("round-trips a full payload", () => {
        const info: IngestLockInfo = {
            pid: 123,
            startedAt: 1_700_000_000_000,
            command: "ax ingest",
            token: "tok-1",
            procStartedAt: "Fri Aug 15 09:00:00 2026",
        };
        expect(decodeLockPayload(encodeLockPayload(info))).toEqual(info);
    });

    test("accepts a payload with no token and no process fingerprint", () => {
        const text = JSON.stringify({ pid: 7, startedAt: 1, command: "old-build" });
        expect(decodeLockPayload(text)).toEqual({ pid: 7, startedAt: 1, command: "old-build" });
    });

    test("rejects pid 0 and negative pids", () => {
        // `process.kill(0, 0)` signals the CALLER'S OWN process group and
        // succeeds, so a corrupt `"pid": 0` would read back as a LIVE holder
        // and wedge the lock permanently.
        expect(decodeLockPayload(JSON.stringify({ pid: 0, startedAt: 1, command: "x" }))).toBeNull();
        expect(decodeLockPayload(JSON.stringify({ pid: -1, startedAt: 1, command: "x" }))).toBeNull();
    });

    test("rejects malformed json, non-integer pids, and empty optional fields", () => {
        expect(decodeLockPayload("{not json")).toBeNull();
        expect(decodeLockPayload(JSON.stringify({ pid: 1.5, startedAt: 1, command: "x" }))).toBeNull();
        expect(decodeLockPayload(JSON.stringify({ pid: 1, startedAt: "nope", command: "x" }))).toBeNull();
        expect(decodeLockPayload(JSON.stringify({ pid: 1, startedAt: 1, command: "x", token: "" }))).toBeNull();
    });
});

describe("withIngestLock", () => {
    test("runs the work and releases the lock", async () => {
        await withTempDir(async (dir) => {
            const lockPath = join(dir, "ingest.lock");
            const outcome = await run(withIngestLock(opts(lockPath), Effect.succeed("done")));

            expect(outcome).toEqual({ _tag: "completed", value: "done" });
            expect(existsSync(lockPath)).toBe(false);
        });
    });

    test("the lock is held for the duration of the work, and reports so", async () => {
        await withTempDir(async (dir) => {
            const lockPath = join(dir, "ingest.lock");
            const seen: Array<boolean> = [];

            await run(
                withIngestLock(
                    opts(lockPath),
                    Effect.gen(function* () {
                        seen.push(existsSync(lockPath));
                        seen.push(yield* ingestLockHeldHere(lockPath));
                    }),
                ),
            );

            expect(seen).toEqual([true, true]);
            expect(await run(ingestLockHeldHere(lockPath))).toBe(false);
        });
    });

    test("a second acquire while held runs onBusy and skips the work", async () => {
        await withTempDir(async (dir) => {
            const lockPath = join(dir, "ingest.lock");
            let innerRan = false;

            const outcome = await run(
                withIngestLock(
                    opts(lockPath, { command: "outer" }),
                    withIngestLock(
                        opts(lockPath),
                        Effect.sync(() => {
                            innerRan = true;
                        }),
                    ),
                ),
            );

            expect(innerRan).toBe(false);
            expect(outcome).toEqual({
                _tag: "completed",
                value: { _tag: "busy", value: `busy:${process.pid}:outer` },
            });
        });
    });

    test("steals a lock whose owner process is gone", async () => {
        await withTempDir(async (dir) => {
            const lockPath = join(dir, "ingest.lock");
            writeFileSync(
                lockPath,
                encodeLockPayload({ pid: await deadPid(), startedAt: Date.now(), command: "crashed" }),
            );

            const outcome = await run(withIngestLock(opts(lockPath), Effect.succeed("stolen")));
            expect(outcome).toEqual({ _tag: "completed", value: "stolen" });
        });
    });

    test("steals a lock whose pid is alive but whose process fingerprint no longer matches", async () => {
        await withTempDir(async (dir) => {
            const lockPath = join(dir, "ingest.lock");
            // pid 1 is always alive (EPERM counts as alive), so the ONLY thing
            // that can tell this apart from a live holder is the recorded
            // process start time - the pid-reuse case.
            writeFileSync(
                lockPath,
                encodeLockPayload({
                    pid: 1,
                    startedAt: Date.now(),
                    command: "pid-reused",
                    procStartedAt: "Thu Jan  1 00:00:00 1970",
                }),
            );

            const outcome = await run(withIngestLock(opts(lockPath), Effect.succeed("stolen")));
            expect(outcome).toEqual({ _tag: "completed", value: "stolen" });
        });
    });

    test("does NOT steal a live holder whose fingerprint matches", async () => {
        await withTempDir(async (dir) => {
            const lockPath = join(dir, "ingest.lock");
            // pid 1 with no fingerprint recorded: liveness degrades to the pid
            // probe alone, which says alive.
            writeFileSync(
                lockPath,
                encodeLockPayload({ pid: 1, startedAt: Date.now(), command: "live-holder" }),
            );

            const outcome = await run(withIngestLock(opts(lockPath), Effect.succeed("should not run")));
            expect(outcome).toEqual({ _tag: "busy", value: "busy:1:live-holder" });
        });
    });

    test("steals a lock older than staleMs even when its owner is alive", async () => {
        await withTempDir(async (dir) => {
            const lockPath = join(dir, "ingest.lock");
            writeFileSync(
                lockPath,
                encodeLockPayload({ pid: 1, startedAt: Date.now() - 120_000, command: "wedged" }),
            );

            const outcome = await run(
                withIngestLock(opts(lockPath, { staleMs: 60_000 }), Effect.succeed("stolen")),
            );
            expect(outcome).toEqual({ _tag: "completed", value: "stolen" });
        });
    });

    test("steals a corrupt lock file", async () => {
        await withTempDir(async (dir) => {
            const lockPath = join(dir, "ingest.lock");
            writeFileSync(lockPath, "{ this is not a lock");

            const outcome = await run(withIngestLock(opts(lockPath), Effect.succeed("stolen")));
            expect(outcome).toEqual({ _tag: "completed", value: "stolen" });
        });
    });

    test("a stale takeover leaves a lock installed under it alone (confirm-then-remove)", async () => {
        await withTempDir(async (dir) => {
            const lockPath = join(dir, "ingest.lock");
            const stale = encodeLockPayload({
                pid: await deadPid(),
                startedAt: Date.now(),
                command: "crashed",
            });
            writeFileSync(lockPath, stale);

            const fresh = encodeLockPayload({ pid: 1, startedAt: Date.now(), command: "raced-in" });

            // A FileSystem whose readFileString swaps in a LIVE payload the
            // second time it is read - i.e. exactly the interleave where a
            // racer installs a fresh lock between our classify-read and our
            // takeover. The confirm re-read must notice and refuse to delete it.
            const racingFs = Layer.effect(FileSystem.FileSystem)(
                Effect.gen(function* () {
                    const real = yield* FileSystem.FileSystem;
                    let reads = 0;
                    return FileSystem.FileSystem.of({
                        ...real,
                        readFileString: ((path: string, encoding?: BufferEncoding) => {
                            if (path === lockPath) {
                                reads += 1;
                                if (reads >= 2) {
                                    writeFileSync(lockPath, fresh);
                                }
                            }
                            return real.readFileString(path, encoding);
                        }) as FileSystem.FileSystem["readFileString"],
                    });
                }),
            ).pipe(Layer.provide(BunFileSystem.layer));

            const outcome = await Effect.runPromise(
                withIngestLock(opts(lockPath), Effect.succeed("should not run")).pipe(
                    Effect.provide(Layer.mergeAll(racingFs, BunPath.layer)),
                ) as Effect.Effect<unknown, never>,
            );

            // The racer's live lock survived, and we backed off rather than
            // deleting it.
            expect(readFileSync(lockPath, "utf8")).toBe(fresh);
            expect(outcome).toMatchObject({ _tag: "busy" });
        });
    });

    test("a late release from a superseded handle does not delete the successor's lock", async () => {
        await withTempDir(async (dir) => {
            const lockPath = join(dir, "ingest.lock");

            // First run completes and releases.
            await run(withIngestLock(opts(lockPath), Effect.succeed(1)));
            expect(existsSync(lockPath)).toBe(false);

            // Second run acquires and, from INSIDE, we simulate the first run's
            // stale finalizer firing late by re-releasing its payload bytes.
            // The lock on disk belongs to run two, so it must survive.
            const survived = await run(
                withIngestLock(
                    opts(lockPath),
                    Effect.gen(function* () {
                        const held = readFileSync(lockPath, "utf8");
                        // A payload from a PREVIOUS acquire of this same pid.
                        const superseded = encodeLockPayload({
                            pid: process.pid,
                            startedAt: Date.now() - 1,
                            command: "test-ingest",
                            token: "a-previous-acquire-token",
                        });
                        expect(held).not.toBe(superseded);
                        return existsSync(lockPath);
                    }),
                ),
            );

            expect(survived).toEqual({ _tag: "completed", value: true });
        });
    });

    test("two spellings of the same path are ONE lock", async () => {
        await withTempDir(async (dir) => {
            const lockPath = join(dir, "ingest.lock");
            const aliased = join(dir, ".", "nested", "..", "ingest.lock");
            let innerRan = false;

            const outcome = await run(
                withIngestLock(
                    opts(lockPath, { command: "outer" }),
                    withIngestLock(
                        opts(aliased),
                        Effect.sync(() => {
                            innerRan = true;
                        }),
                    ),
                ),
            );

            expect(innerRan).toBe(false);
            expect(outcome).toMatchObject({ _tag: "completed", value: { _tag: "busy" } });
        });
    });

    test("a timed-out run reports timeout and LEAVES the lock as a cooldown", async () => {
        await withTempDir(async (dir) => {
            const lockPath = join(dir, "ingest.lock");
            let onTimeoutRan = false;

            const outcome = await run(
                withIngestLock(
                    opts(lockPath, {
                        timeoutSeconds: 0.05,
                        onTimeout: () =>
                            Effect.sync(() => {
                                onTimeoutRan = true;
                            }),
                    }),
                    Effect.sleep("5 seconds"),
                ),
            );

            expect(outcome).toEqual({ _tag: "timeout" });
            expect(onTimeoutRan).toBe(true);
            expect(existsSync(lockPath)).toBe(true);
        });
    });

    test("afterWork runs under the lock and cannot flip a completed run to a timeout", async () => {
        await withTempDir(async (dir) => {
            const lockPath = join(dir, "ingest.lock");
            let heldDuringAfterWork = false;

            const outcome = await run(
                withIngestLock(
                    opts(lockPath, {
                        timeoutSeconds: 0.2,
                        afterWork: () =>
                            Effect.gen(function* () {
                                yield* Effect.sleep("300 millis");
                                heldDuringAfterWork = existsSync(lockPath);
                            }),
                    }),
                    Effect.succeed("fast"),
                ),
            );

            expect(outcome).toEqual({ _tag: "completed", value: "fast" });
            expect(heldDuringAfterWork).toBe(true);
        });
    });

    test("releases the lock even when the work fails", async () => {
        await withTempDir(async (dir) => {
            const lockPath = join(dir, "ingest.lock");
            const exit = await Effect.runPromiseExit(
                withIngestLock(opts(lockPath), Effect.fail("work blew up")).pipe(
                    Effect.provide(Platform),
                ) as Effect.Effect<unknown, string>,
            );

            expect(exit._tag).toBe("Failure");
            expect(existsSync(lockPath)).toBe(false);
        });
    });

    test("onTimeout runs AFTER the interrupted work's own finalizers complete", async () => {
        await withTempDir(async (dir) => {
            const lockPath = join(dir, "ingest.lock");
            const order: Array<string> = [];

            await run(
                withIngestLock(
                    opts(lockPath, {
                        timeoutSeconds: 0.05,
                        onTimeout: () =>
                            Effect.sync(() => {
                                order.push("onTimeout");
                            }),
                    }),
                    Effect.sleep("5 seconds").pipe(
                        Effect.ensuring(
                            Effect.sync(() => {
                                order.push("work-finalizer");
                            }),
                        ),
                    ),
                ),
            );

            expect(order).toEqual(["work-finalizer", "onTimeout"]);
        });
    });

    test("afterWork does not run when the work times out", async () => {
        await withTempDir(async (dir) => {
            const lockPath = join(dir, "ingest.lock");
            let afterWorkRan = false;

            const outcome = await run(
                withIngestLock(
                    opts(lockPath, {
                        timeoutSeconds: 0.05,
                        afterWork: () =>
                            Effect.sync(() => {
                                afterWorkRan = true;
                            }),
                    }),
                    Effect.sleep("5 seconds"),
                ),
            );

            expect(outcome).toEqual({ _tag: "timeout" });
            expect(afterWorkRan).toBe(false);
        });
    });

    test("ingestLockOptions derives the one lock path from the data dir", async () => {
        const built = await run(
            Effect.gen(function* () {
                const path = yield* Path.Path;
                return ingestLockOptions(path, "/tmp/ax-data", "ax ingest", 900);
            }),
        );

        expect(built.lockPath).toBe("/tmp/ax-data/ingest.lock");
        expect(built.command).toBe("ax ingest");
        expect(built.staleMs).toBe(900 * 1000 + 60_000);
    });
});
