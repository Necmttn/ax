import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    extractCursorStateDb,
    __legacyBuildCursorBatchStatements,
    __testBuildCursorBatchStatements,
} from "./cursor.ts";
import { diffStatementSets } from "./normalized/statement-parity.ts";

const composerDiskKvFixture = (withCompaction: boolean): string => {
    const dir = mkdtempSync(join(tmpdir(), "ax-cursor-parity-"));
    const dbPath = join(dir, "state.vscdb");
    const db = new Database(dbPath);
    db.query("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)").run();
    const insert = db.query("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
    insert.run(
        "composerData:composer-parity-1",
        JSON.stringify({
            composerId: "composer-parity-1",
            name: "Parity session",
            createdAt: "2026-06-10T10:00:00.000Z",
            fullConversationHeadersOnly: [
                { bubbleId: "bubble-user-1" },
                { bubbleId: "bubble-tool-1" },
            ],
            ...(withCompaction ? { summarizedComposers: ["composer-old-1"] } : {}),
        }),
    );
    insert.run(
        "bubbleId:composer-parity-1:bubble-user-1",
        JSON.stringify({
            bubbleId: "bubble-user-1",
            type: 1,
            text: "check git status",
            createdAt: "2026-06-10T10:00:01.000Z",
        }),
    );
    insert.run(
        "bubbleId:composer-parity-1:bubble-tool-1",
        JSON.stringify({
            bubbleId: "bubble-tool-1",
            type: 2,
            text: "Running git status.",
            createdAt: "2026-06-10T10:00:05.000Z",
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
    db.close();
    return dbPath;
};

describe("cursor normalized-batch parity", () => {
    for (const withCompaction of [false, true]) {
        it(`new path emits the exact legacy statement multiset (compaction=${withCompaction})`, () => {
            const dbPath = composerDiskKvFixture(withCompaction);
            const extracted = extractCursorStateDb(dbPath);
            expect(extracted.sessions.length).toBeGreaterThan(0);
            expect(extracted.toolCalls.length).toBeGreaterThan(0);
            if (withCompaction) expect(extracted.compactions.length).toBeGreaterThan(0);

            const legacy = __legacyBuildCursorBatchStatements(extracted, dbPath);
            const next = __testBuildCursorBatchStatements(extracted, dbPath);
            expect(diffStatementSets(legacy, next)).toEqual({ missing: [], added: [] });
        });
    }
});
