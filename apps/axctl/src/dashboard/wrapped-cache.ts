import { fetchWrapped } from "./wrapped.ts";
import { makeTtlCachedFetch } from "./ttl-cache.ts";

/**
 * The wrapped profile is a full-graph recomputation (~20s on a year-old
 * graph) and the landing page fires BOTH /api/wrapped and
 * /api/wrapped/public-preview on mount. Staleness is acceptable: wrapped is
 * a recap surface, not realtime - a fresh ingest shows up within the TTL.
 */
const cache = makeTtlCachedFetch("wrapped", () => fetchWrapped(), "15 minutes");

export const fetchWrappedCached = cache.fetch;
export const invalidateWrappedCache = cache.invalidate;

/** Test seam: drop the cache so a fresh holder is built. */
export function resetWrappedCacheForTest(): void {
    cache.resetForTest();
}
