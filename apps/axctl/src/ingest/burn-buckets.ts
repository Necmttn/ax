/**
 * Downsample per-turn token counts into a fixed-size bucket array for the
 * sessions-list BURN sparkline. Bucket k sums the contiguous slice of turns
 * that maps onto it, so the series total is preserved and heavy turns stay
 * visible. Stored JSON-encoded on `session_token_usage.burn_buckets`.
 */
export const BURN_BUCKET_COUNT = 20;

export const computeBurnBuckets = (
    perTurnTokens: ReadonlyArray<number>,
    bucketCount: number = BURN_BUCKET_COUNT,
): number[] => {
    if (bucketCount <= 0) return [];
    const clean = perTurnTokens.map((t) => (Number.isFinite(t) && t > 0 ? Math.trunc(t) : 0));
    if (clean.length === 0) return [];
    if (clean.length <= bucketCount) return clean;
    const buckets = new Array<number>(bucketCount).fill(0);
    for (let i = 0; i < clean.length; i++) {
        const k = Math.min(bucketCount - 1, Math.floor((i * bucketCount) / clean.length));
        buckets[k] += clean[i] ?? 0;
    }
    return buckets;
};
