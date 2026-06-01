import { describe, expect, test } from "bun:test";
import { buildTelemetryRowStatement } from "./telemetry-base.ts";

describe("buildTelemetryRowStatement", () => {
    test("emits an UPSERT with a record ref for the row id", () => {
        const stmt = buildTelemetryRowStatement("hook_fire", {
            id: "abc",
            ts: new Date("2026-01-01T00:00:00.000Z"),
            kind: "hook_fire",
            file_path: "/x",
            harness: "claude",
            ok: true,
            latency_ms: 5,
        });
        expect(stmt.startsWith("UPSERT hook_fire:`abc` CONTENT {")).toBe(true);
        expect(stmt.endsWith("};")).toBe(true);
        expect(stmt).toContain('harness: "claude"');
        expect(stmt).toContain("ok: true");
        expect(stmt).toContain("latency_ms: 5");
        expect(stmt).toContain('ts: d"2026-01-01T00:00:00.000Z"');
    });

    test("a session string field becomes a record ref, not a quoted string", () => {
        const stmt = buildTelemetryRowStatement("hook_fire", {
            id: "abc",
            ts: new Date("2026-01-01T00:00:00.000Z"),
            kind: "hook_fire",
            session: "session:s1",
            file_path: "/x",
            harness: "claude",
            ok: true,
            latency_ms: 5,
        });
        expect(stmt).toContain("session: session:`s1`");
    });

    test("omits id from the CONTENT body", () => {
        const stmt = buildTelemetryRowStatement("t", {
            id: "k", ts: new Date(0), kind: "k", file_path: "",
            harness: "unknown", ok: false, latency_ms: 0,
        });
        expect(stmt).not.toContain("id:");
    });
});
