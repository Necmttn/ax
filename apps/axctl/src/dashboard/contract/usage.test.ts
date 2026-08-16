/**
 * `GET /api/usage` over the v2 seam.
 *
 * The rollup's ONLY data source is `ax_invocation` in the published DuckDB
 * snapshot (see `usage/query.ts`), so these cases run against a REAL temp
 * snapshot rather than a stubbed client. `CacheReadLive` is merged inside
 * `makeContractWebHandler` and wins over anything passed as `services`, so the
 * fixture is pointed at through `AX_DUCKDB_SNAPSHOT` - the same override a user
 * has. A SurrealQL stub would prove nothing here: it cannot catch a predicate
 * DuckDB refuses to bind, which is exactly the defect this file caught.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { isContractRequest, makeContractWebHandler, type ContractWebHandler } from "./web-handler.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("usage contract", { requireFts: true });

const invocation = (
    id: string,
    ts: Date,
    command: string,
    origin: "tty" | "agent",
    exitCode: number,
) => ({
    id,
    ts,
    command,
    flags: "",
    exit_code: exitCode,
    duration_ms: 10,
    origin,
    repo_key: null,
    ax_version: "0.0.0-test",
});

/** Recent, so every row falls inside both the 30d and the 7d window. */
const daysAgo = (n: number): Date => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

const handlers: ContractWebHandler[] = [];
const make = (): ContractWebHandler => {
    const h = makeContractWebHandler({ ingestStream: null });
    handlers.push(h);
    return h;
};

let emptySnapshot = "";
let seededSnapshot = "";
const originalSnapshotEnv = process.env.AX_DUCKDB_SNAPSHOT;
const originalDylibEnv = process.env.AX_DUCKDB_DYLIB;

beforeAll(async () => {
    if (dylibPath === null) return;
    // The handler builds its OWN `CacheReadLive`, which resolves the library
    // through `AX_DUCKDB_DYLIB` and has no other source outside a compiled
    // binary. `duckdbTestSetup` only RETURNS the path it found - it does not
    // export it - so without this the handler answers 500 ("no libduckdb
    // available") and the case reads as a query defect. Same shape as
    // `packages/lib/src/duckdb/seam.test.ts`.
    process.env.AX_DUCKDB_DYLIB = dylibPath;
    const empty = await runWithPlatform(
        publishCacheFixture(tempDir("usage-empty"), dylibPath, () => Effect.void),
    );
    emptySnapshot = empty.snapshotPath;
    const seeded = await runWithPlatform(
        publishCacheFixture(tempDir("usage-seeded"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.put("ax_invocation", invocation("inv:1", daysAgo(3), "sessions", "tty", 0));
                yield* write.put("ax_invocation", invocation("inv:2", daysAgo(2), "sessions", "tty", 0));
                yield* write.put("ax_invocation", invocation("inv:3", daysAgo(1), "ingest", "agent", 1));
            }),
        ),
    );
    seededSnapshot = seeded.snapshotPath;
});

afterAll(async () => {
    for (const h of handlers) await h.dispose();
    if (originalSnapshotEnv === undefined) delete process.env.AX_DUCKDB_SNAPSHOT;
    else process.env.AX_DUCKDB_SNAPSHOT = originalSnapshotEnv;
    if (originalDylibEnv === undefined) delete process.env.AX_DUCKDB_DYLIB;
    else process.env.AX_DUCKDB_DYLIB = originalDylibEnv;
});

const get = (path: string): Request => new Request(`http://127.0.0.1:1738${path}`);

describe("isContractRequest - usage", () => {
    test("GET /api/usage routes to the contract", () => {
        expect(isContractRequest("GET", "/api/usage")).toBe(true);
    });
});

describe("usageRollup handler", () => {
    dtest("GET /api/usage returns 200 + UsageRollup shape with an empty snapshot", async () => {
        process.env.AX_DUCKDB_SNAPSHOT = emptySnapshot;
        const { handler } = make();
        const res = await handler(get("/api/usage"));
        expect(res.status).toBe(200);
        const body = await res.json() as {
            windowDays: number;
            total: number;
            activeDays: number;
            topCommands: unknown[];
            topCommandsByOrigin: { agent: unknown[]; tty: unknown[] };
            unusedSurface: string[];
            originSplit: { agent: number; tty: number };
            reliability: unknown[];
        };
        expect(body).toHaveProperty("windowDays", 30);
        expect(body).toHaveProperty("total", 0);
        expect(body).toHaveProperty("activeDays", 0);
        expect(Array.isArray(body.topCommands)).toBe(true);
        expect(Array.isArray(body.topCommandsByOrigin.agent)).toBe(true);
        expect(Array.isArray(body.topCommandsByOrigin.tty)).toBe(true);
        expect(Array.isArray(body.unusedSurface)).toBe(true);
        expect(typeof body.originSplit).toBe("object");
        expect(body.originSplit).toHaveProperty("agent");
        expect(body.originSplit).toHaveProperty("tty");
        expect(Array.isArray(body.reliability)).toBe(true);
    });

    dtest("GET /api/usage?days=7 uses the supplied window", async () => {
        process.env.AX_DUCKDB_SNAPSHOT = emptySnapshot;
        const { handler } = make();
        const res = await handler(get("/api/usage?days=7"));
        expect(res.status).toBe(200);
        const body = await res.json() as { windowDays: number };
        expect(body.windowDays).toBe(7);
    });

    dtest("GET /api/usage returns correct rollup for seeded rows", async () => {
        process.env.AX_DUCKDB_SNAPSHOT = seededSnapshot;
        const { handler } = make();
        const res = await handler(get("/api/usage"));
        expect(res.status).toBe(200);
        const body = await res.json() as {
            total: number;
            activeDays: number;
            topCommands: Array<{ command: string; count: number }>;
            topCommandsByOrigin: {
                agent: Array<{ command: string; count: number }>;
                tty: Array<{ command: string; count: number }>;
            };
            originSplit: { agent: number; tty: number };
            reliability: Array<{ command: string; failureRate: number }>;
            unusedSurface: string[];
        };
        expect(body.total).toBe(3);
        // 3 distinct days
        expect(body.activeDays).toBe(3);
        // sessions is top command with 2 uses
        expect(body.topCommands[0]).toMatchObject({ command: "sessions", count: 2 });
        expect(body.topCommandsByOrigin.tty[0]).toMatchObject({ command: "sessions", count: 2 });
        expect(body.topCommandsByOrigin.agent[0]).toMatchObject({ command: "ingest", count: 1 });
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

    dtest("an unreadable snapshot returns 500", async () => {
        // The rollup is the whole response, not a decorative corner of it, so it
        // surfaces the failure instead of degrading to a plausible zero.
        process.env.AX_DUCKDB_SNAPSHOT = `${emptySnapshot}.does-not-exist`;
        const { handler } = make();
        const res = await handler(get("/api/usage"));
        expect(res.status).toBe(500);
        const body = await res.json() as { error: string };
        expect(body).toHaveProperty("error");
        expect(typeof body.error).toBe("string");
    });
});
