import { afterEach, describe, expect, it } from "bun:test";
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { Effect, Schema } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { cacheRow } from "@ax/lib/duckdb/row";
import { WATERMARK_TABLE } from "@ax/lib/duckdb/watermark";
import { metricPointRowId } from "../otel/rows.ts";
import {
    ingestOtelSpool,
    METRIC_KEY_CUTOVER_SENTINEL_PATH,
    METRIC_KEY_CUTOVER_VERSION,
    otelSpoolStage,
    stampReceivedAt,
    type OtelSpoolIngestResult,
} from "./otel-spool.ts";

const roots: string[] = [];
const { dylibPath, dtest, tempDir } = await duckdbTestSetup("OTLP spool ingest", {
    requireFts: true,
});

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
    dtest("only decodes appended payloads on the next ingest", async () => {
        const spoolDir = await mkdtemp(join(tmpdir(), "ax-otel-tail-"));
        roots.push(spoolDir);
        const path = join(spoolDir, "2026-08-14.jsonl");
        const line = JSON.stringify({ path: "/v1/metrics", body: JSON.stringify(metricPayload) }) + "\n";
        await writeFile(path, line);
        await runWithPlatform(publishCacheFixture(tempDir("ax-otel-tail-db-"), dylibPath, (write) =>
            Effect.gen(function* () {
                expect((yield* ingestOtelSpool(write, { spoolDir })).payloads).toBe(1);
                yield* Effect.promise(() => appendFile(path, line));
                expect((yield* ingestOtelSpool(write, { spoolDir })).payloads).toBe(1);
            }).pipe(Effect.provide(BunFileSystem.layer), Effect.provide(BunPath.layer)),
        ));
    });

    dtest("decodes a spool file and writes OTLP rows once", async () => {
        const spoolDir = await mkdtemp(join(tmpdir(), "ax-otel-spool-stage-"));
        roots.push(spoolDir);
        await mkdir(spoolDir, { recursive: true });
        const line = JSON.stringify({
            received_at: "2026-08-14T12:00:00.000Z",
            path: "/v1/metrics",
            body: JSON.stringify(metricPayload),
        });
        await writeFile(join(spoolDir, "2026-08-14.jsonl"), `${line}\n`);

        let first: OtelSpoolIngestResult | undefined;
        let second: OtelSpoolIngestResult | undefined;
        let rows: ReadonlyArray<{ readonly metric: string; readonly session_id: string | null }> = [];
        await runWithPlatform(publishCacheFixture(tempDir("ax-otel-spool-writer-"), dylibPath, (write) =>
            Effect.gen(function* () {
                first = yield* ingestOtelSpool(write, { spoolDir });
                second = yield* ingestOtelSpool(write, { spoolDir });
                rows = yield* write.rows(
                    Schema.Struct({ metric: Schema.String, session_id: Schema.NullOr(Schema.String) }),
                    "SELECT metric, session_id FROM otel_metric_point",
                );
            }).pipe(Effect.provide(BunFileSystem.layer), Effect.provide(BunPath.layer)),
        ));

        expect(first).toMatchObject({ files: 1, payloads: 1, rows: 1, malformed: 0 });
        expect(second).toMatchObject({ files: 0, skippedUnchanged: 1 });
        expect(rows).toEqual([{ metric: "claude_code.cost.usage", session_id: "session-1" }]);
    });

    dtest("retains partial UTF-8 records until the terminating newline arrives", async () => {
        const spoolDir = await mkdtemp(join(tmpdir(), "ax-otel-partial-"));
        roots.push(spoolDir);
        const path = join(spoolDir, "2026-08-14.jsonl");
        const payload = JSON.stringify(metricPayload).replace("session-1", "session-日本語");
        const bytes = Buffer.from(JSON.stringify({ path: "/v1/metrics", body: payload }) + "\n");
        const split = bytes.indexOf(Buffer.from("日")) + 1;
        await writeFile(path, bytes.subarray(0, split));
        await runWithPlatform(publishCacheFixture(tempDir("ax-otel-partial-db-"), dylibPath, (write) =>
            Effect.gen(function* () {
                expect(yield* ingestOtelSpool(write, { spoolDir })).toMatchObject({ payloads: 0, malformed: 0 });
                yield* Effect.promise(() => appendFile(path, bytes.subarray(split)));
                expect(yield* ingestOtelSpool(write, { spoolDir })).toMatchObject({ payloads: 1, malformed: 0 });
                const rows = yield* write.rows(Schema.Struct({ session_id: Schema.String }),
                    "SELECT session_id FROM otel_metric_point");
                expect(rows).toEqual([{ session_id: "session-日本語" }]);
            }).pipe(Effect.provide(BunFileSystem.layer), Effect.provide(BunPath.layer)),
        ));
    });

    dtest("replays truncated, rewritten and replaced files and honors forced replay", async () => {
        const spoolDir = await mkdtemp(join(tmpdir(), "ax-otel-rewrite-"));
        roots.push(spoolDir);
        const path = join(spoolDir, "2026-08-14.jsonl");
        const line = JSON.stringify({ path: "/v1/metrics", body: JSON.stringify(metricPayload) }) + "\n";
        await writeFile(path, line.repeat(2));
        const previousForce = process.env.AX_REDERIVE_OTEL_SPOOL;
        try {
            await runWithPlatform(publishCacheFixture(tempDir("ax-otel-rewrite-db-"), dylibPath, (write) =>
                Effect.gen(function* () {
                    expect((yield* ingestOtelSpool(write, { spoolDir })).payloads).toBe(2);
                    yield* Effect.promise(() => writeFile(path, line));
                    expect((yield* ingestOtelSpool(write, { spoolDir })).payloads).toBe(1);
                    // Same inode, larger rewrite, changed old boundary.
                    yield* Effect.promise(() => writeFile(path, line.replace("session-1", "session-2").repeat(2)));
                    expect((yield* ingestOtelSpool(write, { spoolDir })).payloads).toBe(2);
                    // Rename replacement guarantees a different inode.
                    yield* Effect.promise(async () => {
                        await writeFile(path + ".new", line.repeat(3));
                        await rename(path + ".new", path);
                    });
                    expect((yield* ingestOtelSpool(write, { spoolDir })).payloads).toBe(3);
                    process.env.AX_REDERIVE_OTEL_SPOOL = "1";
                    expect((yield* ingestOtelSpool(write, { spoolDir })).payloads).toBe(3);
                }).pipe(Effect.provide(BunFileSystem.layer), Effect.provide(BunPath.layer)),
            ));
        } finally {
            if (previousForce === undefined) delete process.env.AX_REDERIVE_OTEL_SPOOL;
            else process.env.AX_REDERIVE_OTEL_SPOOL = previousForce;
        }
    });

    dtest("does not advance the cursor after a failed payload write", async () => {
        const spoolDir = await mkdtemp(join(tmpdir(), "ax-otel-retry-"));
        roots.push(spoolDir);
        const path = join(spoolDir, "2026-08-14.jsonl");
        const line = JSON.stringify({ path: "/v1/metrics", body: JSON.stringify(metricPayload) }) + "\n";
        await writeFile(path, line);
        await runWithPlatform(publishCacheFixture(tempDir("ax-otel-retry-db-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* ingestOtelSpool(write, { spoolDir });
                yield* Effect.promise(() => appendFile(path, line.repeat(2)));
                let calls = 0;
                const failing: CacheWriteService = { ...write, putMany: (table, rows) => {
                    if (table === "otel_metric_point" && ++calls === 2) {
                        return write.exec("INSERT INTO missing_spool_test_table VALUES (1)").pipe(Effect.asVoid);
                    }
                    return write.putMany(table, rows);
                } };
                expect((yield* ingestOtelSpool(failing, { spoolDir })).failedFiles).toBe(1);
                expect((yield* ingestOtelSpool(write, { spoolDir })).payloads).toBe(2);
            }).pipe(Effect.provide(BunFileSystem.layer), Effect.provide(BunPath.layer)),
        ));
    });

    it("declares the ingest stage contract", () => {
        expect(otelSpoolStage.meta.key).toBe("otel-spool");
        expect(otelSpoolStage.meta.tags).toEqual(["ingest"]);
    });
});

describe("metric-point natural-key cutover (#1011)", () => {
    dtest("wipes stale-keyed rows/edges, replays under the new key, then marks itself done", async () => {
        const spoolDir = await mkdtemp(join(tmpdir(), "ax-otel-spool-cutover-"));
        roots.push(spoolDir);
        await mkdir(spoolDir, { recursive: true });
        const line = JSON.stringify({
            received_at: "2026-08-14T12:00:00.000Z",
            path: "/v1/metrics",
            body: JSON.stringify(metricPayload),
        });
        await writeFile(join(spoolDir, "2026-08-14.jsonl"), `${line}\n`);

        const staleId = "stale-pre-cutover-metric-id";

        let first: OtelSpoolIngestResult | undefined;
        let second: OtelSpoolIngestResult | undefined;
        let metricRows: ReadonlyArray<{ readonly id: string; readonly metric: string; readonly session_id: string | null }> = [];
        let telemetryEdgeRows: ReadonlyArray<{ readonly id: string }> = [];
        let sentinelRows: ReadonlyArray<{ readonly sha: string | null }> = [];

        await runWithPlatform(publishCacheFixture(tempDir("ax-otel-spool-cutover-writer-"), dylibPath, (write) =>
            Effect.gen(function* () {
                // Seed a PRE-cutover row (as if written under the old,
                // dimension-collapsing key) plus a telemetry_of edge that
                // targets it - both must be gone after the cutover.
                yield* write.put("otel_metric_point", cacheRow({
                    id: staleId,
                    harness: "claude",
                    metric: "claude_code.cost.usage",
                    value: 0.99,
                    unit: "USD",
                    session_id: "stale-session",
                    model: null,
                    skill_name: null,
                    agent_name: null,
                    attrs: null,
                    observed_at: new Date("2020-01-01T00:00:00Z"),
                }));
                yield* write.put("telemetry_of", cacheRow({
                    id: "stale-telemetry-edge",
                    in_id: "stale-session",
                    out_id: staleId,
                    out_table: "otel_metric_point",
                    linked_at: new Date("2020-01-01T00:00:00Z"),
                }));
                // Precondition: no version marker yet.
                const preSentinel = yield* write.rows(
                    Schema.Struct({ sha: Schema.NullOr(Schema.String) }),
                    `SELECT sha FROM ${WATERMARK_TABLE} WHERE path = ?`,
                    [METRIC_KEY_CUTOVER_SENTINEL_PATH],
                );
                expect(preSentinel).toEqual([]);

                first = yield* ingestOtelSpool(write, { spoolDir });
                second = yield* ingestOtelSpool(write, { spoolDir });

                metricRows = yield* write.rows(
                    Schema.Struct({ id: Schema.String, metric: Schema.String, session_id: Schema.NullOr(Schema.String) }),
                    "SELECT id, metric, session_id FROM otel_metric_point",
                );
                telemetryEdgeRows = yield* write.rows(
                    Schema.Struct({ id: Schema.String }),
                    "SELECT id FROM telemetry_of WHERE out_table = 'otel_metric_point'",
                );
                sentinelRows = yield* write.rows(
                    Schema.Struct({ sha: Schema.NullOr(Schema.String) }),
                    `SELECT sha FROM ${WATERMARK_TABLE} WHERE path = ?`,
                    [METRIC_KEY_CUTOVER_SENTINEL_PATH],
                );
            }).pipe(Effect.provide(BunFileSystem.layer), Effect.provide(BunPath.layer)),
        ));

        // The cutover fires on the FIRST call (sentinel absent): the stale
        // row/edge are gone, and the retained spool file replays under the
        // new key. The second call is an ordinary warm no-op - the cutover
        // does not re-fire (sentinel now present).
        expect(first).toMatchObject({ files: 1, payloads: 1, rows: 1, malformed: 0 });
        expect(second).toMatchObject({ files: 0, skippedUnchanged: 1 });

        expect(metricRows).toHaveLength(1);
        expect(metricRows[0]!.id).not.toBe(staleId);
        expect(metricRows[0]!.id).toBe(metricPointRowId({
            harness: "claude", metric: "claude_code.cost.usage", value: 0.12, unit: "USD",
            session_id: "session-1", model: null, skill_name: null, agent_name: null,
            attrs: '{"session.id":"session-1"}', observed_at: new Date("2024-06-15T00:00:00.000Z"),
        }));
        expect(metricRows[0]!.metric).toBe("claude_code.cost.usage");
        expect(metricRows[0]!.session_id).toBe("session-1");

        expect(telemetryEdgeRows).toEqual([]);
        expect(sentinelRows).toEqual([{ sha: METRIC_KEY_CUTOVER_VERSION }]);
    });
});

describe("stampReceivedAt (timeless-event epoch collision guard)", () => {
    const received = new Date("2026-08-14T12:00:00.000Z");

    it("stamps an epoch-dated (timeless) row with received_at", () => {
        const rows = [{ event_name: "e", observed_at: new Date(0) }];
        const out = stampReceivedAt(rows, received);
        expect(out[0]!.observed_at.toISOString()).toBe(received.toISOString());
    });

    it("leaves a row that already has a real event-time untouched", () => {
        const real = new Date("2026-06-15T00:00:00.000Z");
        const rows = [{ event_name: "e", observed_at: real }];
        const out = stampReceivedAt(rows, received);
        expect(out[0]!.observed_at).toBe(real);
    });

    it("two timeless events at the same received_at get the same fallback, but distinct-time events do not alias at the epoch", () => {
        const a = stampReceivedAt([{ observed_at: new Date(0) }], new Date("2026-08-14T12:00:00.000Z"));
        const b = stampReceivedAt([{ observed_at: new Date(0) }], new Date("2026-08-14T12:05:00.000Z"));
        // Different POSTs (different received_at) no longer collide at 1970.
        expect(a[0]!.observed_at.toISOString()).not.toBe(b[0]!.observed_at.toISOString());
    });

    it("is a no-op when received_at is null or invalid", () => {
        const rows = [{ observed_at: new Date(0) }];
        expect(stampReceivedAt(rows, null)[0]!.observed_at.getTime()).toBe(0);
        expect(stampReceivedAt(rows, new Date("nope"))[0]!.observed_at.getTime()).toBe(0);
    });
});
