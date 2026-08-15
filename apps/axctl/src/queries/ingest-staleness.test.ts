import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { cacheReadResults, runWithCacheRead } from "../testing/cache-read.ts";
import {
    fetchLastSuccessfulIngestAt,
    staleIngestThresholdMs,
    withIngestStalenessPreflight,
} from "./ingest-staleness.ts";

describe("staleIngestThresholdMs", () => {
    test("uses the default and accepts an explicit disable", () => {
        expect(staleIngestThresholdMs({} as NodeJS.ProcessEnv)).toBe(48 * 3_600_000);
        expect(staleIngestThresholdMs({ AX_STALE_INGEST_HOURS: "0" } as NodeJS.ProcessEnv)).toBe(0);
        expect(staleIngestThresholdMs({ AX_STALE_INGEST_HOURS: " " } as NodeJS.ProcessEnv)).toBe(48 * 3_600_000);
    });
});

describe("fetchLastSuccessfulIngestAt", () => {
    test("uses ended_at and falls back to started_at", async () => {
        const ended = new Date("2026-07-03T12:00:00.000Z");
        const started = new Date("2026-07-03T11:50:00.000Z");
        expect(await runWithCacheRead(fetchLastSuccessfulIngestAt, cacheReadResults([[{ ended_at: ended, started_at: started }]]))).toBe(ended.getTime());
        expect(await runWithCacheRead(fetchLastSuccessfulIngestAt, cacheReadResults([[{ ended_at: null, started_at: started }]]))).toBe(started.getTime());
    });

    test("returns null without a successful run", async () => {
        expect(await runWithCacheRead(fetchLastSuccessfulIngestAt, cacheReadResults([[]]))).toBeNull();
    });
});

test("the stale check runs before the command", async () => {
    const events: string[] = [];
    const fresh = new Date();
    await runWithCacheRead(
        withIngestStalenessPreflight(Effect.sync(() => events.push("command"))),
        cacheReadResults([[{ ended_at: fresh, started_at: fresh }]]),
    );
    expect(events).toEqual(["command"]);
});
