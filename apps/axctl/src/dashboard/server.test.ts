import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    handleDashboardRequest,
    handleDashboardRequestWithCors,
    parseDashboardServeArgs,
} from "./server.ts";
import { dashboardApiCapabilities, isGraphExplorerEnabled } from "./capabilities.ts";

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

describe("GET /api/image", () => {
    const req = (path: string | null): Request => {
        const qs = path === null ? "" : `?path=${encodeURIComponent(path)}`;
        return new Request(`http://127.0.0.1:1738/api/image${qs}`);
    };

    test("serves an existing image file with the right content-type", async () => {
        const file = join(tmpdir(), `ax-img-test-${Date.now()}.png`);
        // 1x1 transparent PNG
        const png = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
            "base64",
        );
        await Bun.write(file, png);
        const res = await handleDashboardRequest(req(file));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/png");
        expect((await res.arrayBuffer()).byteLength).toBe(png.byteLength);
    });

    test("404 when the path is missing", () => {
        return handleDashboardRequest(req("/nope/does-not-exist.png")).then((res) => {
            expect(res.status).toBe(404);
        });
    });

    test("404 for a non-image extension even if it exists", async () => {
        const file = join(tmpdir(), `ax-img-test-${Date.now()}.txt`);
        await Bun.write(file, "secret");
        const res = await handleDashboardRequest(req(file));
        expect(res.status).toBe(404);
    });

    test("404 when no path param is given", async () => {
        expect((await handleDashboardRequest(req(null))).status).toBe(404);
    });
});

describe("dashboard server", () => {
    test("parseDashboardServeArgs defaults to port 1738", () => {
        expect(parseDashboardServeArgs([]).port).toBe(1738);
    });

    test("parseDashboardServeArgs accepts explicit port", () => {
        expect(parseDashboardServeArgs(["--port=1800"]).port).toBe(1800);
    });

    test("graph explorer is disabled unless explicitly enabled", () => {
        expect(isGraphExplorerEnabled({})).toBe(false);
        expect(isGraphExplorerEnabled({ AX_ENABLE_GRAPH_EXPLORER: "0" })).toBe(false);
        expect(isGraphExplorerEnabled({ AX_ENABLE_GRAPH_EXPLORER: "1" })).toBe(true);
    });

    test("capabilities hide graph explorer by default", () => {
        expect(dashboardApiCapabilities({})).not.toContain("graph-explorer");
        expect(dashboardApiCapabilities({})).toContain("skill-graph");
        expect(dashboardApiCapabilities({ AX_ENABLE_GRAPH_EXPLORER: "1" })).toContain("graph-explorer");
    });

    test("graph explorer endpoint returns 404 by default", async () => {
        const prev = process.env.AX_ENABLE_GRAPH_EXPLORER;
        delete process.env.AX_ENABLE_GRAPH_EXPLORER;
        try {
            const res = await handleDashboardRequestWithCors(
                new Request("http://127.0.0.1:1738/api/graph-explorer"),
            );
            expect(res.status).toBe(404);
            await expect(res.json()).resolves.toMatchObject({
                error: "graph_explorer_disabled",
            });
        } finally {
            if (prev === undefined) delete process.env.AX_ENABLE_GRAPH_EXPLORER;
            else process.env.AX_ENABLE_GRAPH_EXPLORER = prev;
        }
    });

    test("GET /api/version is served by the route table", async () => {
        const res = await handleDashboardRequest(new Request("http://127.0.0.1:1738/api/version"));
        expect(res.status).toBe(200);
        const body = await res.json() as { api_version: number; capabilities: string[] };
        expect(body.api_version).toBe(1);
        expect(body.capabilities).toContain("sessions");
    });

    test("unknown /api/* path preserves the legacy 200 not_found quirk", async () => {
        const res = await handleDashboardRequest(new Request("http://127.0.0.1:1738/api/definitely-not-a-route"));
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ error: "not_found" });
    });
});
