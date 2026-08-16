import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    extractCursorStateDb,
    __testToCursorNormalizedBatch,
} from "./cursor.ts";

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
        it(`maps the extracted session to normalized rows (compaction=${withCompaction})`, () => {
            const dbPath = composerDiskKvFixture(withCompaction);
            const extracted = extractCursorStateDb(dbPath);
            const batch = __testToCursorNormalizedBatch(extracted, dbPath);
            expect(batch.providers[0]).toMatchObject({ name: "cursor" });
            expect(batch.sessions).toHaveLength(1);
            expect(batch.events.length).toBe(extracted.providerEvents.length);
            expect(batch.turns.length).toBeGreaterThan(0);
            expect(batch.toolCalls.length).toBeGreaterThan(0);
            expect(batch.syntheticSkillInvocations.length).toBeGreaterThan(0);
            expect(batch.toolCallSkillRelations.length).toBeGreaterThan(0);
            expect(batch.compactions.length).toBe(withCompaction ? 1 : 0);
            expect(batch.turns.every((turn) => turn.agentEvent?.provider === "cursor")).toBe(true);
        });
    }
});
