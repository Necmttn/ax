import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { CacheRead, type CacheReadService } from "@ax/lib/duckdb/seam";
import { fetchWrappedCached, resetWrappedCacheForTest } from "./wrapped-cache.ts";

/** Stub that counts how many `raw()` calls fetchWrapped issues. fetchWrapped
 *  fires 10 independent `read.raw(...)` queries (Effect.all, see wrapped.ts's
 *  rawRows helper); the empty rows exercise its zero-data path. */
const makeCountingDb = (counter: { calls: number }): Layer.Layer<CacheRead> => {
    const stub = {
        snapshotPath: "(test stub)",
        rows: () => Effect.succeed([]),
        first: () => Effect.void,
        raw: (_sql: string, _params?: unknown) => {
            counter.calls += 1;
            return Effect.succeed({ columns: [], rows: [], rowsChanged: 0 });
        },
    } as unknown as CacheReadService;
    return Layer.succeed(CacheRead, stub);
};

const run = <A>(
    eff: Effect.Effect<A, unknown, CacheRead>,
    layer: Layer.Layer<CacheRead>,
) => Effect.runPromise(eff.pipe(Effect.provide(layer)));

afterEach(() => {
    resetWrappedCacheForTest();
});

describe("fetchWrappedCached", () => {
    test("second call within TTL reuses the cached profile (no new DB hits)", async () => {
        const counter = { calls: 0 };
        const layer = makeCountingDb(counter);
        const first = await run(fetchWrappedCached(), layer);
        const callsAfterFirst = counter.calls;
        expect(callsAfterFirst).toBeGreaterThan(0);
        const second = await run(fetchWrappedCached(), layer);
        expect(counter.calls).toBe(callsAfterFirst);
        expect(second).toEqual(first);
    });

    test("reset seam forces a fresh compute", async () => {
        const counter = { calls: 0 };
        const layer = makeCountingDb(counter);
        await run(fetchWrappedCached(), layer);
        const callsAfterFirst = counter.calls;
        resetWrappedCacheForTest();
        await run(fetchWrappedCached(), layer);
        expect(counter.calls).toBeGreaterThan(callsAfterFirst);
    });
});
