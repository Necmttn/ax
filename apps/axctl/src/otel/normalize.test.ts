import { describe, expect, test } from "bun:test";
import { normalizeLogs, normalizeMetrics, normalizeTrace } from "./normalize.ts";

const CC_METRICS = {
    resourceMetrics: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
        scopeMetrics: [{ metrics: [{
            name: "claude_code.cost.usage", unit: "USD",
            sum: { dataPoints: [{
                asDouble: 0.12, timeUnixNano: "1718409600000000000",
                attributes: [
                    { key: "session.id", value: { stringValue: "s1" } },
                    { key: "model", value: { stringValue: "opus" } },
                    { key: "skill.name", value: { stringValue: "tdd" } },
                ],
            }] },
        }] }],
    }],
};

const CODEX_TRACE = {
    resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex_cli_rs" } }] },
        scopeSpans: [{ spans: [{
            name: "session_loop", traceId: "aa", spanId: "bb",
            startTimeUnixNano: "1718409600000000000", endTimeUnixNano: "1718409601000000000",
            attributes: [{ key: "session.id", value: { stringValue: "cdx1" } }],
        }] }],
    }],
};

describe("normalize", () => {
    test("CC metrics → metric point rows with attrs lifted", () => {
        const rows = normalizeMetrics(CC_METRICS as never);
        expect(rows).toHaveLength(1);
        const r = rows[0]!;
        expect(r.harness).toBe("claude");
        expect(r.metric).toBe("claude_code.cost.usage");
        expect(r.value).toBe(0.12);
        expect(r.unit).toBe("USD");
        expect(r.session_id).toBe("s1");
        expect(r.model).toBe("opus");
        expect(r.skill_name).toBe("tdd");
    });

    test("Codex trace → span rows with duration", () => {
        const rows = normalizeTrace(CODEX_TRACE as never);
        expect(rows).toHaveLength(1);
        const r = rows[0]!;
        expect(r.harness).toBe("codex");
        expect(r.name).toBe("session_loop");
        expect(r.span_id).toBe("bb");
        expect(r.session_id).toBe("cdx1");
        expect(r.duration_ms).toBe(1000);
    });

    test("unknown service.name → harness 'unknown', still ingests", () => {
        const rows = normalizeMetrics({
            ...CC_METRICS,
            resourceMetrics: [{ ...CC_METRICS.resourceMetrics[0], resource: { attributes: [] } }],
        } as never);
        expect(rows[0]!.harness).toBe("unknown");
    });
});

import codexLogs from "./__fixtures__/codex-logs.json" with { type: "json" };

describe("normalizeLogs", () => {
    test("allowlist drops transport noise, keeps signal events", () => {
        const rows = normalizeLogs(codexLogs as never);
        const names = rows.map((r) => r.event_name);
        expect(names).not.toContain("codex.websocket_event");
        expect(names).toContain("codex.user_prompt");
        expect(names).toContain("codex.conversation_starts");
        expect(rows.every((r) => r.harness === "codex")).toBe(true);
    });

    test("sse_event row lifts token columns + session from conversation.id", () => {
        const rows = normalizeLogs(codexLogs as never);
        const sse = rows.find((r) => r.event_name === "codex.sse_event");
        expect(sse).toBeDefined();
        expect(sse!.input_tokens).toBe(9994);
        expect(sse!.model).toBe("gpt-5.5");
        expect(sse!.session_id).toBe("019ecba3-1618-7c63-8e2e-e2eaf13075f3");
    });

    test("non-allowlisted-only payload → 0 rows", () => {
        const noise = { resourceLogs: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "codex_exec" } }] },
            scopeLogs: [{ logRecords: [{ attributes: [{ key: "event.name", value: { stringValue: "codex.websocket_event" } }] }] }] }] };
        expect(normalizeLogs(noise as never)).toHaveLength(0);
    });

    test("Claude docs events are kept while non-allowlisted noise is dropped", () => {
        const claudeLogs = {
            resourceLogs: [{
                resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
                scopeLogs: [{ logRecords: [
                    { attributes: [
                        { key: "event.name", value: { stringValue: "claude_code.tool_result" } },
                        { key: "session.id", value: { stringValue: "claude-session-1" } },
                    ] },
                    { attributes: [
                        { key: "event.name", value: { stringValue: "claude_code.api_request" } },
                        { key: "session.id", value: { stringValue: "claude-session-1" } },
                        { key: "input_token_count", value: { stringValue: "120" } },
                        { key: "output_token_count", value: { intValue: "45" } },
                        { key: "reasoning_token_count", value: { stringValue: "7" } },
                        { key: "cached_token_count", value: { intValue: "3" } },
                        { key: "tool_token_count", value: { stringValue: "2" } },
                    ] },
                    { attributes: [
                        { key: "event.name", value: { stringValue: "claude_code.compaction" } },
                        { key: "session.id", value: { stringValue: "claude-session-1" } },
                    ] },
                    { attributes: [
                        { key: "event.name", value: { stringValue: "claude_code.debug_noise" } },
                        { key: "session.id", value: { stringValue: "claude-session-1" } },
                    ] },
                ] }],
            }],
        };

        const rows = normalizeLogs(claudeLogs as never);
        const names = rows.map((r) => r.event_name);

        expect(names).toEqual([
            "claude_code.tool_result",
            "claude_code.api_request",
            "claude_code.compaction",
        ]);
        expect(names).not.toContain("claude_code.debug_noise");
        expect(rows.every((r) => r.harness === "claude")).toBe(true);
        expect(rows.every((r) => r.session_id === "claude-session-1")).toBe(true);

        const apiRequest = rows.find((r) => r.event_name === "claude_code.api_request");
        expect(apiRequest).toBeDefined();
        expect(apiRequest!.input_tokens).toBe(120);
        expect(apiRequest!.output_tokens).toBe(45);
        expect(apiRequest!.reasoning_tokens).toBe(7);
        expect(apiRequest!.cached_tokens).toBe(3);
        expect(apiRequest!.tool_tokens).toBe(2);
    });

    test("Claude body event names are canonicalized and raw API body events stay excluded", () => {
        const claudeLogs = {
            resourceLogs: [{
                resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
                scopeLogs: [{ logRecords: [
                    { body: { stringValue: "claude_code.tool_result" }, attributes: [
                        { key: "event.name", value: { stringValue: "tool_result" } },
                        { key: "session.id", value: { stringValue: "claude-session-2" } },
                    ] },
                    { body: { stringValue: "claude_code.api_request" }, attributes: [
                        { key: "event.name", value: { stringValue: "api_request" } },
                        { key: "session.id", value: { stringValue: "claude-session-2" } },
                        { key: "input_token_count", value: { intValue: "11" } },
                        { key: "output_token_count", value: { intValue: "5" } },
                    ] },
                    { body: { stringValue: "claude_code.at_mention" }, attributes: [
                        { key: "event.name", value: { stringValue: "at_mention" } },
                        { key: "session.id", value: { stringValue: "claude-session-2" } },
                    ] },
                    { body: { stringValue: "claude_code.api_request_body" }, attributes: [
                        { key: "event.name", value: { stringValue: "api_request_body" } },
                        { key: "session.id", value: { stringValue: "claude-session-2" } },
                    ] },
                    { body: { stringValue: "claude_code.api_response_body" }, attributes: [
                        { key: "event.name", value: { stringValue: "api_response_body" } },
                        { key: "session.id", value: { stringValue: "claude-session-2" } },
                    ] },
                ] }],
            }],
        };

        const rows = normalizeLogs(claudeLogs as never);
        const names = rows.map((r) => r.event_name);

        expect(names).toEqual([
            "claude_code.tool_result",
            "claude_code.api_request",
        ]);
        expect(names).not.toContain("claude_code.at_mention");
        expect(names).not.toContain("claude_code.api_request_body");
        expect(names).not.toContain("claude_code.api_response_body");
        expect(rows.every((r) => r.session_id === "claude-session-2")).toBe(true);

        const apiRequest = rows.find((r) => r.event_name === "claude_code.api_request");
        expect(apiRequest!.input_tokens).toBe(11);
        expect(apiRequest!.output_tokens).toBe(5);
    });
});
