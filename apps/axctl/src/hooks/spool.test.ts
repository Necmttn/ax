import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import {
    appendHookFireSpool,
    HOOK_FIRE_SPOOL_FILE,
    HOOK_FIRE_SPOOL_ROTATED_FILE,
    snapshotHookFireSpool,
    type HookFireSpoolRow,
} from "./spool.ts";

const roots: string[] = [];
const Platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const makeRoot = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "ax-hook-spool-"));
    roots.push(root);
    return root;
};

const row = (id: string): HookFireSpoolRow => ({
    id,
    ts: "2026-08-15T10:00:00.000Z",
    kind: "hook_fire",
    session: "s1",
    file: null,
    file_path: `src/${id}.ts`,
    harness: "claude",
    ok: true,
    latency_ms: 7,
    event: "read",
    inject: true,
    reason: "high_signal",
    prior_sessions_considered: 1,
    task_excerpt: "read a file",
    top_prior_sessions: ["session:s0"],
    injected_titles: ["Earlier fix"],
});

describe("hook fire spool durability", () => {
    test("a synced line survives an immediate process kill", async () => {
        const root = await makeRoot();
        const moduleUrl = new URL("./spool.ts", import.meta.url).href;
        const code = `
            import { Effect, Layer } from "effect";
            import { BunFileSystem, BunPath } from "@effect/platform-bun";
            import { appendHookFireSpool } from ${JSON.stringify(moduleUrl)};
            const row = ${JSON.stringify(row("crash-safe"))};
            await Effect.runPromise(appendHookFireSpool(row, { spoolDir: ${JSON.stringify(root)} })
                .pipe(Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))));
            process.kill(process.pid, "SIGKILL");
        `;
        const child = Bun.spawnSync(["bun", "-e", code], {
            cwd: new URL("../../", import.meta.url).pathname,
            stdout: "pipe",
            stderr: "pipe",
        });

        expect(child.exitCode).not.toBe(0);
        if (!(await Bun.file(join(root, HOOK_FIRE_SPOOL_FILE)).exists())) {
            throw new Error(child.stderr.toString());
        }
        const text = await readFile(join(root, HOOK_FIRE_SPOOL_FILE), "utf8");
        expect(text.endsWith("\n")).toBe(true);
        expect(JSON.parse(text).row.id).toBe("crash-safe");
    });

    test("closes a torn tail before it appends the next record", async () => {
        const root = await makeRoot();
        await Bun.write(join(root, HOOK_FIRE_SPOOL_FILE), '{"torn":');

        await Effect.runPromise(
            appendHookFireSpool(row("after-torn"), { spoolDir: root }).pipe(Effect.provide(Platform)),
        );

        const text = await readFile(join(root, HOOK_FIRE_SPOOL_FILE), "utf8");
        expect(text).toContain('{"torn":\n');
        expect(JSON.parse(text.split("\n")[1]!).row.id).toBe("after-torn");
    });

    test("keeps only one active and one rotated bounded file", async () => {
        const root = await makeRoot();
        const encodedBytes = new TextEncoder().encode(JSON.stringify({ v: 1, row: row("a") }) + "\n").byteLength;
        const options = { spoolDir: root, maxBytes: encodedBytes + 1 };

        for (const id of ["a", "b", "c"]) {
            await Effect.runPromise(appendHookFireSpool(row(id), options).pipe(Effect.provide(Platform)));
        }

        const active = await readFile(join(root, HOOK_FIRE_SPOOL_FILE), "utf8");
        const rotated = await readFile(join(root, HOOK_FIRE_SPOOL_ROTATED_FILE), "utf8");
        expect((JSON.parse(active) as { row: { id: string } }).row.id).toBe("c");
        expect((JSON.parse(rotated) as { row: { id: string } }).row.id).toBe("b");
        expect(Buffer.byteLength(active)).toBeLessThanOrEqual(encodedBytes + 1);
        expect(Buffer.byteLength(rotated)).toBeLessThanOrEqual(encodedBytes + 1);
    });

    test("blocks rotation while it takes an immutable drain snapshot", async () => {
        const root = await makeRoot();
        const encodedBytes = new TextEncoder().encode(JSON.stringify({ v: 1, row: row("a") }) + "\n").byteLength;
        const options = { spoolDir: root, maxBytes: encodedBytes + 1 };
        await Effect.runPromise(appendHookFireSpool(row("a"), options).pipe(Effect.provide(Platform)));
        await Effect.runPromise(appendHookFireSpool(row("b"), options).pipe(Effect.provide(Platform)));

        let releaseRead!: () => void;
        const readGate = new Promise<void>((resolve) => {
            releaseRead = resolve;
        });
        let signalRead!: () => void;
        const firstRead = new Promise<void>((resolve) => {
            signalRead = resolve;
        });
        const snapshotPromise = Effect.runPromise(
            snapshotHookFireSpool({
                spoolDir: root,
                afterRead: (name) =>
                    name === HOOK_FIRE_SPOOL_ROTATED_FILE
                        ? Effect.sync(signalRead).pipe(Effect.andThen(Effect.promise(() => readGate)))
                        : Effect.void,
            }).pipe(Effect.provide(Platform)),
        );
        await firstRead;

        let appendFinished = false;
        const appendPromise = Effect.runPromise(
            appendHookFireSpool(row("c"), options).pipe(Effect.provide(Platform)),
        ).then(() => {
            appendFinished = true;
        });
        await Bun.sleep(10);
        expect(appendFinished).toBe(false);

        releaseRead();
        const snapshot = await snapshotPromise;
        await appendPromise;
        const snapIds = snapshot.flatMap(({ text }) =>
            text
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line).row.id),
        );
        expect(snapIds).toEqual(["a", "b"]);
        expect(JSON.parse(await readFile(join(root, HOOK_FIRE_SPOOL_ROTATED_FILE), "utf8")).row.id).toBe("b");
        expect(JSON.parse(await readFile(join(root, HOOK_FIRE_SPOOL_FILE), "utf8")).row.id).toBe("c");
    });
});
