import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { handleOtlp } from "./otel.ts";
import codexLogs from "../../otel/__fixtures__/codex-logs.json" with { type: "json" };

const captured: string[] = [];
const stubDb = Layer.succeed(SurrealClient, {
    query: <T>(sql: string) => { captured.push(sql); return Effect.succeed([[]] as unknown as T); },
} as never);

const ccMetrics = JSON.stringify({
    resourceMetrics: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
        scopeMetrics: [{ metrics: [{
            name: "claude_code.cost.usage", unit: "USD",
            sum: { dataPoints: [{ asDouble: 0.5, timeUnixNano: "1718409600000000000",
                attributes: [{ key: "session.id", value: { stringValue: "s1" } }] }] },
        }] }],
    }],
});

const toBuf = (s: string): ArrayBuffer => {
    const u8 = new TextEncoder().encode(s);
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
};

describe("handleOtlp", () => {
    test("metrics body → writer UPSERT, returns ack", async () => {
        captured.length = 0;
        const ack = await Effect.runPromise(
            handleOtlp("metrics", toBuf(ccMetrics), undefined).pipe(Effect.provide(stubDb)),
        );
        expect(captured.join("\n")).toContain("UPSERT otel_metric_point:");
        expect(ack).toEqual({ partialSuccess: {} });
    });

    test("malformed JSON → ack, no write (fail-open)", async () => {
        captured.length = 0;
        const ack = await Effect.runPromise(
            handleOtlp("metrics", toBuf("not json"), undefined).pipe(Effect.provide(stubDb)),
        );
        expect(captured).toHaveLength(0);
        expect(ack).toEqual({ partialSuccess: {} });
    });

    test("logs signal → ack, no write", async () => {
        captured.length = 0;
        const ack = await Effect.runPromise(
            handleOtlp("logs", toBuf("{}"), undefined).pipe(Effect.provide(stubDb)),
        );
        expect(captured).toHaveLength(0);
        expect(ack).toEqual({ partialSuccess: {} });
    });
});

test("logs body → writer UPSERT into otel_log_event, returns ack", async () => {
    captured.length = 0;
    const ack = await Effect.runPromise(
        handleOtlp("logs", toBuf(JSON.stringify(codexLogs)), undefined).pipe(Effect.provide(stubDb)),
    );
    expect(captured.join("\n")).toContain("UPSERT otel_log_event:");
    expect(ack).toEqual({ partialSuccess: {} });
});
