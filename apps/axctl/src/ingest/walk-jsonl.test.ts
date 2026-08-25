import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { mkdir, mkdtemp, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkJsonlFilesLenient, walkJsonlFilesStrict } from "./walk-jsonl.ts";

const BunFsLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);

const runStrict = (root: string, cutoffMs: number) =>
    Effect.runPromise(walkJsonlFilesStrict(root, cutoffMs).pipe(Effect.provide(BunFsLayer)));

const runLenient = (root: string, cutoffMs: number) =>
    Effect.runPromise(walkJsonlFilesLenient(root, cutoffMs).pipe(Effect.provide(BunFsLayer)));

describe("walkJsonlFiles", () => {
    test("strict and lenient collect fresh .jsonl files with sizeBytes", async () => {
        const base = await mkdtemp(join(tmpdir(), "ax-walk-jsonl-"));
        const root = join(base, "root");
        const month = join(root, "2026", "06");
        await mkdir(month, { recursive: true });

        const fresh = join(month, "a.jsonl");
        const text = "{}\n";
        await writeFile(fresh, text);
        await writeFile(join(month, "b.txt"), "ignored\n");

        const old = join(month, "old.jsonl");
        await writeFile(old, "{}\n");
        const oldDate = new Date("2020-01-01T00:00:00.000Z");
        await utimes(old, oldDate, oldDate);

        const outside = join(base, "outside");
        await mkdir(outside, { recursive: true });
        const oldLeak = join(outside, "leak.jsonl");
        await writeFile(oldLeak, "{}\n");
        await utimes(oldLeak, oldDate, oldDate);
        await symlink(outside, join(month, "linked-dir"));

        const cutoffMs = new Date("2025-01-01T00:00:00.000Z").getTime();
        const strict = await runStrict(root, cutoffMs);
        const lenient = await runLenient(root, cutoffMs);

        expect(strict.map((f) => f.path).sort()).toEqual([fresh]);
        expect(lenient.map((f) => f.path).sort()).toEqual([fresh]);
        expect(strict[0]?.sizeBytes).toBe(text.length);
        expect(lenient[0]?.sizeBytes).toBe(text.length);
    });

    test("lenient skips symlinked directory contents and symlinked files", async () => {
        const base = await mkdtemp(join(tmpdir(), "ax-walk-jsonl-link-"));
        const root = join(base, "root");
        await mkdir(root, { recursive: true });
        const real = join(root, "a.jsonl");
        await writeFile(real, "{}\n");

        const outside = join(base, "outside");
        await mkdir(outside, { recursive: true });
        const leak = join(outside, "leak.jsonl");
        await writeFile(leak, "{}\n");
        await symlink(outside, join(root, "linked-dir"));
        await symlink(leak, join(root, "linked.jsonl"));

        const lenient = await runLenient(root, 0);

        expect(lenient.map((f) => f.path).sort()).toEqual([real]);
    });

    test("cutoff filters old files", async () => {
        const base = await mkdtemp(join(tmpdir(), "ax-walk-jsonl-cutoff-"));
        const root = join(base, "root");
        await mkdir(root, { recursive: true });
        const old = join(root, "old.jsonl");
        await writeFile(old, "{}\n");
        const oldDate = new Date("2020-01-01T00:00:00.000Z");
        await utimes(old, oldDate, oldDate);

        const cutoffMs = new Date("2025-01-01T00:00:00.000Z").getTime();

        expect(await runStrict(root, cutoffMs)).toEqual([]);
        expect(await runLenient(root, cutoffMs)).toEqual([]);
    });

    test("missing roots return an empty list", async () => {
        const base = await mkdtemp(join(tmpdir(), "ax-walk-jsonl-missing-"));
        const missing = join(base, "missing");

        expect(await runStrict(missing, 0)).toEqual([]);
        expect(await runLenient(missing, 0)).toEqual([]);
    });

    // #796: a regular file used as the configured root is not "absent" - it's
    // a real misconfiguration, and the lenient walker used to swallow every
    // filesystem error into `[]`, indistinguishable from "no sessions yet".
    // Both walkers must surface a typed failure instead of a silent zero.
    test("a regular file root propagates a typed failure for both walkers", async () => {
        const base = await mkdtemp(join(tmpdir(), "ax-walk-jsonl-regular-root-"));
        const root = join(base, "not-a-directory.jsonl");
        await writeFile(root, "{}\n");

        const strictExit = await Effect.runPromiseExit(
            walkJsonlFilesStrict(root, 0).pipe(Effect.provide(BunFsLayer)),
        );
        const lenientExit = await Effect.runPromiseExit(
            walkJsonlFilesLenient(root, 0).pipe(Effect.provide(BunFsLayer)),
        );

        expect(strictExit._tag).toBe("Failure");
        expect(lenientExit._tag).toBe("Failure");

        // Not the vanished-entry/missing-root case - that one recovers to [].
        const lenientError = await Effect.runPromise(
            Effect.flip(walkJsonlFilesLenient(root, 0).pipe(Effect.provide(BunFsLayer))),
        );
        expect(lenientError.reason._tag).not.toBe("NotFound");
    });
});
