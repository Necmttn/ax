import { describe, expect, test } from "bun:test";
import type { OtelLogEventRow } from "../otel/rows.ts";
import { projectHarnessToolEvent } from "./harness-tool-events.ts";

const row = (overrides: Partial<OtelLogEventRow>): OtelLogEventRow => ({
    harness: "codex",
    event_name: "codex.tool_decision",
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
    observed_at: new Date("2026-06-17T00:00:00Z"),
    ...overrides,
});

describe("projectHarnessToolEvent", () => {
    test("projects Codex tool decisions", () => {
        const projected = projectHarnessToolEvent(
            row({
                attrs: JSON.stringify({
                    tool_name: "shell",
                    tool_call_id: "call-1",
                    decision: "approved",
                    source: "policy",
                }),
            }),
        );

        expect(projected).toMatchObject({
            sessionId: "session-1",
            harness: "codex",
            eventKind: "decision",
            toolName: "shell",
            toolUseId: "call-1",
            decision: "approved",
            decisionSource: "policy",
        });
    });

    test("projects Claude tool results", () => {
        const projected = projectHarnessToolEvent(
            row({
                harness: "claude",
                event_name: "claude_code.tool_result",
                attrs: JSON.stringify({
                    tool_name: "Bash",
                    tool_use_id: "toolu_1",
                    success: "false",
                    error_type: "permission_denied",
                    duration_ms: 45,
                }),
            }),
        );

        expect(projected).toMatchObject({
            sessionId: "session-1",
            harness: "claude",
            eventKind: "result",
            toolName: "Bash",
            toolUseId: "toolu_1",
            success: false,
            errorType: "permission_denied",
            durationMs: 45,
        });
    });

    test("uses empty attrs for malformed or non-object attr payloads", () => {
        expect(projectHarnessToolEvent(row({ attrs: null })).attrs).toEqual({});
        expect(projectHarnessToolEvent(row({ attrs: "{not-json" })).attrs).toEqual({});
        expect(projectHarnessToolEvent(row({ attrs: JSON.stringify(["not", "object"]) })).attrs).toEqual({});
        expect(projectHarnessToolEvent(row({ attrs: JSON.stringify("not-object") })).attrs).toEqual({});
    });

    test("prefers row duration over attr duration", () => {
        const projected = projectHarnessToolEvent(
            row({
                duration_ms: 12,
                attrs: JSON.stringify({ duration_ms: 45 }),
            }),
        );

        expect(projected.durationMs).toBe(12);
    });

    test("parses finite numeric duration strings only", () => {
        expect(projectHarnessToolEvent(row({ attrs: JSON.stringify({ duration_ms: "45" }) })).durationMs).toBe(45);
        expect(projectHarnessToolEvent(row({ attrs: JSON.stringify({ duration_ms: "   " }) })).durationMs).toBeNull();
        expect(projectHarnessToolEvent(row({ attrs: JSON.stringify({ duration_ms: "Infinity" }) })).durationMs).toBeNull();
    });

    test("classifies request, permission wait, and unknown event kinds", () => {
        expect(projectHarnessToolEvent(row({ event_name: "claude_code.api_request" })).eventKind).toBe("request");
        expect(projectHarnessToolEvent(row({ event_name: "claude_code.permission_mode_changed" })).eventKind).toBe("permission_wait");
        expect(projectHarnessToolEvent(row({ event_name: "codex.blocked_on_user" })).eventKind).toBe("permission_wait");
        expect(projectHarnessToolEvent(row({ event_name: "codex.user_prompt" })).eventKind).toBe("unknown");
    });

    test("parses boolean success values without stringifying other fields", () => {
        const projected = projectHarnessToolEvent(
            row({
                attrs: JSON.stringify({
                    tool_name: 123,
                    toolName: true,
                    success: true,
                    decision: false,
                    decision_source: 45,
                    error_type: "  ",
                }),
            }),
        );

        expect(projected).toMatchObject({
            toolName: null,
            success: true,
            decision: null,
            decisionSource: null,
            errorType: null,
        });
    });
});
