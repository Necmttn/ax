/**
 * DB-free unit tests for the #908 clone primitives (`clone-file.ts`).
 *
 * `cloneFile` is exercised directly against the real filesystem - this
 * suite's whole point is proving the APFS `clonefile` syscall actually
 * clones on this machine, so it does NOT go through a `DuckDb` layer at all.
 * `walIsQuiescent` and `statsEqual` cover the two tripwires the brief calls
 * out as "hard to synthesize reliably" at the `publishSnapshot` integration
 * level (a non-empty post-checkpoint WAL, a torn copy): unit-testing the
 * helpers directly here is the documented fallback for that gap.
 */
import { describe, expect, test } from "bun:test";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, FileSystem } from "effect";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    clearPartialClone,
    cloneFile,
    statSnapshot,
    statsEqual,
    walIsQuiescent,
    type FileStatSnapshot,
} from "./clone-file.ts";

const withTempDir = async (body: (dir: string) => Promise<void>): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), "ax-clone-file-"));
    try {
        await body(dir);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};

const runWithFs = <A>(body: (fs: FileSystem.FileSystem) => Effect.Effect<A, never, FileSystem.FileSystem>): Promise<A> =>
    Effect.runPromise(
        Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            return yield* body(fs);
        }).pipe(Effect.provide(BunFileSystem.layer)) as Effect.Effect<A>,
    );

/**
 * Whether THIS machine's temp filesystem supports a true clone. CI runs on
 * ext4 (no FICLONE reflink), where `COPYFILE_FICLONE_FORCE` must fail and
 * `publishSnapshot` takes the logical fallback - that is the DESIGNED
 * behavior, not a defect, so the byte-for-byte assertion only applies where
 * a clone is possible. Probed once, with the same primitive under test.
 */
const cloneSupported = await (async () => {
    const dir = mkdtempSync(join(tmpdir(), "ax-clone-probe-"));
    try {
        writeFileSync(join(dir, "probe-src"), "probe");
        const outcome = await Effect.runPromise(cloneFile(join(dir, "probe-src"), join(dir, "probe-dst")));
        return outcome.cloneable;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
})();

describe("cloneFile", () => {
    test.if(cloneSupported)("clones a file byte-for-byte via APFS clonefile", async () => {
        await withTempDir(async (dir) => {
            const src = join(dir, "src.bin");
            const dst = join(dir, "dst.bin");
            const content = "ax-clone-payload-".repeat(500);
            writeFileSync(src, content);

            const outcome = await Effect.runPromise(cloneFile(src, dst));

            expect(outcome.cloneable).toBe(true);
            expect(existsSync(dst)).toBe(true);
            expect(readFileSync(dst, "utf8")).toBe(content);
        });
    });

    test.if(!cloneSupported)("reports non-cloneable (fallback contract) where the filesystem cannot clone", async () => {
        await withTempDir(async (dir) => {
            const src = join(dir, "src.bin");
            const dst = join(dir, "dst.bin");
            writeFileSync(src, "ax-clone-payload");

            const outcome = await Effect.runPromise(cloneFile(src, dst));

            expect(outcome.cloneable).toBe(false);
            expect(typeof outcome.reason).toBe("string");
        });
    });

    test("reports a non-cloneable outcome (never throws) when the source is missing", async () => {
        await withTempDir(async (dir) => {
            const src = join(dir, "does-not-exist.bin");
            const dst = join(dir, "dst.bin");

            const outcome = await Effect.runPromise(cloneFile(src, dst));

            expect(outcome.cloneable).toBe(false);
            expect(outcome.reason).toBeDefined();
            expect(existsSync(dst)).toBe(false);
        });
    });
});

describe("statsEqual (torn-copy tripwire, pure half)", () => {
    test("true for identical size + mtime", () => {
        const a: FileStatSnapshot = { size: 1024, mtimeNs: 1_700_000_000_000_000_000n };
        const b: FileStatSnapshot = { size: 1024, mtimeNs: 1_700_000_000_000_000_000n };
        expect(statsEqual(a, b)).toBe(true);
    });

    test("false when size differs", () => {
        const a: FileStatSnapshot = { size: 1024, mtimeNs: 1_700_000_000_000_000_000n };
        const b: FileStatSnapshot = { size: 2048, mtimeNs: 1_700_000_000_000_000_000n };
        expect(statsEqual(a, b)).toBe(false);
    });

    test("false when mtime differs by a whole millisecond", () => {
        const a: FileStatSnapshot = { size: 1024, mtimeNs: 1_700_000_000_000_000_000n };
        const b: FileStatSnapshot = { size: 1024, mtimeNs: 1_700_000_001_000_000_000n };
        expect(statsEqual(a, b)).toBe(false);
    });

    /** #952: the whole point of carrying `mtimeNs` instead of `Date`'s
     *  whole-millisecond `getTime()` - two mtimes that round to the SAME
     *  millisecond (both `...123` ms) but differ at the sub-millisecond
     *  (nanosecond) grain must still compare unequal, or an in-place rewrite
     *  landing inside one millisecond window is invisible to the tripwire. */
    test("false when mtimes differ only below whole-millisecond precision", () => {
        const a: FileStatSnapshot = { size: 1024, mtimeNs: 1_700_000_000_123_000_000n };
        const b: FileStatSnapshot = { size: 1024, mtimeNs: 1_700_000_000_123_500_000n };
        expect(statsEqual(a, b)).toBe(false);
    });
});

describe("statSnapshot (precise mtime via statSync bigint)", () => {
    test("captures size and a nanosecond-precision mtime as a bigint", async () => {
        await withTempDir(async (dir) => {
            const file = join(dir, "f.bin");
            writeFileSync(file, "hello");

            const snap = await Effect.runPromise(statSnapshot(file));

            expect(snap.size).toBe(5);
            expect(typeof snap.mtimeNs).toBe("bigint");
            expect(snap.mtimeNs > 0n).toBe(true);
        });
    });

    test("fails with a typed PreciseStatError when the path does not exist", async () => {
        await withTempDir(async (dir) => {
            const exit = await Effect.runPromiseExit(statSnapshot(join(dir, "missing.bin")));

            expect(exit._tag).toBe("Failure");
        });
    });
});

describe("walIsQuiescent (post-checkpoint WAL tripwire)", () => {
    test("quiescent when the WAL file is absent", async () => {
        await withTempDir(async (dir) => {
            const live = join(dir, "live.duckdb");
            writeFileSync(live, "not a real duckdb file, just needs to exist as a path stem");

            const quiescent = await runWithFs((fs) => walIsQuiescent(fs, live));

            expect(quiescent).toBe(true);
        });
    });

    test("quiescent when the WAL file exists but is empty", async () => {
        await withTempDir(async (dir) => {
            const live = join(dir, "live.duckdb");
            writeFileSync(live, "stem");
            writeFileSync(`${live}.wal`, "");

            const quiescent = await runWithFs((fs) => walIsQuiescent(fs, live));

            expect(quiescent).toBe(true);
        });
    });

    test("NOT quiescent when the WAL file has bytes - the case a real checkpoint should never leave behind", async () => {
        await withTempDir(async (dir) => {
            const live = join(dir, "live.duckdb");
            writeFileSync(live, "stem");
            writeFileSync(`${live}.wal`, "uncommitted-wal-bytes");

            const quiescent = await runWithFs((fs) => walIsQuiescent(fs, live));

            expect(quiescent).toBe(false);
        });
    });

    test("NOT quiescent when WAL stat fails for a reason other than NotFound (#950)", async () => {
        await withTempDir(async (dir) => {
            const live = join(dir, "live.duckdb");
            writeFileSync(live, "stem");
            symlinkSync(`${live}.wal`, `${live}.wal`);

            const quiescent = await runWithFs((fs) => walIsQuiescent(fs, live));

            expect(quiescent).toBe(false);
        });
    });

    /**
     * #952: the pre-clone WAL check alone only guards the window BEFORE the
     * clone starts - a commit on another handle that lands entirely in the
     * WAL during the check->clone window is invisible to it. The fix is to
     * re-run this SAME primitive again after the clone; that is only a valid
     * fix if the primitive is stateless and re-evaluates the file fresh on
     * every call rather than caching its first answer, which is what this
     * proves: calling it a second time, after new bytes land, flips the
     * result from quiescent to not - exactly what a post-clone re-check
     * needs to catch a race the pre-clone check missed.
     */
    test("re-checking after new bytes land on the WAL flips quiescent to non-quiescent (post-clone recheck, #952)", async () => {
        await withTempDir(async (dir) => {
            const live = join(dir, "live.duckdb");
            writeFileSync(live, "stem");
            writeFileSync(`${live}.wal`, "");

            const beforeClone = await runWithFs((fs) => walIsQuiescent(fs, live));
            expect(beforeClone).toBe(true);

            // Simulates a commit on another handle landing in the WAL during
            // the check -> clone window - the exact case the pre-clone check
            // cannot see, and the post-clone recheck exists to catch.
            writeFileSync(`${live}.wal`, "a-commit-that-landed-during-the-clone");

            const afterClone = await runWithFs((fs) => walIsQuiescent(fs, live));
            expect(afterClone).toBe(false);
        });
    });
});

describe("clearPartialClone (temp cleanup after a rejected clone attempt) (#952)", () => {
    test("removes a partially-cloned temp file", async () => {
        await withTempDir(async (dir) => {
            const tmp = join(dir, "partial.duckdb");
            writeFileSync(tmp, "partial-clone-bytes");

            await runWithFs((fs) => clearPartialClone(fs, tmp).pipe(Effect.orDie));

            expect(existsSync(tmp)).toBe(false);
        });
    });

    test("is a no-op when there is nothing at the temp path (force semantics)", async () => {
        await withTempDir(async (dir) => {
            const tmp = join(dir, "never-existed.duckdb");

            await runWithFs((fs) => clearPartialClone(fs, tmp).pipe(Effect.orDie));

            expect(existsSync(tmp)).toBe(false);
        });
    });

    /**
     * The safety property #952 depends on: a caller (`publishSnapshot` in
     * `client.ts`) that cannot clear a partial clone must STOP rather than
     * fall through to a fallback of unknown provenance at the same path. A
     * removal failure has to actually surface as a typed failure - not be
     * swallowed - for that guarantee to hold.
     */
    test("fails with a typed ClearPartialCloneError when removal is denied, and leaves the file in place", async () => {
        await withTempDir(async (dir) => {
            const lockedDir = join(dir, "locked");
            mkdirSync(lockedDir);
            const tmp = join(lockedDir, "partial.duckdb");
            writeFileSync(tmp, "partial-clone-bytes");
            // Read+execute, no write: removing a file inside must fail.
            chmodSync(lockedDir, 0o555);

            try {
                const exit = await Effect.runPromiseExit(
                    Effect.gen(function* () {
                        const fs = yield* FileSystem.FileSystem;
                        return yield* clearPartialClone(fs, tmp);
                    }).pipe(Effect.provide(BunFileSystem.layer)) as Effect.Effect<void, unknown>,
                );

                expect(exit._tag).toBe("Failure");
                expect(existsSync(tmp)).toBe(true);
            } finally {
                // Restore write access so withTempDir's own cleanup can remove it.
                chmodSync(lockedDir, 0o755);
            }
        });
    });
});
