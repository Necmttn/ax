import { describe, expect, test } from "bun:test";
import { metricPointKey, spanKey, type OtelMetricPointRow } from "./rows.ts";
import { logEventKey, type OtelLogEventRow } from "./rows.ts";

describe("otel record keys", () => {
    test("metricPointKey is deterministic for same point", () => {
        const row: OtelMetricPointRow = {
            harness: "claude", metric: "claude_code.cost.usage", value: 0.12,
            unit: "USD", session_id: "s1", model: "opus", skill_name: null,
            agent_name: null, attrs: null, observed_at: new Date("2026-06-15T00:00:00Z"),
        };
        expect(metricPointKey(row)).toBe(metricPointKey(row));
    });

    test("metricPointKey differs when metric or ts differs", () => {
        const base: OtelMetricPointRow = {
            harness: "claude", metric: "claude_code.cost.usage", value: 0.12,
            unit: "USD", session_id: "s1", model: null, skill_name: null,
            agent_name: null, attrs: null, observed_at: new Date("2026-06-15T00:00:00Z"),
        };
        expect(metricPointKey(base)).not.toBe(metricPointKey({ ...base, metric: "x" }));
    });

    test("spanKey is the span_id", () => {
        expect(spanKey({ span_id: "abc" })).toBe("abc");
    });
});

describe("otel log event keys", () => {
    const base: OtelLogEventRow = {
        harness: "codex", event_name: "codex.sse_event", session_id: "c1",
        model: "gpt-5.5", input_tokens: 9994, output_tokens: 0, reasoning_tokens: 0,
        cached_tokens: 0, tool_tokens: 9994, duration_ms: null, status_code: null,
        attrs: null, observed_at: new Date("2026-06-15T00:00:00Z"),
    };
    test("deterministic for same event+index", () => {
        expect(logEventKey(base, 0)).toBe(logEventKey(base, 0));
    });
    test("differs by index (distinct same-name events at same ts)", () => {
        expect(logEventKey(base, 0)).not.toBe(logEventKey(base, 1));
    });
    test("differs by event_name", () => {
        expect(logEventKey(base, 0)).not.toBe(logEventKey({ ...base, event_name: "x" }, 0));
    });
});
