import { afterAll, describe, expect, test } from "bun:test";
import { Effect, Layer, Option } from "effect";
import { CacheRead, type CacheReadService } from "@ax/lib/duckdb/seam";
import { DuckDbQueryError } from "@ax/lib/duckdb/errors";
import { AX_VERSION } from "../../cli/version.ts";
import { API_VERSION } from "../capabilities.ts";
import { isContractRequest, makeContractWebHandler, type ContractWebHandler } from "./web-handler.ts";

/** Stub CacheRead: `rows`/`first` (fetchWorktreesOverview's many small
 *  queries) degrade to empty, same as a real dylib-less test run - that
 *  view only asserts response shape, not content. `raw` (/api/self-improve)
 *  echoes a canned row, or fails with a DuckDbQueryError for SQL containing
 *  "boom". No SurrealClient stub: nothing left in this contract group reads
 *  it (see system.ts's module doc - the default `InertSurrealLayer` in
 *  web-handler.ts is exercised as-is). */
const stubCacheReadService: CacheReadService = {
    rows: () => Effect.succeed([]),
    first: () => Effect.succeed(Option.none()),
    raw: (sql) =>
        sql.includes("boom")
            ? Effect.fail(new DuckDbQueryError({ sql, message: "boom: db exploded" }))
            : Effect.succeed({ columns: [], rows: [{ ok: true }], rowsChanged: 0 }),
    snapshotPath: "(test stub)",
};
const stubCacheRead = Layer.succeed(CacheRead)(stubCacheReadService);

const handlers: ContractWebHandler[] = [];
function make(liveIngest = false): ContractWebHandler {
    // A truthy fake stream handle is enough: version only null-checks it.
    const h = makeContractWebHandler({
        ingestStream: liveIngest ? ({} as never) : null,
        cacheRead: stubCacheRead,
    });
    handlers.push(h);
    return h;
}
afterAll(async () => {
    for (const h of handlers) await h.dispose();
});

const req = (method: string, path: string, body?: unknown): Request =>
    new Request(`http://127.0.0.1:1738${path}`, {
        method,
        ...(body === undefined ? {} : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        }),
    });

describe("isContractRequest", () => {
    test("owns exactly the migrated (method, path) pairs", () => {
        // /api/version is in the contract (docs, generated client) but is
        // ROUTED to the DB-free legacy row so the daemon's identity probe
        // keeps answering when SurrealDB is down - see web-handler.ts.
        expect(isContractRequest("GET", "/api/version")).toBe(false);
        expect(isContractRequest("GET", "/api/worktrees")).toBe(true);
        expect(isContractRequest("GET", "/docs")).toBe(true);
        expect(isContractRequest("GET", "/openapi.json")).toBe(true);
        // Non-GET on a migrated GET path stays with the legacy table (its
        // method-ANY quirk) until the family is fully cut over.
        expect(isContractRequest("POST", "/api/version")).toBe(false);
        // Retired (studio ephemeral, wave 3): never routes anywhere now.
        expect(isContractRequest("POST", "/api/query")).toBe(false);
        expect(isContractRequest("GET", "/api/graph-health")).toBe(false);
        // The deliberately-unmigrated route never routes here.
        expect(isContractRequest("GET", "/api/graph-explorer")).toBe(false);
    });
});

describe("contract system group", () => {
    test("GET /api/version matches the legacy response shape", async () => {
        const { handler } = make(true);
        const res = await handler(req("GET", "/api/version"));
        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, unknown>;
        expect(body.version).toBe(AX_VERSION);
        expect(body.api_version).toBe(API_VERSION);
        expect(body.capabilities).toContain("sessions");
        expect(body.live_ingest).toBe(true);
        expect(body.otlp_receiver).toBe(true);
    });

    test("version reports live_ingest false when the sidecar is down", async () => {
        const { handler } = make(false);
        const res = await handler(req("GET", "/api/version"));
        expect(((await res.json()) as { live_ingest: boolean }).live_ingest).toBe(false);
    });

    test("GET /api/worktrees returns activity + git", async () => {
        const { handler } = make();
        const res = await handler(req("GET", "/api/worktrees"));
        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, unknown>;
        expect(body).toHaveProperty("activity");
        expect(body).toHaveProperty("git");
    });
});

describe("contract docs", () => {
    test("GET /docs serves the Scalar reference page", async () => {
        const { handler } = make();
        const res = await handler(req("GET", "/docs"));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/html");
        expect(await res.text()).toContain("Scalar");
    });

    test("GET /openapi.json includes the system endpoints", async () => {
        const { handler } = make();
        const res = await handler(req("GET", "/openapi.json"));
        expect(res.status).toBe(200);
        const spec = await res.json() as { paths: Record<string, unknown> };
        expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining([
            "/api/version", "/api/worktrees", "/api/self-improve",
        ]));
        expect(Object.keys(spec.paths)).not.toEqual(expect.arrayContaining([
            "/api/query", "/api/graph-health",
        ]));
    });
});
