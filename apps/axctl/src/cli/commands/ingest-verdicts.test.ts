/**
 * One-line ingest verdicts (#265/#266): exit-path messages for timeout,
 * failure, and clean-with-skips runs. Pure formatters - the exit-code wiring
 * itself lives in cmdIngest and is exercised via the ingest-lock outcome
 * tests (src/ingest/ingest-lock.test.ts).
 */
import { describe, expect, test } from "bun:test";
import {
    formatIngestFailedVerdict,
    formatIngestSkipSummary,
    formatIngestTimeoutVerdict,
    formatMaintenanceSummary,
} from "./ingest.ts";

describe("ingest verdict lines", () => {
    test("timeout verdict names the env knob and the resume command", () => {
        const line = formatIngestTimeoutVerdict("ingest", 900);
        expect(line).toBe(
            "ingest: timed out after 900s (AX_INGEST_TIMEOUT_SECONDS) - " +
                "progress saved, re-run 'ax ingest' to continue",
        );
    });

    test("timeout verdict maps ingest-here to the real CLI spelling", () => {
        expect(formatIngestTimeoutVerdict("ingest-here", 60)).toContain(
            "re-run 'ax ingest here' to continue",
        );
    });

    test("failed verdict carries session count and first error", () => {
        expect(formatIngestFailedVerdict(1134, "DbError: connection reset")).toBe(
            "ingest: FAILED after 1134 sessions - DbError: connection reset",
        );
    });

    test("skip summary reports per-file isolation count", () => {
        expect(formatIngestSkipSummary(3)).toBe(
            "ingest: ok - 3 file(s) skipped (per-file isolation; retried next run)",
        );
    });
});

describe("formatMaintenanceSummary", () => {
    test("reports otel + blob gc counts on the happy path", () => {
        const line = formatMaintenanceSummary({
            otel: {
                deletedByTable: { otel_metric_point: 1, otel_span: 2, otel_log_event: 5 },
                deletedEdges: 3,
            },
            blobGc: { scanned: 10, removed: 4, failed: 0, skipped: false },
        });
        expect(line).toBe(
            "ingest: maintenance - otel pruned 8 row(s) + 3 edge(s); blob gc removed 4/10 blob(s)",
        );
    });

    test("surfaces a blob gc skip reason instead of counts", () => {
        const line = formatMaintenanceSummary({
            blobGc: { scanned: 0, removed: 0, failed: 0, skipped: true, skipReason: "empty reference set" },
        });
        expect(line).toBe("ingest: maintenance - blob gc skipped (empty reference set)");
    });

    test("surfaces per-file remove failures alongside the removed count", () => {
        const line = formatMaintenanceSummary({
            blobGc: { scanned: 5, removed: 3, failed: 2, skipped: false },
        });
        expect(line).toBe("ingest: maintenance - blob gc removed 3/5 blob(s), 2 failed");
    });

    test("reports a failure reason instead of counts when a half errors", () => {
        const line = formatMaintenanceSummary({
            otelError: "DbError: connection reset",
            blobGcError: "PlatformError: EACCES",
        });
        expect(line).toBe(
            "ingest: maintenance - otel retention FAILED - DbError: connection reset; " +
                "blob gc FAILED - PlatformError: EACCES",
        );
    });
});
