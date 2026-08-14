import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import {
    OTLP_ACK,
    defaultOtlpSpoolDir,
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
    const spoolDir = await mkdtemp(join(tmpdir(), "ax-otlpd-"));
    roots.push(spoolDir);
    const server = await Effect.runPromise(
        startOtlpSpoolServer({ spoolDir, port: 0, now }).pipe(Effect.provide(platformLayer)),
    );
    servers.push(server);
    return { spoolDir, server };
};

describe("OTLP spool receiver", () => {
    it("returns the OTLP acknowledgement and appends the raw JSON body", async () => {
        const now = new Date("2026-08-14T12:34:56.000Z");
        const { spoolDir, server } = await start(() => now);
        const raw = '{"resourceMetrics":[]}';

        const response = await fetch(`${server.url}/v1/metrics`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: raw,
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(OTLP_ACK);
        const text = await readFile(join(spoolDir, "2026-08-14.jsonl"), "utf8");
        expect(text.trim().split("\n").map((line) => JSON.parse(line))).toEqual([{
            received_at: now.toISOString(),
            path: "/v1/metrics",
            body: raw,
        }]);
    });

    it("returns 2xx and preserves a malformed body", async () => {
        const now = new Date("2026-08-14T12:34:56.000Z");
        const { spoolDir, server } = await start(() => now);

        const response = await fetch(`${server.url}/v1/logs`, {
            method: "POST",
            body: "{broken",
        });

        expect(response.status).toBe(200);
        const line = await readFile(join(spoolDir, "2026-08-14.jsonl"), "utf8");
        expect(JSON.parse(line).body).toBe("{broken");
    });

    it("rotates by day and removes spool files older than 90 days", async () => {
        let now = new Date("2026-08-14T23:59:59.000Z");
        const { spoolDir, server } = await start(() => now);
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
        const spoolDir = await mkdtemp(join(tmpdir(), "ax-otlpd-startup-"));
        roots.push(spoolDir);
        await Bun.write(join(spoolDir, "2026-05-15.jsonl"), "old\n", { createPath: true });

        const server = await Effect.runPromise(
            startOtlpSpoolServer({
                spoolDir,
                port: 0,
                now: () => new Date("2026-08-15T12:00:00.000Z"),
            }).pipe(Effect.provide(platformLayer)),
        );
        servers.push(server);

        expect(await Bun.file(join(spoolDir, "2026-05-15.jsonl")).exists()).toBe(false);
    });

    it("recovers from a crash that left a torn (no trailing newline) line", async () => {
        const now = new Date("2026-08-14T12:00:00.000Z");
        const spoolDir = await mkdtemp(join(tmpdir(), "ax-otlpd-torn-"));
        roots.push(spoolDir);
        const dayFile = join(spoolDir, "2026-08-14.jsonl");
        // Simulates a process kill mid-append: the final line was flushed
        // partially and never got its trailing "\n".
        const torn = '{"received_at":"2026-08-14T11:00:00.000Z","path":"/v1/logs","bod';
        await Bun.write(dayFile, torn, { createPath: true });

        const server = await Effect.runPromise(
            startOtlpSpoolServer({ spoolDir, port: 0, now: () => now }).pipe(
                Effect.provide(platformLayer),
            ),
        );
        servers.push(server);

        const response = await fetch(`${server.url}/v1/logs`, {
            method: "POST",
            body: '{"resourceLogs":[]}',
        });
        expect(response.status).toBe(200);

        const text = await readFile(dayFile, "utf8");
        const lines = text.split("\n").filter((line) => line.length > 0);
        expect(lines).toHaveLength(2);
        // The torn line stays malformed (it was never fixed up) ...
        expect(() => JSON.parse(lines[0]!)).toThrow();
        // ... but the new record decodes on its own line.
        const record = JSON.parse(lines[1]!) as { body: string };
        expect(record.body).toBe('{"resourceLogs":[]}');
    });

    it("does not touch an already-clean file's trailing newline", async () => {
        const now = new Date("2026-08-14T12:00:00.000Z");
        const spoolDir = await mkdtemp(join(tmpdir(), "ax-otlpd-clean-"));
        roots.push(spoolDir);
        const dayFile = join(spoolDir, "2026-08-14.jsonl");
        const clean = '{"received_at":"2026-08-14T11:00:00.000Z","path":"/v1/logs","body":"{}"}\n';
        await Bun.write(dayFile, clean, { createPath: true });

        const server = await Effect.runPromise(
            startOtlpSpoolServer({ spoolDir, port: 0, now: () => now }).pipe(
                Effect.provide(platformLayer),
            ),
        );
        servers.push(server);

        await fetch(`${server.url}/v1/logs`, { method: "POST", body: '{"resourceLogs":[]}' });

        const text = await readFile(dayFile, "utf8");
        const lines = text.split("\n").filter((line) => line.length > 0);
        expect(lines).toHaveLength(2);
        expect(() => JSON.parse(lines[0]!)).not.toThrow();
        expect(() => JSON.parse(lines[1]!)).not.toThrow();
    });
});

describe("defaultOtlpSpoolDir (decoupled from AX_DATA_DIR)", () => {
    const prevSpoolDir = process.env.AX_OTLP_SPOOL_DIR;
    const prevDataDir = process.env.AX_DATA_DIR;

    afterEach(() => {
        if (prevSpoolDir === undefined) delete process.env.AX_OTLP_SPOOL_DIR;
        else process.env.AX_OTLP_SPOOL_DIR = prevSpoolDir;
        if (prevDataDir === undefined) delete process.env.AX_DATA_DIR;
        else process.env.AX_DATA_DIR = prevDataDir;
    });

    it("defaults to ~/.ax/otlp/spool, ignoring AX_DATA_DIR entirely", () => {
        delete process.env.AX_OTLP_SPOOL_DIR;
        process.env.AX_DATA_DIR = "/some/other/data/dir";

        expect(defaultOtlpSpoolDir()).toBe(`${homedir()}/.ax/otlp/spool`);
    });

    it("honors an explicit AX_OTLP_SPOOL_DIR override", () => {
        process.env.AX_OTLP_SPOOL_DIR = "/custom/spool/dir";
        process.env.AX_DATA_DIR = "/some/other/data/dir";

        expect(defaultOtlpSpoolDir()).toBe("/custom/spool/dir");
    });
});
