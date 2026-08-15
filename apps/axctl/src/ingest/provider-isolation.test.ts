import { describe, expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Effect, Exit } from "effect";
import { AxConfigTest } from "@ax/lib/config";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { DbError } from "@ax/lib/errors";
import { FixturePlatform, publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { ingestCursor } from "./cursor.ts";
import { ingestOpenCode } from "./opencode.ts";
import { ingestPi } from "./pi.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("provider isolation", { requireFts: true });

const queryError = () => new DbError({ operation: "query", message: "statement rejected" });
const connectError = () => new DbError({ operation: "connect", message: "cache not reachable" });

const withRowFailure = (write: CacheWriteService, marker: string): CacheWriteService => ({
    ...write,
    put: (table: Parameters<CacheWriteService["put"]>[0], row: Parameters<CacheWriteService["put"]>[1]) =>
        JSON.stringify(row).includes(marker) ? Effect.fail(queryError()) : write.put(table, row),
    putMany: (table: Parameters<CacheWriteService["putMany"]>[0], rows: Parameters<CacheWriteService["putMany"]>[1]) =>
        JSON.stringify(rows).includes(marker) ? Effect.fail(queryError()) : write.putMany(table, rows),
}) as unknown as CacheWriteService;

const piLines = (id: string) => [
    { type: "session", version: 3, id, timestamp: "2026-06-01T10:00:00Z", cwd: "/repo" },
    { type: "message", id: `${id}-m1`, parentId: null, timestamp: "2026-06-01T10:00:01Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
].map((row) => JSON.stringify(row)).join("\n");

const seedOpenCode = (path: string) => {
    const db = new Database(path);
    db.run("CREATE TABLE session (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, created_at TEXT, updated_at TEXT)");
    db.run("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, created_at TEXT)");
    for (const id of ["ocgood", "ocbad"]) {
        db.query("INSERT INTO session VALUES (?, '/repo', ?, '2026-06-01T10:00:00Z', '2026-06-01T10:01:00Z')").run(id, id);
        db.query("INSERT INTO message VALUES (?, ?, 'user', 'hello', '2026-06-01T10:00:01Z')").run(`${id}-m1`, id);
    }
    db.close();
};

const seedCursor = (path: string) => {
    const db = new Database(path);
    db.run("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    db.query("INSERT INTO ItemTable VALUES ('composer.composerData', ?)").run(JSON.stringify({
        conversations: ["convgood", "convbad"].map((id) => ({
            id,
            title: id,
            messages: [{ id: `${id}-m1`, role: "user", text: "hello", timestamp: "2026-06-01T10:00:00Z" }],
        })),
    }));
    db.close();
};

describe("provider unit failure isolation with real DuckDB", () => {
    dtest("Pi skips one failed file and writes the other file", async () => {
        const piDir = tempDir("ax-pi-isolation-");
        await Bun.write(join(piDir, "good.jsonl"), piLines("pigood"));
        await Bun.write(join(piDir, "bad.jsonl"), piLines("pibad"));
        let stats: unknown;
        await runWithPlatform(publishCacheFixture(tempDir("ax-pi-cache-"), dylibPath, (write) =>
            Effect.gen(function* () {
                stats = yield* ingestPi(withRowFailure(write, "pibad"), {}).pipe(
                    Effect.provide(AxConfigTest({ paths: { piDir } })),
                    Effect.provide(FixturePlatform),
                );
            }),
        ));
        expect(stats).toMatchObject({ sessions: 1, files: 1, failedFiles: 1 });
    });

    dtest("OpenCode skips one failed session and writes the other session", async () => {
        const opencodeDir = tempDir("ax-opencode-isolation-");
        seedOpenCode(join(opencodeDir, "opencode.db"));
        let stats: unknown;
        await runWithPlatform(publishCacheFixture(tempDir("ax-opencode-cache-"), dylibPath, (write) =>
            Effect.gen(function* () {
                stats = yield* ingestOpenCode(withRowFailure(write, "ocbad"), {}).pipe(
                    Effect.provide(AxConfigTest({ paths: { opencodeDir } })),
                    Effect.provide(FixturePlatform),
                );
            }),
        ));
        expect(stats).toMatchObject({ sessions: 1, turns: 1, failedFiles: 1 });
    });

    dtest("Cursor skips one failed session and writes the other session", async () => {
        const cursorUserDir = tempDir("ax-cursor-isolation-");
        await mkdir(join(cursorUserDir, "globalStorage"), { recursive: true });
        seedCursor(join(cursorUserDir, "globalStorage", "state.vscdb"));
        let stats: unknown;
        await runWithPlatform(publishCacheFixture(tempDir("ax-cursor-cache-"), dylibPath, (write) =>
            Effect.gen(function* () {
                stats = yield* ingestCursor(withRowFailure(write, "convbad"), {}).pipe(
                    Effect.provide(AxConfigTest({ paths: { cursorUserDir } })),
                    Effect.provide(FixturePlatform),
                );
            }),
        ));
        expect(stats).toMatchObject({ sessions: 1, turns: 1, failedFiles: 1 });
    });

    dtest("a connection error stops the provider stage", async () => {
        const piDir = tempDir("ax-pi-connect-");
        await Bun.write(join(piDir, "one.jsonl"), piLines("pi-one"));
        let failed = false;
        await runWithPlatform(publishCacheFixture(tempDir("ax-pi-connect-cache-"), dylibPath, (write) =>
            Effect.gen(function* () {
                const broken = {
                    ...write,
                    put: () => Effect.fail(connectError()),
                    putMany: () => Effect.fail(connectError()),
                } as unknown as CacheWriteService;
                const exit = yield* Effect.exit(ingestPi(broken, {}).pipe(
                    Effect.provide(AxConfigTest({ paths: { piDir } })),
                    Effect.provide(FixturePlatform),
                ));
                failed = Exit.isFailure(exit);
            }),
        ));
        expect(failed).toBe(true);
    });
});
