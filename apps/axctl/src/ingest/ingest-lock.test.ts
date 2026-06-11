/**
 * Tests for src/ingest/ingest-lock.ts - single-flight advisory ingest lock.
 *
 * Uses a real temp dir + Bun FileSystem so the acquire/release/steal logic is
 * exercised against actual file IO (the in-repo test FileSystem is read-only).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, FileSystem, Layer, Path } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withIngestLock, type IngestLockInfo } from "./ingest-lock.ts";

const Platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const run = <A, E>(eff: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    Effect.runPromise(Effect.provide(eff, Platform));

let dir: string;
let lockPath: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ax-lock-"));
    lockPath = join(dir, "ingest.lock");
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

const writeLock = (info: IngestLockInfo) => writeFileSync(lockPath, JSON.stringify(info));

const STALE_MS = 60_000;
const T0 = 1_000_000;

describe("withIngestLock", () => {
    test("acquires when no lock exists, runs work, then releases", async () => {
        let ran = false;
        const result = await run(
            withIngestLock(
                { lockPath, command: "ingest", staleMs: STALE_MS, now: () => T0, onBusy: () => Effect.succeed("busy" as const) },
                Effect.sync(() => {
                    ran = true;
                    // lock file must exist WHILE work runs
                    expect(existsSync(lockPath)).toBe(true);
                    return "ran" as const;
                }),
            ),
        );
        expect(ran).toBe(true);
        expect(result).toEqual({ _tag: "completed", value: "ran" });
        // released after work completes
        expect(existsSync(lockPath)).toBe(false);
    });

    test("skips (runs onBusy) when a fresh lock owned by a live process is held", async () => {
        // process.pid is alive (it's us); fresh relative to injected now.
        writeLock({ pid: process.pid, startedAt: T0, command: "other-ingest" });
        let ran = false;
        const result = await run(
            withIngestLock(
                { lockPath, command: "ingest", staleMs: STALE_MS, now: () => T0 + 1_000, onBusy: (h) => Effect.succeed(`busy:${h.pid}` as const) },
                Effect.sync(() => {
                    ran = true;
                    return "ran" as const;
                }),
            ),
        );
        expect(ran).toBe(false);
        expect(result).toEqual({ _tag: "busy", value: `busy:${process.pid}` });
    });

    test("steals a stale lock (older than staleMs) and runs work", async () => {
        writeLock({ pid: process.pid, startedAt: T0, command: "old-ingest" });
        let ran = false;
        await run(
            withIngestLock(
                { lockPath, command: "ingest", staleMs: STALE_MS, now: () => T0 + STALE_MS + 1, onBusy: () => Effect.succeed("busy" as const) },
                Effect.sync(() => {
                    ran = true;
                    return "ran" as const;
                }),
            ),
        );
        expect(ran).toBe(true);
    });

    test("steals a lock held by a dead pid even if fresh", async () => {
        // A pid that is almost certainly not a live process.
        writeLock({ pid: 2_147_483_646, startedAt: T0, command: "dead-ingest" });
        let ran = false;
        await run(
            withIngestLock(
                { lockPath, command: "ingest", staleMs: STALE_MS, now: () => T0 + 1, onBusy: () => Effect.succeed("busy" as const) },
                Effect.sync(() => {
                    ran = true;
                    return "ran" as const;
                }),
            ),
        );
        expect(ran).toBe(true);
    });

    test("releases the lock even when work fails", async () => {
        const exit = await Effect.runPromiseExit(
            Effect.provide(
                withIngestLock(
                    { lockPath, command: "ingest", staleMs: STALE_MS, now: () => T0, onBusy: () => Effect.succeed("busy" as const) },
                    Effect.fail("boom" as const),
                ),
                Platform,
            ),
        );
        expect(exit._tag).toBe("Failure");
        expect(existsSync(lockPath)).toBe(false);
    });

    test("on timeout: KEEPS the lock (cooldown), runs onTimeout, returns a distinguishable timeout outcome", async () => {
        let timedOut = false;
        const result = await run(
            withIngestLock(
                {
                    lockPath,
                    command: "ingest",
                    staleMs: STALE_MS,
                    timeoutSeconds: 1,
                    now: () => T0,
                    onBusy: () => Effect.succeed("busy" as const),
                    onTimeout: () => Effect.sync(() => { timedOut = true; }),
                },
                // never completes -> hits the 1s timeout
                Effect.never,
            ),
        );
        expect(timedOut).toBe(true);
        // NOT a success value: callers must be able to exit non-zero (#265)
        expect(result).toEqual({ _tag: "timeout" });
        // lock deliberately left in place so the DB gets a cooldown window
        expect(existsSync(lockPath)).toBe(true);
    });

    test("onTimeout runs AFTER the interrupted work's finalizers complete", async () => {
        const order: string[] = [];
        await run(
            withIngestLock(
                {
                    lockPath,
                    command: "ingest",
                    staleMs: STALE_MS,
                    timeoutSeconds: 1,
                    now: () => T0,
                    onBusy: () => Effect.succeed("busy" as const),
                    onTimeout: () => Effect.sync(() => { order.push("onTimeout"); }),
                },
                // work's own finalizer (e.g. withIngestRunFinish settling the
                // ingest_run row) must have run before onTimeout overwrites it.
                Effect.never.pipe(
                    Effect.ensuring(Effect.sync(() => { order.push("work-finalizer"); })),
                ),
            ),
        );
        expect(order).toEqual(["work-finalizer", "onTimeout"]);
    });

    test("atomic acquire: a fresh live holder is never overwritten", async () => {
        // pre-existing fresh+live lock; withIngestLock must NOT clobber it.
        writeLock({ pid: process.pid, startedAt: T0, command: "holder" });
        let ran = false;
        await run(
            withIngestLock(
                { lockPath, command: "ingest", staleMs: STALE_MS, now: () => T0, onBusy: () => Effect.succeed("busy" as const) },
                Effect.sync(() => { ran = true; return "ran" as const; }),
            ),
        );
        expect(ran).toBe(false);
        // holder's lock content is intact
        const after = JSON.parse(readFileSync(lockPath, "utf8")) as IngestLockInfo;
        expect(after.command).toBe("holder");
    });
});
