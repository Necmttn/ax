import { describe, expect, test } from "bun:test";
import { metricPointKey, metricPointRowId, spanKey, type OtelMetricPointRow } from "./rows.ts";
import { logEventKey, type OtelLogEventRow } from "./rows.ts";
import { canonicalAttrsJson } from "./otlp-schema.ts";

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

// ==================== #1011: attrs-dimension discrimination + hashed row id

describe("metricPointKey / metricPointRowId discriminate every dimension (#1011)", () => {
    const base: OtelMetricPointRow = {
        harness: "claude", metric: "claude_code.cost.usage", value: 0.12,
        unit: "USD", session_id: "s1", model: "opus", skill_name: null,
        agent_name: null, attrs: null, observed_at: new Date("2026-06-15T00:00:00Z"),
    };

    test("distinguishes points differing only in agent.name", () => {
        const a = { ...base, agent_name: "a" };
        const b = { ...base, agent_name: "b" };
        expect(metricPointKey(a)).not.toBe(metricPointKey(b));
        expect(metricPointRowId(a)).not.toBe(metricPointRowId(b));
    });

    test("distinguishes points differing only in `type` (carried in attrs)", () => {
        const a = { ...base, attrs: canonicalAttrsJson(new Map([["type", "input"]])) };
        const b = { ...base, attrs: canonicalAttrsJson(new Map([["type", "output"]])) };
        expect(metricPointKey(a)).not.toBe(metricPointKey(b));
        expect(metricPointRowId(a)).not.toBe(metricPointRowId(b));
    });

    test("distinguishes points differing only in query_source (carried in attrs)", () => {
        const a = { ...base, attrs: canonicalAttrsJson(new Map([["query_source", "sonnet"]])) };
        const b = { ...base, attrs: canonicalAttrsJson(new Map([["query_source", "haiku"]])) };
        expect(metricPointKey(a)).not.toBe(metricPointKey(b));
        expect(metricPointRowId(a)).not.toBe(metricPointRowId(b));
    });

    test("distinguishes points differing only in an MCP server name (carried in attrs)", () => {
        const a = { ...base, attrs: canonicalAttrsJson(new Map([["mcp.server.name", "linear"]])) };
        const b = { ...base, attrs: canonicalAttrsJson(new Map([["mcp.server.name", "figma"]])) };
        expect(metricPointKey(a)).not.toBe(metricPointKey(b));
        expect(metricPointRowId(a)).not.toBe(metricPointRowId(b));
    });

    test("attribute wire ORDER does not change the id - canonicalization sorts keys", () => {
        const wireOrderOne = new Map([["type", "input"], ["query_source", "sonnet"]]);
        const wireOrderTwo = new Map([["query_source", "sonnet"], ["type", "input"]]);
        const a = { ...base, attrs: canonicalAttrsJson(wireOrderOne) };
        const b = { ...base, attrs: canonicalAttrsJson(wireOrderTwo) };
        expect(a.attrs).toBe(b.attrs); // canonicalAttrsJson itself is order-independent
        expect(metricPointKey(a)).toBe(metricPointKey(b));
        expect(metricPointRowId(a)).toBe(metricPointRowId(b));
    });

    test("same identity, different value - still collapses to ONE id (last-write-win)", () => {
        const a = { ...base, value: 1 };
        const b = { ...base, value: 2 };
        expect(metricPointRowId(a)).toBe(metricPointRowId(b));
    });

    test("metricPointRowId is a hash, not the raw pipe-joined key verbatim", () => {
        const id = metricPointRowId(base);
        expect(id).not.toBe(metricPointKey(base));
        expect(id).toMatch(/^[0-9a-f]{32}$/);
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
