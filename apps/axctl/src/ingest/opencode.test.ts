import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import {
    __testBuildOpenCodeBatchStatements,
    __testFindOpenCodeDbCandidates,
    extractOpenCodeDatabase,
} from "./opencode.ts";
import { toolCallRecordKey, turnRecordKey } from "./record-keys.ts";

const findOpenCodeDbCandidates = (opencodeDir: string, cutoffMs: number): Promise<string[]> =>
    Effect.runPromise(
        __testFindOpenCodeDbCandidates(opencodeDir, cutoffMs).pipe(
            Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
        ),
    );

async function withTempOpenCodeDb<T>(fn: (db: Database, dbPath: string) => T | Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "ax-opencode-"));
    const dbPath = join(dir, "opencode.db");
    const db = new Database(dbPath);
    try {
        return await fn(db, dbPath);
    } finally {
        db.close();
        await rm(dir, { recursive: true, force: true });
    }
}

describe("OpenCode SQLite extraction", () => {
    test("extracts sessions and message events from the local database", async () => {
        await withTempOpenCodeDb((db, dbPath) => {
            db.run("CREATE TABLE session (id text primary key, cwd text, title text, created_at text, updated_at text)");
            db.run("CREATE TABLE message (id text primary key, session_id text, role text, content text, created_at text)");
            db.query(
                "INSERT INTO session (id, cwd, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            ).run(
                "oc-session-1",
                "/Users/necmttn/Projects/ax",
                "OpenCode fixture",
                "2026-05-29T01:00:00.000Z",
                "2026-05-29T01:02:00.000Z",
            );
            db.query(
                "INSERT INTO message (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
            ).run(
                "oc-message-1",
                "oc-session-1",
                "user",
                "Implement the OpenCode adapter.",
                "2026-05-29T01:01:00.000Z",
            );

            const extracted = extractOpenCodeDatabase(dbPath);

            expect(extracted.sessions).toHaveLength(1);
            expect(extracted.providerEvents).toHaveLength(1);
            expect(extracted.turns).toHaveLength(1);
            expect(extracted.toolCalls).toHaveLength(0);
            expect(extracted.sessions[0]).toMatchObject({
                id: "oc-session-1",
                cwd: "/Users/necmttn/Projects/ax",
                title: "OpenCode fixture",
                started_at: "2026-05-29T01:00:00.000Z",
                ended_at: "2026-05-29T01:02:00.000Z",
            });
            expect(extracted.providerEvents[0]).toMatchObject({
                provider: "opencode",
                providerSessionId: "oc-session-1",
                providerEventId: "oc-message-1",
                seq: 1,
                type: "message",
                role: "user",
                text: "Implement the OpenCode adapter.",
                textExcerpt: "Implement the OpenCode adapter.",
                labels: {
                    source: "opencode_sqlite",
                    sessionId: "oc-session-1",
                },
            });
            expect(extracted.turns[0]).toMatchObject({
                session: "oc-session-1",
                providerEventId: "oc-message-1",
                seq: 1,
                role: "user",
                text: "Implement the OpenCode adapter.",
            });
        });
    });

    test("extracts observed OpenCode schema with JSON message and part data", async () => {
        await withTempOpenCodeDb((db, dbPath) => {
            db.run(
                "CREATE TABLE session (id text primary key, directory text, title text, time_created integer, time_updated integer, model text)",
            );
            db.run(
                "CREATE TABLE message (id text primary key, session_id text, time_created integer, time_updated integer, data text)",
            );
            db.run(
                "CREATE TABLE part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text)",
            );
            db.query(
                "INSERT INTO session (id, directory, title, time_created, time_updated, model) VALUES (?, ?, ?, ?, ?, ?)",
            ).run(
                "ses-observed",
                "/Users/necmttn/Projects/ax",
                "Observed schema",
                1775546262338,
                1775546336989,
                "gpt-observed",
            );
            db.query(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            ).run(
                "msg-user",
                "ses-observed",
                1775546262338,
                1775546262338,
                JSON.stringify({
                    role: "user",
                    time: { created: 1775546262338 },
                    model: { providerID: "opencode", modelID: "minimax-m2.5-free" },
                }),
            );
            db.query(
                "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
            ).run(
                "prt-user-text",
                "msg-user",
                "ses-observed",
                1775546262339,
                1775546262339,
                JSON.stringify({ type: "text", text: "Observed schema user text." }),
            );

            const extracted = extractOpenCodeDatabase(dbPath);

            expect(extracted.sessions).toHaveLength(1);
            expect(extracted.toolCalls).toHaveLength(0);
            expect(extracted.sessions[0]).toMatchObject({
                id: "ses-observed",
                cwd: "/Users/necmttn/Projects/ax",
                title: "Observed schema",
                started_at: "2026-04-07T07:17:42.338Z",
                ended_at: "2026-04-07T07:18:56.989Z",
            });
            expect(extracted.providerEvents).toHaveLength(1);
            expect(extracted.providerEvents[0]).toMatchObject({
                providerEventId: "msg-user",
                role: "user",
                text: "Observed schema user text.",
                labels: {
                    source: "opencode_sqlite",
                    sessionId: "ses-observed",
                    model: "minimax-m2.5-free",
                    provider: "opencode",
                },
            });
            expect(extracted.turns[0]).toMatchObject({
                ts: "2026-04-07T07:17:42.338Z",
                text: "Observed schema user text.",
            });
        });
    });

    test("extracts observed OpenCode tool parts into shared tool calls and invocation edges", async () => {
        await withTempOpenCodeDb((db, dbPath) => {
            db.run(
                "CREATE TABLE session (id text primary key, directory text, title text, time_created integer, time_updated integer, model text)",
            );
            db.run(
                "CREATE TABLE message (id text primary key, session_id text, time_created integer, time_updated integer, data text)",
            );
            db.run(
                "CREATE TABLE part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text)",
            );
            db.query(
                "INSERT INTO session (id, directory, title, time_created, time_updated, model) VALUES (?, ?, ?, ?, ?, ?)",
            ).run("ses-tools", "/tmp/project", "Tool schema", 1775546262338, 1775546263000, "gpt-observed");
            db.query(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            ).run(
                "msg-assistant-tool",
                "ses-tools",
                1775546262400,
                1775546262500,
                JSON.stringify({ role: "assistant", parentID: "msg-user" }),
            );
            db.query(
                "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
            ).run(
                "prt-tool-grep",
                "msg-assistant-tool",
                "ses-tools",
                1775546262401,
                1775546262415,
                JSON.stringify({
                    type: "tool",
                    tool: "grep",
                    callID: "call-grep-1",
                    state: {
                        status: "completed",
                        input: {
                            pattern: "extractOpenCodeDatabase",
                            path: "src/ingest",
                            include: "*.ts",
                        },
                        output: "src/ingest/opencode.ts:322:export function extractOpenCodeDatabase",
                        metadata: { matches: 1, truncated: false },
                        title: "extractOpenCodeDatabase",
                        time: { start: 1775546262401, end: 1775546262415 },
                    },
                }),
            );

            const extracted = extractOpenCodeDatabase(dbPath);

            expect(extracted.turns[0]).toMatchObject({
                session: "ses-tools",
                providerEventId: "msg-assistant-tool",
                seq: 1,
                has_tool_use: true,
                has_error: false,
            });
            expect(extracted.toolCalls).toHaveLength(1);
            expect(extracted.toolCalls[0]).toMatchObject({
                provider: "opencode",
                toolName: "grep",
                toolKind: "cli",
                sessionId: "ses-tools",
                seq: 1,
                turnKey: turnRecordKey("ses-tools", 1),
                callId: "call-grep-1",
                ts: "2026-04-07T07:17:42.401Z",
                cwd: "/tmp/project",
                inputJson: {
                    pattern: "extractOpenCodeDatabase",
                    path: "src/ingest",
                    include: "*.ts",
                },
                outputExcerpt: "src/ingest/opencode.ts:322:export function extractOpenCodeDatabase",
                durationMs: 14,
                hasError: false,
            });

            const toolCallKey = toolCallRecordKey({
                sessionId: "ses-tools",
                seq: 1,
                callId: "call-grep-1",
            });
            const sql = __testBuildOpenCodeBatchStatements(extracted, dbPath).join("\n");
            expect(sql).toContain("UPSERT tool:");
            expect(sql).toContain("UPSERT tool_call:");
            expect(sql).toContain(`tool_call:\`${toolCallKey}\``);
            expect(sql).toContain("RELATE turn:");
            expect(sql).toContain("->invoked:");
            expect(sql).toContain("opencode:grep");
            expect(sql).toContain("RELATE tool_call:");
            expect(sql).toContain("kind = \"invoked_skill\"");
        });
    });

    test("extracts observed messages when message.time_updated is absent", async () => {
        await withTempOpenCodeDb((db, dbPath) => {
            db.run(
                "CREATE TABLE session (id text primary key, directory text, title text, time_created integer, time_updated integer)",
            );
            db.run(
                "CREATE TABLE message (id text primary key, session_id text, time_created integer, data text)",
            );
            db.run(
                "CREATE TABLE part (id text primary key, message_id text, session_id text, time_created integer, data text)",
            );
            db.query(
                "INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?)",
            ).run("ses-no-message-updated", "/tmp/project", "No message updated", 1775546262338, 1775546262339);
            db.query(
                "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
            ).run(
                "msg-no-message-updated",
                "ses-no-message-updated",
                1775546262338,
                JSON.stringify({ role: "user" }),
            );
            db.query(
                "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
            ).run(
                "prt-no-message-updated",
                "msg-no-message-updated",
                "ses-no-message-updated",
                1775546262338,
                JSON.stringify({ type: "text", text: "No message updated column." }),
            );

            const extracted = extractOpenCodeDatabase(dbPath);

            expect(extracted.sessions).toHaveLength(1);
            expect(extracted.providerEvents).toHaveLength(1);
            expect(extracted.providerEvents[0]).toMatchObject({
                providerEventId: "msg-no-message-updated",
                text: "No message updated column.",
            });
            expect(extracted.warnings).toEqual([]);
        });
    });

    test("keeps valid rows when timestamps or JSON payloads are malformed", async () => {
        await withTempOpenCodeDb((db, dbPath) => {
            db.run(
                "CREATE TABLE session (id text primary key, directory text, title text, time_created integer, time_updated integer)",
            );
            db.run(
                "CREATE TABLE message (id text primary key, session_id text, time_created integer, time_updated integer, data text)",
            );
            db.run(
                "CREATE TABLE part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text)",
            );
            db.query(
                "INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?)",
            ).run("ses-drift", "/tmp/project", "Drift", 1775546262338, null);
            db.query(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            ).run("msg-good", "ses-drift", "bad timestamp", null, JSON.stringify({ role: "assistant" }));
            db.query(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            ).run("msg-bad-json", "ses-drift", 1775546262339, 1775546262339, "{not json");
            db.query(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            ).run("msg-orphan", "missing-session", 1775546262340, 1775546262340, JSON.stringify({ role: "user" }));
            db.query(
                "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
            ).run("prt-good", "msg-good", "ses-drift", 1775546262341, 1775546262341, JSON.stringify({ type: "text", text: "Still valid." }));

            const extracted = extractOpenCodeDatabase(dbPath);

            expect(extracted.sessions).toHaveLength(1);
            expect(extracted.providerEvents.map((event) => event.providerEventId)).toEqual(["msg-good"]);
            expect(extracted.providerEvents[0]).toMatchObject({
                role: "assistant",
                text: "Still valid.",
                ts: "2026-04-07T07:17:42.338Z",
            });
            expect(extracted.skipped).toBeGreaterThanOrEqual(2);
            expect(extracted.warnings.join("\n")).toContain("invalid timestamp");
            expect(extracted.warnings.join("\n")).toContain("invalid message JSON");
            expect(extracted.warnings.join("\n")).toContain("missing session");
        });
    });

    test("returns an empty extract when required columns are absent", async () => {
        await withTempOpenCodeDb((db, dbPath) => {
            db.run("CREATE TABLE session (id text primary key, title text)");
            db.run("CREATE TABLE message (id text primary key, body text)");

            const extracted = extractOpenCodeDatabase(dbPath);

            expect(extracted.sessions).toHaveLength(0);
            expect(extracted.providerEvents).toHaveLength(0);
            expect(extracted.turns).toHaveLength(0);
            expect(extracted.warnings.join("\n")).toContain("unsupported OpenCode schema");
        });
    });

    test("uses per-session sequence numbers and stable escaped record keys", async () => {
        await withTempOpenCodeDb((db, dbPath) => {
            db.run("CREATE TABLE session (id text primary key, cwd text, title text, created_at text, updated_at text)");
            db.run("CREATE TABLE message (id text primary key, session_id text, role text, content text, created_at text)");
            db.query(
                "INSERT INTO session (id, cwd, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            ).run("session`a", "/tmp/a", "A", "2026-05-29T01:00:00.000Z", "2026-05-29T01:00:10.000Z");
            db.query(
                "INSERT INTO session (id, cwd, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            ).run("session\nb", "/tmp/b", "B", "2026-05-29T01:00:00.000Z", "2026-05-29T01:00:10.000Z");
            const insertMessage = db.query(
                "INSERT INTO message (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
            );
            insertMessage.run("msg-a-1", "session`a", "user", "A1", "2026-05-29T01:00:01.000Z");
            insertMessage.run("msg-b-1", "session\nb", "user", "B1", "2026-05-29T01:00:02.000Z");
            insertMessage.run("msg-a-2", "session`a", "assistant", "A2", "2026-05-29T01:00:03.000Z");

            const extracted = extractOpenCodeDatabase(dbPath);
            const seqByEventId = new Map(
                extracted.providerEvents.map((event) => [event.providerEventId, event.seq]),
            );
            const statements = __testBuildOpenCodeBatchStatements(extracted, dbPath);
            const sql = statements.join("\n");

            expect(seqByEventId).toEqual(new Map([
                ["msg-a-1", 1],
                ["msg-b-1", 1],
                ["msg-a-2", 2],
            ]));
            expect(sql).toContain("session: session:`session\\`a`");
            expect(sql).toContain("session: session:`session\\nb`");
            expect(sql).not.toContain("session: session:`session`a`");
        });
    });

    test("discovery skips old databases when a since cutoff is provided", async () => {
        await withTempOpenCodeDb(async (_db, dbPath) => {
            const old = new Date("2026-05-01T00:00:00.000Z");
            await utimes(dbPath, old, old);

            expect(await findOpenCodeDbCandidates(join(dbPath, ".."), old.getTime() + 1)).toEqual([]);
            expect(await findOpenCodeDbCandidates(join(dbPath, ".."), old.getTime())).toEqual([dbPath]);
        });
    });
});
