import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { Effect, Layer, Option } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import {
    __testBuildCursorBatchStatements,
    __testFindCursorStateDbs,
    __testIncludeCursorByMtime,
    extractCursorStateDb,
    isAllowedCursorHistoryKey,
} from "./cursor.ts";
import { agentEventRecordKey } from "./provider-events.ts";
import { turnRecordKey } from "./record-keys.ts";

const findCursorStateDbs = (cursorUserDir: string, cutoffMs: number): Promise<string[]> =>
    Effect.runPromise(
        __testFindCursorStateDbs(cursorUserDir, cutoffMs).pipe(
            Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
        ),
    );

async function withTempCursorStateDb<T>(fn: (db: Database, dbPath: string) => T | Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "ax-cursor-"));
    const dbPath = join(dir, "state.vscdb");
    const db = new Database(dbPath);
    try {
        return await fn(db, dbPath);
    } finally {
        db.close();
        await rm(dir, { recursive: true, force: true });
    }
}

function createCursorFixtureDb(
    dbPath: string,
    input: {
        conversationId?: string;
        messageId?: string;
        secret?: string;
    } = {},
): void {
    const db = new Database(dbPath);
    try {
        db.run("CREATE TABLE ItemTable (key text primary key, value blob)");
        db.query("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
            "composer.composerData",
            JSON.stringify({
                conversations: [
                    {
                        id: input.conversationId ?? "cursor-session-1",
                        title: "Cursor fixture",
                        messages: [
                            {
                                id: input.messageId ?? "cursor-message-1",
                                role: "user",
                                text: "Implement the Cursor adapter.",
                                timestamp: "2026-05-29T08:00:00.000Z",
                            },
                        ],
                    },
                ],
            }),
        );
        db.query("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
            "cursorAuth/accessToken",
            JSON.stringify({ accessToken: input.secret ?? "cursor-secret-token" }),
        );
    } finally {
        db.close();
    }
}

describe("Cursor history key allowlist", () => {
    test("allows composer history and rejects auth/privacy keys", () => {
        expect(isAllowedCursorHistoryKey("composer.composerData")).toBe(true);
        expect(isAllowedCursorHistoryKey("composerData:composer-live-1")).toBe(true);
        expect(isAllowedCursorHistoryKey("cursorAuth/accessToken")).toBe(false);
        expect(isAllowedCursorHistoryKey("cursorai/donotchange/privacyMode")).toBe(false);
    });
});

describe("Cursor state.vscdb extraction", () => {
    test("extracts composer conversations without parsing secret rows into raw events", async () => {
        await withTempCursorStateDb((db, dbPath) => {
            db.run("CREATE TABLE ItemTable (key text primary key, value blob)");
            db.query("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
                "composer.composerData",
                JSON.stringify({
                    conversations: [
                        {
                            id: "cursor-session-1",
                            title: "Cursor fixture",
                            messages: [
                                {
                                    id: "cursor-message-1",
                                    role: "user",
                                    text: "Implement the Cursor adapter.",
                                    timestamp: "2026-05-29T08:00:00.000Z",
                                },
                            ],
                        },
                    ],
                }),
            );
            db.query("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
                "cursorAuth/accessToken",
                JSON.stringify({ accessToken: "cursor-secret-token" }),
            );

            const extracted = extractCursorStateDb(dbPath);

            expect(extracted.sessions).toHaveLength(1);
            expect(extracted.providerEvents).toHaveLength(1);
            expect(extracted.turns).toHaveLength(1);
            expect(extracted.sessions[0]).toMatchObject({
                title: "Cursor fixture",
                sourcePath: dbPath,
                started_at: "2026-05-29T08:00:00.000Z",
                ended_at: "2026-05-29T08:00:00.000Z",
            });
            expect(extracted.sessions[0]?.id).not.toBe("cursor-session-1");
            expect(extracted.providerEvents[0]).toMatchObject({
                provider: "cursor",
                providerSessionId: extracted.sessions[0]?.id,
                providerEventId: "cursor-message-1",
                seq: 1,
                type: "message",
                role: "user",
                text: "Implement the Cursor adapter.",
                textExcerpt: "Implement the Cursor adapter.",
            });
            expect(extracted.providerEvents[0]?.raw).toMatchObject({
                cursorConversationId: "cursor-session-1",
                cursorMessageId: "cursor-message-1",
            });
            expect(JSON.stringify(extracted.providerEvents[0]?.raw)).not.toContain("cursor-secret-token");
        });
    });

    test("extracts observed cursorDiskKV composerData and bubbleId rows", async () => {
        await withTempCursorStateDb((db, dbPath) => {
            db.run("CREATE TABLE cursorDiskKV (key text primary key, value blob)");
            db.query("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
                "composerData:composer-live-1",
                JSON.stringify({
                    composerId: "composer-live-1",
                    name: "Projects in projects folder",
                    createdAt: 1780051788552,
                    lastUpdatedAt: 1780051839967,
                    fullConversationHeadersOnly: [
                        { bubbleId: "bubble-user-1", type: 1, grouping: { hasText: true } },
                        { bubbleId: "bubble-assistant-1", type: 2, grouping: { hasText: true } },
                    ],
                }),
            );
            db.query("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
                "bubbleId:composer-live-1:bubble-user-1",
                JSON.stringify({
                    bubbleId: "bubble-user-1",
                    type: 1,
                    text: "what projects i have in my projects folder",
                    createdAt: "2026-05-29T10:49:48.611Z",
                }),
            );
            db.query("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
                "bubbleId:composer-live-1:bubble-assistant-1",
                JSON.stringify({
                    bubbleId: "bubble-assistant-1",
                    type: 2,
                    text: "I’ll quickly check your projects folder.",
                    createdAt: "2026-05-29T10:49:55.458Z",
                }),
            );

            const extracted = extractCursorStateDb(dbPath);

            expect(extracted.sessions).toHaveLength(1);
            expect(extracted.turns).toHaveLength(2);
            expect(extracted.providerEvents).toHaveLength(2);
            expect(extracted.sessions[0]).toMatchObject({
                title: "Projects in projects folder",
                cursorConversationId: "composer-live-1",
                started_at: "2026-05-29T10:49:48.611Z",
                ended_at: "2026-05-29T10:49:55.458Z",
            });
            expect(extracted.providerEvents.map((event) => [event.providerEventId, event.role, event.text])).toEqual([
                ["bubble-user-1", "user", "what projects i have in my projects folder"],
                ["bubble-assistant-1", "assistant", "I’ll quickly check your projects folder."],
            ]);
        });
    });

    test("flags compaction when a composer has a non-empty summarizedComposers array", async () => {
        await withTempCursorStateDb((db, dbPath) => {
            db.run("CREATE TABLE cursorDiskKV (key text primary key, value blob)");
            db.query("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
                "composerData:comp-1",
                JSON.stringify({
                    composerId: "comp-1",
                    name: "t",
                    createdAt: 1748000000000,
                    summarizedComposers: ["prev-comp"],
                    fullConversationHeadersOnly: [
                        { bubbleId: "b1", type: 1, grouping: { hasText: true } },
                    ],
                }),
            );
            db.query("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
                "bubbleId:comp-1:b1",
                JSON.stringify({
                    bubbleId: "b1",
                    type: 2,
                    text: "hi",
                    createdAt: "2026-05-29T10:49:48.611Z",
                }),
            );

            const extract = extractCursorStateDb(dbPath);

            expect(extract.compactions.length).toBe(1);
            expect(extract.compactions[0]?.harness).toBe("cursor");
            expect(extract.compactions[0]?.strategy).toBe("encrypted");
            expect(extract.compactions[0]?.summary).toBeNull();
            expect(extract.compactions[0]?.boundaryRef).toBe("b1");
            expect(extract.providerEvents.filter((e) => e.type === "compaction").length).toBe(1);
            const compactionEvent = extract.providerEvents.find((e) => e.type === "compaction")!;
            expect(extract.compactions[0]?.agentEventKey).toBe(agentEventRecordKey(compactionEvent));
        });
    });

    test("does not flag compaction when summarizedComposers is empty", async () => {
        await withTempCursorStateDb((db, dbPath) => {
            db.run("CREATE TABLE cursorDiskKV (key text primary key, value blob)");
            db.query("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
                "composerData:comp-2",
                JSON.stringify({
                    composerId: "comp-2",
                    name: "t",
                    createdAt: 1748000000000,
                    summarizedComposers: [],
                    fullConversationHeadersOnly: [
                        { bubbleId: "b1", type: 1, grouping: { hasText: true } },
                    ],
                }),
            );
            db.query("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
                "bubbleId:comp-2:b1",
                JSON.stringify({
                    bubbleId: "b1",
                    type: 2,
                    text: "hi",
                    createdAt: "2026-05-29T10:49:48.611Z",
                }),
            );

            const extract = extractCursorStateDb(dbPath);

            expect(extract.compactions.length).toBe(0);
        });
    });

    test("extracts Cursor toolFormerData into shared tool calls and invocation edges", async () => {
        await withTempCursorStateDb((db, dbPath) => {
            db.run("CREATE TABLE cursorDiskKV (key text primary key, value blob)");
            db.query("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
                "composerData:composer-tools-1",
                JSON.stringify({
                    composerId: "composer-tools-1",
                    name: "Tool run fixture",
                    createdAt: "2026-05-29T10:49:48.611Z",
                    fullConversationHeadersOnly: [
                        { bubbleId: "bubble-user-1", type: 1, grouping: { hasText: true } },
                        { bubbleId: "bubble-tool-1", type: 2, grouping: { hasText: true } },
                    ],
                }),
            );
            db.query("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
                "bubbleId:composer-tools-1:bubble-user-1",
                JSON.stringify({
                    bubbleId: "bubble-user-1",
                    type: 1,
                    text: "check git status",
                    createdAt: "2026-05-29T10:49:48.611Z",
                }),
            );
            db.query("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
                "bubbleId:composer-tools-1:bubble-tool-1",
                JSON.stringify({
                    bubbleId: "bubble-tool-1",
                    type: 2,
                    text: "Running git status.",
                    createdAt: "2026-05-29T10:49:55.458Z",
                    toolFormerData: {
                        toolCallId: "cursor-tool-call-1",
                        status: "completed",
                        name: "run_terminal_command_v2",
                        rawArgs: "",
                        params: JSON.stringify({ command: "git status --short" }),
                        result: JSON.stringify({ output: " M src/ingest/cursor.ts\n" }),
                    },
                }),
            );

            const extracted = extractCursorStateDb(dbPath);

            expect(extracted.sessions).toHaveLength(1);
            expect(extracted.turns).toHaveLength(2);
            expect(extracted.toolCalls).toHaveLength(1);
            expect(extracted.invocations).toHaveLength(1);
            expect(extracted.skillRelations).toHaveLength(1);
            expect(extracted.providerEvents).toHaveLength(3);
            expect(extracted.turns[1]).toMatchObject({
                role: "assistant",
                message_kind: "tool_call",
                has_tool_use: true,
                has_error: false,
            });
            expect(extracted.toolCalls[0]).toMatchObject({
                provider: "cursor",
                toolName: "run_terminal_command_v2",
                toolKind: "unknown",
                callId: "cursor-tool-call-1",
                commandText: "git status --short",
                commandNorm: "git status",
                commandToolName: "git",
                outputExcerpt: JSON.stringify({ output: " M src/ingest/cursor.ts\n" }),
                hasError: false,
            });
            expect(extracted.invocations[0]).toMatchObject({
                session: extracted.sessions[0]?.id,
                seq: 2,
                skill: "cursor:run_terminal_command_v2",
            });

            const statements = __testBuildCursorBatchStatements(extracted, dbPath);
            expect(statements.some((statement) => statement.includes("tool_call"))).toBe(true);
            expect(statements.some((statement) => statement.includes("cursor:run_terminal_command_v2"))).toBe(true);
            expect(statements.some((statement) => statement.includes("->invoked:"))).toBe(true);
            expect(statements.some((statement) => statement.includes(`session = session:\`${extracted.sessions[0]?.id}\``))).toBe(true);
            expect(statements.some((statement) => statement.includes("->concerns:"))).toBe(true);
            expect(statements.join("\n")).toContain("git status");
        });
    });

    test("namespaces repeated conversation and message ids by database identity", async () => {
        const dir = await mkdtemp(join(tmpdir(), "ax-cursor-collision-"));
        try {
            const dbPathA = join(dir, "globalStorage", "state.vscdb");
            const dbPathB = join(dir, "workspaceStorage", "workspace-a", "state.vscdb");
            await mkdir(join(dir, "globalStorage"), { recursive: true });
            await mkdir(join(dir, "workspaceStorage", "workspace-a"), { recursive: true });
            createCursorFixtureDb(dbPathA, {
                conversationId: "same-conversation",
                messageId: "same-message",
                secret: "secret-a",
            });
            createCursorFixtureDb(dbPathB, {
                conversationId: "same-conversation",
                messageId: "same-message",
                secret: "secret-b",
            });

            const first = extractCursorStateDb(dbPathA, { cursorUserDir: dir });
            const second = extractCursorStateDb(dbPathB, { cursorUserDir: dir });

            expect(first.sessions).toHaveLength(1);
            expect(second.sessions).toHaveLength(1);
            expect(first.turns).toHaveLength(1);
            expect(second.turns).toHaveLength(1);
            expect(first.providerEvents).toHaveLength(1);
            expect(second.providerEvents).toHaveLength(1);

            const firstSessionId = first.sessions[0]?.id;
            const secondSessionId = second.sessions[0]?.id;
            expect(firstSessionId).toBeDefined();
            expect(secondSessionId).toBeDefined();
            expect(firstSessionId).not.toBe(secondSessionId);
            expect(first.providerEvents[0]?.providerSessionId).toBe(firstSessionId);
            expect(second.providerEvents[0]?.providerSessionId).toBe(secondSessionId);
            expect(first.providerEvents[0]?.raw).toMatchObject({
                cursorConversationId: "same-conversation",
                cursorMessageId: "same-message",
            });
            expect(second.providerEvents[0]?.raw).toMatchObject({
                cursorConversationId: "same-conversation",
                cursorMessageId: "same-message",
            });

            const firstEventKey = agentEventRecordKey({
                provider: "cursor",
                providerSessionId: first.providerEvents[0]!.providerSessionId,
                providerEventId: first.providerEvents[0]!.providerEventId ?? null,
                seq: first.providerEvents[0]!.seq,
            });
            const secondEventKey = agentEventRecordKey({
                provider: "cursor",
                providerSessionId: second.providerEvents[0]!.providerSessionId,
                providerEventId: second.providerEvents[0]!.providerEventId ?? null,
                seq: second.providerEvents[0]!.seq,
            });
            expect(firstEventKey).not.toBe(secondEventKey);
            expect(turnRecordKey(first.turns[0]!.session, first.turns[0]!.seq)).not.toBe(
                turnRecordKey(second.turns[0]!.session, second.turns[0]!.seq),
            );
            expect(JSON.stringify(first.providerEvents[0]?.raw)).not.toContain("secret-a");
            expect(JSON.stringify(second.providerEvents[0]?.raw)).not.toContain("secret-b");
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("discovery skips old state databases when a since cutoff is provided", async () => {
        const dir = await mkdtemp(join(tmpdir(), "ax-cursor-since-"));
        try {
            const globalDir = join(dir, "globalStorage");
            const workspaceDir = join(dir, "workspaceStorage", "workspace-a");
            await mkdir(globalDir, { recursive: true });
            await mkdir(workspaceDir, { recursive: true });
            const oldDb = join(globalDir, "state.vscdb");
            const freshDb = join(workspaceDir, "state.vscdb");
            await writeFile(oldDb, "");
            await writeFile(freshDb, "");
            const old = new Date("2026-05-01T00:00:00.000Z");
            const fresh = new Date("2026-05-29T00:00:00.000Z");
            await utimes(oldDb, old, old);
            await utimes(freshDb, fresh, fresh);

            expect(await findCursorStateDbs(dir, old.getTime() + 1)).toEqual([freshDb]);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("mtime filtering skips old databases but includes unknown mtimes", () => {
        const cutoffMs = new Date("2026-05-02T00:00:00.000Z").getTime();

        expect(__testIncludeCursorByMtime(Option.some(new Date("2026-05-01T00:00:00.000Z")), cutoffMs)).toBe(
            false,
        );
        expect(__testIncludeCursorByMtime(Option.none(), cutoffMs)).toBe(true);
    });

    test("discovery treats fresh SQLite WAL sidecars as fresh database activity", async () => {
        const dir = await mkdtemp(join(tmpdir(), "ax-cursor-wal-"));
        try {
            const globalDir = join(dir, "globalStorage");
            await mkdir(globalDir, { recursive: true });
            const dbPath = join(globalDir, "state.vscdb");
            const walPath = `${dbPath}-wal`;
            await writeFile(dbPath, "");
            await writeFile(walPath, "");
            const old = new Date("2026-05-01T00:00:00.000Z");
            const fresh = new Date("2026-05-29T00:00:00.000Z");
            await utimes(dbPath, old, old);
            await utimes(walPath, fresh, fresh);

            expect(await findCursorStateDbs(dir, old.getTime() + 1)).toEqual([dbPath]);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("discovery treats fresh SQLite SHM sidecars as fresh database activity", async () => {
        const dir = await mkdtemp(join(tmpdir(), "ax-cursor-shm-"));
        try {
            const workspaceDir = join(dir, "workspaceStorage", "workspace-a");
            await mkdir(workspaceDir, { recursive: true });
            const dbPath = join(workspaceDir, "state.vscdb");
            const shmPath = `${dbPath}-shm`;
            await writeFile(dbPath, "");
            await writeFile(shmPath, "");
            const old = new Date("2026-05-01T00:00:00.000Z");
            const fresh = new Date("2026-05-29T00:00:00.000Z");
            await utimes(dbPath, old, old);
            await utimes(shmPath, fresh, fresh);

            expect(await findCursorStateDbs(dir, old.getTime() + 1)).toEqual([dbPath]);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    // Regression: old discovery filtered workspaceStorage entries with
    // `Dirent.isDirectory()` (does NOT follow symlinks). The @effect/platform
    // migration briefly used `fs.stat().type` (FOLLOWS), which would pick up a
    // workspace that is merely a symlink TO a directory. classifyNoFollow
    // restores Dirent semantics: a symlinked workspace dir is skipped.
    test("skips a symlinked workspaceStorage entry (no-follow)", async () => {
        const dir = await mkdtemp(join(tmpdir(), "ax-cursor-symlink-"));
        try {
            // A real workspace dir with a db -> discovered.
            const realWorkspace = join(dir, "workspaceStorage", "real");
            await mkdir(realWorkspace, { recursive: true });
            const realDb = join(realWorkspace, "state.vscdb");
            await writeFile(realDb, "");

            // An out-of-tree dir holding a db, reached only via a symlinked
            // workspaceStorage entry -> must NOT be discovered.
            const outside = join(dir, "outside");
            await mkdir(outside, { recursive: true });
            await writeFile(join(outside, "state.vscdb"), "");
            await symlink(outside, join(dir, "workspaceStorage", "linked"));

            expect(await findCursorStateDbs(dir, 0)).toEqual([realDb]);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
