import { afterAll, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { CacheRead } from "@ax/lib/duckdb/seam";
import { CacheUnavailableError } from "@ax/lib/duckdb/seam";
import { makeTestCacheRead } from "@ax/lib/testing/cache";
import { isContractRequest, makeContractWebHandler, type ContractWebHandler } from "./web-handler.ts";

/** Stub snapshot returning no rows - enough for null/empty paths. */
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

describe("isContractRequest - insights + hardening", () => {
    test("GET /api/version is NOT contract-routed (DB-free legacy row serves it)", () => {
        expect(isContractRequest("GET", "/api/version")).toBe(false);
    });

    test("insights exact paths route to the contract", () => {
        for (const p of [
            "/api/recall", "/api/skill-graph", "/api/wrapped",
            "/api/wrapped/public-preview", "/api/workflow", "/api/tool-failures",
        ]) expect(isContractRequest("GET", p)).toBe(true);
    });

    test("single-segment param paths route; multi-segment falls to legacy greedy rows", () => {
        expect(isContractRequest("GET", "/api/episodes/abc-123")).toBe(true);
        expect(isContractRequest("GET", "/api/episodes/a/b")).toBe(false);
        expect(isContractRequest("GET", "/api/projects/my-repo")).toBe(true);
        expect(isContractRequest("GET", "/api/projects/a/b")).toBe(false);
        expect(isContractRequest("GET", "/api/tool-failures/Bash/detail")).toBe(true);
        expect(isContractRequest("GET", "/api/tool-failures/a/b/detail")).toBe(false);
    });

    test("graph-explorer stays legacy (env-gated experimental)", () => {
        expect(isContractRequest("GET", "/api/graph-explorer")).toBe(false);
    });
});

describe("insights handlers", () => {
    test("recall with empty q answers the canned empty page without touching the snapshot", async () => {
        // The poison is on `CacheRead` because that is the seam the handler
        // actually resolves. Poisoning a service no handler reads would pass
        // whether or not the short-circuit exists.
        const poisoned = Layer.mock(CacheRead, {
            rows: () => Effect.die(new Error("snapshot must not be read for empty q")),
            first: () => Effect.die(new Error("snapshot must not be read for empty q")),
            raw: () => Effect.die(new Error("snapshot must not be read for empty q")),
            snapshotPath: "(poisoned)",
        });
        const { handler } = make(poisoned);
        const res = await handler(get("/api/recall?q=%20"));
        expect(res.status).toBe(200);
        const body = await res.json() as { hits: unknown[]; total_count: number };
        expect(body.hits).toEqual([]);
        expect(body.total_count).toBe(0);
    });

    test("project lookup miss maps to 404 { error } (legacy respond parity)", async () => {
        const { handler } = make();
        const res = await handler(get("/api/projects/nope"));
        expect(res.status).toBe(404);
        await expect(res.json()).resolves.toMatchObject({ error: "project not found" });
    });

    test("garbage numeric query param is a 400, not a silent default", async () => {
        const { handler } = make();
        const res = await handler(get("/api/skill-graph?limit=abc"));
        expect(res.status).toBe(400);
    });
});

describe("contract handler self-healing", () => {
    test("a failed layer build answers 500 and recovers on the next request", async () => {
        let attempts = 0;
        const flaky = Layer.effect(CacheRead)(Effect.suspend(() => {
            attempts += 1;
            if (attempts === 1) {
                return Effect.fail(
                    new CacheUnavailableError({ path: "(none)", message: "db down at boot" }),
                );
            }
            return Effect.succeed({
                rows: () => Effect.succeed([]),
                first: () => Effect.succeed(null),
                raw: () => Effect.succeed([]),
                snapshotPath: "(rebuilt)",
            } as unknown as CacheRead["Service"]);
        }));
        const { handler } = make(flaky);

        const first = await handler(get("/api/wrapped"));
        expect(first.status).toBe(500);
        await expect(first.json()).resolves.toMatchObject({ error: expect.stringContaining("db down") });

        // The wrapper swapped in a fresh handler; the rebuilt layer succeeds.
        const second = await handler(get("/api/tool-failures"));
        expect(second.status).toBe(200);
    });
});
