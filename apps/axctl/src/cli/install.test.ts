import { describe, expect, test } from "bun:test";
import {
    formatDaemonStatus,
    formatDoctorReport,
    parseDaemonCommand,
    staleRunningIngestRuns,
    type DaemonStatus,
    type DoctorReport,
} from "./install.ts";

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
            agents: [],
        };
        expect(formatDaemonStatus(status)).toContain("conflict: port 8521 held by pid=4242 (other-db)");
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
