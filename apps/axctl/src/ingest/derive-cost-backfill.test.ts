import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { deriveCostBackfill } from "./derive-cost-backfill.ts";

interface UsageRowFixture {
    readonly id: string;
    readonly model: string | null;
    readonly prompt_tokens: number | null;
    readonly completion_tokens: number | null;
    readonly cache_creation_input_tokens: number | null;
    readonly cache_read_input_tokens: number | null;
    readonly estimated_tokens: number;
    readonly estimated_cost_usd: number | null;
    readonly pricing_source: string | null;
}

// Serve the null-cost selection from a fixture; capture UPDATEs. The
// `agent_model` catalog fetch returns nothing, so pricing comes from the
// built-in catalog (claude-opus-4 etc.).
const makeDb = (rows: UsageRowFixture[], sink: string[]) =>
    Layer.succeed(SurrealClient, {
        query: <T>(sql: string) => {
            if (/UPDATE session_token_usage/.test(sql)) {
                sink.push(sql);
                return Effect.succeed([[]] as unknown as T);
            }
            if (/FROM session_token_usage WHERE estimated_cost_usd IS NONE/.test(sql)) {
                return Effect.succeed([rows] as unknown as T);
            }
            if (/agent_model/.test(sql)) return Effect.succeed([[]] as unknown as T);
            return Effect.succeed([[]] as unknown as T);
        },
    } as never);

const row = (over: Partial<UsageRowFixture>): UsageRowFixture => ({
    id: "session_token_usage:`s1`",
    model: "claude-opus-4-5",
    prompt_tokens: null,
    completion_tokens: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    estimated_tokens: 1_000_000,
    estimated_cost_usd: null,
    pricing_source: null,
    ...over,
});

describe("deriveCostBackfill", () => {
    test("prices null-cost rows and persists estimated: provenance, guarded by IS NONE", async () => {
        const sink: string[] = [];
        const stats = await Effect.runPromise(
            deriveCostBackfill().pipe(Effect.provide(makeDb([row({})], sink))),
        );
        expect(stats).toEqual({ scanned: 1, backfilled: 1, unpriced: 0 });
        expect(sink).toHaveLength(1);
        const stmt = sink[0]!;
        // Writes by primary record id (never UPDATE-WHERE over the table).
        expect(stmt).toContain("UPDATE session_token_usage:`s1` SET");
        // 1M estimated tokens × claude-opus-4-5 input $5/M (byte-estimate rows
        // price the whole count at the input rate - honest lower bound).
        expect(stmt).toContain("estimated_cost_usd = 5.00000000");
        expect(stmt).toContain('pricing_source = "estimated:built_in_catalog_2026-05-29"');
        // Race guard: a concurrently ingest-priced cost wins at write time.
        expect(stmt).toContain("WHERE estimated_cost_usd IS NONE");
    });

    test("prices from the prompt/completion split when present", async () => {
        const sink: string[] = [];
        const stats = await Effect.runPromise(
            deriveCostBackfill().pipe(Effect.provide(makeDb([
                row({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000, estimated_tokens: 123 }),
            ], sink))),
        );
        expect(stats.backfilled).toBe(1);
        // $5/M input + $25/M output for claude-opus-4-5.
        expect(sink[0]).toContain("estimated_cost_usd = 30.00000000");
    });

    test("unknown/unpriceable models stay null (unknown is not $0)", async () => {
        const sink: string[] = [];
        const stats = await Effect.runPromise(
            deriveCostBackfill().pipe(Effect.provide(makeDb([
                row({ model: null }),
                row({ id: "session_token_usage:`s2`", model: "totally-unknown-model" }),
            ], sink))),
        );
        expect(stats).toEqual({ scanned: 2, backfilled: 0, unpriced: 2 });
        expect(sink).toHaveLength(0);
    });

    test("defensively skips already-estimated and already-priced rows", async () => {
        const sink: string[] = [];
        const stats = await Effect.runPromise(
            deriveCostBackfill().pipe(Effect.provide(makeDb([
                // Should be excluded by the selection - never rewritten even if returned.
                row({ pricing_source: "estimated:built_in_catalog_2026-05-29" }),
                row({ id: "session_token_usage:`s2`", estimated_cost_usd: 1.23, pricing_source: "built_in_catalog_2026-05-29" }),
            ], sink))),
        );
        expect(stats.backfilled).toBe(0);
        expect(sink).toHaveLength(0);
    });

    test("no null-cost rows -> no catalog fetch, no writes", async () => {
        const sink: string[] = [];
        const stats = await Effect.runPromise(
            deriveCostBackfill().pipe(Effect.provide(makeDb([], sink))),
        );
        expect(stats).toEqual({ scanned: 0, backfilled: 0, unpriced: 0 });
        expect(sink).toHaveLength(0);
    });
});
