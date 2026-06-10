import { mkdtemp, symlink, writeFile, readlink, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { ensureSymlink, removeBinLinkSlot } from "./install.ts";

// Smoke test for the @effect/platform migration of install.ts. Exercises the
// readLink-based `ensureSymlink` rewrite (replacing the old lstat-based one)
// against the REAL Bun-backed FileSystem over a tmp dir, covering all four
// branches: create / replace / no-op / regular-file-in-the-way.
const BunFsLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);

const runEnsureSymlink = (target: string, link: string): Promise<void> =>
    Effect.runPromise(ensureSymlink(target, link).pipe(Effect.provide(BunFsLayer)));

const runRemoveSlot = (binLink: string): Promise<"removed" | "absent" | "skipped"> =>
    Effect.runPromise(removeBinLinkSlot(binLink).pipe(Effect.provide(BunFsLayer)));

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

// BUG 2 regression: a REGULAR FILE (or directory) occupying the axctl/ax link
// slot must NOT abort uninstall. The old lstat-based code classified it
// "skipped" and continued to the purge step; the readLink rewrite must do the
// same. (readLink on a regular file fails with EINVAL -> reason "Unknown", NOT
// NotFound, which the buggy `isNotFound`-gated code re-raised -> partial
// uninstall.) `removeBinLinkSlot` is the exact per-slot logic cmdUninstall runs
// before it unconditionally proceeds to purge.
describe("removeBinLinkSlot (uninstall classification, classifyNoFollow rewrite)", () => {
    test("regular file at axctl slot -> 'skipped', file left intact (no abort)", async () => {
        const dir = await makeTempDir();
        const link = join(dir, "axctl");
        await writeFile(link, "user-owned regular file at axctl\n");

        const status = await runRemoveSlot(link);

        expect(status).toBe("skipped");
        // File must survive: uninstall skips it and CONTINUES to purge.
        expect(existsSync(link)).toBe(true);
        expect(await Bun.file(link).text()).toBe("user-owned regular file at axctl\n");
    });

    test("regular file at ax slot -> 'skipped', file left intact (no abort)", async () => {
        const dir = await makeTempDir();
        const link = join(dir, "ax");
        await writeFile(link, "user-owned regular file at ax\n");

        const status = await runRemoveSlot(link);

        expect(status).toBe("skipped");
        expect(existsSync(link)).toBe(true);
        expect(await Bun.file(link).text()).toBe("user-owned regular file at ax\n");
    });

    test("directory at slot -> 'skipped', directory left intact", async () => {
        const dir = await makeTempDir();
        const link = join(dir, "axctl");
        await mkdir(link);

        const status = await runRemoveSlot(link);

        expect(status).toBe("skipped");
        expect(existsSync(link)).toBe(true);
    });

    test("symlink at slot -> 'removed' (the normal uninstall path)", async () => {
        const dir = await makeTempDir();
        const target = join(dir, "target-bin");
        await writeFile(target, "x\n");
        const link = join(dir, "axctl");
        await symlink(target, link);

        const status = await runRemoveSlot(link);

        expect(status).toBe("removed");
        expect(existsSync(link)).toBe(false);
        // Only the link is reclaimed; the symlink target is untouched.
        expect(existsSync(target)).toBe(true);
    });

    test("absent slot -> 'absent'", async () => {
        const dir = await makeTempDir();
        const status = await runRemoveSlot(join(dir, "axctl"));
        expect(status).toBe("absent");
    });
});

// BUG 1 regression: launchctl loads run through async helpers (loadAgent runs
// `launchctl load -w` via execSync and may throw). The migration wrapped them
// in `Effect.sync(() => loadAgent(...))`, which does NOT await - it returns the
// pending Promise as a success value, so a FAILED launchctl load no longer
// halts install/start/restart (the program proceeds to subsequent steps). The
// fix wraps them in `Effect.promise(() => loadAgent(...))`, which awaits and
// turns a rejection into a defect that HALTS the program. These tests pin that
// difference at the Effect level (stubbing execSync/launchctl in-process is
// impractical, so we exercise the wrapper semantics directly).
describe("async helper wrapped in Effect.promise halts on rejection (BUG 1)", () => {
    const rejectingAsync = async (): Promise<void> => {
        throw new Error("launchctl load -w failed");
    };

    test("Effect.promise(() => rejectingAsync()) fails/dies and does NOT run later steps", async () => {
        let proceeded = false;
        const program = Effect.gen(function* () {
            yield* Effect.promise(() => rejectingAsync());
            // This MUST NOT run once the load helper rejects.
            proceeded = true;
        });

        const exit = await Effect.runPromiseExit(program);

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
            // A rejected promise surfaces as a defect (die), matching the old
            // propagate-and-stop behavior of `await loadAgent(...)`.
            expect(Cause.hasDies(exit.cause)).toBe(true);
        }
        expect(proceeded).toBe(false);
    });

    test("the OLD Effect.sync form WOULD have swallowed the rejection (proceeds) - contrast", async () => {
        let proceeded = false;
        const program = Effect.gen(function* () {
            // Effect.sync does not await: the rejected promise is returned as a
            // success value, the unhandled rejection escapes, and the program
            // proceeds. We attach a no-op catch so the test process does not log
            // an unhandledRejection; the point is `proceeded` flips to true.
            // This test exists to demonstrate exactly the antipattern the
            // lazyPromiseInEffectSync diagnostic guards against, so keep it.
            // @effect-diagnostics-next-line lazyPromiseInEffectSync:off
            const p = yield* Effect.sync(() => rejectingAsync());
            (p as Promise<void>).catch(() => {});
            proceeded = true;
        });

        await Effect.runPromise(program);

        // Demonstrates the bug the fix removes: the sync form let install continue.
        expect(proceeded).toBe(true);
    });
});
