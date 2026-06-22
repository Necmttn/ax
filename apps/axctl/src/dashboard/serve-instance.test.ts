import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    isPidAlive,
    probeServePort,
    readServePidfile,
    removeServePidfile,
    resolveStudioTarget,
    servePidfilePath,
    writeServePidfile,
} from "./serve-instance.ts";
import { DEFAULT_DASHBOARD_PORT } from "@ax/lib/dashboard-port";

const tmp = mkdtempSync(join(tmpdir(), "ax-serve-instance-"));
const pidfile = join(tmp, "serve.json");

describe("serve pidfile", () => {
    test("roundtrips through write/read", async () => {
        const state = { pid: 4242, port: 1738, startedAt: "2026-06-12T00:00:00.000Z", axVersion: "0.25.0" };
        await writeServePidfile(state, pidfile);
        expect(await readServePidfile(pidfile)).toEqual({ version: 1, ...state });
    });

    test("remove deletes the file and is idempotent", async () => {
        await removeServePidfile(pidfile);
        await removeServePidfile(pidfile);
        expect(await readServePidfile(pidfile)).toBeNull();
    });

    test("missing file reads as null", async () => {
        expect(await readServePidfile(join(tmp, "nope.json"))).toBeNull();
    });

    test("garbage reads as null", async () => {
        const garbage = join(tmp, "garbage.json");
        await Bun.write(garbage, "{not json");
        expect(await readServePidfile(garbage)).toBeNull();
        await Bun.write(garbage, JSON.stringify({ pid: "not-a-number", port: 1738 }));
        expect(await readServePidfile(garbage)).toBeNull();
    });

    test("default path lives under the ax data dir", () => {
        expect(servePidfilePath("/data/ax")).toBe("/data/ax/serve.json");
    });
});

describe("isPidAlive", () => {
    test("true for this process", () => {
        expect(isPidAlive(process.pid)).toBe(true);
    });

    test("false for an exited process", async () => {
        const proc = Bun.spawn(["true"]);
        await proc.exited;
        expect(isPidAlive(proc.pid)).toBe(false);
    });
});

/** Bun types `server.port` as optional (unix sockets); these are always TCP. */
const portOf = (server: { port?: number | undefined }): number => {
    if (server.port === undefined) throw new Error("expected a TCP port");
    return server.port;
};

describe("probeServePort", () => {
    test("identifies an ax daemon by /api/version shape", async () => {
        const server = Bun.serve({
            port: 0,
            fetch: () =>
                Response.json({ version: "0.25.0", api_version: 3, live_ingest: true }),
        });
        try {
            expect(await probeServePort(portOf(server))).toEqual({
                kind: "ax",
                version: "0.25.0",
                liveIngest: true,
            });
        } finally {
            await server.stop(true);
        }
    });

    test("classifies a non-ax HTTP listener as foreign", async () => {
        const server = Bun.serve({ port: 0, fetch: () => new Response("hello") });
        try {
            expect(await probeServePort(portOf(server))).toEqual({ kind: "foreign" });
        } finally {
            await server.stop(true);
        }
    });

    test("classifies an erroring HTTP listener as foreign", async () => {
        const server = Bun.serve({
            port: 0,
            fetch: () => new Response("nope", { status: 500 }),
        });
        try {
            expect(await probeServePort(portOf(server))).toEqual({ kind: "foreign" });
        } finally {
            await server.stop(true);
        }
    });

    test("classifies a closed port as none", async () => {
        const server = Bun.serve({ port: 0, fetch: () => new Response("x") });
        const port = portOf(server);
        await server.stop(true);
        expect(await probeServePort(port)).toEqual({ kind: "none" });
    });
});

describe("resolveStudioTarget", () => {
    test("no pidfile → default port, not live", async () => {
        const target = await resolveStudioTarget(join(tmp, "absent.json"));
        expect(target).toEqual({
            baseUrl: `http://localhost:${DEFAULT_DASHBOARD_PORT}`,
            port: DEFAULT_DASHBOARD_PORT,
            live: false,
        });
    });

    test("pidfile with a live pid → recorded port, live", async () => {
        const path = join(tmp, "studio-live.json");
        // process.pid is guaranteed alive (it's us) - exercises the live branch.
        await writeServePidfile(
            { pid: process.pid, port: 4321, startedAt: "2026-06-22T00:00:00.000Z", axVersion: "0.34.2" },
            path,
        );
        expect(await resolveStudioTarget(path)).toEqual({
            baseUrl: "http://localhost:4321",
            port: 4321,
            live: true,
        });
    });

    test("pidfile with a dead pid → default port, not live", async () => {
        const path = join(tmp, "studio-dead.json");
        // pid 1 is init; signal-0 to it from a normal user throws EPERM (=alive),
        // so use an implausibly high pid that is almost certainly not running.
        await writeServePidfile(
            { pid: 2_000_000_000, port: 4321, startedAt: "2026-06-22T00:00:00.000Z", axVersion: "0.34.2" },
            path,
        );
        const target = await resolveStudioTarget(path);
        expect(target.live).toBe(false);
        expect(target.port).toBe(DEFAULT_DASHBOARD_PORT);
    });
});

afterAll(async () => {
    await Bun.$`rm -rf ${tmp}`.quiet().nothrow();
});
