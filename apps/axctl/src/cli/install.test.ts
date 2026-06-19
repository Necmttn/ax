import { describe, expect, test } from "bun:test";
import {
    agentDoctorCheck,
    dbPortConflict,
    findDesktopApp,
    formatDaemonStatus,
    formatDoctorReport,
    parseDaemonCommand,
    resolveDaemonHostPort,
    staleRunningIngestRuns,
    watcherProfilePublishDoctorCheck,
    type DaemonStatus,
    type DoctorReport,
} from "./install.ts";

describe("dbPortConflict (IDE-model helper is not a foreign conflict, #568)", () => {
    const holder = { pid: 9473, command: "/Users/x/result/bin/surreal start --bind 127.0.0.1:8521" };
    test("no holder → no conflict", () => {
        expect(dbPortConflict(null, null, false)).toBeNull();
    });
    test("our own launchd ax-db pid → no conflict", () => {
        expect(dbPortConflict(holder, 9473, false)).toBeNull();
    });
    test("foreign holder (non-IDE) → conflict", () => {
        expect(dbPortConflict(holder, 123, false)).toEqual(holder);
    });
    test("IDE model + surreal holder → suppressed (app helper owns the port)", () => {
        expect(dbPortConflict(holder, null, true)).toBeNull();
    });
    test("IDE model + non-surreal holder → still a conflict", () => {
        const other = { pid: 4242, command: "other-db" };
        expect(dbPortConflict(other, null, true)).toEqual(other);
    });
});

describe("agentDoctorCheck (absent LaunchAgents are OK in IDE model, #568)", () => {
    const absent = { label: "com.necmttn.ax-watch", plist: "/tmp/w.plist", plistExists: false, loaded: false, pid: null };
    test("non-IDE macOS: absent agent → not ok", () => {
        const c = agentDoctorCheck(absent, false, true);
        expect(c.ok).toBe(false);
        expect(c.detail).toContain("not loaded");
    });
    test("IDE model: absent agent → ok, owned by app", () => {
        const c = agentDoctorCheck(absent, true, true);
        expect(c.ok).toBe(true);
        expect(c.detail).toContain("ax studio app");
    });
    test("loaded agent → ok in either model", () => {
        const loaded = { label: "com.necmttn.ax-db", plist: "/tmp/db.plist", plistExists: true, loaded: true, pid: 1 };
        expect(agentDoctorCheck(loaded, false, true).ok).toBe(true);
        expect(agentDoctorCheck(loaded, true, true).ok).toBe(true);
    });
});

describe("findDesktopApp (desktop owns the daemon → CLI skips LaunchAgents)", () => {
    const candidates = [
        "/Applications/ax studio.app",
        "/Users/someone/Applications/ax studio.app",
    ] as const;

    test("returns the first candidate path that exists", () => {
        const got = findDesktopApp(candidates, (p) => p === candidates[1]);
        expect(got).toBe(candidates[1]);
    });

    test("returns undefined when no candidate exists", () => {
        expect(findDesktopApp(candidates, () => false)).toBeUndefined();
    });
});

describe("resolveDaemonHostPort (doctor honors AX_DB_URL)", () => {
    const state = {
        version: 1 as const,
        db: { host: "127.0.0.1", port: 8521 },
        updatedAt: "2026-06-16T00:00:00.000Z",
    };

    test("falls back to runtime-state when AX_DB_URL is unset", () => {
        expect(resolveDaemonHostPort(state, undefined)).toEqual({
            host: "127.0.0.1",
            port: 8521,
            url: "ws://127.0.0.1:8521",
        });
    });

    test("honors an explicit AX_DB_URL host:port over runtime-state", () => {
        // Regression: doctor probed the runtime-state default (8521) while the
        // rest of the CLI connected via AX_DB_URL - so it checked the wrong
        // instance and reported another db's listener / stuck ingest_runs.
        expect(resolveDaemonHostPort(state, "ws://10.0.0.5:8531")).toEqual({
            host: "10.0.0.5",
            port: 8531,
            url: "ws://10.0.0.5:8531",
        });
    });

    test("ignores a malformed AX_DB_URL and keeps runtime-state", () => {
        expect(resolveDaemonHostPort(state, "not a url")).toEqual({
            host: "127.0.0.1",
            port: 8521,
            url: "ws://127.0.0.1:8521",
        });
    });
});

describe("cli install operations", () => {
    test("parses daemon subcommands", () => {
        expect(parseDaemonCommand([])).toEqual({ command: "status", json: false });
        expect(parseDaemonCommand(["status", "--json"])).toEqual({ command: "status", json: true });
        expect(parseDaemonCommand(["restart"])).toEqual({ command: "restart", json: false });
        expect(() => parseDaemonCommand(["reload"])).toThrow("unknown command");
    });

    test("formats daemon status for humans and json", () => {
        const status: DaemonStatus = {
            platform: "darwin",
            macosLaunchd: true,
            dataDir: "/tmp/ax",
            logDir: "/tmp/ax/logs",
            dbListening: true,
            endpoint: {
                host: "127.0.0.1",
                port: 8521,
                url: "ws://127.0.0.1:8521",
                listening: true,
                conflict: null,
                runtimeStatePath: "/tmp/ax/runtime.json",
            },
            ideModel: false,
            agents: [
                {
                    label: "com.necmttn.ax-db",
                    plist: "/tmp/db.plist",
                    plistExists: true,
                    loaded: true,
                    pid: 123,
                },
            ],
        };

        const text = formatDaemonStatus(status);
        expect(text).toContain("database: listening on 127.0.0.1:8521");
        expect(text).toContain("endpoint: ws://127.0.0.1:8521");
        expect(text).toContain("pid=123");
        expect(JSON.parse(formatDaemonStatus(status, true))).toMatchObject({
            platform: "darwin",
            dbListening: true,
            endpoint: { url: "ws://127.0.0.1:8521" },
        });
    });

    test("surfaces port conflict in daemon status output", () => {
        const status: DaemonStatus = {
            platform: "darwin",
            macosLaunchd: true,
            dataDir: "/tmp/ax",
            logDir: "/tmp/ax/logs",
            dbListening: true,
            endpoint: {
                host: "127.0.0.1",
                port: 8521,
                url: "ws://127.0.0.1:8521",
                listening: true,
                conflict: { pid: 4242, command: "other-db" },
                runtimeStatePath: "/tmp/ax/runtime.json",
            },
            ideModel: false,
            agents: [],
        };
        expect(formatDaemonStatus(status)).toContain("conflict: port 8521 held by pid=4242 (other-db)");
    });

    test("IDE model: daemon status notes app ownership, no conflict warning", () => {
        const status: DaemonStatus = {
            platform: "darwin",
            macosLaunchd: true,
            dataDir: "/tmp/ax",
            logDir: "/tmp/ax/logs",
            dbListening: true,
            endpoint: {
                host: "127.0.0.1",
                port: 8521,
                url: "ws://127.0.0.1:8521",
                listening: true,
                conflict: null, // suppressed in IDE model (app helper owns the port)
                runtimeStatePath: "/tmp/ax/runtime.json",
            },
            ideModel: true,
            agents: [
                { label: "com.necmttn.ax-db", plist: "/tmp/db.plist", plistExists: false, loaded: false, pid: null },
            ],
        };
        const text = formatDaemonStatus(status);
        expect(text).toContain("model: IDE");
        expect(text).not.toContain("conflict: port");
    });

    test("formats doctor checks", () => {
        const report: DoctorReport = {
            platform: "darwin",
            checks: [
                { name: "binary", ok: true, detail: "/tmp/ax" },
                { name: "db-listener", ok: false, detail: "127.0.0.1:8521 is not listening" },
            ],
        };

        const text = formatDoctorReport(report);
        expect(text).toContain("ok   binary");
        expect(text).toContain("warn db-listener");
        expect(JSON.parse(formatDoctorReport(report, true)).checks[0]).toMatchObject({
            name: "binary",
            ok: true,
        });
    });

    test("doctor flags watcher profile publish freshness drift", () => {
        const check = watcherProfilePublishDoctorCheck(
            "<string>/bin/ax profile publish --if-stale=6 >>watcher.log 2&gt;&amp;1 || true</string>",
        );

        expect(check).toEqual({
            name: "watcher-profile-publish",
            ok: false,
            detail: "profile publish uses --if-stale=6; expected --if-stale=2; run 'axctl install' to refresh the watcher plist",
        });
    });

    test("doctor accepts the current watcher profile publish freshness gate", () => {
        const check = watcherProfilePublishDoctorCheck(
            "<string>/bin/ax profile publish --if-stale=2 >>watcher.log 2&gt;&amp;1 || true</string>",
        );

        expect(check).toEqual({
            name: "watcher-profile-publish",
            ok: true,
            detail: "profile publish freshness gate: 2h",
        });
    });
});

describe("doctor stale ingest_run detection", () => {
    const NOW = Date.parse("2026-06-11T12:00:00.000Z");
    const STALE_AFTER_MS = 960_000; // 900s timeout + 60s grace

    const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

    test("flags a running row whose newest heartbeat is older than the threshold", () => {
        const rows = [
            { id: "ingest_run:dead", started_at: at(3_600_000) }, // 1h ago, no heartbeat
        ];
        expect(staleRunningIngestRuns(rows, NOW, STALE_AFTER_MS)).toEqual(rows);
    });

    test("a fresh heartbeat keeps an old run out of the stale set", () => {
        const rows = [
            {
                id: "ingest_run:live",
                started_at: at(3_600_000), // started long ago...
                last_progress_at: at(30_000), // ...but heartbeat 30s ago
            },
        ];
        expect(staleRunningIngestRuns(rows, NOW, STALE_AFTER_MS)).toEqual([]);
    });

    test("a recent start without heartbeat is not stale", () => {
        const rows = [{ id: "ingest_run:young", started_at: at(60_000) }];
        expect(staleRunningIngestRuns(rows, NOW, STALE_AFTER_MS)).toEqual([]);
    });

    test("rows with no parseable timestamp are flagged (cannot prove liveness)", () => {
        const rows = [{ id: "ingest_run:mystery" }];
        expect(staleRunningIngestRuns(rows, NOW, STALE_AFTER_MS)).toEqual(rows);
    });
});
