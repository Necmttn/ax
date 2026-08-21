import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { AnyValue, LogsPayload, MetricsPayload, TracePayload, attrValueToScalar, nanoToDate } from "./otlp-schema.ts";
import { normalizeLogs } from "./normalize.ts";

describe("otlp envelope schemas", () => {
    test("decodes an AnyValue stringValue", () => {
        const v = Schema.decodeUnknownSync(AnyValue)({ stringValue: "opus" });
        expect(attrValueToScalar(v)).toBe("opus");
    });

    test("decodes intValue as string and yields number", () => {
        const v = Schema.decodeUnknownSync(AnyValue)({ intValue: "42" });
        expect(attrValueToScalar(v)).toBe(42);
    });

    // The whole `otel_log_event` signal was silently zero because of this one
    // arm. proto3 JSON EMITS an int64 as a string, so every int64 field here was
    // typed string-only - but the mapping also requires a parser to ACCEPT a
    // number, and a live Claude Code 2.1.233 export sends bare numbers. Decode
    // failed, the fail-open receiver counted the body `malformed`, and metrics
    // from the same process landed fine, so nothing looked broken.
    test("decodes intValue sent as a JSON number, the form Claude Code actually emits", () => {
        const v = Schema.decodeUnknownSync(AnyValue)({ intValue: 83729 });
        expect(attrValueToScalar(v)).toBe(83729);
    });

    test("nanoToDate accepts both JSON forms, and never throws on a bad one", () => {
        const asString = nanoToDate("1718409600000000000");
        expect(nanoToDate(1718409600000000000).getTime()).toBe(asString.getTime());
        // BigInt() throws a SyntaxError on a non-integral number. This converter
        // sits on a fail-open receive path, so it must floor rather than throw.
        expect(nanoToDate(1718409600000000000.5).getTime()).toBe(asString.getTime());
        expect(nanoToDate(undefined).getTime()).toBe(0);
        expect(nanoToDate("not-a-number").getTime()).toBe(0);
    });

    test("a log record whose attribute intValue is a number decodes and normalizes", () => {
        const payload = {
            resourceLogs: [{
                resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
                scopeLogs: [{
                    logRecords: [{
                        timeUnixNano: "1718409600000000000",
                        observedTimeUnixNano: "1718409600000000000",
                        body: { stringValue: "tool_decision" },
                        attributes: [
                            { key: "session.id", value: { stringValue: "sess-1" } },
                            { key: "event.name", value: { stringValue: "tool_decision" } },
                            { key: "input_token_count", value: { intValue: 83729 } },
                        ],
                    }],
                }],
            }],
        };
        const decoded = Schema.decodeUnknownSync(LogsPayload)(payload);
        const rows = normalizeLogs(decoded);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.event_name).toBe("claude_code.tool_decision");
        expect(rows[0]!.input_tokens).toBe(83729);
    });

    test("decodes a minimal metrics payload", () => {
        const payload = {
            resourceMetrics: [{
                resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
                scopeMetrics: [{
                    metrics: [{
                        name: "claude_code.cost.usage", unit: "USD",
                        sum: { dataPoints: [{
                            asDouble: 0.12, timeUnixNano: "1718409600000000000",
                            attributes: [
                                { key: "session.id", value: { stringValue: "s1" } },
                                { key: "model", value: { stringValue: "opus" } },
                            ],
                        }] },
                    }],
                }],
            }],
        };
        const decoded = Schema.decodeUnknownSync(MetricsPayload)(payload);
        expect(decoded.resourceMetrics[0]?.scopeMetrics[0]?.metrics[0]?.name).toBe("claude_code.cost.usage");
    });

    test("decodes a minimal trace payload", () => {
        const payload = {
            resourceSpans: [{
                resource: { attributes: [{ key: "service.name", value: { stringValue: "codex_cli_rs" } }] },
                scopeSpans: [{
                    spans: [{
                        name: "session_loop", traceId: "aa", spanId: "bb",
                        startTimeUnixNano: "1718409600000000000", endTimeUnixNano: "1718409601000000000",
                        attributes: [],
                    }],
                }],
            }],
        };
        const decoded = Schema.decodeUnknownSync(TracePayload)(payload);
        expect(decoded.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.name).toBe("session_loop");
    });

    test("decodes a minimal logs payload", () => {
        const payload = {
            resourceLogs: [{
                resource: { attributes: [{ key: "service.name", value: { stringValue: "codex_exec" } }] },
                scopeLogs: [{ logRecords: [{
                    observedTimeUnixNano: "1718409600000000000",
                    attributes: [{ key: "event.name", value: { stringValue: "codex.user_prompt" } }],
                }] }],
            }],
        };
        const d = Schema.decodeUnknownSync(LogsPayload)(payload);
        expect(d.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.attributes?.[0]?.key).toBe("event.name");
    });

    test("defaults omitted repeated log fields without dropping sibling records", () => {
        const empty = Schema.decodeUnknownSync(LogsPayload)({});
        const payload = {
            resourceLogs: [
                {},
                {
                    resource: {},
                    scopeLogs: [
                        {},
                        { logRecords: [{ observedTimeUnixNano: "1718409600000000000" }] },
                    ],
                },
            ],
        };
        const decoded = Schema.decodeUnknownSync(LogsPayload)(payload);

        expect(empty.resourceLogs).toEqual([]);
        expect(decoded.resourceLogs[0]?.scopeLogs).toEqual([]);
        expect(decoded.resourceLogs[1]?.resource?.attributes).toEqual([]);
        expect(decoded.resourceLogs[1]?.scopeLogs[0]?.logRecords).toEqual([]);
        expect(decoded.resourceLogs[1]?.scopeLogs[1]?.logRecords[0]?.attributes).toEqual([]);
    });
});
