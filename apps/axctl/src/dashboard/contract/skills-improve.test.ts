import { afterAll, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { isContractRequest, makeContractWebHandler, type ContractWebHandler } from "./web-handler.ts";

const emptyDb = Layer.mock(SurrealClient, {
    query: <T extends unknown[] = unknown[]>(_sql: string, _bindings?: Record<string, unknown> | undefined) =>
        Effect.succeed(Array.from({ length: 8 }, () => []) as unknown as T),
    raw: null as never,
});

const handlers: ContractWebHandler[] = [];
function make(): ContractWebHandler {
    const h = makeContractWebHandler({ ingestStream: null, services: emptyDb });
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

describe("isContractRequest - skills/improve/live routing", () => {
    test("exact paths route to the contract", () => {
        expect(isContractRequest("GET", "/api/decisions")).toBe(true);
        expect(isContractRequest("GET", "/api/skills")).toBe(true);
        expect(isContractRequest("POST", "/api/skills/decide-bulk")).toBe(true);
        expect(isContractRequest("GET", "/api/improve")).toBe(true);
        expect(isContractRequest("GET", "/api/improve/analyze-brief")).toBe(true);
        expect(isContractRequest("GET", "/api/wrapped/generate-brief")).toBe(true);
        expect(isContractRequest("GET", "/api/improve/some-sig/impact")).toBe(true);
    });

    test("skill param routes match per method", () => {
        expect(isContractRequest("POST", "/api/skills/my-skill/decide")).toBe(true);
        expect(isContractRequest("DELETE", "/api/skills/my-skill/decide")).toBe(true);
        expect(isContractRequest("GET", "/api/skills/my-skill/detail")).toBe(true);
        expect(isContractRequest("GET", "/api/skills/my-skill/source")).toBe(true);
        expect(isContractRequest("POST", "/api/skills/my-skill/open")).toBe(true);
        // Wrong method or raw-slash name falls to the legacy rows.
        expect(isContractRequest("GET", "/api/skills/my-skill/decide")).toBe(false);
        expect(isContractRequest("POST", "/api/skills/a/b/decide")).toBe(false);
    });

    test("all improve actions route to the contract (handler 404s unknown ones)", () => {
        expect(isContractRequest("POST", "/api/improve/sig123/accept")).toBe(true);
        expect(isContractRequest("POST", "/api/improve/sig123/reject")).toBe(true);
        expect(isContractRequest("POST", "/api/improve/sig123/verdict")).toBe(true);
        expect(isContractRequest("POST", "/api/improve/sig123/explode")).toBe(true);
    });

    test("SSE and image stay raw legacy routes", () => {
        expect(isContractRequest("GET", "/api/events")).toBe(false);
        expect(isContractRequest("GET", "/api/image")).toBe(false);
    });

    test("POST /api/ingest is retired (studio ephemeral, wave 3) - never routes anywhere", () => {
        expect(isContractRequest("POST", "/api/ingest")).toBe(false);
    });
});

describe("skills handlers", () => {
    test("decide-bulk with empty names returns 400 with the legacy message", async () => {
        const { handler } = make();
        const res = await handler(req("POST", "/api/skills/decide-bulk", {
            names: [],
            decision: "keep",
            reason: null,
        }));
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({
            error: "names must be a non-empty array of skill names",
        });
    });

    test("decide with an invalid decision enum is rejected 400 by the schema", async () => {
        const { handler } = make();
        const res = await handler(req("POST", "/api/skills/some-skill/decide", {
            decision: "yolo",
            reason: null,
        }));
        expect(res.status).toBe(400);
    });
});

describe("improve handlers", () => {
    test("unknown action answers the legacy 404 { error: unknown_improve_action }", async () => {
        const { handler } = make();
        const res = await handler(req("POST", "/api/improve/sig123/explode", {}));
        expect(res.status).toBe(404);
        await expect(res.json()).resolves.toEqual({ error: "unknown_improve_action" });
    });

});
