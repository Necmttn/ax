import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import {
    OTLP_ACK,
    OTLP_MAX_BODY_BYTES,
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

    it("rejects a present, non-loopback Host header with 403 (DNS-rebinding defense)", async () => {
        const now = new Date("2026-08-14T12:34:56.000Z");
        const { spoolDir, server } = await start(() => now);

        const response = await fetch(`${server.url}/v1/metrics`, {
            method: "POST",
            headers: { "content-type": "application/json", host: "attacker.com" },
            body: '{"resourceMetrics":[]}',
        });

        expect(response.status).toBe(403);
        // A rejected request must never reach the spool file.
        expect(await Bun.file(join(spoolDir, "2026-08-14.jsonl")).exists()).toBe(false);
    });

    it("rejects an oversized body (disk-exhaustion / ingest-OOM defense)", async () => {
        const now = new Date("2026-08-14T12:34:56.000Z");
        const { spoolDir, server } = await start(() => now);
        // One byte past the cap; Bun refuses it before fetch() runs.
        const huge = "x".repeat(OTLP_MAX_BODY_BYTES + 1);

        const response = await fetch(`${server.url}/v1/logs`, {
            method: "POST",
            body: huge,
        }).catch(() => ({ status: 413 }) as Response);

        expect(response.status).toBe(413);
        // Nothing oversized was spooled.
        expect(await Bun.file(join(spoolDir, "2026-08-14.jsonl")).exists()).toBe(false);
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

    it("forwards an accepted body to the configured collector AND still spools it (#1017)", async () => {
        const now = new Date("2026-08-14T09:00:00.000Z");
        const spoolDir = await mkdtemp(join(tmpdir(), "ax-otlpd-fwd-"));
        roots.push(spoolDir);
        const forwardConfigPath = join(spoolDir, "otel-forward.json");
        await writeFile(forwardConfigPath, JSON.stringify({
            enabled: true,
            created_at: now.toISOString(),
            targets: [{ signal: "logs", url: "https://collector.example/v1/logs", headers: { "dd-api-key": "k" } }],
        }));

        const relayed: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
        let resolveRelay: () => void = () => {};
        const relayDone = new Promise<void>((r) => { resolveRelay = r; });
        const relayFetch = (async (url: string, init: RequestInit) => {
            relayed.push({ url, body: String(init.body), headers: init.headers as Record<string, string> });
            resolveRelay();
            return new Response("ok", { status: 200 });
        }) as unknown as typeof fetch;

        const server = await Effect.runPromise(
            startOtlpSpoolServer({ spoolDir, port: 0, now: () => now, forwardConfigPath, relayFetch })
                .pipe(Effect.provide(platformLayer)),
        );
        servers.push(server);

        const response = await fetch(`${server.url}/v1/logs`, { method: "POST", body: '{"resourceLogs":[1]}' });
        expect(response.status).toBe(200); // the 2xx never waits on the relay

        await relayDone; // the fire-and-forget relay ran
        expect(relayed).toHaveLength(1);
        expect(relayed[0].url).toBe("https://collector.example/v1/logs");
        expect(relayed[0].body).toBe('{"resourceLogs":[1]}');
        expect(relayed[0].headers["dd-api-key"]).toBe("k");

        // The body still landed in the local spool - forwarding is ADDITIVE.
        const text = await readFile(join(spoolDir, "2026-08-14.jsonl"), "utf8");
        expect(JSON.parse(text.trim()).body).toBe('{"resourceLogs":[1]}');
    });

    it("does not forward when the config is absent or disabled", async () => {
        const now = new Date("2026-08-14T09:00:00.000Z");
        const spoolDir = await mkdtemp(join(tmpdir(), "ax-otlpd-nofwd-"));
        roots.push(spoolDir);
        let called = false;
        const relayFetch = (async () => { called = true; return new Response("ok"); }) as unknown as typeof fetch;
        const server = await Effect.runPromise(
            startOtlpSpoolServer({
                spoolDir, port: 0, now: () => now,
                forwardConfigPath: join(spoolDir, "absent.json"),
                relayFetch,
            }).pipe(Effect.provide(platformLayer)),
        );
        servers.push(server);
        await fetch(`${server.url}/v1/logs`, { method: "POST", body: '{"resourceLogs":[]}' });
        await new Promise((r) => setTimeout(r, 20));
        expect(called).toBe(false);
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
