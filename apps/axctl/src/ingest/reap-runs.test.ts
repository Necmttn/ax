import { describe, expect, test } from "bun:test";
import { Effect, Layer, Path } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { AxConfigTest } from "@ax/lib/config";
import { makeTestSurrealClient } from "@ax/lib/testing/surreal";
import { reapStaleIngestRuns, selectStrandedRunIds } from "./reap-runs.ts";

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

describe("reapStaleIngestRuns (real seam)", () => {
    // One stranded row (heartbeat in 2020) + one live row (heartbeat now). Only
    // the DB leaf is faked; the reap logic under test is the real one.
    const rows = () => [
        { id: "ingest_run:⟨070849df-4eba-4545-bd3d-c8e47d3e751a⟩", started_at: "2020-01-01T00:00:00.000Z" },
        { id: "ingest_run:live", started_at: new Date().toISOString(), last_progress_at: new Date().toISOString() },
    ];

    const harness = () => {
        const tc = makeTestSurrealClient({
            routes: { "FROM ingest_run WHERE status = 'running'": [rows()] },
        });
        const layer = Layer.mergeAll(
            tc.layer,
            AxConfigTest({ knobs: { ingestTimeoutSeconds: 900 } }).pipe(Layer.provide(BunFileSystem.layer)),
            BunFileSystem.layer,
            Path.layer,
        );
        return { tc, layer };
    };

    test("finalizes the stranded row as partial and leaves the live one alone", async () => {
        const { tc, layer } = harness();
        const result = await Effect.runPromise(reapStaleIngestRuns().pipe(Effect.provide(layer)));

        expect(result.reaped).toBe(1);
        expect(result.ids).toEqual(["070849df-4eba-4545-bd3d-c8e47d3e751a"]);

        // The observable effect: an UPDATE actually went to the DB for the dead
        // row, settling it as "partial" with the reaped marker.
        const updates = tc.captured.filter((sql) => sql.startsWith("UPDATE ingest_run:"));
        expect(updates).toHaveLength(1);
        expect(updates[0]).toContain("070849df-4eba-4545-bd3d-c8e47d3e751a");
        expect(updates[0]).toContain(`status = "partial"`);
        expect(updates[0]).toContain("reaped");
        expect(updates.join()).not.toContain("live");
    });

    test("dry-run reports the row but issues no UPDATE", async () => {
        const { tc, layer } = harness();
        const result = await Effect.runPromise(reapStaleIngestRuns({ dryRun: true }).pipe(Effect.provide(layer)));

        expect(result.found).toBe(1);
        expect(result.reaped).toBe(0);
        expect(tc.captured.filter((sql) => sql.startsWith("UPDATE ingest_run:"))).toHaveLength(0);
    });
});
