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

    test("GET /api/version reports live_ingest=false without a streaming sidecar", async () => {
        // No serveDashboard boot in tests => no Durable Streams sidecar, the
        // same shape as the compiled binary. The studio reads this flag to
        // engage its polling fallback instead of hitting the 503.
        const matched = matchRoute(systemRoutes, "GET", "/api/version");
        if (matched.kind !== "matched") throw new Error("expected /api/version to match");
        const res = await matched.match.route.run(
            {
                req: new Request("http://h/api/version"),
                url: new URL("http://h/api/version"),
                path: {},
                body: { kind: "none" },
            },
            (() => Promise.reject(new Error("unused"))) as never,
        );
        expect(res.status).toBe(200);
        const body = await res.json() as { live_ingest: boolean; capabilities: string[] };
        expect(body.live_ingest).toBe(false);
        expect(body.capabilities).toContain("ingest");
    });
});
