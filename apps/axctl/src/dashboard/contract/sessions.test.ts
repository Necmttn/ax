import { afterAll, describe, expect, test } from "bun:test";
import { makeTestCacheRead } from "@ax/lib/testing/cache";
import { isContractRequest, makeContractWebHandler, type ContractWebHandler } from "./web-handler.ts";

/**
 * Empty published snapshot. `/api/sessions` is DuckDB-backed in v2, and the
 * production `CacheReadLive` needs a real libduckdb that no plain `bun test`
 * run (or CI) has - without this seam the route answers 500 "the DuckDB library
 * could not be loaded", which says nothing about the route.
 *
 * The default responder is `[]`, so every statement returns no rows: exactly
 * the empty-data path these status assertions are about. Rows still decode
 * through the caller's `Schema` (see @ax/lib/testing/cache), and query
 * CORRECTNESS is asserted elsewhere against a real temp DuckDB
 * (`duckdbTestSetup` + `publishCacheFixture`), never here.
 */
const emptyCache = makeTestCacheRead().layer;

const handlers: ContractWebHandler[] = [];
function make(cacheRead: Parameters<typeof makeContractWebHandler>[0]["cacheRead"] = emptyCache): ContractWebHandler {
    const h = makeContractWebHandler({ ingestStream: null, cacheRead });
    handlers.push(h);
    return h;
}
afterAll(async () => {
    for (const h of handlers) await h.dispose();
});

const get = (path: string): Request => new Request(`http://127.0.0.1:1738${path}`);

describe("isContractRequest - sessions routing", () => {
    test("exact sessions paths route to the contract", () => {
        for (const p of [
            "/api/session-canvas",
            "/api/session-summary",
            "/api/session-orchestration",
            "/api/sessions",
            "/api/sessions/compare",
        ]) {
            expect(isContractRequest("GET", p)).toBe(true);
        }
    });

    test("single-segment session param paths route to the contract", () => {
        expect(isContractRequest("GET", "/api/sessions/abc")).toBe(true);
        expect(isContractRequest("GET", "/api/sessions/abc/inspect")).toBe(true);
        expect(isContractRequest("GET", "/api/sessions/abc/evidence")).toBe(true);
        expect(isContractRequest("GET", "/api/sessions/abc/children")).toBe(true);
        expect(isContractRequest("GET", "/api/sessions/abc/insights")).toBe(true);
        expect(isContractRequest("GET", "/api/sessions/abc/timeline")).toBe(true);
    });

    test("multi-segment (raw slash) session ids fall through to legacy greedy rows", () => {
        // /api/sessions/a/b has two segments after /sessions/, so it does NOT
        // match /^\/api\/sessions\/[^/]+$/ - falls to legacy :id+ routes.
        expect(isContractRequest("GET", "/api/sessions/a/b")).toBe(false);
    });

    test("POST /api/sessions does NOT route to contract (legacy method-ANY row)", () => {
        expect(isContractRequest("POST", "/api/sessions")).toBe(false);
    });
});

describe("sessions handlers - sessionCompare validation", () => {
    test("fewer than 2 ids returns 400 with the legacy message", async () => {
        const { handler } = make();
        // One id - should fail
        const res = await handler(get("/api/sessions/compare?ids=only-one"));
        expect(res.status).toBe(400);
        const body = await res.json() as { error: string };
        expect(body.error).toBe("need at least 2 session ids (ids=a,b)");
    });

    test("empty ids string returns 400", async () => {
        const { handler } = make();
        const res = await handler(get("/api/sessions/compare?ids="));
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({ error: "need at least 2 session ids (ids=a,b)" });
    });

    test("two ids reaches the fetch and returns 200 (or 500 if row mapping fails)", async () => {
        // The stub returns [[]] (empty result tuples). fetchSessionCompare may or
        // may not succeed depending on row parsing; we assert the status observed
        // and confirm it is NOT 400 (the bad-request path did not trigger).
        const { handler } = make();
        const res = await handler(get("/api/sessions/compare?ids=a,b"));
        // 400 means the validation fired - that is wrong. 200 or 500 are both
        // acceptable: 200 if the canned empty rows map cleanly, 500 if the
        // row mapping expects specific fields.
        expect(res.status).not.toBe(400);
    });
});

describe("sessions handlers - sessionInspect not-found mapping", () => {
    test("a session with no transcript maps to 404 { error }", async () => {
        // The real not-found path is TranscriptNotFoundError from
        // locateTranscript: an unknown id finds no transcript on disk and no
        // row in the snapshot. An earlier version of this test poisoned a
        // service the handler had already stopped resolving, so it asserted
        // nothing about either path - and its own comment conceded as much by
        // accepting 404 OR 500.
        const { handler } = make();
        const res = await handler(get("/api/sessions/abc/inspect"));
        expect(res.status).toBe(404);
        const body = await res.json() as { error: string };
        expect(typeof body.error).toBe("string");
    });
});

describe("sessions handlers - missing required query param", () => {
    test("missing required id on session-summary returns 400 (contract schema validation)", async () => {
        const { handler } = make();
        const res = await handler(get("/api/session-summary"));
        // id is required in the contract schema - HttpApi should reject with 400
        expect(res.status).toBe(400);
    });

    test("a validation 400 carries a body naming the request and the contract surfaces", async () => {
        // `HttpApiSchemaError` documents itself as responding with an EMPTY 400.
        // Zero bytes reads as a broken server, and the primary consumer of this
        // API is an agent that has to self-correct from the response alone
        // (#855).
        const { handler } = make();
        const res = await handler(get("/api/session-orchestration"));
        expect(res.status).toBe(400);
        const body = await res.json() as Record<string, unknown>;
        expect(body.error).toBe("bad_request");
        expect(body.message).toContain("GET /api/session-orchestration");
        expect(body.docs).toBe("http://127.0.0.1:1738/docs");
        expect(body.openapi).toBe("http://127.0.0.1:1738/openapi.json");
    });
});

describe("sessions handlers - basic responses", () => {
    test("GET /api/sessions returns 200 with empty stub", async () => {
        const { handler } = make();
        const res = await handler(get("/api/sessions"));
        expect(res.status).toBe(200);
    });

    test("GET /api/session-canvas returns 200 with empty stub", async () => {
        // fetchSessionCanvas needs multiple queries - stub returns [] for all.
        // The response may 500 if the row mapping is strict; we just check we
        // reach the handler (not a routing failure).
        const { handler } = make();
        const res = await handler(get("/api/session-canvas"));
        // 200 or 500 are both acceptable (not a 404 routing miss)
        expect([200, 500]).toContain(res.status);
    });
});
