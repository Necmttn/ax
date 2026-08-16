import { describe, expect, test } from "bun:test";
import {
    formatDoctorReport,
    otlpdDoctorCheck,
    staleRunningIngestRuns,
    type AgentRuntimeStatus,
    type DoctorReport,
} from "./install.ts";

describe("otlpdDoctorCheck (wave 3: the only LaunchAgent left)", () => {
    const agent = (over: Partial<AgentRuntimeStatus>): AgentRuntimeStatus => ({
        label: "com.necmttn.ax-otlpd",
        plist: "/tmp/otlpd.plist",
        plistExists: false,
        loaded: false,
        pid: null,
        ...over,
    });

    test("plist absent (never consented) is ok=true - not a failure", () => {
        const check = otlpdDoctorCheck(agent({ plistExists: false }));
        expect(check.ok).toBe(true);
        expect(check.name).toBe("otlpd");
        expect(check.detail).toContain("telemetry consent not granted");
    });

    test("plist present but not loaded (write-only / not yet started) is ok=true", () => {
        const check = otlpdDoctorCheck(agent({ plistExists: true, loaded: false }));
        expect(check.ok).toBe(true);
        expect(check.detail).toContain("plist present, not loaded");
    });

    test("loaded reports the pid", () => {
        const check = otlpdDoctorCheck(agent({ plistExists: true, loaded: true, pid: 4242 }));
        expect(check.ok).toBe(true);
        expect(check.detail).toBe("loaded pid=4242");
    });
});

describe("formatDoctorReport", () => {
    test("formats doctor checks for humans and json", () => {
        const report: DoctorReport = {
            platform: "darwin",
            checks: [
                { name: "binary", ok: true, detail: "/tmp/ax" },
                { name: "cache", ok: false, detail: "graph is stale" },
            ],
        };

        const text = formatDoctorReport(report);
        expect(text).toContain("ok   binary");
        expect(text).toContain("warn cache");
        expect(JSON.parse(formatDoctorReport(report, true)).checks[0]).toMatchObject({
            name: "binary",
            ok: true,
        });
    });
});

describe("doctor stale ingest_run detection (staleRunningIngestRuns)", () => {
    const NOW = Date.parse("2026-06-11T12:00:00.000Z");
    const STALE_AFTER_MS = 960_000; // 900s timeout + 60s grace

    const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

    test("flags a running row whose newest heartbeat is older than the threshold", () => {
        const rows = [
            { id: "dead", started_at: at(3_600_000) }, // 1h ago, no heartbeat
        ];
        expect(staleRunningIngestRuns(rows, NOW, STALE_AFTER_MS)).toEqual(rows);
    });

    test("a fresh heartbeat keeps an old run out of the stale set", () => {
        const rows = [
            {
                id: "live",
                started_at: at(3_600_000), // started long ago...
                last_progress_at: at(30_000), // ...but heartbeat 30s ago
            },
        ];
        expect(staleRunningIngestRuns(rows, NOW, STALE_AFTER_MS)).toEqual([]);
    });

    test("a recent start without heartbeat is not stale", () => {
        const rows = [{ id: "young", started_at: at(60_000) }];
        expect(staleRunningIngestRuns(rows, NOW, STALE_AFTER_MS)).toEqual([]);
    });

    test("rows with no parseable timestamp are flagged (cannot prove liveness)", () => {
        const rows = [{ id: "mystery" }];
        expect(staleRunningIngestRuns(rows, NOW, STALE_AFTER_MS)).toEqual(rows);
    });
});
