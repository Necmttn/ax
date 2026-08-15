import { describe, expect, test } from "bun:test";
import { selectStrandedRunIds } from "./reap-runs.ts";

describe("selectStrandedRunIds", () => {
    const now = Date.parse("2026-06-16T12:00:00.000Z");
    const staleAfterMs = 960_000; // 900s timeout + 60s grace

    test("reaps a run whose heartbeat is older than the budget", () => {
        const rows = [
            { id: "ingest_run:dead", started_at: "2026-06-16T11:00:00.000Z", last_progress_at: "2026-06-16T11:30:00.000Z" },
        ];
        expect(selectStrandedRunIds(rows, now, staleAfterMs)).toEqual(["dead"]);
    });

    test("spares a run whose heartbeat is within the budget", () => {
        const rows = [
            { id: "ingest_run:live", started_at: "2026-06-16T10:00:00.000Z", last_progress_at: "2026-06-16T11:59:00.000Z" },
        ];
        expect(selectStrandedRunIds(rows, now, staleAfterMs)).toEqual([]);
    });

    test("falls back to started_at when last_progress_at is absent", () => {
        const rows = [
            { id: "ingest_run:nohb", started_at: "2026-06-16T11:58:00.000Z" }, // 2min ago -> live
            { id: "ingest_run:oldhb", started_at: "2026-06-16T11:00:00.000Z" }, // 1h ago -> stranded
        ];
        expect(selectStrandedRunIds(rows, now, staleAfterMs)).toEqual(["oldhb"]);
    });

    test("reaps a row with no parseable timestamp (can't prove it's live)", () => {
        const rows = [{ id: "ingest_run:mystery" }];
        expect(selectStrandedRunIds(rows, now, staleAfterMs)).toEqual(["mystery"]);
    });

    test("strips the ingest_run: prefix and backticks to a bare id", () => {
        const rows = [{ id: "ingest_run:`weird-id`" }];
        expect(selectStrandedRunIds(rows, now, staleAfterMs)).toEqual(["weird-id"]);
    });

    test("strips angle-bracket escaping on uuid-form ids", () => {
        const rows = [{ id: "ingest_run:⟨070849df-4eba-4545-bd3d-c8e47d3e751a⟩" }];
        expect(selectStrandedRunIds(rows, now, staleAfterMs)).toEqual(["070849df-4eba-4545-bd3d-c8e47d3e751a"]);
    });
});
