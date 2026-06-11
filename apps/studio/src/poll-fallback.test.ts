import { describe, expect, test } from "bun:test";
import { POLL_INTERVAL_MS, shouldPollFallback } from "./poll-fallback.ts";

describe("shouldPollFallback (compiled-binary live-stream gap)", () => {
    test("daemon reports live_ingest=false (compiled binary) → poll", () => {
        expect(shouldPollFallback({ liveIngest: false, triggerStatus: undefined })).toBe(true);
    });

    test("daemon reports live_ingest=true (source) → stream, no polling", () => {
        expect(shouldPollFallback({ liveIngest: true, triggerStatus: undefined })).toBe(false);
    });

    test("flag unknown (older daemon / probe in flight) → prefer streaming", () => {
        expect(shouldPollFallback({ liveIngest: undefined, triggerStatus: undefined })).toBe(false);
    });

    test("flag unknown but POST /api/ingest 503'd → poll", () => {
        expect(shouldPollFallback({ liveIngest: undefined, triggerStatus: 503 })).toBe(true);
    });

    test("non-503 trigger failure (e.g. 500 mid-run error) → no polling", () => {
        expect(shouldPollFallback({ liveIngest: undefined, triggerStatus: 500 })).toBe(false);
    });

    test("flag says streaming works → a stray 503 still wins (sidecar died)", () => {
        // live_ingest=true was probed earlier; if the trigger later 503s the
        // sidecar is gone - fall back rather than dead-end.
        expect(shouldPollFallback({ liveIngest: true, triggerStatus: 503 })).toBe(true);
    });

    test("poll interval is ~5s", () => {
        expect(POLL_INTERVAL_MS).toBe(5000);
    });
});
