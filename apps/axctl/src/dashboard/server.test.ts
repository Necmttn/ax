import { describe, expect, test } from "bun:test";
import { dashboardApiKind, formatSseEvent, handleDashboardRequestWithCors, parseDashboardServeArgs, parseQueryRequest, recentIngestEventsSql } from "./server.ts";

function preflight(headers: Record<string, string>): Request {
    return new Request("http://127.0.0.1:1738/api/version", {
        method: "OPTIONS",
        headers: { "access-control-request-method": "GET", ...headers },
    });
}

describe("studio CORS / Private Network Access", () => {
    test("echoes Allow-Private-Network on a studio-origin preflight that requests it", async () => {
        const res = await handleDashboardRequestWithCors(preflight({
            origin: "https://ax.necmttn.com",
            "access-control-request-private-network": "true",
        }));
        expect(res.status).toBe(204);
        expect(res.headers.get("access-control-allow-origin")).toBe("https://ax.necmttn.com");
        expect(res.headers.get("access-control-allow-private-network")).toBe("true");
    });

    test("omits Allow-Private-Network when the preflight does not request it", async () => {
        const res = await handleDashboardRequestWithCors(preflight({
            origin: "https://ax.necmttn.com",
        }));
        expect(res.headers.get("access-control-allow-private-network")).toBeNull();
    });

    test("disallowed origin gets no CORS or PNA headers", async () => {
        const res = await handleDashboardRequestWithCors(preflight({
            origin: "https://evil.example",
            "access-control-request-private-network": "true",
        }));
        expect(res.headers.get("access-control-allow-origin")).toBeNull();
        expect(res.headers.get("access-control-allow-private-network")).toBeNull();
    });
});

describe("dashboard server", () => {
    test("parseDashboardServeArgs defaults to port 1738", () => {
        expect(parseDashboardServeArgs([]).port).toBe(1738);
    });

    test("parseDashboardServeArgs accepts explicit port", () => {
        expect(parseDashboardServeArgs(["--port=1800"]).port).toBe(1800);
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
