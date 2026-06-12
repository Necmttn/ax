import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { fetchWrappedCached, resetWrappedCacheForTest } from "./wrapped-cache.ts";

type QueryResult = Array<Record<string, unknown>>;

/** Mock that counts how many times the DB is hit. fetchWrapped issues one
 *  multi-statement query; the empty result arrays exercise its zero-data path. */
const makeCountingDb = (counter: { calls: number }): Layer.Layer<SurrealClient> => {
    const stub: SurrealClientShape = {
        query: (_sql: string) => {
            counter.calls += 1;
            // fetchWrapped destructures a long tuple of statement results; an
            // oversized list of empty arrays satisfies any statement count.
            return Effect.succeed(
                Array.from({ length: 64 }, () => [] as QueryResult) as [
                    QueryResult,
                    ...QueryResult[],
                ],
            );
        },
    } as unknown as SurrealClientShape;
    return Layer.succeed(SurrealClient, stub);
};

const run = <A>(
    eff: Effect.Effect<A, unknown, SurrealClient>,
    layer: Layer.Layer<SurrealClient>,
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
