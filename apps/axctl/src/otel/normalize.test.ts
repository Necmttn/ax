import { describe, expect, test } from "bun:test";
import { normalizeMetrics, normalizeTrace } from "./normalize.ts";

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

import { normalizeLogs } from "./normalize.ts";
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
});
