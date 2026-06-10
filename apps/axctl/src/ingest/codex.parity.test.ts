import { describe, expect, it } from "bun:test";
import {
    __testBuildCodexBatchStatements,
    __testExtractCodexJsonlLines,
    __testStreamCodexJsonlLines,
} from "./codex.ts";
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

/**
 * Richest codex fixture: session_meta, turn_context, plain message turns,
 * function_call + function_call_output (exec_command AND apply_patch, the
 * latter producing edited file evidence), update_plan, event_msg/token_count
 * (session + per-turn usage), and a compacted event. Line ORDER matters for
 * the streaming case: with `every = 3`, each function_call_output lands in a
 * LATER drain window than its function_call so cross-batch agent_event parent
 * edges are exercised.
 */
const fixtureLines = (): string[] => [
    JSON.stringify({
        type: "session_meta",
        timestamp: "2026-06-10T08:00:00.000Z",
        payload: {
            id: "codex-parity",
            cwd: "/Users/necmttn/Projects/ax",
            cli_version: "0.4.0",
            model_provider: "openai",
            timestamp: "2026-06-10T08:00:00.000Z",
        },
    }),
    JSON.stringify({
        type: "turn_context",
        timestamp: "2026-06-10T08:00:01.000Z",
        payload: { model: "gpt-5.3-codex" },
    }),
    JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-10T08:00:02.000Z",
        payload: {
            type: "message",
            message: { role: "user", content: [{ type: "input_text", text: "fix the ingest bug" }] },
        },
    }),
    JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-10T08:00:03.000Z",
        payload: {
            type: "function_call",
            name: "exec_command",
            call_id: "call_exec",
            arguments: JSON.stringify({ cmd: "git status --short" }),
        },
    }),
    JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-10T08:00:04.000Z",
        payload: {
            type: "function_call",
            name: "apply_patch",
            call_id: "call_patch",
            arguments: JSON.stringify({
                patch: [
                    "*** Begin Patch",
                    "*** Update File: src/ingest/codex.ts",
                    "@@",
                    "-old",
                    "+new",
                    "*** End Patch",
                ].join("\n"),
            }),
        },
    }),
    JSON.stringify({
        type: "event_msg",
        timestamp: "2026-06-10T08:00:05.000Z",
        payload: {
            type: "token_count",
            info: {
                model_context_window: 258400,
                total_token_usage: {
                    input_tokens: 1000,
                    cached_input_tokens: 250,
                    output_tokens: 125,
                    total_tokens: 1200,
                },
                last_token_usage: {
                    input_tokens: 1000,
                    cached_input_tokens: 250,
                    output_tokens: 125,
                    total_tokens: 1200,
                },
            },
        },
    }),
    JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-10T08:00:06.000Z",
        payload: {
            type: "function_call_output",
            call_id: "call_exec",
            output: "M apps/axctl/src/ingest/codex.ts\n",
        },
    }),
    JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-10T08:00:07.000Z",
        payload: {
            type: "function_call_output",
            call_id: "call_patch",
            output: "Success. Updated the following files:\nM src/ingest/codex.ts\n",
        },
    }),
    JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-10T08:00:08.000Z",
        payload: {
            type: "function_call",
            name: "update_plan",
            call_id: "call_plan",
            arguments: JSON.stringify({
                explanation: "Tracking task progress.",
                plan: [
                    { step: "Inspect Codex ingestion", status: "completed" },
                    { step: "Write evidence graph records", status: "in_progress" },
                ],
            }),
        },
    }),
    JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-10T08:00:09.000Z",
        payload: {
            type: "message",
            message: { role: "assistant", content: [{ type: "output_text", text: "Patched and planned." }] },
        },
    }),
    JSON.stringify({
        type: "compacted",
        timestamp: "2026-06-10T08:00:10.000Z",
        payload: { message: "", replacement_history: [{ type: "message" }, { type: "message" }] },
    }),
    JSON.stringify({
        type: "event_msg",
        timestamp: "2026-06-10T08:00:11.000Z",
        payload: {
            type: "token_count",
            info: {
                model_context_window: 258400,
                total_token_usage: {
                    input_tokens: 2400,
                    cached_input_tokens: 600,
                    output_tokens: 300,
                    total_tokens: 2900,
                },
            },
        },
    }),
];

describe("codex normalized-batch parity", () => {
    it("single-shot extract emits golden statement shapes", () => {
        const extracted = __testExtractCodexJsonlLines(fixtureLines());
        expect(extracted).not.toBeNull();
        // Fixture-coverage guards: every codex-specific parity leg must stay
        // non-empty so a fixture drift can't silently shrink coverage.
        expect(extracted!.turns.length).toBeGreaterThan(0);
        expect(extracted!.invocations.length).toBeGreaterThan(0);
        expect(extracted!.toolCalls.length).toBeGreaterThan(0);
        expect(extracted!.planSnapshots.length).toBeGreaterThan(0);
        expect(extracted!.compactions.length).toBeGreaterThan(0);
        expect(extracted!.skillRelations.length).toBeGreaterThan(0);
        expect(extracted!.tokenUsage).not.toBeNull();
        expect(extracted!.turnTokenUsages.length).toBeGreaterThan(0);
        expect(extractToolFileEvidence(extracted!.toolCalls).length).toBeGreaterThan(0);
        const statements = __testBuildCodexBatchStatements(extracted!, 1200, true);
        const sql = statements.join("\n");
        expect(countStarting(statements, "UPSERT agent_provider:")).toBe(1);
        expect(countStarting(statements, "UPSERT agent_session:")).toBe(1);
        expect(countStarting(statements, "DELETE (SELECT VALUE id FROM agent_event_child")).toBe(1);
        expect(countStarting(statements, "DELETE (SELECT VALUE id FROM agent_event WHERE")).toBe(1);
        expect(countStarting(statements, "UPSERT agent_event:")).toBe(extracted!.providerEvents.length);
        expect(countRelation(statements, "agent_event_child")).toBe(8);
        expect(countStarting(statements, "UPSERT turn:")).toBe(extracted!.turns.length);
        expect(countStarting(statements, "UPSERT tool:")).toBe(4);
        expect(countStarting(statements, "UPSERT tool_call:")).toBe(extracted!.toolCalls.length);
        expect(countStarting(statements, "UPSERT skill:")).toBe(extracted!.skillRelations.length);
        expect(countRelation(statements, "invoked")).toBe(extracted!.invocations.length);
        expect(countRelation(statements, "concerns")).toBe(extracted!.skillRelations.length);
        expect(countStarting(statements, "UPSERT plan:")).toBe(extracted!.planSnapshots.length);
        expect(countStarting(statements, "UPSERT plan_snapshot:")).toBe(extracted!.planSnapshots.length);
        expect(countStarting(statements, "UPSERT compaction:")).toBe(extracted!.compactions.length);
        expect(countStarting(statements, "UPSERT session_token_usage:")).toBe(1);
        expect(countStarting(statements, "UPSERT turn_token_usage:")).toBe(extracted!.turnTokenUsages.length);

        expect(statements[0]).toBe('UPSERT agent_provider:`codex` MERGE { name: "codex", display_name: "Codex", version: "0.4.0", capabilities: "{\\"transcripts\\":true,\\"toolCalls\\":true,\\"planSignals\\":{\\"provider\\":\\"codex\\",\\"status\\":\\"available\\",\\"planSources\\":[\\"codex_update_plan\\"],\\"toolNames\\":[\\"update_plan\\"],\\"evidence\\":\\"Codex session JSONL exposes update_plan function call arguments.\\"},\\"delegationSignals\\":{\\"provider\\":\\"codex\\",\\"status\\":\\"available\\",\\"rawSignals\\":[\\"spawn_agent tool output\\"],\\"sharedRecords\\":[\\"spawned\\"],\\"evidence\\":\\"Codex spawn_agent output includes agent_id and nickname; derive-spawned writes spawned edges after the child session exists.\\"}}", updated_at: time::now() };');
        const sessionStatement = expectOneStatement(statements, (statement) => statement.startsWith("UPSERT agent_session:"), "codex agent_session row");
        expect(sessionStatement).toContain('provider_session_id: "codex-parity", ax_session: session:`codex-parity`');
        expect(sessionStatement).toContain('raw: "{\\"source\\":\\"codex_transcript\\",\\"cliVersion\\":\\"0.4.0\\",\\"modelProvider\\":\\"openai\\",\\"model\\":\\"gpt-5.3-codex\\"}"');
        expect(sessionStatement).toContain('labels: "{\\"source\\":\\"transcript\\"}", metrics: "{\\"turns\\":7,\\"toolCalls\\":3,\\"providerEvents\\":8}"');
        expect(statements).toContain('UPSERT turn:`codex_parity__01869a265130c185__seq_000001` CONTENT { session: session:`codex-parity`, seq: 1, ts: d"2026-06-10T08:00:02.000Z", role: "user", message_kind: "task", intent_kind: "organic_task", text: "fix the ingest bug", text_excerpt: "fix the ingest bug", has_tool_use: false, has_error: false };');
        const execToolCall = expectOneStatement(statements, (statement) => statement.startsWith("UPSERT tool_call:") && statement.includes('name: "exec_command"'), "codex exec_command tool_call row");
        expect(execToolCall).toContain('call_id: "call_exec", ts: d"2026-06-10T08:00:03.000Z", status: "ok"');
        expect(execToolCall).toContain('input_json: "{\\"cmd\\":\\"git status --short\\"}", output_json: "M apps/axctl/src/ingest/codex.ts\\n"');
        expect(execToolCall).toContain('command_text: "git status --short", command_norm: "git status"');
        expect(statements).toContain('RELATE turn:`codex_parity__01869a265130c185__seq_000002`->invoked:`6af5e141725410b0`->skill:`v2__codex_exec_command__83ae52d007aad013` SET session = session:`codex-parity`, ts = d"2026-06-10T08:00:03.000Z", args = "\\"{\\\\\\"cmd\\\\\\":\\\\\\"git status --short\\\\\\"}\\"", turn_has_error = false, turn_index = 2;');
        expect(sql).toContain("UPSERT agent_provider:`codex`");
        expect(sql).toMatch(/UPSERT agent_session:`codex__codex_parity__[^`]+`/);
        expect(sql).toMatch(/DELETE \(SELECT VALUE id FROM agent_event_child WHERE agent_session = agent_session:`codex__codex_parity__[^`]+`\)/);
        expect(sql).toMatch(/UPSERT agent_event:`codex__codex_parity__[^`]+__/);
        expect(sql).toMatch(/UPSERT turn:`[^`]+` CONTENT \{ session: session:`codex-parity`, seq: \d+, ts:/);
        expect(sql).not.toMatch(/UPSERT turn:`[^`]+` CONTENT \{[^}]*agent_event:/);
        expect(sql).toContain("UPSERT tool:`codex__");
        expect(sql).toContain("UPSERT tool_call:`");
        expect(sql).toContain("UPSERT file:`");
        expect(sql).toMatch(/RELATE (tool_call|turn):`[^`]+`->(edited|edited_file|mentioned_file|read_file):`[^`]+`->file:`[^`]+` SET /);
        expect(sql).toContain('scope: "codex-tool", dir_path: "(synthetic)", content_hash: "codex"');
        expect(sql).toMatch(/RELATE turn:`[^`]+`->invoked:`[^`]+`->skill:`[^`]+` SET session = session:`codex-parity`/);
        expect(sql).toMatch(/RELATE tool_call:`[^`]+`->concerns:`[^`]+`->skill:`[^`]+` SET /);
        expect(sql).toContain("UPSERT plan:`");
        expect(sql).toContain("UPSERT plan_snapshot:`");
        expect(statements.some((statement) => statement.startsWith("UPSERT compaction:"))).toBe(true);
        expect(sql).toContain("UPSERT session_token_usage:`codex_parity`");
        expect(sql).toContain("UPSERT turn_token_usage:`");
    });

    it("streaming batches keep first-batch-only clearing and parent edges", () => {
        const batches = __testStreamCodexJsonlLines(fixtureLines(), 3);
        expect(batches.length).toBeGreaterThan(1);
        // Streaming-only coverage guard: cross-batch agent_event parent edges
        // (function_call_output drained after its function_call) must appear.
        expect(batches.reduce((sum, batch) => sum + batch.parentEdges.length, 0)).toBeGreaterThan(0);
        batches.forEach((batch, index) => {
            const clearExisting = index === 0;
            const statements = __testBuildCodexBatchStatements(batch, 1200, clearExisting);
            const sql = statements.join("\n");
            expect(sql.includes("DELETE (SELECT VALUE id FROM agent_event_child")).toBe(clearExisting && batch.session !== null);
            if (batch.session !== null) {
                expect(sql).toContain("UPSERT agent_provider:`codex`");
                expect(sql).toMatch(/UPSERT agent_session:`codex__codex_parity__[^`]+`/);
            }
            if (batch.parentEdges.length > 0) {
                expect(sql).toMatch(/RELATE agent_event:`[^`]+`->agent_event_child:`[^`]+`->agent_event:`[^`]+` SET /);
            }
        });
    });
});
