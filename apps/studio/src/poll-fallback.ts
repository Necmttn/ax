/**
 * Polling fallback decision for the Live Ingest tab.
 *
 * On the compiled axctl binary the Durable Streams sidecar can't load (no
 * native lmdb in a single-file build), so the live stream path is dead:
 * POST /api/ingest 503s and nothing ever auto-refreshes. Instead of a dead
 * state, the Live tab drops to polling the count endpoints every
 * `POLL_INTERVAL_MS` so a CLI-driven `ax ingest` backfill is still visible.
 *
 * The streaming path stays preferred: polling engages ONLY when
 *   (a) the daemon says so up front (`live_ingest === false` on
 *       GET /api/version), or
 *   (b) POST /api/ingest came back 503 (older daemon without the flag).
 */

export const POLL_INTERVAL_MS = 5000;

export interface PollFallbackInput {
    /** `live_ingest` from GET /api/version; `undefined` = older daemon or
     *  version probe still in flight (assume streaming works). */
    readonly liveIngest: boolean | undefined;
    /** HTTP status of the last failed POST /api/ingest, if any. */
    readonly triggerStatus: number | undefined;
}

export function shouldPollFallback({ liveIngest, triggerStatus }: PollFallbackInput): boolean {
    if (liveIngest === false) return true;
    return triggerStatus === 503;
}
