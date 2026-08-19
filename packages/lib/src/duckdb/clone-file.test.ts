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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneFile, statsEqual, walIsQuiescent, type FileStatSnapshot } from "./clone-file.ts";

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
        const a: FileStatSnapshot = { size: 1024, mtimeMs: 1_700_000_000_000 };
        const b: FileStatSnapshot = { size: 1024, mtimeMs: 1_700_000_000_000 };
        expect(statsEqual(a, b)).toBe(true);
    });

    test("false when size differs", () => {
        const a: FileStatSnapshot = { size: 1024, mtimeMs: 1_700_000_000_000 };
        const b: FileStatSnapshot = { size: 2048, mtimeMs: 1_700_000_000_000 };
        expect(statsEqual(a, b)).toBe(false);
    });

    test("false when mtime differs", () => {
        const a: FileStatSnapshot = { size: 1024, mtimeMs: 1_700_000_000_000 };
        const b: FileStatSnapshot = { size: 1024, mtimeMs: 1_700_000_000_001 };
        expect(statsEqual(a, b)).toBe(false);
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
});
