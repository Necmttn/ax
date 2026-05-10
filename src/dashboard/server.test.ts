import { describe, expect, test } from "bun:test";
import { parseDashboardServeArgs, parseQueryRequest, routeStaticAsset } from "./server.ts";
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
});
