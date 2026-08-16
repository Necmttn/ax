import { afterAll, describe, expect, test } from "bun:test";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleOtlp } from "./otel.ts";
import codexLogs from "../../otel/__fixtures__/codex-logs.json" with { type: "json" };

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

const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);
const spoolDir = mkdtempSync(join(tmpdir(), "ax-otlp-contract-"));
const now = new Date("2026-08-15T00:00:00.000Z");
afterAll(() => rmSync(spoolDir, { recursive: true, force: true }));
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runPromise(effect.pipe(Effect.provide(platform as never)) as Effect.Effect<A, E, never>);

describe("handleOtlp", () => {
    test("metrics body decodes and returns an ack without a database write", async () => {
        const ack = await run(handleOtlp("metrics", toBuf(ccMetrics), undefined, { spoolDir, now: () => now }));
        expect(ack).toEqual({ partialSuccess: {} });
        const line = readFileSync(join(spoolDir, "2026-08-15.jsonl"), "utf8");
        expect(JSON.parse(line)).toMatchObject({ path: "/v1/metrics", body: ccMetrics });
    });

    test("malformed JSON → ack, no write (fail-open)", async () => {
        const ack = await run(handleOtlp("metrics", toBuf("not json"), undefined, { spoolDir, now: () => now }));
        expect(ack).toEqual({ partialSuccess: {} });
    });

    test("logs signal → ack, no write", async () => {
        const ack = await run(handleOtlp("logs", toBuf("{}"), undefined, { spoolDir, now: () => now }));
        expect(ack).toEqual({ partialSuccess: {} });
    });
});

test("logs body decodes and returns an ack without a database write", async () => {
    const ack = await run(handleOtlp("logs", toBuf(JSON.stringify(codexLogs)), undefined, { spoolDir, now: () => now }));
    expect(ack).toEqual({ partialSuccess: {} });
});
