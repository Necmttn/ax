import { describe, expect, it } from "bun:test";
import {
    __testExtractCodexJsonlLines,
    __testStreamCodexJsonlLines,
    toCodexNormalizedBatch,
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
    it("warns and falls back for missing or malformed timestamps", () => {
        const extracted = __testExtractCodexJsonlLines([
            JSON.stringify({ type: "session_meta", payload: {
                id: "codex-invalid-timestamp", cwd: "/Users/necmttn/Projects/ax",
                timestamp: "2026-06-10T08:00:00.000Z",
            } }),
            JSON.stringify({ type: "compacted", timestamp: "not-a-timestamp",
                payload: { message: "", replacement_history: [{ type: "message" }] } }),
        ]);
        expect(extracted).not.toBeNull();
        expect(extracted!.warnings).toHaveLength(2);
        expect(extracted!.warnings[0]).toContain("missing entry timestamp");
        expect(extracted!.warnings[1]).toContain("invalid entry timestamp");
        expect(extracted!.compactions).toHaveLength(1);
    });

    it("maps the rich extract to every normalized writer collection", () => {
        const extracted = __testExtractCodexJsonlLines(fixtureLines());
        expect(extracted).not.toBeNull();
        const batch = toCodexNormalizedBatch(extracted!, 1200);
        expect(batch.providers[0]).toMatchObject({ name: "codex", version: "0.4.0" });
        expect(batch.sessions[0]).toMatchObject({ id: "codex-parity", model: "gpt-5.3-codex" });
        expect(batch.events.length).toBe(extracted!.providerEvents.length);
        expect(batch.turns.length).toBeGreaterThan(0);
        expect(batch.toolCalls.length).toBeGreaterThan(0);
        expect(batch.toolFileEvidence.length).toBeGreaterThan(0);
        expect(batch.syntheticSkillInvocations.length).toBeGreaterThan(0);
        expect(batch.toolCallSkillRelations.length).toBeGreaterThan(0);
        expect(batch.planSnapshots.length).toBeGreaterThan(0);
        expect(batch.compactions.length).toBeGreaterThan(0);
        expect(batch.toolCalls.find((call) => call.callId === "call_exec")).toMatchObject({
            toolName: "exec_command", commandText: "git status --short", hasError: false,
        });
        expect(extractToolFileEvidence(extracted!.toolCalls).length).toBeGreaterThan(0);
    });

    it("keeps cross-batch parent edges during streaming", () => {
        const batches = __testStreamCodexJsonlLines(fixtureLines(), 3);
        expect(batches.length).toBeGreaterThan(1);
        const normalized = batches.map((batch) => toCodexNormalizedBatch(batch, 1200));
        expect(normalized.reduce((sum, batch) => sum + batch.agentEventParentEdges.length, 0))
            .toBeGreaterThan(0);
        expect(normalized[0]!.sessions).toHaveLength(1);
    });
});
