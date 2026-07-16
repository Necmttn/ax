import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    handleDashboardRequest,
    handleDashboardRequestWithCors,
    isAllowedHost,
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

    test("desktop app origin ax://studio is allowed (preflight + GET)", async () => {
        const pre = await handleDashboardRequestWithCors(preflight({ origin: "ax://studio" }));
        expect(pre.status).toBe(204);
        expect(pre.headers.get("access-control-allow-origin")).toBe("ax://studio");

        const res = await handleDashboardRequestWithCors(
            new Request("http://127.0.0.1:1738/api/version", { headers: { origin: "ax://studio" } }),
        );
        expect(res.status).toBe(200);
        expect(res.headers.get("access-control-allow-origin")).toBe("ax://studio");
    });

    test("preflight echoes the requested headers (traceparent etc), default content-type", async () => {
        const withHeaders = await handleDashboardRequestWithCors(preflight({
            origin: "ax://studio",
            "access-control-request-headers": "content-type,traceparent",
        }));
        expect(withHeaders.headers.get("access-control-allow-headers")).toBe("content-type,traceparent");

        const without = await handleDashboardRequestWithCors(preflight({ origin: "ax://studio" }));
        expect(without.headers.get("access-control-allow-headers")).toBe("content-type");
    });

    test("other custom-scheme origins stay disallowed", async () => {
        const res = await handleDashboardRequestWithCors(preflight({ origin: "ax://evil" }));
        expect(res.headers.get("access-control-allow-origin")).toBeNull();
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

    // GET / serves the studio SPA (embedded or on-disk) or, failing that, the
    // daemon landing page - either way 200 HTML. A hashed asset that doesn't
    // exist is a hard 404 regardless of whether studio is bundled, so it never
    // leaks the SPA shell for a `.js` request (hash-mismatch surfaces).
    test("GET / serves HTML (studio or landing)", async () => {
        const res = await handleDashboardRequest(new Request("http://127.0.0.1:1738/"));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/html");
    });

    test("GET a missing /assets/* path is a 404, never the SPA shell", async () => {
        const res = await handleDashboardRequest(
            new Request("http://127.0.0.1:1738/assets/definitely-not-a-real-hash-xyz.js"),
        );
        expect(res.status).toBe(404);
    });
});

describe("Host-header validation (DNS-rebinding defense)", () => {
    test("isAllowedHost accepts loopback hosts with optional port", () => {
        expect(isAllowedHost("127.0.0.1")).toBe(true);
        expect(isAllowedHost("127.0.0.1:1738")).toBe(true);
        expect(isAllowedHost("localhost")).toBe(true);
        expect(isAllowedHost("localhost:1738")).toBe(true);
        expect(isAllowedHost("[::1]")).toBe(true);
        expect(isAllowedHost("[::1]:1738")).toBe(true);
        expect(isAllowedHost(null)).toBe(true); // non-browser client omits Host
    });

    test("isAllowedHost rejects foreign hosts", () => {
        expect(isAllowedHost("attacker.com")).toBe(false);
        expect(isAllowedHost("attacker.com:1738")).toBe(false);
        expect(isAllowedHost("ax.necmttn.com")).toBe(false);
        expect(isAllowedHost("127.0.0.1.attacker.com")).toBe(false);
        expect(isAllowedHost("0.0.0.0")).toBe(false);
    });

    test("a foreign Host header is 403ed before dispatch (reads included)", async () => {
        const res = await handleDashboardRequestWithCors(
            new Request("http://127.0.0.1:1738/api/version", { headers: { host: "attacker.com" } }),
        );
        expect(res.status).toBe(403);
    });

    test("a foreign Host on a state-changing route is 403ed", async () => {
        const res = await handleDashboardRequestWithCors(
            new Request("http://127.0.0.1:1738/api/query", {
                method: "POST",
                headers: { host: "attacker.com", "content-type": "application/json" },
                body: JSON.stringify({ sql: "SELECT 1" }),
            }),
        );
        expect(res.status).toBe(403);
    });

    test("a foreign Host is 403ed on OPTIONS preflight too", async () => {
        const res = await handleDashboardRequestWithCors(
            new Request("http://127.0.0.1:1738/api/version", {
                method: "OPTIONS",
                headers: { host: "attacker.com", origin: "https://ax.necmttn.com" },
            }),
        );
        expect(res.status).toBe(403);
    });

    test("loopback Host on a normal request still works", async () => {
        const res = await handleDashboardRequestWithCors(
            new Request("http://127.0.0.1:1738/api/version", { headers: { host: "127.0.0.1:1738" } }),
        );
        expect(res.status).toBe(200);
    });
});

describe("CORS write-method narrowing (finding #3)", () => {
    test("studio origin gets the full method set", async () => {
        const res = await handleDashboardRequestWithCors(preflight({ origin: "https://ax.necmttn.com" }));
        expect(res.headers.get("access-control-allow-methods")).toBe("GET, POST, DELETE, OPTIONS");
    });

    test("desktop ax://studio origin gets the full method set", async () => {
        const res = await handleDashboardRequestWithCors(preflight({ origin: "ax://studio" }));
        expect(res.headers.get("access-control-allow-methods")).toBe("GET, POST, DELETE, OPTIONS");
    });

    test("a bare localhost dev origin gets read-only methods (no POST/DELETE)", async () => {
        const res = await handleDashboardRequestWithCors(preflight({ origin: "http://localhost:3000" }));
        const methods = res.headers.get("access-control-allow-methods") ?? "";
        expect(methods).toBe("GET, OPTIONS");
        expect(methods).not.toContain("POST");
        expect(methods).not.toContain("DELETE");
    });

    test("localhost dev origin still gets a CORS grant + PNA (not fully blocked)", async () => {
        const res = await handleDashboardRequestWithCors(preflight({
            origin: "http://127.0.0.1:5173",
            "access-control-request-private-network": "true",
        }));
        expect(res.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
        expect(res.headers.get("access-control-allow-private-network")).toBe("true");
    });
});
