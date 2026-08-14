import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { makeTestSurrealClient } from "@ax/lib/testing/surreal";
import { ingestOtelSpool, otelSpoolStage } from "./otel-spool.ts";

const roots: string[] = [];

afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const metricPayload = {
    resourceMetrics: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
        scopeMetrics: [{
            metrics: [{
                name: "claude_code.cost.usage",
                unit: "USD",
                sum: { dataPoints: [{
                    asDouble: 0.12,
                    timeUnixNano: "1718409600000000000",
                    attributes: [{ key: "session.id", value: { stringValue: "session-1" } }],
                }] },
            }],
        }],
    }],
};

describe("otel-spool ingest stage", () => {
    it("decodes a spool file and writes OTLP rows once", async () => {
        const spoolDir = await mkdtemp(join(tmpdir(), "ax-otel-spool-stage-"));
        roots.push(spoolDir);
        await mkdir(spoolDir, { recursive: true });
        const line = JSON.stringify({
            received_at: "2026-08-14T12:00:00.000Z",
            path: "/v1/metrics",
            body: JSON.stringify(metricPayload),
        });
        await writeFile(join(spoolDir, "2026-08-14.jsonl"), `${line}\n`);

        const watermarks = new Map<string, { path: string; mtime_ms: number; size: number }>();
        const tc = makeTestSurrealClient({
            fallback: (sql) => {
                if (sql.includes("FROM ingest_file_state")) return [[...watermarks.values()]];
                if (sql.includes("UPSERT ingest_file_state")) {
                    const path = /path: "([^"]+)"/.exec(sql)?.[1];
                    const mtimeMs = Number(/mtime_ms: (\d+)/.exec(sql)?.[1]);
                    const size = Number(/size: (\d+)/.exec(sql)?.[1]);
                    if (path) watermarks.set(path, { path, mtime_ms: mtimeMs, size });
                }
                return [[]];
            },
        });
        const layer = Layer.mergeAll(tc.layer, BunFileSystem.layer, BunPath.layer);

        const run = () => Effect.runPromise(
            ingestOtelSpool({ spoolDir }).pipe(Effect.provide(layer)),
        );
        const first = await run();
        const second = await run();

        expect(first).toMatchObject({ files: 1, payloads: 1, rows: 1, malformed: 0 });
        expect(second).toMatchObject({ files: 0, skippedUnchanged: 1 });
        const writes = tc.captured.filter((sql) => sql.includes("UPSERT otel_metric_point"));
        expect(writes).toHaveLength(1);
        expect(writes[0]).toContain('metric = "claude_code.cost.usage"');
        expect(writes[0]).toContain('session_id = "session-1"');
    });

    it("declares the ingest stage contract", () => {
        expect(otelSpoolStage.meta.key).toBe("otel-spool");
        expect(otelSpoolStage.meta.tags).toEqual(["ingest"]);
    });
});
