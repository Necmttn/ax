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
});
