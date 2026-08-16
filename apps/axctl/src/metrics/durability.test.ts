import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { computeDurability as computeDurabilityWithRead } from "./durability.ts";
import { CacheRead } from "@ax/lib/duckdb/seam";
import { makeTestCacheRead } from "@ax/lib/testing/cache";

const db = (rows: Array<Record<string, unknown>>) =>
    makeTestCacheRead({ fallback: rows }).layer;
const computeDurability = (ids: readonly string[]) => Effect.gen(function* () {
    const read = yield* CacheRead;
    return yield* computeDurabilityWithRead(read, ids);
});

describe("computeDurability", () => {
    test("ratio = durable / produced, reading commit.reverted", async () => {
        const rows = [
            { session: "session:`s1`", produced: 4, reverted: 1 },
            { session: "session:`s2`", produced: 2, reverted: 0 },
        ];
        const out = await Effect.runPromise(computeDurability(["session:`s1`", "session:`s2`"]).pipe(Effect.provide(db(rows))));
        expect(out.get("session:`s1`")).toEqual({ produced: 4, reverted: 1, ratio: 0.75 });
        expect(out.get("session:`s2`")).toEqual({ produced: 2, reverted: 0, ratio: 1 });
    });
    test("no produced commits → ratio null, not 0", async () => {
        const rows = [{ session: "session:`s3`", produced: 0, reverted: 0 }];
        const out = await Effect.runPromise(computeDurability(["session:`s3`"]).pipe(Effect.provide(db(rows))));
        expect(out.get("session:`s3`")).toEqual({ produced: 0, reverted: 0, ratio: null });
    });
    test("session missing from the GROUP BY result defaults to produced 0 / ratio null", async () => {
        const out = await Effect.runPromise(computeDurability(["session:`sX`"]).pipe(Effect.provide(db([]))));
        expect(out.get("session:`sX`")).toEqual({ produced: 0, reverted: 0, ratio: null });
    });
});
