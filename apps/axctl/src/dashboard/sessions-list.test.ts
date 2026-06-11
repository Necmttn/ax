import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { makeTestSurrealClient } from "@ax/lib/testing/surreal";
import { fetchSessionsList } from "./sessions-list.ts";

const RID = "session:`aaaaaaaa-0000-0000-0000-000000000001`";
const BARE = "aaaaaaaa-0000-0000-0000-000000000001";

const pageRow = {
    id: RID,
    project: "ax",
    source: "claude",
    cwd: "/Users/x/ax",
    model: "claude-fable-5",
    started_at: "2026-06-11T01:00:00.000Z",
    ended_at: null,
    has_raw_file: true,
};

const run = (stub: SurrealClientShape) =>
    Effect.runPromise(
        fetchSessionsList({}).pipe(Effect.provideService(SurrealClient, stub)),
    );

// NOTE on fixture shape: `makeTestSurrealClient`'s `fallback` is a single
// responder answering EVERY `.query()` call with the same result tuple, so
// per-call fixtures go through `responses` - one entry per `.query()` call,
// each entry being that call's full result-set tuple. fetchSessionsList
// issues 3 calls: page+count (2 sets), spawned counts (1 set), enrichment
// (3 sets).

describe("fetchSessionsList enrichment", () => {
    test("joins health/usage/metrics onto rows and computes signal", async () => {
        const stub = makeTestSurrealClient({
            denyWrites: true,
            responses: [
                // call 1: page select + count (multi-statement -> two result sets)
                [[pageRow], [{ total: 1 }]],
                // call 2: spawned counts
                [[]],
                // call 3: enrichment (multi-statement -> three result sets)
                [
                    [{
                        session: RID, turns: 58, tool_errors: 5, user_corrections: 2,
                        context_pressure: "high", ts: new Date().toISOString(),
                    }],
                    [{
                        session: RID, estimated_cost_usd: 11.2, estimated_tokens: 3_400_000,
                        cache_read_input_tokens: 2_400_000, burn_buckets: "[100,200,300]",
                    }],
                    [{
                        session: RID, produced_commits: 5, reverted_commits: 1,
                        lines_added: 2100, lines_removed: 940,
                    }],
                ],
            ],
        }).client;

        const res = await run(stub);
        const row = res.sessions[0]!;
        expect(row.id).toBe(BARE);
        expect(row.turn_count).toBe(58);
        expect(row.cost_usd).toBe(11.2);
        expect(row.burn_buckets).toEqual([100, 200, 300]);
        expect(row.friction).toBe(7);
        expect(row.signal).toBe("friction");
        expect(row.produced_commits).toBe(5);
        expect(row.reverted_commits).toBe(1);
        expect(row.lines_added).toBe(2100);
        expect(row.lines_removed).toBe(940);
        // ended_at null + fresh health ts -> live
        expect(row.is_live).toBe(true);
    });

    test("rows without enrichment rows render null fields, signal null, not live", async () => {
        const stub = makeTestSurrealClient({
            denyWrites: true,
            responses: [
                [[{ ...pageRow, ended_at: "2026-06-11T02:00:00.000Z" }], [{ total: 1 }]],
                [[]], // spawned
                [[], [], []], // empty enrichment sets
            ],
        }).client;
        const res = await run(stub);
        const row = res.sessions[0]!;
        expect(row.turn_count).toBe(0);
        expect(row.cost_usd).toBeNull();
        expect(row.burn_buckets).toBeNull();
        expect(row.friction).toBeNull();
        expect(row.signal).toBeNull();
        expect(row.is_live).toBe(false);
    });

    test("zero-friction health row -> signal clean", async () => {
        const stub = makeTestSurrealClient({
            denyWrites: true,
            responses: [
                [[pageRow], [{ total: 1 }]],
                [[]],
                [
                    [{ session: RID, turns: 4, tool_errors: 0, user_corrections: 0, context_pressure: "low", ts: new Date().toISOString() }],
                    [],
                    [],
                ],
            ],
        }).client;
        const res = await run(stub);
        expect(res.sessions[0]!.signal).toBe("clean");
        expect(res.sessions[0]!.friction).toBe(0);
    });

    test("malformed burn_buckets JSON degrades to null", async () => {
        const stub = makeTestSurrealClient({
            denyWrites: true,
            responses: [
                [[pageRow], [{ total: 1 }]],
                [[]],
                [
                    [],
                    [{ session: RID, estimated_cost_usd: 1, estimated_tokens: 10, cache_read_input_tokens: 0, burn_buckets: "not json" }],
                    [],
                ],
            ],
        }).client;
        const res = await run(stub);
        expect(res.sessions[0]!.burn_buckets).toBeNull();
        expect(res.sessions[0]!.cost_usd).toBe(1);
    });
});
