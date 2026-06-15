import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { AnyValue, LogsPayload, MetricsPayload, TracePayload, attrValueToScalar } from "./otlp-schema.ts";

describe("otlp envelope schemas", () => {
    test("decodes an AnyValue stringValue", () => {
        const v = Schema.decodeUnknownSync(AnyValue)({ stringValue: "opus" });
        expect(attrValueToScalar(v)).toBe("opus");
    });

    test("decodes intValue as string and yields number", () => {
        const v = Schema.decodeUnknownSync(AnyValue)({ intValue: "42" });
        expect(attrValueToScalar(v)).toBe(42);
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
});
