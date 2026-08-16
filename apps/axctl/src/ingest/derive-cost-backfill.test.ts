import { describe, expect } from "bun:test";
import { Effect, Schema } from "effect";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { deriveCostBackfill } from "./derive-cost-backfill.ts";
import { MODEL_PRICING_SOURCE } from "./model-pricing.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("cost backfill", { requireFts: true });

const usage = (id: string, model: string | null, values: Record<string, unknown> = {}) => ({
    id,
    session: id,
    source: "claude",
    model,
    prompt_tokens: null,
    completion_tokens: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    estimated_tokens: 1_000_000,
    transcript_bytes: 4_000_000,
    estimated_cost_usd: null,
    pricing_source: null,
    ...values,
});

describe("deriveCostBackfill on real DuckDB", () => {
    dtest("prices estimated tokens and preserves the pricing source", async () => {
        let stats: unknown;
        let row: unknown;
        await runWithPlatform(publishCacheFixture(tempDir("ax-cost-backfill-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.put("session_token_usage", usage("s1", "claude-opus-4-5"));
                stats = yield* deriveCostBackfill(write);
                row = (yield* write.rows(Schema.Struct({
                    cost: Schema.Number,
                    source: Schema.String,
                }), "SELECT estimated_cost_usd AS cost, pricing_source AS source FROM session_token_usage WHERE id = ?", ["s1"]))[0];
            }),
        ));
        expect(stats).toEqual({ scanned: 1, backfilled: 1, unpriced: 0 });
        expect(row).toEqual({ cost: 5, source: `estimated:${MODEL_PRICING_SOURCE}` });
    });

    dtest("uses the prompt and completion split", async () => {
        let cost = -1;
        await runWithPlatform(publishCacheFixture(tempDir("ax-cost-split-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.put("session_token_usage", usage("s1", "claude-opus-4-5", {
                    prompt_tokens: 1_000_000,
                    completion_tokens: 1_000_000,
                    estimated_tokens: 123,
                }));
                yield* deriveCostBackfill(write);
                cost = (yield* write.rows(Schema.Struct({ cost: Schema.Number }),
                    "SELECT estimated_cost_usd AS cost FROM session_token_usage WHERE id = ?", ["s1"]))[0]!.cost;
            }),
        ));
        expect(cost).toBe(30);
    });

    dtest("leaves unknown models null and becomes idempotent", async () => {
        let first: unknown;
        let second: unknown;
        let nullCount = -1;
        await runWithPlatform(publishCacheFixture(tempDir("ax-cost-unknown-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.putMany("session_token_usage", [
                    usage("s1", null),
                    usage("s2", "totally-unknown-model"),
                    usage("s3", "claude-opus-4-5"),
                ]);
                first = yield* deriveCostBackfill(write);
                second = yield* deriveCostBackfill(write);
                nullCount = (yield* write.rows(Schema.Struct({ count: Schema.Number }),
                    "SELECT count(*)::INTEGER AS count FROM session_token_usage WHERE estimated_cost_usd IS NULL"))[0]!.count;
            }),
        ));
        expect(first).toEqual({ scanned: 3, backfilled: 1, unpriced: 2 });
        expect(second).toEqual({ scanned: 2, backfilled: 0, unpriced: 2 });
        expect(nullCount).toBe(2);
    });
});
