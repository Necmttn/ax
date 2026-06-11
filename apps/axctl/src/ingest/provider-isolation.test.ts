/**
 * Per-unit failure isolation for the Pi / OpenCode / Cursor stages (#261).
 *
 * Mirrors the file-isolation contract proven for Claude + Codex in #257:
 *  - one failing unit (a Pi session FILE, an OpenCode/Cursor SESSION inside a
 *    SQLite store) is recorded + skipped while the rest of the stage completes;
 *  - connection-level DbErrors still abort the stage;
 *  - failure storms (consecutive failures, no success between) still abort;
 *  - stats surface the skipped count as `failedFiles`.
 *
 * The DB seam is the shared in-memory SurrealClient double: routes inject a
 * DbError when the issued SQL mentions the bad unit's session id. Fixtures
 * live on the real filesystem (bun:sqlite needs real files), so the layers
 * are BunFileSystem + Path + a test AxConfig pointing at a temp dir.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Effect, Exit, Layer, Path } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { AxConfigTest } from "@ax/lib/config";
import { DbError } from "@ax/lib/errors";
import { makeTestSurrealClient, type TestSurrealRoutes } from "@ax/lib/testing/surreal";
import { ingestCursor, type CursorStats } from "./cursor.ts";
import { ingestOpenCode, type OpenCodeStats } from "./opencode.ts";
import { ingestPi, type PiStats } from "./pi.ts";

const queryError = (message: string) => new DbError({ operation: "query", message });
const connectError = () => new DbError({ operation: "connect", message: "daemon not reachable" });

const layersFor = (
    paths: Partial<{ piDir: string; opencodeDir: string; cursorUserDir: string }>,
    routes: TestSurrealRoutes,
) => {
    const tc = makeTestSurrealClient({ routes });
    const layer = Layer.mergeAll(
        tc.layer,
        AxConfigTest({ paths }).pipe(Layer.provide(BunFileSystem.layer)),
        BunFileSystem.layer,
        Path.layer,
    );
    return { tc, layer };
};

// ---------------------------------------------------------------------------
// Pi: unit of isolation is a session FILE (same as codex)
// ---------------------------------------------------------------------------

const piSessionLines = (sessionId: string): string =>
    [
        JSON.stringify({
            type: "session",
            version: 3,
            id: sessionId,
            timestamp: "2026-06-01T10:00:00.000Z",
            cwd: "/Users/necmttn/Projects/ax",
        }),
        JSON.stringify({
            type: "message",
            id: `${sessionId}msg1`,
            parentId: null,
            timestamp: "2026-06-01T10:00:01.000Z",
            message: {
                role: "user",
                content: [{ type: "text", text: "hello pi" }],
            },
        }),
    ].join("\n");

describe("pi per-file failure isolation", () => {
    let piDir: string;

    beforeAll(async () => {
        piDir = await mkdtemp(join(tmpdir(), "ax-pi-isolation-"));
        await writeFile(join(piDir, "good.jsonl"), piSessionLines("pigood"));
        await writeFile(join(piDir, "bad.jsonl"), piSessionLines("pibad"));
    });
    afterAll(async () => {
        await rm(piDir, { recursive: true, force: true });
    });

    test("a failing session file is skipped and reported; the rest completes", async () => {
        const { tc, layer } = layersFor({ piDir }, [
            { match: "pibad", rows: Effect.fail(queryError("statement rejected")) },
        ]);
        const stats = await Effect.runPromise(
            ingestPi({}).pipe(Effect.provide(layer)) as Effect.Effect<PiStats>,
        );

        expect(stats.sessions).toBe(1);
        expect(stats.files).toBe(1);
        expect(stats.failedFiles).toBe(1);
        // The good session's statements went through.
        expect(tc.captured.some((sql) => sql.includes("pigood"))).toBe(true);
    });

    test("a connection-level DbError aborts the stage", async () => {
        const { layer } = layersFor({ piDir }, [
            { match: "UPSERT", rows: Effect.fail(connectError()) },
        ]);
        const exit = await Effect.runPromiseExit(
            ingestPi({}).pipe(Effect.provide(layer)) as Effect.Effect<unknown, DbError>,
        );
        expect(Exit.isFailure(exit)).toBe(true);
    });
});

describe("pi failure storm aborts the stage", () => {
    let piDir: string;

    beforeAll(async () => {
        piDir = await mkdtemp(join(tmpdir(), "ax-pi-storm-"));
        // Default storm threshold is 10 consecutive failures.
        for (let i = 0; i < 10; i++) {
            await writeFile(join(piDir, `storm-${i}.jsonl`), piSessionLines(`pistorm${i}`));
        }
    });
    afterAll(async () => {
        await rm(piDir, { recursive: true, force: true });
    });

    test("10 consecutive failing files fail the stage with a storm DbError", async () => {
        const { layer } = layersFor({ piDir }, [
            { match: "pistorm", rows: Effect.fail(queryError("statement rejected")) },
        ]);
        const exit = await Effect.runPromiseExit(
            ingestPi({}).pipe(Effect.provide(layer)) as Effect.Effect<unknown, DbError>,
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
            expect(String(exit.cause)).toContain("consecutive");
        }
    });
});

// ---------------------------------------------------------------------------
// OpenCode: unit of isolation is a SESSION inside the SQLite store
// ---------------------------------------------------------------------------

const seedOpenCodeStore = (dbPath: string): void => {
    const db = new Database(dbPath);
    try {
        db.run("CREATE TABLE session (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, created_at TEXT, updated_at TEXT)");
        db.run("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, created_at TEXT)");
        db.run(
            "INSERT INTO session VALUES ('ocgood', '/tmp/p', 'good', '2026-06-01T10:00:00.000Z', '2026-06-01T10:05:00.000Z')",
        );
        db.run(
            "INSERT INTO session VALUES ('ocbad', '/tmp/p', 'bad', '2026-06-01T11:00:00.000Z', '2026-06-01T11:05:00.000Z')",
        );
        db.run("INSERT INTO message VALUES ('m1', 'ocgood', 'user', 'hello good', '2026-06-01T10:00:01.000Z')");
        db.run("INSERT INTO message VALUES ('m2', 'ocbad', 'user', 'hello bad', '2026-06-01T11:00:01.000Z')");
    } finally {
        db.close();
    }
};

describe("opencode per-session failure isolation", () => {
    let opencodeDir: string;

    beforeAll(async () => {
        opencodeDir = await mkdtemp(join(tmpdir(), "ax-opencode-isolation-"));
        seedOpenCodeStore(join(opencodeDir, "opencode.db"));
    });
    afterAll(async () => {
        await rm(opencodeDir, { recursive: true, force: true });
    });

    test("a failing session is skipped and reported; the rest completes", async () => {
        const { tc, layer } = layersFor({ opencodeDir }, [
            { match: "ocbad", rows: Effect.fail(queryError("statement rejected")) },
        ]);
        const stats = await Effect.runPromise(
            ingestOpenCode({}).pipe(Effect.provide(layer)) as Effect.Effect<OpenCodeStats>,
        );

        expect(stats.sessions).toBe(1);
        expect(stats.turns).toBe(1);
        expect(stats.failedFiles).toBe(1);
        expect(tc.captured.some((sql) => sql.includes("ocgood"))).toBe(true);
    });

    test("a connection-level DbError aborts the stage", async () => {
        const { layer } = layersFor({ opencodeDir }, [
            { match: "UPSERT", rows: Effect.fail(connectError()) },
        ]);
        const exit = await Effect.runPromiseExit(
            ingestOpenCode({}).pipe(Effect.provide(layer)) as Effect.Effect<unknown, DbError>,
        );
        expect(Exit.isFailure(exit)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Cursor: unit of isolation is a SESSION inside the state.vscdb store
// ---------------------------------------------------------------------------

const seedCursorStore = (dbPath: string): void => {
    const db = new Database(dbPath);
    try {
        db.run("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
        const payload = JSON.stringify({
            conversations: [
                {
                    id: "convgood",
                    title: "good",
                    messages: [
                        { id: "b1", role: "user", text: "hello good", timestamp: "2026-06-01T10:00:00.000Z" },
                    ],
                },
                {
                    id: "convbad",
                    title: "bad",
                    messages: [
                        { id: "b2", role: "user", text: "hello bad", timestamp: "2026-06-01T11:00:00.000Z" },
                    ],
                },
            ],
        });
        db.query("INSERT INTO ItemTable VALUES ('composer.composerData', ?)").run(payload);
    } finally {
        db.close();
    }
};

describe("cursor per-session failure isolation", () => {
    let cursorUserDir: string;

    beforeAll(async () => {
        cursorUserDir = await mkdtemp(join(tmpdir(), "ax-cursor-isolation-"));
        await mkdir(join(cursorUserDir, "globalStorage"), { recursive: true });
        seedCursorStore(join(cursorUserDir, "globalStorage", "state.vscdb"));
    });
    afterAll(async () => {
        await rm(cursorUserDir, { recursive: true, force: true });
    });

    test("a failing session is skipped and reported; the rest completes", async () => {
        const { tc, layer } = layersFor({ cursorUserDir }, [
            { match: "convbad", rows: Effect.fail(queryError("statement rejected")) },
        ]);
        const stats = await Effect.runPromise(
            ingestCursor({}).pipe(Effect.provide(layer)) as Effect.Effect<CursorStats>,
        );

        expect(stats.sessions).toBe(1);
        expect(stats.turns).toBe(1);
        expect(stats.failedFiles).toBe(1);
        expect(tc.captured.some((sql) => sql.includes("convgood"))).toBe(true);
    });

    test("a connection-level DbError aborts the stage", async () => {
        const { layer } = layersFor({ cursorUserDir }, [
            { match: "UPSERT", rows: Effect.fail(connectError()) },
        ]);
        const exit = await Effect.runPromiseExit(
            ingestCursor({}).pipe(Effect.provide(layer)) as Effect.Effect<unknown, DbError>,
        );
        expect(Exit.isFailure(exit)).toBe(true);
    });
});
