import { describe, expect, test } from "bun:test";
import { dashboardApiKind, formatSseEvent, parseDashboardServeArgs, parseQueryRequest, recentIngestEventsSql, routeStaticAsset } from "./server.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";

describe("dashboard server", () => {
    test("parseDashboardServeArgs defaults to port 1738", () => {
        expect(parseDashboardServeArgs([]).port).toBe(1738);
    });

    test("parseDashboardServeArgs accepts explicit port", () => {
        expect(parseDashboardServeArgs(["--port=1800"]).port).toBe(1800);
    });

    test("routeStaticAsset serves index for root", () => {
        expect(routeStaticAsset(new URL("http://localhost/"))?.path.endsWith("index.html")).toBe(true);
    });

    test("dashboard static assets exist", () => {
        const dir = join(import.meta.dir, "static");
        expect(existsSync(join(dir, "index.html"))).toBe(true);
        expect(existsSync(join(dir, "app.js"))).toBe(true);
        expect(existsSync(join(dir, "styles.css"))).toBe(true);
    });

    test("parseQueryRequest rejects non-select mutations", async () => {
        await expect(parseQueryRequest(new Request("http://x/api/query", {
            method: "POST",
            body: JSON.stringify({ sql: "DELETE session;" }),
        }))).rejects.toThrow("Only SELECT, RETURN, and INFO queries are allowed");
    });

    test("formatSseEvent emits valid SSE frame", () => {
        expect(formatSseEvent("message", { ok: true })).toBe('event: message\ndata: {"ok":true}\n\n');
    });

    test("recentIngestEventsSql reads persisted ingest events", () => {
        const sql = recentIngestEventsSql("2026-05-10T00:00:00.000Z", 12);
        expect(sql).toContain("FROM ingest_event");
        expect(sql).toContain('WHERE ts > d"2026-05-10T00:00:00.000Z"');
        expect(sql).toContain("ORDER BY ts ASC");
        expect(sql).toContain("LIMIT 12");
    });

    test("dashboardApiKind recognizes self improve route", () => {
        expect(dashboardApiKind("/api/self-improve")).toBe("self-improve");
    });

    test("dashboardApiKind recognizes experiment-loop improve route", () => {
        expect(dashboardApiKind("/api/improve")).toBe("improve");
        expect(dashboardApiKind("/api/improve/extra")).toBe("unknown");
    });
});
