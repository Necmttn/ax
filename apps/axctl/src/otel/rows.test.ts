import { describe, expect, test } from "bun:test";
import { metricPointKey, spanKey, type OtelMetricPointRow } from "./rows.ts";

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
