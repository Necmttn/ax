import { describe, expect } from "bun:test";
import { Effect, Schema } from "effect";
import { backfillInvokedPositions } from "./backfill-invoked-positions.ts";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("invoked positions", { requireFts: true });
const at = new Date("2026-06-01T00:00:00Z");

describe("backfillInvokedPositions on real DuckDB", () => {
    dtest("computes indexes, total turns, and first invocation", async () => {
        let result: unknown;
        let rows: unknown;
        await runWithPlatform(publishCacheFixture(tempDir("ax-invoked-position-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.put("session", { id: "s", source: "claude", started_at: at });
                yield* write.putMany("turn", [
                    { id: "t1", session: "s", seq: 1n, ts: at, role: "user", has_tool_use: false, has_error: false },
                    { id: "t2", session: "s", seq: 2n, ts: at, role: "assistant", has_tool_use: false, has_error: false },
                    { id: "t3", session: "s", seq: 3n, ts: at, role: "assistant", has_tool_use: false, has_error: false },
                ]);
                yield* write.putMany("invoked", [
                    { id: "i1", in_id: "t1", out_id: "skill-a", session: "s", ts: at },
                    { id: "i2", in_id: "t3", out_id: "skill-a", session: "s", ts: at },
                ]);
                result = yield* backfillInvokedPositions(write);
                rows = yield* write.rows(Schema.Struct({
                    id: Schema.String, turn_index: Schema.BigInt,
                    total_turns: Schema.BigInt, is_first: Schema.Boolean,
                }), "SELECT id, turn_index, total_turns, is_first FROM invoked ORDER BY id");
            }),
        ));
        expect(result).toEqual({ backfilled: 2, sessions: 1 });
        expect(rows).toEqual([
            { id: "i1", turn_index: 1n, total_turns: 3n, is_first: true },
            { id: "i2", turn_index: 3n, total_turns: 3n, is_first: false },
        ]);
    });

    dtest("is idempotent and preserves an existing turn index", async () => {
        let results: unknown[] = [];
        let turnIndex = 0n;
        await runWithPlatform(publishCacheFixture(tempDir("ax-invoked-idempotent-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.put("turn", { id: "t2", session: "s", seq: 2n, ts: at,
                    role: "assistant", has_tool_use: false, has_error: false });
                yield* write.put("invoked", { id: "i", in_id: "t2", out_id: "skill-a",
                    session: "s", ts: at, turn_index: 9n });
                results = [yield* backfillInvokedPositions(write), yield* backfillInvokedPositions(write)];
                turnIndex = (yield* write.rows(
                    Schema.Struct({ turn_index: Schema.BigInt }),
                    "SELECT turn_index FROM invoked",
                ))[0]!.turn_index;
            }),
        ));
        expect(results).toEqual([
            { backfilled: 1, sessions: 1 },
            { backfilled: 0, sessions: 0 },
        ]);
        expect(turnIndex).toBe(9n);
    });
});
