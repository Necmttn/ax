import { afterAll, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { DbError } from "@ax/lib/errors";
import { isContractRequest, makeContractWebHandler, type ContractWebHandler } from "./web-handler.ts";

/** Stub DB returning empty ax_invocation results. */
const emptyDb = Layer.mock(SurrealClient, {
    query: <T extends unknown[] = unknown[]>(_sql: string, _bindings?: Record<string, unknown> | undefined) =>
        Effect.succeed([[]] as unknown as T),
    raw: null as never,
});

const seededDb = Layer.mock(SurrealClient, {
    query: <T extends unknown[] = unknown[]>(sql: string, _bindings?: Record<string, unknown> | undefined) => {
        if (sql.includes("ax_invocation")) {
            const rows = [
                { ts: "2026-06-01T10:00:00Z", command: "sessions", origin: "tty" as const, exit_code: 0 },
                { ts: "2026-06-02T11:00:00Z", command: "sessions", origin: "tty" as const, exit_code: 0 },
                { ts: "2026-06-03T12:00:00Z", command: "ingest", origin: "agent" as const, exit_code: 1 },
            ];
            return Effect.succeed([rows] as unknown as T);
        }
        return Effect.succeed([[]] as unknown as T);
    },
    raw: null as never,
});

const handlers: ContractWebHandler[] = [];
function make(services: Parameters<typeof makeContractWebHandler>[0]["services"] = emptyDb): ContractWebHandler {
    const h = makeContractWebHandler({ ingestStream: null, services });
    handlers.push(h);
    return h;
}
afterAll(async () => {
    for (const h of handlers) await h.dispose();
});

const get = (path: string): Request => new Request(`http://127.0.0.1:1738${path}`);

describe("isContractRequest - usage", () => {
    test("GET /api/usage routes to the contract", () => {
        expect(isContractRequest("GET", "/api/usage")).toBe(true);
    });
});

describe("usageRollup handler", () => {
    test("GET /api/usage returns 200 + UsageRollup shape with empty DB", async () => {
        const { handler } = make(emptyDb);
        const res = await handler(get("/api/usage"));
        expect(res.status).toBe(200);
        const body = await res.json() as {
            windowDays: number;
            total: number;
            activeDays: number;
            topCommands: unknown[];
            unusedSurface: string[];
            originSplit: { agent: number; tty: number };
            reliability: unknown[];
        };
        expect(body).toHaveProperty("windowDays", 30);
        expect(body).toHaveProperty("total", 0);
        expect(body).toHaveProperty("activeDays", 0);
        expect(Array.isArray(body.topCommands)).toBe(true);
        expect(Array.isArray(body.unusedSurface)).toBe(true);
        expect(typeof body.originSplit).toBe("object");
        expect(body.originSplit).toHaveProperty("agent");
        expect(body.originSplit).toHaveProperty("tty");
        expect(Array.isArray(body.reliability)).toBe(true);
    });

    test("GET /api/usage?days=7 uses the supplied window", async () => {
        const { handler } = make(emptyDb);
        const res = await handler(get("/api/usage?days=7"));
        expect(res.status).toBe(200);
        const body = await res.json() as { windowDays: number };
        expect(body.windowDays).toBe(7);
    });

    test("GET /api/usage returns correct rollup for seeded rows", async () => {
        const { handler } = make(seededDb);
        const res = await handler(get("/api/usage"));
        expect(res.status).toBe(200);
        const body = await res.json() as {
            total: number;
            activeDays: number;
            topCommands: Array<{ command: string; count: number }>;
            originSplit: { agent: number; tty: number };
            reliability: Array<{ command: string; failureRate: number }>;
            unusedSurface: string[];
        };
        expect(body.total).toBe(3);
        // 3 distinct days
        expect(body.activeDays).toBe(3);
        // sessions is top command with 2 uses
        expect(body.topCommands[0]).toMatchObject({ command: "sessions", count: 2 });
        // origin split: 2 tty, 1 agent
        expect(body.originSplit).toEqual({ tty: 2, agent: 1 });
        // ingest had 1 failure out of 1 run
        expect(body.reliability.some((r) => r.command === "ingest" && r.failureRate === 1)).toBe(true);
        // sessions and ingest used, so both should NOT be in unusedSurface
        expect(body.unusedSurface).not.toContain("sessions");
        expect(body.unusedSurface).not.toContain("ingest");
        // unused commands should be in unusedSurface
        expect(body.unusedSurface).toContain("recall");
    });

    test("DB error returns 500", async () => {
        const failDb = Layer.mock(SurrealClient, {
            query: () => Effect.fail(new DbError({ operation: "query", message: "db exploded" })),
            raw: null as never,
        });
        const { handler } = make(failDb);
        const res = await handler(get("/api/usage"));
        expect(res.status).toBe(500);
        const body = await res.json() as { error: string };
        expect(body).toHaveProperty("error");
        expect(typeof body.error).toBe("string");
    });
});
