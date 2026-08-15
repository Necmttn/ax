import { Effect, Layer, Option } from "effect";
import { CacheRead, type CacheReadService } from "@ax/lib/duckdb/seam";

/** A typed seam stub for tests of pure row transforms. Database behavior uses real fixtures. */
export const cacheReadResults = (
    results: ReadonlyArray<ReadonlyArray<unknown>>,
): Layer.Layer<CacheRead> => {
    let index = 0;
    const next = () => results[index++] ?? [];
    const service: CacheReadService = {
        snapshotPath: "(test)",
        rows: () => Effect.succeed(next() as never),
        first: () => Effect.succeed(Option.fromNullable(next()[0]) as never),
        raw: () => Effect.die("raw reads are not available in this test seam"),
    };
    return Layer.succeed(CacheRead, service);
};

export const runWithCacheRead = <A, E>(
    effect: Effect.Effect<A, E, CacheRead>,
    layer: Layer.Layer<CacheRead>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(layer)));
