import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer, Path } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { AxConfigTest } from "@ax/lib/config";
import { DbError } from "@ax/lib/errors";
import { makeTestSurrealClient, type TestSurrealRoutes } from "@ax/lib/testing/surreal";
import {
    __testBuildCursorBatchStatements,
    __testBuildCursorSessionUpsertStatement,
    __testPartitionCursorExtract,
    __testSliceCursorExtractForSession,
    extractCursorStateDb,
    ingestCursor,
    type CursorStats,
} from "./cursor.ts";

/** Multi-session composerData store: three conversations, one with a tool
 *  call, so the partition covers turns/toolCalls/providerEvents/invocations/
 *  skillRelations. Conversation ids double as SQL markers for route-matching
 *  in later tasks. */
export const seedMultiSessionStore = (dir: string): string => {
    const dbPath = join(dir, "state.vscdb");
    const db = new Database(dbPath);
    try {
        db.run("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
        const payload = JSON.stringify({
            conversations: [
                {
                    id: "convalpha",
                    title: "alpha",
                    messages: [
                        { id: "a1", role: "user", text: "alpha question", timestamp: "2026-06-01T10:00:00.000Z" },
                        { id: "a2", role: "assistant", text: "alpha answer", timestamp: "2026-06-01T10:00:05.000Z" },
                    ],
                },
                {
                    id: "convbravo",
                    title: "bravo",
                    messages: [
                        { id: "b1", role: "user", text: "bravo question", timestamp: "2026-06-01T11:00:00.000Z" },
                        {
                            id: "b2",
                            role: "assistant",
                            text: "running a command",
                            timestamp: "2026-06-01T11:00:05.000Z",
                            toolFormerData: {
                                toolCallId: "bravo-tool-1",
                                status: "completed",
                                name: "run_terminal_command_v2",
                                rawArgs: "",
                                params: JSON.stringify({ command: "git status --short" }),
                                result: JSON.stringify({ output: "clean\n" }),
                            },
                        },
                    ],
                },
                {
                    id: "convcharlie",
                    title: "charlie",
                    messages: [
                        { id: "c1", role: "user", text: "charlie question", timestamp: "2026-06-01T12:00:00.000Z" },
                    ],
                },
            ],
        });
        db.query("INSERT INTO ItemTable VALUES ('composer.composerData', ?)").run(payload);
    } finally {
        db.close();
    }
    return dbPath;
};

describe("partitionCursorExtract", () => {
    test("one-pass partition equals the per-session slice oracle for every session", () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-cursor-partition-"));
        const dbPath = seedMultiSessionStore(dir);
        const extract = extractCursorStateDb(dbPath);
        expect(extract.sessions.length).toBe(3);

        const partitions = __testPartitionCursorExtract(extract);
        expect(partitions.map((p) => p.session.id)).toEqual(extract.sessions.map((s) => s.id));
        for (const { session, slice } of partitions) {
            expect(slice).toEqual(__testSliceCursorExtractForSession(extract, session.id));
        }
        // The tool-call session's slice actually carries the correlated pieces.
        const bravo = partitions.find((p) => p.session.cursorConversationId === "convbravo")!;
        expect(bravo.slice.toolCalls.length).toBe(1);
        expect(bravo.slice.skillRelations.length).toBe(1);
        expect(bravo.slice.invocations.length).toBe(1);
    });
});

const layersFor = (cursorUserDir: string, routes: TestSurrealRoutes = []) => {
    const tc = makeTestSurrealClient({ routes });
    const layer = Layer.mergeAll(
        tc.layer,
        AxConfigTest({ paths: { cursorUserDir } }).pipe(Layer.provide(BunFileSystem.layer)),
        BunFileSystem.layer,
        Path.layer,
    );
    return { tc, layer };
};

const runCursor = (layer: Layer.Layer<never>) =>
    Effect.runPromise(ingestCursor({}).pipe(Effect.provide(layer)) as Effect.Effect<CursorStats>);

describe("cursor batched writes", () => {
    test("batched run executes the SAME statements as the per-session oracle, in fewer query calls", async () => {
        const cursorUserDir = await mkdtemp(join(tmpdir(), "ax-cursor-batch-"));
        try {
            await mkdir(join(cursorUserDir, "globalStorage"), { recursive: true });
            const dbPath = seedMultiSessionStore(join(cursorUserDir, "globalStorage"));
            const { tc, layer } = layersFor(cursorUserDir);

            const stats = await runCursor(layer);
            expect(stats.sessions).toBe(3);
            expect(stats.failedFiles).toBe(0);

            const executed = tc.captured.join("");
            const extract = extractCursorStateDb(dbPath, { cursorUserDir });
            // Every record-write statement the OLD per-session path would have
            // issued is present verbatim (same records, same shapes).
            for (const { session, slice } of __testPartitionCursorExtract(extract)) {
                expect(executed).toContain(__testBuildCursorSessionUpsertStatement(session));
                for (const statement of __testBuildCursorBatchStatements(slice, dbPath)) {
                    expect(executed).toContain(statement);
                }
            }
            // Commit amortization: old path = 2+ round trips per session (SDK
            // upsert + >=1 statement chunk) = >=6 query calls for 3 sessions.
            // New path: 1 watermark SELECT + 1 batched chunk.
            const writeCalls = tc.captured.filter((sql) => !sql.includes("FROM ingest_file_state")).length;
            expect(writeCalls).toBe(1);
            expect(tc.upserts.length).toBe(0); // no per-session SDK upserts anymore
        } finally {
            await rm(cursorUserDir, { recursive: true, force: true });
        }
    });

    test("a bad session inside a batch is isolated (#261): batch falls back per-session", async () => {
        const cursorUserDir = await mkdtemp(join(tmpdir(), "ax-cursor-batch-iso-"));
        try {
            await mkdir(join(cursorUserDir, "globalStorage"), { recursive: true });
            seedMultiSessionStore(join(cursorUserDir, "globalStorage"));
            const { tc, layer } = layersFor(cursorUserDir, [
                { match: "convbravo", rows: Effect.fail(new DbError({ operation: "query", message: "statement rejected" })) },
            ]);

            const stats = await runCursor(layer);
            expect(stats.sessions).toBe(2);
            expect(stats.failedFiles).toBe(1);
            const executed = tc.captured.join("");
            expect(executed).toContain("convalpha");
            expect(executed).toContain("convcharlie");
            // The bad session committed no watermark: no STANDALONE
            // ingest_file_state UPSERT (the per-session commit issued by the
            // #261 fallback) names it. `startsWith` (not `includes`) is
            // deliberate: the failed whole-group attempt's captured SQL also
            // contains a watermark statement for convbravo (batched with the
            // other members' - it never committed, but the mock still
            // records issued SQL even on failure), and that same blob
            // legitimately embeds convbravo's own data too. Filtering to
            // calls that ARE a watermark commit (not merely contain one)
            // isolates the actual per-session commits the fallback made.
            const marks = tc.captured.filter((sql) => sql.startsWith("UPSERT ingest_file_state"));
            expect(marks.join("")).not.toContain("convbravo");
        } finally {
            await rm(cursorUserDir, { recursive: true, force: true });
        }
    });

    test("a connection-level DbError still aborts the stage through the fallback", async () => {
        const cursorUserDir = await mkdtemp(join(tmpdir(), "ax-cursor-batch-conn-"));
        try {
            await mkdir(join(cursorUserDir, "globalStorage"), { recursive: true });
            seedMultiSessionStore(join(cursorUserDir, "globalStorage"));
            const { layer } = layersFor(cursorUserDir, [
                { match: "UPSERT session:", rows: Effect.fail(new DbError({ operation: "connect", message: "daemon not reachable" })) },
            ]);
            const exit = await Effect.runPromiseExit(
                ingestCursor({}).pipe(Effect.provide(layer)) as Effect.Effect<unknown, DbError>,
            );
            expect(Exit.isFailure(exit)).toBe(true);
        } finally {
            await rm(cursorUserDir, { recursive: true, force: true });
        }
    });
});
