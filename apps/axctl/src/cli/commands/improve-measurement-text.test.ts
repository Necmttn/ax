/**
 * `ax improve verdict` / `ax improve checkpoint` text (#1134): the CLI has to
 * say WHY there is no suggestion. Pure formatters, tested here; the command
 * wiring that prints them is one console.log per line.
 */
import { describe, expect, test } from "bun:test";
import {
    formatCheckpointHistoryLine,
    formatCheckpointSummary,
    formatCurrentVerdictLine,
    formatVerdictListLine,
    isCurrentCheckpointRow,
    measurementReasonText,
} from "./improve.ts";

describe("measurementReasonText", () => {
    test("names the gap without inventing a waiting-for-sessions story", () => {
        expect(measurementReasonText("detector_unavailable")).toBe("no detector for this form");
        expect(measurementReasonText("no_opportunities")).toBe("no opportunities in the window");
        expect(measurementReasonText("artifact_unavailable")).toBe("no installed artifact recorded");
        expect(measurementReasonText("refresh_required")).toBe("opportunity evidence needs derivation");
        expect(measurementReasonText("retired")).toBe("experiment retired");
        expect(measurementReasonText("not_started")).toBe("artifact not installed yet");
        expect(measurementReasonText(null)).toBeNull();
    });

    test("a missing detector is never described as waiting for more sessions", () => {
        expect(measurementReasonText("detector_unavailable")).not.toContain("session");
    });
});

describe("formatVerdictListLine", () => {
    const row = (overrides: Record<string, unknown> = {}) => ({
        dedupe_sig: "abc123",
        title: "Guard resets",
        locked_verdict: null,
        latest_checkpoint: { kind: "+10s", suggested: "adopted" },
        current_reason: null,
        ...overrides,
    });

    test("a current suggestion reads as a suggestion", () => {
        expect(formatVerdictListLine(row())).toBe("  abc123  [+10s suggested: adopted]  Guard resets");
    });

    test("a locked verdict outranks the checkpoint", () => {
        expect(formatVerdictListLine(row({ locked_verdict: "partial" })))
            .toBe("  abc123  [locked: partial]  Guard resets");
    });

    test("no suggestion reads as insufficient data with its reason, never `suggested: ?`", () => {
        const line = formatVerdictListLine(row({
            latest_checkpoint: { kind: "+10s", suggested: null },
            current_reason: "no_opportunities",
        }));
        expect(line).toBe("  abc123  [+10s insufficient data: no opportunities in the window]  Guard resets");
        expect(line).not.toContain("suggested: ?");
    });

    test("a lifecycle state is reported as the state, not as a measurement", () => {
        expect(formatVerdictListLine(row({
            latest_checkpoint: { kind: "+10s", suggested: null },
            current_reason: "retired",
        }))).toBe("  abc123  [experiment retired]  Guard resets");
    });

    test("no checkpoint at all still says so", () => {
        expect(formatVerdictListLine(row({ latest_checkpoint: null, current_reason: "no_checkpoint" })))
            .toBe("  abc123  [no checkpoint yet]  Guard resets");
    });
});

describe("formatCurrentVerdictLine", () => {
    test("reports the current recommendation before any history", () => {
        expect(formatCurrentVerdictLine({
            latest_checkpoint: { kind: "+3s", suggested: "partial" },
            current_reason: null,
        })).toBe("  current       +3s suggested: partial (observed use, not proven improvement)");
    });

    test("reports the reason when there is nothing to recommend", () => {
        expect(formatCurrentVerdictLine({
            latest_checkpoint: { kind: "+3s", suggested: null },
            current_reason: "refresh_required",
        })).toBe("  current       insufficient data - opportunity evidence needs derivation");
    });
});

describe("formatCheckpointHistoryLine", () => {
    test("labels a historical row that is not the current recommendation", () => {
        const line = formatCheckpointHistoryLine({
            kind: "+3s", observed_at: "2026-01-20T00:00:00Z", suggested: "adopted",
            user_verdict: null,
            measured: { opportunities: 12, addressed: 8 },
        }, false);
        expect(line).toContain("historical");
        expect(line).toContain("opportunities=12 addressed=8");
    });

    test("an insufficient-data row shows its reason instead of a suggestion", () => {
        const line = formatCheckpointHistoryLine({
            kind: "+10s", observed_at: "2026-01-25T00:00:00Z", suggested: null,
            user_verdict: null,
            measured: {
                opportunities: 0, addressed: 0,
                measurement_status: "insufficient_data", reason: "detector_unavailable",
            },
        }, true);
        expect(line).toContain("insufficient data: no detector for this form");
        expect(line).not.toContain("suggested: ?");
    });
});

describe("isCurrentCheckpointRow", () => {
    const live = {
        latest_checkpoint: { kind: "+10s", suggested: "adopted" },
        current_reason: null,
    };

    test("the row a live recommendation came from is current", () => {
        expect(isCurrentCheckpointRow(live, { kind: "+10s" })).toBe(true);
        expect(isCurrentCheckpointRow(live, { kind: "+3s" })).toBe(false);
    });

    test("a suppressed suggestion leaves EVERY stored row historical", () => {
        // Same kind as the newest row, but the projection withheld it - so the
        // old positive answer must not be presented as the current one.
        for (const row of [
            { latest_checkpoint: { kind: "+10s", suggested: null }, current_reason: "no_opportunities" },
            { latest_checkpoint: { kind: "+10s", suggested: "adopted" }, current_reason: "retired" },
            { latest_checkpoint: null, current_reason: "no_checkpoint" },
        ]) {
            expect(isCurrentCheckpointRow(row, { kind: "+10s" })).toBe(false);
        }
    });
});

describe("formatCheckpointSummary", () => {
    const stats = (overrides: Record<string, number> = {}) => ({
        experimentsScanned: 2,
        experimentsExcluded: 1,
        checkpointsInserted: 1,
        checkpointsRefreshed: 1,
        checkpointsSkipped: 4,
        insufficientData: 1,
        cacheRefreshRequired: 0,
        ...overrides,
    });

    test("reports excluded and insufficient-data counts separately", () => {
        expect(formatCheckpointSummary(stats())).toEqual([
            "checkpoints scanned: 2 eligible experiment(s)",
            "checkpoints excluded: 1 (not installed, retired, regressed or locked)",
            "checkpoints inserted: 1",
            "checkpoints refreshed: 1",
            "checkpoints skipped: 4",
            "insufficient data: 1 window(s) - stored with no suggested verdict",
        ]);
    });

    test("a zero-write run says why, instead of always blaming due windows", () => {
        expect(formatCheckpointSummary(stats({
            checkpointsInserted: 0, checkpointsRefreshed: 0, cacheRefreshRequired: 2,
        }))).toContain(
            "2 experiment(s) need opportunity derivation - run `ax ingest`, then re-run this command",
        );
    });

    test("a zero-write run with nothing eligible names the exclusion", () => {
        expect(formatCheckpointSummary(stats({
            experimentsScanned: 0, experimentsExcluded: 3, checkpointsInserted: 0,
            checkpointsRefreshed: 0, checkpointsSkipped: 0, insufficientData: 0,
        }))).toContain(
            "No eligible experiments: 3 excluded (run `ax improve lint` to record an installed artifact)",
        );
    });

    test("a zero-write run with eligible experiments falls back to due windows", () => {
        expect(formatCheckpointSummary(stats({
            checkpointsInserted: 0, checkpointsRefreshed: 0, insufficientData: 0,
        }))).toContain(
            "No new windows due. Re-run with --force to refresh unreviewed checkpoints",
        );
    });
});
