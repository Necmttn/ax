import { describe, expect, test } from "bun:test";
import {
    formatStaleIngestWarning,
    isStrandedRun,
    REAP_GRACE_SECONDS,
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
