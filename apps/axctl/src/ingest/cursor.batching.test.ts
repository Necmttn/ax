import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    __testPartitionCursorExtract,
    __testSliceCursorExtractForSession,
    extractCursorStateDb,
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
