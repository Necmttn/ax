/**
 * The windowed metrics behind `ax routing impact`, against a REAL cache.
 *
 * The window arithmetic is the whole content of this query - a `>` on one edge
 * and a `<=` on the other, so two adjacent blocks neither double-count a row nor
 * drop one - and that is exactly what a SQL-text assertion cannot check.
 */
import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { publishCacheFixture, readFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { fetchWindowMetrics } from "./io.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("routing impact io", {
    requireFts: true,
});

const at = (iso: string) => new Date(iso);

/** Two session totals, two turn costs, and four turns, spread over three days. */
const fixture = () =>
    runWithPlatform(
        publishCacheFixture(tempDir("ax-routing-io-"), dylibPath, (w) =>
            Effect.gen(function* () {
                yield* w.putMany("session", [
                    { id: "s1", project: "ax" },
                    { id: "s2", project: "ax" },
                ]);
                yield* w.putMany("session_token_usage", [
                    {
                        id: "u1",
                        session: "s1",
                        source: "claude",
                        estimated_tokens: 100n,
                        transcript_bytes: 10n,
                        estimated_cost_usd: 100,
                        ts: at("2026-08-01T12:00:00.000Z"),
                    },
                    {
                        id: "u2",
                        session: "s2",
                        source: "claude",
                        estimated_tokens: 200n,
                        transcript_bytes: 20n,
                        estimated_cost_usd: 200,
                        ts: at("2026-08-03T12:00:00.000Z"),
                    },
                ]);
                yield* w.putMany("turn", [
                    { id: "t1", session: "s1", seq: 1n, role: "assistant", ts: at("2026-08-01T12:00:00.000Z") },
                    { id: "t2", session: "s1", seq: 2n, role: "user", ts: at("2026-08-01T12:01:00.000Z") },
                    { id: "t3", session: "s2", seq: 1n, role: "assistant", ts: at("2026-08-03T12:00:00.000Z") },
                    { id: "t4", session: "s2", seq: 2n, role: "assistant", ts: at("2026-08-05T12:00:00.000Z") },
                ]);
                yield* w.putMany("turn_token_usage", [
                    {
                        id: "tu1",
                        session: "s1",
                        turn: "t1",
                        seq: 1n,
                        source: "claude",
                        estimated_tokens: 100n,
                        estimated_cost_usd: 1.5,
                        usage_source: "transcript",
                        usage_quality: "exact",
                        ts: at("2026-08-01T12:00:00.000Z"),
                    },
                    {
                        id: "tu2",
                        session: "s2",
                        turn: "t3",
                        seq: 1n,
                        source: "claude",
                        estimated_tokens: 200n,
                        estimated_cost_usd: 2.25,
                        usage_source: "transcript",
                        usage_quality: "exact",
                        ts: at("2026-08-03T12:00:00.000Z"),
                    },
                    {
                        id: "tu-unpriced",
                        session: "s2",
                        turn: "t4",
                        seq: 2n,
                        source: "claude",
                        estimated_tokens: 50n,
                        estimated_cost_usd: null,
                        usage_source: "transcript",
                        usage_quality: "exact",
                        ts: at("2026-08-10T12:00:00.000Z"),
                    },
                ]);
            }),
        ),
    );

const metricsOver = (snapshotPath: string, startIso: string, endIso: string) =>
    Effect.runPromise(
        fetchWindowMetrics(startIso, endIso).pipe(
            Effect.provide(readFixture(snapshotPath, dylibPath)),
        ) as Effect.Effect<{
            readonly tokenCostUsd: number | null;
            readonly pricedRows: number;
            readonly totalRows: number;
            readonly turns: number;
        }>,
    );

describe("fetchWindowMetrics", () => {
    dtest("sums turn-time cost and counts ASSISTANT turns inside the window", async () => {
        const f = await fixture();
        const metrics = await metricsOver(
            f.snapshotPath,
            "2026-07-31T00:00:00.000Z",
            "2026-08-04T00:00:00.000Z",
        );

        expect(metrics.tokenCostUsd).toBeCloseTo(3.75, 6);
        // t2 is a user turn and t4 is outside the window - the work proxy counts
        // neither.
        expect(metrics.turns).toBe(2);
    });

    dtest("the window is half-open, so two adjacent blocks never share a row", async () => {
        // `ax routing impact` diffs an OFF block against an ON block, and a row
        // on the shared boundary counted in both (or in neither) is a silent
        // error in the very number the command exists to report.
        const f = await fixture();
        const boundary = "2026-08-03T12:00:00.000Z";
        const before = await metricsOver(f.snapshotPath, "2026-07-31T00:00:00.000Z", boundary);
        const after = await metricsOver(f.snapshotPath, boundary, "2026-08-06T00:00:00.000Z");

        expect(before.turns).toBe(2);
        expect(after.turns).toBe(1);
        expect((before.tokenCostUsd ?? 0) + (after.tokenCostUsd ?? 0)).toBeCloseTo(3.75, 6);
    });

    dtest("an empty window is zeroes, not a failure", async () => {
        const f = await fixture();
        const metrics = await metricsOver(
            f.snapshotPath,
            "2020-01-01T00:00:00.000Z",
            "2020-01-02T00:00:00.000Z",
        );

        expect(metrics).toEqual({ tokenCostUsd: 0, pricedRows: 0, totalRows: 0, turns: 0 });
    });

    dtest("marks window cost unknown when any used row is unpriced (#998)", async () => {
        const f = await fixture();
        const metrics = await metricsOver(
            f.snapshotPath,
            "2026-08-09T00:00:00.000Z",
            "2026-08-11T00:00:00.000Z",
        );

        expect(metrics).toMatchObject({ tokenCostUsd: null, pricedRows: 0, totalRows: 1 });
    });
});
