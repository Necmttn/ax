import { describe, expect, test } from "bun:test";
import {
    formatDaemonStatus,
    formatDoctorReport,
    parseDaemonCommand,
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
            dataDir: "/tmp/agentctl",
            logDir: "/tmp/agentctl/logs",
            dbListening: true,
            agents: [
                {
                    label: "com.necmttn.agentctl-db",
                    plist: "/tmp/db.plist",
                    plistExists: true,
                    loaded: true,
                    pid: 123,
                },
            ],
        };

        expect(formatDaemonStatus(status)).toContain("database: listening");
        expect(formatDaemonStatus(status)).toContain("pid=123");
        expect(JSON.parse(formatDaemonStatus(status, true))).toMatchObject({
            platform: "darwin",
            dbListening: true,
        });
    });

    test("formats doctor checks", () => {
        const report: DoctorReport = {
            platform: "darwin",
            checks: [
                { name: "binary", ok: true, detail: "/tmp/agentctl" },
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
