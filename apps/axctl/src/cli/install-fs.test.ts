import { mkdtemp, symlink, writeFile, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { ensureSymlink } from "./install.ts";

// Smoke test for the @effect/platform migration of install.ts. Exercises the
// readLink-based `ensureSymlink` rewrite (replacing the old lstat-based one)
// against the REAL Bun-backed FileSystem over a tmp dir, covering all four
// branches: create / replace / no-op / regular-file-in-the-way.
const BunFsLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);

const runEnsureSymlink = (target: string, link: string): Promise<void> =>
    Effect.runPromise(ensureSymlink(target, link).pipe(Effect.provide(BunFsLayer)));

const makeTempDir = (): Promise<string> => mkdtemp(join(tmpdir(), "ax-install-fs-"));

describe("ensureSymlink (readLink rewrite, no lstat)", () => {
    test("create: link absent -> symlink created pointing at target", async () => {
        const dir = await makeTempDir();
        const target = join(dir, "target-bin");
        await writeFile(target, "#!/bin/sh\n");
        const link = join(dir, "axctl");

        await runEnsureSymlink(target, link);

        expect(await readlink(link)).toBe(target);
    });

    test("replace: existing symlink to a DIFFERENT target -> repointed", async () => {
        const dir = await makeTempDir();
        const oldTarget = join(dir, "old-bin");
        const newTarget = join(dir, "new-bin");
        await writeFile(oldTarget, "old\n");
        await writeFile(newTarget, "new\n");
        const link = join(dir, "axctl");
        await symlink(oldTarget, link);

        await runEnsureSymlink(newTarget, link);

        expect(await readlink(link)).toBe(newTarget);
    });

    test("no-op: symlink already points at the desired target", async () => {
        const dir = await makeTempDir();
        const target = join(dir, "target-bin");
        await writeFile(target, "x\n");
        const link = join(dir, "axctl");
        await symlink(target, link);

        await runEnsureSymlink(target, link);

        expect(await readlink(link)).toBe(target);
    });

    test("regular-file-in-the-way: throws and does not clobber the file (old semantics)", async () => {
        const dir = await makeTempDir();
        const target = join(dir, "target-bin");
        await writeFile(target, "x\n");
        const link = join(dir, "axctl");
        await writeFile(link, "i am a regular file, not a symlink\n");

        await expect(runEnsureSymlink(target, link)).rejects.toThrow();
        // The regular file must be left intact (the old code threw before touching it).
        expect(await Bun.file(link).text()).toBe("i am a regular file, not a symlink\n");
    });
});
