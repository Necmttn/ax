import { describe, expect, it } from "bun:test";
import {
    __testBuildCodexBatchStatements,
    __testExtractCodexJsonlLines,
    __testStreamCodexJsonlLines,
} from "./codex.ts";
import { extractToolFileEvidence } from "./tool-file-evidence.ts";

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
