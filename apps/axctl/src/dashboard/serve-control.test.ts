import { describe, expect, test } from "bun:test";
import { serveStatus, serveStop, type ServeControlDeps } from "./serve-control.ts";
import type { ServePidfile, ServeProbe } from "./serve-instance.ts";

interface FakeWorld {
    readonly deps: ServeControlDeps;
    readonly logs: string[];
    readonly errors: string[];
    readonly killed: Array<{ pid: number; signal: NodeJS.Signals }>;
    pidfileRemoved: boolean;
}

function fakeWorld(opts: {
    pidfile?: ServePidfile | null;
    probe?: ServeProbe;
    alivePids?: ReadonlySet<number>;
    listenerPid?: number | null;
    killEndsPid?: boolean;
}): FakeWorld {
    const alive = new Set(opts.alivePids ?? []);
    const world: FakeWorld = {
        logs: [],
        errors: [],
        killed: [],
        pidfileRemoved: false,
        deps: {
            readPidfile: async () => opts.pidfile ?? null,
            removePidfile: async () => {
                world.pidfileRemoved = true;
            },
            probe: async () => opts.probe ?? { kind: "none" },
            pidAlive: (pid) => alive.has(pid),
            listenerPid: async () => opts.listenerPid ?? null,
            kill: (pid, signal) => {
                world.killed.push({ pid, signal });
                if (opts.killEndsPid !== false) alive.delete(pid);
            },
            sleep: async () => undefined,
            log: (line) => world.logs.push(line),
            error: (line) => world.errors.push(line),
        },
    };
    return world;
}

const pidfile = (pid: number, port = 1738): ServePidfile => ({
    version: 1,
    pid,
    port,
    startedAt: "2026-06-12T00:00:00.000Z",
    axVersion: "0.25.0",
});

const axProbe: ServeProbe = { kind: "ax", version: "0.25.0", liveIngest: true };

describe("serveStatus", () => {
    test("running with a live pidfile reports pid + urls, exits 0", async () => {
        const w = fakeWorld({ pidfile: pidfile(4242), probe: axProbe, alivePids: new Set([4242]) });
        expect(await serveStatus(w.deps)).toBe(0);
        expect(w.logs.join("\n")).toContain("pid 4242");
        expect(w.logs.join("\n")).toContain("http://localhost:1738");
    });

    test("running without a pidfile falls back to the port listener", async () => {
        const w = fakeWorld({ probe: axProbe, listenerPid: 94545 });
        expect(await serveStatus(w.deps)).toBe(0);
        expect(w.logs.join("\n")).toContain("pid 94545");
    });

    test("foreign listener exits 1 with the lsof hint", async () => {
        const w = fakeWorld({ probe: { kind: "foreign" } });
        expect(await serveStatus(w.deps)).toBe(1);
        expect(w.errors.join("\n")).toContain("lsof");
    });

    test("dead pidfile is cleaned up and reported as not running", async () => {
        const w = fakeWorld({ pidfile: pidfile(99), probe: { kind: "none" } });
        expect(await serveStatus(w.deps)).toBe(1);
        expect(w.pidfileRemoved).toBe(true);
        expect(w.logs.join("\n")).toContain("not running");
    });

    test("alive-but-unresponsive pid is reported as wedged", async () => {
        const w = fakeWorld({ pidfile: pidfile(99), probe: { kind: "none" }, alivePids: new Set([99]) });
        expect(await serveStatus(w.deps)).toBe(1);
        expect(w.errors.join("\n")).toContain("wedged");
    });

    test("nothing running exits 1", async () => {
        const w = fakeWorld({});
        expect(await serveStatus(w.deps)).toBe(1);
        expect(w.logs.join("\n")).toContain("not running");
    });
});

describe("serveStop", () => {
    test("SIGTERMs the port listener and removes the pidfile", async () => {
        const w = fakeWorld({
            pidfile: pidfile(4242),
            probe: axProbe,
            alivePids: new Set([4242]),
            listenerPid: 4242,
        });
        expect(await serveStop(w.deps)).toBe(0);
        expect(w.killed).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
        expect(w.pidfileRemoved).toBe(true);
    });

    test("kills the listener pid, not a recycled pidfile pid", async () => {
        const w = fakeWorld({
            pidfile: pidfile(4242),
            probe: axProbe,
            alivePids: new Set([4242, 94545]),
            listenerPid: 94545,
        });
        expect(await serveStop(w.deps)).toBe(0);
        expect(w.killed).toEqual([{ pid: 94545, signal: "SIGTERM" }]);
    });

    test("refuses to kill a foreign listener", async () => {
        const w = fakeWorld({ probe: { kind: "foreign" }, listenerPid: 77 });
        expect(await serveStop(w.deps)).toBe(1);
        expect(w.killed).toEqual([]);
    });

    test("unresolvable pid refuses with the lsof hint", async () => {
        const w = fakeWorld({ probe: axProbe, listenerPid: null });
        expect(await serveStop(w.deps)).toBe(1);
        expect(w.killed).toEqual([]);
        expect(w.errors.join("\n")).toContain("lsof");
    });

    test("survivor after SIGTERM exits 1 with the kill -9 hint", async () => {
        const w = fakeWorld({
            probe: axProbe,
            alivePids: new Set([55]),
            listenerPid: 55,
            killEndsPid: false,
        });
        expect(await serveStop(w.deps)).toBe(1);
        expect(w.errors.join("\n")).toContain("kill -9 55");
    });

    test("nothing running is a clean no-op", async () => {
        const w = fakeWorld({});
        expect(await serveStop(w.deps)).toBe(0);
        expect(w.logs.join("\n")).toContain("not running");
    });

    test("stale pidfile with nothing listening is cleaned up", async () => {
        const w = fakeWorld({ pidfile: pidfile(99), probe: { kind: "none" } });
        expect(await serveStop(w.deps)).toBe(0);
        expect(w.pidfileRemoved).toBe(true);
    });
});
