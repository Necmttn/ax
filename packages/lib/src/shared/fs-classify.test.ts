import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { classifyNoFollow, type EntryKind } from "./fs-classify.ts";

// The in-memory test FileSystem does not model symlinks, so prove the no-follow
// (lstat-equivalent) semantics against the REAL Bun-backed FileSystem over a
// tmp dir containing an actual `fs.symlink`.
const classify = (path: string): Promise<EntryKind> =>
    Effect.runPromise(
        classifyNoFollow(path).pipe(Effect.provide(BunFileSystem.layer)) as Effect.Effect<
            EntryKind,
            never,
            never
        >,
    );

describe("classifyNoFollow", () => {
    test("does not follow symlinks (lstat-equivalent), matching node Dirent semantics", async () => {
        const base = await mkdtemp(join(tmpdir(), "ax-fs-classify-"));
        try {
            const realDir = join(base, "real-dir");
            const realFile = join(base, "real-file.txt");
            await mkdir(realDir, { recursive: true });
            await writeFile(realFile, "hi\n");

            // symlink TO a directory -> classifies as SymbolicLink, NOT Directory.
            const linkToDir = join(base, "link-to-dir");
            await symlink(realDir, linkToDir);

            // symlink TO a file -> classifies as SymbolicLink, NOT File.
            const linkToFile = join(base, "link-to-file");
            await symlink(realFile, linkToFile);

            expect(await classify(linkToDir)).toBe("SymbolicLink");
            expect(await classify(linkToFile)).toBe("SymbolicLink");
            expect(await classify(realDir)).toBe("Directory");
            expect(await classify(realFile)).toBe("File");
            expect(await classify(join(base, "does-not-exist"))).toBe("Missing");

            // A dangling symlink (target missing) still classifies as a link,
            // because `readLink` succeeds on the link itself.
            const dangling = join(base, "dangling");
            await symlink(join(base, "nowhere"), dangling);
            expect(await classify(dangling)).toBe("SymbolicLink");
        } finally {
            await rm(base, { recursive: true, force: true });
        }
    });
});
