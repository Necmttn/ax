import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { extractOpenCodeDatabase } from "./opencode.ts";

describe("OpenCode SQLite extraction", () => {
    test("extracts sessions and message events from the local database", async () => {
        const dir = await mkdtemp(join(tmpdir(), "ax-opencode-"));
        const dbPath = join(dir, "opencode.db");
        const db = new Database(dbPath);
        try {
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
        } finally {
            db.close();
        }

        try {
            const extracted = extractOpenCodeDatabase(dbPath);

            expect(extracted.sessions).toHaveLength(1);
            expect(extracted.providerEvents).toHaveLength(1);
            expect(extracted.turns).toHaveLength(1);
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
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
