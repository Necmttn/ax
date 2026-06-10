import { describe, expect, it } from "bun:test";
import { __testBuildPiBatchStatements, __testExtractPiJsonlLines } from "./pi.ts";
import { extractToolFileEvidence } from "./tool-file-evidence.ts";

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

const fixtureLines = (): string[] => [
    JSON.stringify({ type: "session", version: 3, id: "pi-parity", timestamp: "2026-06-10T06:00:00.000Z", cwd: "/Users/necmttn/Projects/ax" }),
    JSON.stringify({ type: "message", id: "user-1", parentId: null, timestamp: "2026-06-10T06:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "list files" }] } }),
    JSON.stringify({
        type: "message", id: "assistant-1", parentId: "user-1", timestamp: "2026-06-10T06:00:02.000Z",
        message: {
            role: "assistant", model: "gpt-5.5", provider: "openai-codex",
            usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 3, totalTokens: 20 },
            content: [
                { type: "text", text: "Listing." },
                { type: "toolCall", id: "call-1", name: "exec_command", input: { command: "ls -la" } },
                { type: "toolCall", id: "call-2", name: "read", input: { path: "README.md" } },
            ],
        },
    }),
    JSON.stringify({ type: "message", id: "result-1", parentId: "assistant-1", timestamp: "2026-06-10T06:00:03.000Z", message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "total 8" }] } }),
    JSON.stringify({ type: "message", id: "result-2", parentId: "result-1", timestamp: "2026-06-10T06:00:03.500Z", message: { role: "toolResult", toolCallId: "call-2", content: [{ type: "text", text: "# ax" }] } }),
    JSON.stringify({ type: "compaction", id: "compaction-1", parentId: "result-2", timestamp: "2026-06-10T06:00:04.000Z", summary: "compacted history" }),
];

describe("pi normalized-batch parity", () => {
    it("new path emits golden statement shapes", () => {
        const extracted = __testExtractPiJsonlLines(fixtureLines());
        expect(extracted).not.toBeNull();
        expect(extracted!.toolCalls.length).toBe(2);
        // Fixture-coverage guards: synthetic-invocation, compaction, and
        // tool-file-evidence parity coverage must not silently shrink if the
        // fixture drifts.
        expect(extracted!.invocations.length).toBeGreaterThan(0);
        expect(extracted!.compactions.length).toBeGreaterThan(0);
        expect(extractToolFileEvidence(extracted!.toolCalls).length).toBeGreaterThan(0);
        const statements = __testBuildPiBatchStatements(extracted!);
        const sql = statements.join("\n");
        expect(countStarting(statements, "UPSERT agent_provider:")).toBe(1);
        expect(countStarting(statements, "UPSERT agent_session:")).toBe(1);
        expect(countStarting(statements, "DELETE (SELECT VALUE id FROM agent_event_child")).toBe(1);
        expect(countStarting(statements, "DELETE (SELECT VALUE id FROM agent_event WHERE")).toBe(1);
        expect(countStarting(statements, "UPSERT agent_event:")).toBe(extracted!.providerEvents.length);
        expect(countRelation(statements, "agent_event_child")).toBe(6);
        expect(countStarting(statements, "UPSERT turn:")).toBe(extracted!.turns.length);
        expect(countStarting(statements, "UPSERT tool:")).toBe(3);
        expect(countStarting(statements, "UPSERT tool_call:")).toBe(extracted!.toolCalls.length);
        expect(countStarting(statements, "UPSERT file:")).toBe(1);
        expect(countRelation(statements, "read_file")).toBe(1);
        expect(countStarting(statements, "UPSERT skill:")).toBe(extracted!.skillRelations.length);
        expect(countRelation(statements, "invoked")).toBe(extracted!.invocations.length);
        expect(countRelation(statements, "concerns")).toBe(extracted!.skillRelations.length);
        expect(countStarting(statements, "UPSERT compaction:")).toBe(extracted!.compactions.length);
        expect(countStarting(statements, "UPSERT session_token_usage:")).toBe(1);

        expect(statements[0]).toBe('UPSERT agent_provider:`pi` MERGE { name: "pi", display_name: "Pi", version: "3", capabilities: "{\\"transcripts\\":true,\\"providerGraph\\":true,\\"planSignals\\":{\\"provider\\":\\"pi\\",\\"status\\":\\"unavailable\\",\\"planSources\\":[],\\"toolNames\\":[],\\"evidence\\":\\"Current Pi JSONL fixtures expose message, custom, and generic toolCall blocks; no raw plan snapshot payload equivalent is present.\\"},\\"delegationSignals\\":{\\"provider\\":\\"pi\\",\\"status\\":\\"unavailable\\",\\"rawSignals\\":[],\\"sharedRecords\\":[\\"spawned\\"],\\"evidence\\":\\"Current Pi JSONL fixtures expose generic toolCall blocks but no child-session id or delegation relation payload.\\"}}", updated_at: time::now() };');
        const sessionStatement = expectOneStatement(statements, (statement) => statement.startsWith("UPSERT agent_session:"), "pi agent_session row");
        expect(sessionStatement).toContain('provider_session_id: "pi-parity", ax_session: session:`pi-parity`');
        expect(sessionStatement).toContain('raw: "{\\"source\\":\\"pi_jsonl\\",\\"sourcePath\\":\\"pi-test.jsonl\\",\\"version\\":3}"');
        expect(sessionStatement).toContain('labels: "{\\"source\\":\\"pi\\"}", metrics: "{\\"turns\\":4,\\"toolCalls\\":2,\\"providerEvents\\":7,\\"usage\\":{\\"input\\":10,\\"output\\":5,\\"cacheRead\\":2,\\"cacheWrite\\":3,\\"totalTokens\\":20}}"');
        expect(statements).toContain('UPSERT turn:`pi_parity__c193685e6fae5e69__seq_000002` CONTENT { session: session:`pi-parity`, agent_event: agent_event:`pi__pi_parity__c193685e6fae5e69__assistant_1__c5ebef03b853f62f`, seq: 2, ts: d"2026-06-10T06:00:02.000Z", role: "assistant", message_kind: "assistant", intent_kind: "assistant", text: "Listing.", text_excerpt: "Listing.", has_tool_use: true, has_error: false };');
        const readToolCall = expectOneStatement(statements, (statement) => statement.startsWith("UPSERT tool_call:") && statement.includes('name: "read"'), "pi read tool_call row");
        expect(readToolCall).toContain('call_id: "call-2", ts: d"2026-06-10T06:00:02.000Z", status: "ok"');
        expect(readToolCall).toContain('input_json: "{\\"path\\":\\"README.md\\"}", output_json: "[{\\"type\\":\\"text\\",\\"text\\":\\"# ax\\"}]"');
        expect(statements).toContain('RELATE turn:`pi_parity__c193685e6fae5e69__seq_000002`->invoked:`8e23fa1687c39644`->skill:`v2__pi_read__6f9122599f8a0175` SET session = session:`pi-parity`, ts = d"2026-06-10T06:00:02.000Z", args = "{\\"path\\":\\"README.md\\"}", turn_has_error = false, turn_index = 2;');
        expect(sql).toContain("UPSERT agent_provider:`pi`");
        expect(sql).toMatch(/UPSERT agent_session:`pi__pi_parity__[^`]+`/);
        expect(sql).toMatch(/UPSERT agent_event:`pi__pi_parity__[^`]+__/);
        expect(sql).toMatch(/UPSERT turn:`[^`]+` CONTENT \{ session: session:`pi-parity`, agent_event: agent_event:`pi__pi_parity__/);
        expect(sql).toContain("UPSERT tool:`pi__");
        expect(sql).toContain("UPSERT tool_call:`");
        expect(sql).toContain("UPSERT file:`");
        expect(sql).toMatch(/RELATE tool_call:`[^`]+`->(read_file|mentioned_file):`[^`]+`->file:`[^`]+` SET /);
        expect(sql).toContain('scope: "pi-tool", dir_path: "(synthetic)", content_hash: "pi"');
        expect(sql).toMatch(/RELATE turn:`[^`]+`->invoked:`[^`]+`->skill:`[^`]+` SET session = session:`pi-parity`/);
        expect(statements.some((statement) => statement.startsWith("UPSERT compaction:"))).toBe(true);
        expect(sql).toContain("UPSERT session_token_usage:`pi_parity`");
    });
});
