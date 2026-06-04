import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import {
    DEFAULT_DB_HOST,
    DEFAULT_DB_PORT,
    dbUrlFromState,
    defaultRuntimeState,
    readRuntimeState,
    writeRuntimeState,
} from "./runtime-state.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "ax-runtime-"));
    try {
        return await fn(dir);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

const run = <A, E>(eff: Effect.Effect<A, E, import("effect").FileSystem.FileSystem>) =>
    Effect.runPromise(eff.pipe(Effect.provide(BunFileSystem.layer)));

describe("runtime-state", () => {
    test("returns defaults when file missing", async () => {
        await withTempDir(async (dir) => {
            const state = await run(readRuntimeState(join(dir, "runtime.json")));
            expect(state.db.host).toBe(DEFAULT_DB_HOST);
            expect(state.db.port).toBe(DEFAULT_DB_PORT);
        });
    });

    test("returns defaults on malformed JSON", async () => {
        await withTempDir(async (dir) => {
            const path = join(dir, "runtime.json");
            writeFileSync(path, "{not json");
            const state = await run(readRuntimeState(path));
            expect(state.db.port).toBe(DEFAULT_DB_PORT);
        });
    });

    test("returns defaults on out-of-range port", async () => {
        await withTempDir(async (dir) => {
            const path = join(dir, "runtime.json");
            writeFileSync(path, JSON.stringify({ db: { host: "x", port: 0 } }));
            const state = await run(readRuntimeState(path));
            expect(state.db.port).toBe(DEFAULT_DB_PORT);
            expect(state.db.host).toBe("x");
        });
    });

    test("writeRuntimeState round-trips through readRuntimeState atomically", async () => {
        await withTempDir(async (dir) => {
            const path = join(dir, "runtime.json");
            const written = await run(
                writeRuntimeState({ db: { host: "127.0.0.1", port: 8530 } }, path),
            );
            expect(written.db.port).toBe(8530);
            expect(written.updatedAt).not.toBe(defaultRuntimeState().updatedAt);
            expect(existsSync(path)).toBe(true);
            const read = await run(readRuntimeState(path));
            expect(read.db.port).toBe(8530);
            expect(read.db.host).toBe("127.0.0.1");
        });
    });

    test("dbUrlFromState composes ws URL", () => {
        expect(dbUrlFromState({ version: 1, db: { host: "127.0.0.1", port: 9000 }, updatedAt: "x" })).toBe(
            "ws://127.0.0.1:9000",
        );
    });
});
