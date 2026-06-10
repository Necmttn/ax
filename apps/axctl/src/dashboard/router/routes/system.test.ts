import { describe, expect, test } from "bun:test";
import { matchRoute, type RouteInput } from "../router.ts";
import { decodeQueryParams, systemRoutes } from "./system.ts";

const input = (body: RouteInput["body"]): RouteInput => ({
    req: new Request("http://h/api/query", { method: "POST" }),
    url: new URL("http://h/api/query"),
    path: {},
    body,
});

describe("decodeQueryParams (POST /api/query)", () => {
    test("accepts SELECT", () => {
        const d = decodeQueryParams(input({ kind: "json", value: { sql: " SELECT * FROM session; " } }));
        expect(d).toEqual({ ok: true, value: { sql: "SELECT * FROM session;" } });
    });

    test("rejects mutations with the legacy message", () => {
        const d = decodeQueryParams(input({ kind: "json", value: { sql: "DELETE session;" } }));
        expect(d).toMatchObject({ ok: false, status: 400, body: { error: "Only SELECT, RETURN, and INFO queries are allowed" } });
    });

    test("rejects missing sql with the legacy message", () => {
        const d = decodeQueryParams(input({ kind: "json", value: {} }));
        expect(d).toMatchObject({ ok: false, status: 400, body: { error: "SQL is required" } });
    });

    test("rejects invalid JSON bodies", () => {
        const d = decodeQueryParams(input({ kind: "invalid" }));
        expect(d).toMatchObject({ ok: false, status: 400, body: { error: "invalid_json" } });
    });
});

describe("systemRoutes", () => {
    test("legacy queryApi endpoints remain method-agnostic", () => {
        expect(matchRoute(systemRoutes, "POST", "/api/graph-health").kind).toBe("matched");
    });

    test("POST /api/query remains POST-only", () => {
        expect(matchRoute(systemRoutes, "GET", "/api/query").kind).toBe("method_mismatch");
    });
});
