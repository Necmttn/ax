import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
    extractCursorStateDb,
    isAllowedCursorHistoryKey,
} from "./cursor.ts";

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

describe("Cursor history key allowlist", () => {
    test("allows composer history and rejects auth/privacy keys", () => {
        expect(isAllowedCursorHistoryKey("composer.composerData")).toBe(true);
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
                id: "cursor-session-1",
                title: "Cursor fixture",
                sourcePath: dbPath,
                started_at: "2026-05-29T08:00:00.000Z",
                ended_at: "2026-05-29T08:00:00.000Z",
            });
            expect(extracted.providerEvents[0]).toMatchObject({
                provider: "cursor",
                providerSessionId: "cursor-session-1",
                providerEventId: "cursor-message-1",
                seq: 1,
                type: "message",
                role: "user",
                text: "Implement the Cursor adapter.",
                textExcerpt: "Implement the Cursor adapter.",
            });
            expect(JSON.stringify(extracted.providerEvents[0]?.raw)).not.toContain("cursor-secret-token");
        });
    });
});
