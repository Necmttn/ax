import { Effect, type Duration } from "effect";

/**
 * TTL-cached, single-flight fetch with manual invalidation - the serving
 * pattern for the dashboard's expensive read endpoints (wrapped profile,
 * next actions, skill triage). One compute per TTL window shared by every
 * caller; concurrent callers during a compute wait on the same fiber.
 * Mutating endpoints call `invalidate` so their effects show immediately
 * instead of waiting out the TTL.
 *
 * The holder is module-scoped per cache (closure state inside
 * `Effect.cachedInvalidateWithTTL`), so it survives across requests and
 * runtime rebuilds. Benign cold-start race: two concurrent first calls may
 * each build a holder; one wins, costing at most one duplicate compute.
 */
export interface TtlCachedFetch<A, E, R> {
    readonly fetch: () => Effect.Effect<A, E, R>;
    readonly invalidate: () => Effect.Effect<void>;
    /** Test seam: drop the holder so the next fetch rebuilds it. */
    readonly resetForTest: () => void;
}

export const makeTtlCachedFetch = <A, E, R>(
    name: string,
    make: () => Effect.Effect<A, E, R>,
    ttl: Duration.Input,
): TtlCachedFetch<A, E, R> => {
    let holder: readonly [Effect.Effect<A, E, R>, Effect.Effect<void>] | null = null;
    const ensure = Effect.gen(function* () {
        if (holder === null) {
            holder = yield* Effect.cachedInvalidateWithTTL(make(), ttl);
        }
        return holder;
    });
    return {
        fetch: Effect.fn(`dashboard.${name}.cached`)(function* () {
            const [cached, invalidate] = yield* ensure;
            // cachedInvalidateWithTTL stores the EXIT - a failed or
            // interrupted compute would otherwise be served instantly for the
            // whole TTL window. Never cache failures: drop the entry so the
            // next caller recomputes.
            return yield* cached.pipe(Effect.tapCause(() => invalidate));
        }),
        invalidate: Effect.fn(`dashboard.${name}.invalidate`)(function* () {
            if (holder !== null) {
                yield* holder[1];
            }
        }),
        resetForTest: () => {
            holder = null;
        },
    };
};
