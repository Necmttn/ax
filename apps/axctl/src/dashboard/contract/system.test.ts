import { afterAll, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { DbError } from "@ax/lib/errors";
import { AX_VERSION } from "../../cli/version.ts";
import { API_VERSION } from "../capabilities.ts";
import { isContractRequest, makeContractWebHandler, type ContractWebHandler } from "./web-handler.ts";

/** Stub DB: SELECT echoes a canned row set; "boom" SQL fails with DbError. */
const stubDb = Layer.mock(SurrealClient, {
    query: <T extends unknown[] = unknown[]>(sql: string, _bindings?: Record<string, unknown> | undefined): Effect.Effect<T, DbError, never> =>
        sql.includes("boom")
            ? Effect.fail(new DbError({ operation: "query", message: "boom: db exploded" }))
            : Effect.succeed([[{ ok: true }]] as unknown as T),
    // `raw` is the only non-effect member, so Layer.mock requires it; the
    // contract handlers never touch it.
    raw: null as never,
});

const handlers: ContractWebHandler[] = [];
function make(liveIngest = false): ContractWebHandler {
    // A truthy fake stream handle is enough: version only null-checks it.
    const h = makeContractWebHandler({
        ingestStream: liveIngest ? ({} as never) : null,
        services: stubDb,
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
        expect(isContractRequest("POST", "/api/query")).toBe(true);
        expect(isContractRequest("GET", "/docs")).toBe(true);
        expect(isContractRequest("GET", "/openapi.json")).toBe(true);
        // Non-GET on a migrated GET path stays with the legacy table (its
        // method-ANY quirk) until the family is fully cut over.
        expect(isContractRequest("POST", "/api/version")).toBe(false);
        expect(isContractRequest("GET", "/api/query")).toBe(false);
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

    test("POST /api/query rejects non-read SQL with 400 (legacy parity)", async () => {
        const { handler } = make();
        const res = await handler(req("POST", "/api/query", { sql: "DELETE FROM session" }));
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({
            error: "Only SELECT, RETURN, and INFO queries are allowed",
        });
    });

    test("POST /api/query rejects empty SQL with 400", async () => {
        const { handler } = make();
        const res = await handler(req("POST", "/api/query", { sql: "   " }));
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({ error: "SQL is required" });
    });

    test("POST /api/query returns result + durationMs", async () => {
        const { handler } = make();
        const res = await handler(req("POST", "/api/query", { sql: "SELECT * FROM session" }));
        expect(res.status).toBe(200);
        const body = await res.json() as { result: unknown; durationMs: number };
        expect(body.result).toEqual([[{ ok: true }]]);
        expect(typeof body.durationMs).toBe("number");
    });

    test("POST /api/query maps DbError to 400 (legacy parity)", async () => {
        const { handler } = make();
        const res = await handler(req("POST", "/api/query", { sql: "SELECT boom" }));
        expect(res.status).toBe(400);
        const body = await res.json() as { error: string };
        expect(body.error).toContain("boom");
    });

    test("GET /api/graph-health passes rows through", async () => {
        const { handler } = make();
        const res = await handler(req("GET", "/api/graph-health"));
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual([[{ ok: true }]]);
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
            "/api/version", "/api/query", "/api/graph-health", "/api/worktrees", "/api/self-improve",
        ]));
    });
});
