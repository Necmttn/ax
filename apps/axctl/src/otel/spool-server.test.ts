import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import {
    OTLP_ACK,
    startOtlpSpoolServer,
    type OtlpSpoolServer,
} from "./spool-server.ts";

const roots: string[] = [];
const servers: OtlpSpoolServer[] = [];
const platformLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

afterEach(async () => {
    for (const server of servers.splice(0)) await server.stop();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const start = async (now: () => Date) => {
    const dataDir = await mkdtemp(join(tmpdir(), "ax-otlpd-"));
    roots.push(dataDir);
    const server = await Effect.runPromise(
        startOtlpSpoolServer({ dataDir, port: 0, now }).pipe(Effect.provide(platformLayer)),
    );
    servers.push(server);
    return { dataDir, server };
};

describe("OTLP spool receiver", () => {
    it("returns the OTLP acknowledgement and appends the raw JSON body", async () => {
        const now = new Date("2026-08-14T12:34:56.000Z");
        const { dataDir, server } = await start(() => now);
        const raw = '{"resourceMetrics":[]}';

        const response = await fetch(`${server.url}/v1/metrics`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: raw,
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(OTLP_ACK);
        const text = await readFile(join(dataDir, "otlp", "spool", "2026-08-14.jsonl"), "utf8");
        expect(text.trim().split("\n").map((line) => JSON.parse(line))).toEqual([{
            received_at: now.toISOString(),
            path: "/v1/metrics",
            body: raw,
        }]);
    });

    it("returns 2xx and preserves a malformed body", async () => {
        const now = new Date("2026-08-14T12:34:56.000Z");
        const { dataDir, server } = await start(() => now);

        const response = await fetch(`${server.url}/v1/logs`, {
            method: "POST",
            body: "{broken",
        });

        expect(response.status).toBe(200);
        const line = await readFile(join(dataDir, "otlp", "spool", "2026-08-14.jsonl"), "utf8");
        expect(JSON.parse(line).body).toBe("{broken");
    });

    it("rotates by day and removes spool files older than 90 days", async () => {
        let now = new Date("2026-08-14T23:59:59.000Z");
        const { dataDir, server } = await start(() => now);
        const spoolDir = join(dataDir, "otlp", "spool");
        await writeFile(join(spoolDir, "2026-05-15.jsonl"), "old\n");
        await writeFile(join(spoolDir, "2026-05-17.jsonl"), "keep\n");

        await fetch(`${server.url}/v1/traces`, { method: "POST", body: "{}" });
        now = new Date("2026-08-15T00:00:01.000Z");
        await fetch(`${server.url}/v1/traces`, { method: "POST", body: "{}" });

        expect(await Bun.file(join(spoolDir, "2026-08-14.jsonl")).exists()).toBe(true);
        expect(await Bun.file(join(spoolDir, "2026-08-15.jsonl")).exists()).toBe(true);
        expect(await Bun.file(join(spoolDir, "2026-05-15.jsonl")).exists()).toBe(false);
        expect(await Bun.file(join(spoolDir, "2026-05-17.jsonl")).exists()).toBe(true);
    });

    it("removes expired spool files on startup", async () => {
        const dataDir = await mkdtemp(join(tmpdir(), "ax-otlpd-startup-"));
        roots.push(dataDir);
        const spoolDir = join(dataDir, "otlp", "spool");
        await Bun.write(join(spoolDir, "2026-05-15.jsonl"), "old\n", { createPath: true });

        const server = await Effect.runPromise(
            startOtlpSpoolServer({
                dataDir,
                port: 0,
                now: () => new Date("2026-08-15T12:00:00.000Z"),
            }).pipe(Effect.provide(platformLayer)),
        );
        servers.push(server);

        expect(await Bun.file(join(spoolDir, "2026-05-15.jsonl")).exists()).toBe(false);
    });
});
