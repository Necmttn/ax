import { describe, expect, test } from "bun:test";
import { projectClaudeLogEvent } from "./log-event-projection.ts";
import type { OtelLogEventRow } from "./rows.ts";

const row = (overrides: Partial<OtelLogEventRow>): OtelLogEventRow => ({
    harness: "claude",
    event_name: "claude_code.tool_result",
    session_id: "session-1",
    model: null,
    input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    cached_tokens: null,
    tool_tokens: null,
    duration_ms: null,
    status_code: null,
    attrs: null,
    observed_at: new Date("2026-06-17T00:00:00.000Z"),
    ...overrides,
});

describe("projectClaudeLogEvent", () => {
    test("projects tool result fields and nulls unrelated typed fields", () => {
        const projected = projectClaudeLogEvent(row({
            attrs: JSON.stringify({
                "event.name": "claude_code.tool_result",
                "prompt.id": "prompt-1",
                "event.sequence": "42",
                tool_use_id: "toolu_123",
                tool_name: "Bash",
                success: "true",
            }),
        }));

        expect(projected).toEqual({
            eventName: "claude_code.tool_result",
            promptId: "prompt-1",
            eventSequence: 42,
            toolUseId: "toolu_123",
            toolName: "Bash",
            decision: null,
            decisionSource: null,
            success: true,
            mcpServerScope: null,
            pluginScope: null,
            preTokens: null,
            postTokens: null,
        });
    });

    test("returns null typed fields when attrs are malformed JSON", () => {
        const projected = projectClaudeLogEvent(row({ attrs: "{not-json" }));

        expect(projected).toEqual({
            eventName: "claude_code.tool_result",
            promptId: null,
            eventSequence: null,
            toolUseId: null,
            toolName: null,
            decision: null,
            decisionSource: null,
            success: null,
            mcpServerScope: null,
            pluginScope: null,
            preTokens: null,
            postTokens: null,
        });
    });

    test("projects api_request correlation while token and cost usage stay outside projection", () => {
        const usageRow = row({
            event_name: "claude_code.api_request",
            model: "claude-sonnet-4-6",
            input_tokens: 120,
            output_tokens: 45,
            cached_tokens: 3,
            duration_ms: 250,
            attrs: JSON.stringify({
                "event.name": "api_request",
                "prompt.id": "prompt-api",
                "event.sequence": 7,
                cost_usd: 0.014,
            }),
        });

        const projected = projectClaudeLogEvent(usageRow);

        expect(projected).toEqual({
            eventName: "claude_code.api_request",
            promptId: "prompt-api",
            eventSequence: 7,
            toolUseId: null,
            toolName: null,
            decision: null,
            decisionSource: null,
            success: null,
            mcpServerScope: null,
            pluginScope: null,
            preTokens: null,
            postTokens: null,
        });
        expect(usageRow.input_tokens).toBe(120);
        expect(usageRow.output_tokens).toBe(45);
        expect(usageRow.cached_tokens).toBe(3);
        expect(usageRow.duration_ms).toBe(250);
        expect(JSON.parse(usageRow.attrs!).cost_usd).toBe(0.014);
    });
});
