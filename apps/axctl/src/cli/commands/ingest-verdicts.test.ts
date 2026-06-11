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
