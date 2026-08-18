import { describe, expect, test } from "bun:test";
import {
    formatStaleIngestWarning,
    FRESHNESS_SPAWN_DEBOUNCE_MS,
    isStrandedRun,
    REAP_GRACE_SECONDS,
    shouldSpawnBackgroundIngest,
    STALE_INGEST_AFTER_HOURS,
} from "./ingest-staleness.ts";

describe("isStrandedRun", () => {
    const now = Date.parse("2026-07-16T12:00:00.000Z");
    const staleAfterMs = 960_000; // 900s ingest timeout + 60s grace

    test("strands a run whose heartbeat is older than the budget", () => {
        expect(isStrandedRun(
            { id: "ingest_run:dead", started_at: "2026-07-16T11:00:00.000Z", last_progress_at: "2026-07-16T11:30:00.000Z" },
            now,
            staleAfterMs,
        )).toBe(true);
    });

    test("spares a run whose heartbeat is within the budget", () => {
        expect(isStrandedRun(
            { id: "ingest_run:live", started_at: "2026-07-16T10:00:00.000Z", last_progress_at: "2026-07-16T11:59:00.000Z" },
            now,
            staleAfterMs,
        )).toBe(false);
    });

    test("falls back to started_at when last_progress_at is absent", () => {
        expect(isStrandedRun({ id: "a", started_at: "2026-07-16T11:58:00.000Z" }, now, staleAfterMs)).toBe(false);
        expect(isStrandedRun({ id: "b", started_at: "2026-07-16T11:00:00.000Z" }, now, staleAfterMs)).toBe(true);
    });

    test("strands a row with no parseable timestamp (can't prove it's live)", () => {
        expect(isStrandedRun({ id: "ingest_run:mystery" }, now, staleAfterMs)).toBe(true);
    });

    test("REAP_GRACE_SECONDS is the shared 60s margin doctor and the reaper both use", () => {
        expect(REAP_GRACE_SECONDS).toBe(60);
    });
});

describe("formatStaleIngestWarning", () => {
    const now = Date.parse("2026-07-16T12:00:00.000Z");
    const thresholdMs = STALE_INGEST_AFTER_HOURS * 3_600_000;

    test("no warning when the last successful ingest is inside the threshold", () => {
        expect(formatStaleIngestWarning({
            lastOkMs: now - 3_600_000,
            nowMs: now,
            thresholdMs,
        })).toBeNull();
    });

    test("warns in days once the graph is older than the threshold", () => {
        const warning = formatStaleIngestWarning({
            lastOkMs: Date.parse("2026-07-03T12:00:00.000Z"),
            nowMs: now,
            thresholdMs,
        });
        expect(warning).toContain("graph is stale");
        expect(warning).toContain("13d ago");
        expect(warning).toContain("ax ingest");
    });

    test("warns in hours just past the threshold", () => {
        const warning = formatStaleIngestWarning({
            lastOkMs: now - 50 * 3_600_000,
            nowMs: now,
            thresholdMs,
        });
        expect(warning).toContain("50h ago");
    });

    test("warns with tailored copy when no successful ingest was ever recorded", () => {
        const warning = formatStaleIngestWarning({ lastOkMs: null, nowMs: now, thresholdMs });
        expect(warning).toContain("no successful ingest");
        expect(warning).toContain("ax ingest");
    });

    test("a non-positive threshold disables the warning entirely", () => {
        expect(formatStaleIngestWarning({ lastOkMs: null, nowMs: now, thresholdMs: 0 })).toBeNull();
        expect(formatStaleIngestWarning({ lastOkMs: 0, nowMs: now, thresholdMs: 0 })).toBeNull();
    });
});

describe("isStrandedRun accepts what each engine hands it", () => {
    const staleAfterMs = 60_000;
    const now = Date.parse("2026-08-15T12:00:00.123Z");

    test("a Date heartbeat keeps its MILLISECONDS", () => {
        // The DuckDB seam decodes a TIMESTAMP to a Date. The old
        // `Date.parse(String(date))` went through "Sat Aug 15 2026 12:00:00
        // GMT+0000", which parses only to whole seconds - so a run whose last
        // heartbeat was 999ms inside the budget could read as 1ms outside it.
        const justInside = new Date(now - staleAfterMs + 1);
        const justOutside = new Date(now - staleAfterMs - 1);

        expect(isStrandedRun({ last_progress_at: justInside }, now, staleAfterMs)).toBe(false);
        expect(isStrandedRun({ last_progress_at: justOutside }, now, staleAfterMs)).toBe(true);
    });

    test("an ISO string still works - doctor's raw HTTP probe never sees a Date", () => {
        expect(
            isStrandedRun({ last_progress_at: new Date(now - 1000).toISOString() }, now, staleAfterMs),
        ).toBe(false);
    });

    test("started_at is used only when last_progress_at is ABSENT", () => {
        const fresh = new Date(now - 1000);
        expect(isStrandedRun({ started_at: fresh }, now, staleAfterMs)).toBe(false);
        // Present but unreadable: unreadable residue stays stranded rather than
        // falling back to a recent started_at and reading as live.
        expect(
            isStrandedRun({ last_progress_at: "not a date", started_at: fresh }, now, staleAfterMs),
        ).toBe(true);
    });

    test("a row with no heartbeat at all is stranded", () => {
        expect(isStrandedRun({}, now, staleAfterMs)).toBe(true);
    });
});

describe("shouldSpawnBackgroundIngest", () => {
    const now = Date.parse("2026-08-16T12:00:00.000Z");

    test("always spawns when nothing has been recorded yet", () => {
        expect(shouldSpawnBackgroundIngest({
            lastSpawnAtMs: null,
            nowMs: now,
            debounceMs: FRESHNESS_SPAWN_DEBOUNCE_MS,
        })).toBe(true);
    });

    test("refuses a second spawn inside the debounce window", () => {
        expect(shouldSpawnBackgroundIngest({
            lastSpawnAtMs: now - 1_000,
            nowMs: now,
            debounceMs: FRESHNESS_SPAWN_DEBOUNCE_MS,
        })).toBe(false);
    });

    test("spawns again once the debounce window has fully elapsed", () => {
        expect(shouldSpawnBackgroundIngest({
            lastSpawnAtMs: now - FRESHNESS_SPAWN_DEBOUNCE_MS,
            nowMs: now,
            debounceMs: FRESHNESS_SPAWN_DEBOUNCE_MS,
        })).toBe(true);
    });

    test("is exclusive at the boundary minus one ms", () => {
        expect(shouldSpawnBackgroundIngest({
            lastSpawnAtMs: now - FRESHNESS_SPAWN_DEBOUNCE_MS + 1,
            nowMs: now,
            debounceMs: FRESHNESS_SPAWN_DEBOUNCE_MS,
        })).toBe(false);
    });
});
