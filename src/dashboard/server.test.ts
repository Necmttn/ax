import { describe, expect, test } from "bun:test";
import { parseDashboardServeArgs, routeStaticAsset } from "./server.ts";

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
});
