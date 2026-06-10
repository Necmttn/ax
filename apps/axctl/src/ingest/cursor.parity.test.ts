import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    extractCursorStateDb,
    __testBuildCursorBatchStatements,
} from "./cursor.ts";

const countStarting = (statements: readonly string[], prefix: string): number =>
    statements.filter((statement) => statement.startsWith(prefix)).length;

const countRelation = (statements: readonly string[], relation: string): number =>
    statements.filter((statement) => statement.includes(`->${relation}:`)).length;

const expectOneStatement = (
    statements: readonly string[],
    predicate: (statement: string) => boolean,
    label: string,
): string => {
    const matches = statements.filter(predicate);
    expect(matches.length, label).toBe(1);
    return matches[0]!;
};

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
        it(`new path emits golden statement shapes (compaction=${withCompaction})`, () => {
            const dbPath = composerDiskKvFixture(withCompaction);
            const extracted = extractCursorStateDb(dbPath);
            expect(extracted.sessions.length).toBeGreaterThan(0);
            expect(extracted.toolCalls.length).toBeGreaterThan(0);
            if (withCompaction) expect(extracted.compactions.length).toBeGreaterThan(0);

            const statements = __testBuildCursorBatchStatements(extracted, dbPath);
            const sql = statements.join("\n");
            expect(countStarting(statements, "UPSERT agent_provider:")).toBe(1);
            expect(countStarting(statements, "UPSERT agent_session:")).toBe(extracted.sessions.length);
            expect(countStarting(statements, "DELETE (SELECT VALUE id FROM agent_event_child")).toBe(extracted.sessions.length);
            expect(countStarting(statements, "DELETE (SELECT VALUE id FROM agent_event WHERE")).toBe(extracted.sessions.length);
            expect(countStarting(statements, "UPSERT agent_event:")).toBe(extracted.providerEvents.length);
            expect(countRelation(statements, "agent_event_child")).toBe(1);
            expect(countStarting(statements, "UPSERT turn:")).toBe(extracted.turns.length);
            expect(countStarting(statements, "UPSERT tool:")).toBe(2);
            expect(countStarting(statements, "UPSERT tool_call:")).toBe(extracted.toolCalls.length);
            expect(countStarting(statements, "UPSERT skill:")).toBe(extracted.skillRelations.length);
            expect(countRelation(statements, "invoked")).toBe(extracted.invocations.length);
            expect(countRelation(statements, "concerns")).toBe(extracted.skillRelations.length);
            expect(countStarting(statements, "UPSERT compaction:")).toBe(extracted.compactions.length);

            expect(statements[0]).toBe('UPSERT agent_provider:`cursor` MERGE { name: "cursor", display_name: "Cursor", version: NONE, capabilities: "{\\"sqlite\\":true,\\"transcripts\\":true,\\"providerGraph\\":true,\\"toolCalls\\":true,\\"planSignals\\":{\\"provider\\":\\"cursor\\",\\"status\\":\\"unavailable\\",\\"planSources\\":[],\\"toolNames\\":[],\\"evidence\\":\\"Current Cursor state.vscdb fixtures expose composer messages/bubbles only; no raw plan snapshot payload equivalent is present.\\"},\\"delegationSignals\\":{\\"provider\\":\\"cursor\\",\\"status\\":\\"unavailable\\",\\"rawSignals\\":[],\\"sharedRecords\\":[\\"spawned\\"],\\"evidence\\":\\"Current Cursor state.vscdb fixtures expose composer messages/bubbles only; no child-session id or delegation relation payload is present.\\"}}", updated_at: time::now() };');
            const sessionStatement = expectOneStatement(statements, (statement) => statement.startsWith("UPSERT agent_session:"), "cursor agent_session row");
            expect(sessionStatement).toContain('provider: agent_provider:`cursor`');
            expect(sessionStatement).toContain('provider_session_id: "cursor__');
            expect(sessionStatement).toContain('title: "Parity session", model: NONE');
            expect(sessionStatement).toContain('raw: "{\\"source\\":\\"cursor_state_vscdb\\",');
            expect(sessionStatement).toContain('\\"cursorConversationId\\":\\"composer-parity-1\\"}"');
            expect(sessionStatement).toContain('labels: "{\\"source\\":\\"cursor\\",');
            expect(sessionStatement).toContain('metrics: "{\\"turns\\":2,\\"toolCalls\\":1,');
            const turnStatement = expectOneStatement(statements, (statement) => statement.startsWith("UPSERT turn:") && statement.includes("seq: 2"), "cursor tool turn row");
            expect(turnStatement).toContain('role: "assistant", message_kind: "tool_call", intent_kind: "tool_call"');
            expect(turnStatement).toContain('text: "Running git status.", text_excerpt: "Running git status.", has_tool_use: true, has_error: false');
            const toolCallStatement = expectOneStatement(statements, (statement) => statement.startsWith("UPSERT tool_call:"), "cursor tool_call row");
            expect(toolCallStatement).toContain('name: "run_terminal_command_v2", seq: 2, call_id: "cursor-tool-call-1"');
            expect(toolCallStatement).toContain('input_json: "{\\"command\\":\\"git status --short\\"}"');
            expect(toolCallStatement).toContain('command_text: "git status --short", command_norm: "git status"');
            const skillStatement = expectOneStatement(statements, (statement) => statement.startsWith("UPSERT skill:"), "cursor synthetic skill row");
            expect(skillStatement).toBe('UPSERT skill:`v2__cursor_run_terminal_command_v2__5ed1feabe33858f7` MERGE { name: "cursor:run_terminal_command_v2", scope: "cursor-tool", dir_path: "(synthetic)", content_hash: "cursor" };');
            const invokedStatement = expectOneStatement(statements, (statement) => statement.includes("->invoked:"), "cursor invoked relation");
            expect(invokedStatement).toContain('->skill:`v2__cursor_run_terminal_command_v2__5ed1feabe33858f7` SET session = session:`cursor__');
            expect(invokedStatement).toContain('args = "{\\"command\\":\\"git status --short\\"}", turn_has_error = false, turn_index = 2;');
            const concernsStatement = expectOneStatement(statements, (statement) => statement.includes("->concerns:"), "cursor tool_call concerns relation");
            expect(concernsStatement).toContain('->skill:`v2__cursor_run_terminal_command_v2__5ed1feabe33858f7` SET kind = "invoked_skill"');
            expect(concernsStatement).toContain('labels = "{\\"provider\\":\\"cursor\\",\\"toolName\\":\\"run_terminal_command_v2\\",\\"source\\":\\"composerData:composer-parity-1\\"}"');
            expect(sql).toContain("UPSERT agent_provider:`cursor`");
            expect(sql).toContain("UPSERT agent_session:`cursor__");
            expect(sql).toContain("DELETE (SELECT VALUE id FROM agent_event_child WHERE agent_session = agent_session:`cursor__");
            expect(sql).toContain("UPSERT agent_event:`cursor__");
            expect(sql).toMatch(/UPSERT turn:`[^`]+` CONTENT \{ session: session:`[^`]+`, agent_event: agent_event:`cursor__/);
            expect(sql).toContain("UPSERT tool:`cursor__");
            expect(sql).toContain("UPSERT tool_call:`");
            expect(sql).toContain('scope: "cursor-tool", dir_path: "(synthetic)", content_hash: "cursor"');
            expect(sql).toMatch(/RELATE turn:`[^`]+`->invoked:`[^`]+`->skill:`[^`]+` SET session = session:/);
            expect(statements.some((statement) => statement.startsWith("UPSERT compaction:"))).toBe(withCompaction);
        });
    }
});
