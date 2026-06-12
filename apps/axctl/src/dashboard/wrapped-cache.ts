import { Effect } from "effect";
import type { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import type { WrappedProfile } from "@ax/lib/shared/dashboard-types";
import { fetchWrapped } from "./wrapped.ts";

/**
 * TTL-cached, single-flight wrapper around `fetchWrapped`.
 *
 * The wrapped profile is a full-graph recomputation (~20s on a year-old
 * graph) and the landing page fires BOTH /api/wrapped and
 * /api/wrapped/public-preview on mount - uncached that is two parallel
 * full computes. `Effect.cachedWithTTL` gives one compute per TTL window
 * shared by every caller; concurrent callers during a compute wait on the
 * same fiber instead of duplicating it.
 *
 * Staleness is acceptable: wrapped is a recap surface, not realtime. A
 * fresh ingest shows up within the TTL.
 */
const WRAPPED_TTL = "15 minutes";

let holder: Effect.Effect<WrappedProfile, DbError, SurrealClient> | null = null;

export const fetchWrappedCached = Effect.fn("dashboard.fetchWrappedCached")(
    function* () {
        if (holder === null) {
            // Benign cold-start race: two concurrent first calls may each build
            // a cache holder; one wins the assignment and later calls share it.
            // Worst case equals today's uncached behavior, once.
            holder = yield* Effect.cachedWithTTL(fetchWrapped(), WRAPPED_TTL);
        }
        return yield* holder;
    },
);

/** Test seam: drop the cache so a fresh holder is built. */
export function resetWrappedCacheForTest(): void {
    holder = null;
}
