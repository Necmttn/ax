import { describe, expect, test } from "bun:test";
import {
    formatSseComment,
    formatSseEvent,
    imageContentType,
    liveRoutes,
    recentIngestEventsSql,
} from "./live.ts";
import { matchRoute } from "../router.ts";

describe("imageContentType", () => {
    test("maps known image extensions (case-insensitive)", () => {
        expect(imageContentType("/a/x.png")).toBe("image/png");
        expect(imageContentType("/a/x.JPG")).toBe("image/jpeg");
        expect(imageContentType("/a/x.jpeg")).toBe("image/jpeg");
        expect(imageContentType("/a/x.webp")).toBe("image/webp");
        expect(imageContentType("/a/x.svg")).toBe("image/svg+xml");
        expect(imageContentType("/a/x.avif")).toBe("image/avif");
    });

    test("returns null for non-image / extensionless paths", () => {
        expect(imageContentType("/etc/passwd")).toBeNull();
        expect(imageContentType("/a/notes.txt")).toBeNull();
        expect(imageContentType("/a/script.sh")).toBeNull();
        expect(imageContentType("noext")).toBeNull();
    });
});

describe("dashboard live routes", () => {
    test("formatSseEvent emits valid SSE frame", () => {
        expect(formatSseEvent("message", { ok: true })).toBe('event: message\ndata: {"ok":true}\n\n');
    });

    test("formatSseComment emits an EventSource-ignored keep-alive line", () => {
        // A line starting with ':' is an SSE comment - EventSource never fires
        // a listener for it. This is the idle keep-alive that prevents the 60s
        // idleTimeout from reaping the socket mid-stream (issue #503).
        expect(formatSseComment("ping")).toBe(": ping\n\n");
        expect(formatSseComment("ping").startsWith(":")).toBe(true);
    });

    test("recentIngestEventsSql reads persisted ingest events", () => {
        const sql = recentIngestEventsSql("2026-05-10T00:00:00.000Z", 12);
        expect(sql).toContain("FROM ingest_event");
        expect(sql).toContain('WHERE ts > d"2026-05-10T00:00:00.000Z"');
        expect(sql).toContain("ORDER BY ts ASC");
        expect(sql).toContain("LIMIT 12");
    });

    test("POST /api/events matches the raw SSE route", () => {
        expect(matchRoute(liveRoutes, "POST", "/api/events").kind).toBe("matched");
    });

    test("POST /api/image falls through to legacy API not_found", async () => {
        const { handleDashboardRequest } = await import("../../server.ts");
        const res = await handleDashboardRequest(
            new Request("http://127.0.0.1:1738/api/image", { method: "POST" }),
        );
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ error: "not_found" });
    });

    test("GET /api/ingest falls through to legacy API not_found", async () => {
        const { handleDashboardRequest } = await import("../../server.ts");
        const res = await handleDashboardRequest(
            new Request("http://127.0.0.1:1738/api/ingest"),
        );
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ error: "not_found" });
    });

    test("POST /api/ingest without a booted server falls through to not_found", async () => {
        // The ingest trigger is contract-served; without a booted server
        // there is no contract handler, and the legacy table no longer has
        // an ingest row - the /api/* not_found quirk answers. A booted
        // server (the only real deployment) routes this to the contract,
        // which 503s when the sidecar is down (covered in contract tests).
        const { handleDashboardRequest } = await import("../../server.ts");
        const res = await handleDashboardRequest(
            new Request("http://127.0.0.1:1738/api/ingest", { method: "POST", body: "{}" }),
        );
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ error: "not_found" });
    });
});
