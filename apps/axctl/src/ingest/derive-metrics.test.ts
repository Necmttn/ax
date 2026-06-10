import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { deriveMetrics } from "./derive-metrics.ts";
import { SurrealClient } from "@ax/lib/db";

// Capture UPSERTs to session_metrics; serve canned reads. The query-routing
// order matters: the dirty-set query (`... FROM session WHERE ... OR id IN
// (SELECT VALUE in FROM produced WHERE out.reverted = true)`) contains BOTH
// `FROM session` and `FROM produced`, so it must be matched (by `FROM session
// WHERE`) BEFORE the durability/time-to-land `FROM produced` branch.
const makeDb = (sink: string[]) =>
    Layer.succeed(SurrealClient, {
        query: <T>(sql: string) => {
            if (/UPSERT session_metrics|UPDATE commit|DELETE fragility_cascade/.test(sql)) {
                sink.push(sql);
                return Effect.succeed([[]] as unknown as T);
            }
            // commit-reverted existing-true set; "WHERE out.reverted" won't match.
            if (/WHERE reverted = true/.test(sql)) return Effect.succeed([[]] as unknown as T);
            // dirty-set: a VALUE select returning one dirty session id.
            if (/FROM session WHERE/.test(sql)) return Effect.succeed([["session:`s1`"]] as unknown as T);
            if (/FROM commit\b/.test(sql)) return Effect.succeed([[]] as unknown as T);
            if (/FROM touched/.test(sql)) return Effect.succeed([[]] as unknown as T);
            if (/FROM session_health/.test(sql)) return Effect.succeed([[]] as unknown as T);
            // durability (and time-to-land, harmlessly) aggregate.
            if (/FROM produced/.test(sql)) {
                return Effect.succeed([[{ session: "session:`s1`", produced: 2, reverted: 0 }]] as unknown as T);
            }
            if (/FROM tool_call/.test(sql)) return Effect.succeed([[]] as unknown as T);
            // wave-2: delegation spawn edges (none) - keeps the compute deref-free.
            if (/FROM spawned/.test(sql)) return Effect.succeed([[]] as unknown as T);
            return Effect.succeed([[]] as unknown as T);
        },
    } as never);

describe("deriveMetrics", () => {
    test("recomputes commit.reverted then UPSERTs one row per dirty session", async () => {
        const sink: string[] = [];
        const stats = await Effect.runPromise(deriveMetrics({ sinceDays: 1 }).pipe(Effect.provide(makeDb(sink))));
        expect(sink.some((s) => /UPSERT session_metrics/.test(s) && s.includes("session:`s1`"))).toBe(true);
        // wave-2 fields are present in the UPSERT CONTENT.
        expect(sink.some((s) => /cold_start_reads:/.test(s) && /delegation_ratio:/.test(s) && /time_to_first_edit_ms:/.test(s)))
            .toBe(true);
        expect(stats.sessionsWritten).toBe(1);
        // Fragility-cascade precompute runs on the dirty path: with no reverted
        // commits it writes 0 edges but still rewrites (clears) the table.
        expect(stats.cascadeEdges).toBe(0);
        expect(sink.some((s) => /DELETE fragility_cascade;/.test(s))).toBe(true);
    });

    // PR-driven dirty source (issue #172): an OLD session (outside the window)
    // whose PR merge state changed must land in the dirty set, and the
    // pr_merge watermark must advance only AFTER session_metrics is written.
    test("PR merge-state change pulls an out-of-window session into the dirty set", async () => {
        const sink: string[] = [];
        const db = Layer.succeed(SurrealClient, {
            query: <T>(sql: string) => {
                if (/UPSERT session_metrics|UPDATE commit|DELETE fragility_cascade|UPSERT ingest_file_state|DELETE ingest_file_state/.test(sql)) {
                    sink.push(sql);
                    return Effect.succeed([[]] as unknown as T);
                }
                if (/WHERE reverted = true/.test(sql)) return Effect.succeed([[]] as unknown as T);
                // PR snapshot: one merged PR, never seen by the watermark.
                if (/FROM pull_request/.test(sql)) {
                    return Effect.succeed([[{ id: "pull_request:`p1`", merge_sha: "abc123", merged_at: "2026-06-01T00:00:00Z" }]] as unknown as T);
                }
                if (/FROM ingest_file_state/.test(sql)) return Effect.succeed([[]] as unknown as T);
                // sha → commit resolution for the changed merge sha (resolves,
                // so the PR's watermark row is advanceable).
                if (/FROM commit WHERE sha IN/.test(sql)) {
                    return Effect.succeed([[{ id: "commit:`c9`", sha: "abc123" }]] as unknown as T);
                }
                // The windowed dirty query returns NOTHING - the session is old.
                if (/FROM session WHERE/.test(sql)) return Effect.succeed([[]] as unknown as T);
                if (/FROM commit\b/.test(sql)) return Effect.succeed([[]] as unknown as T);
                if (/FROM touched/.test(sql)) return Effect.succeed([[]] as unknown as T);
                if (/FROM session_health/.test(sql)) return Effect.succeed([[]] as unknown as T);
                // commit → producing session (the pr-merge dirty resolution).
                if (/SELECT VALUE type::string\(in\) FROM produced WHERE out IN/.test(sql)) {
                    return Effect.succeed([["session:`oldS`"]] as unknown as T);
                }
                if (/FROM produced/.test(sql)) {
                    return Effect.succeed([[{ session: "session:`oldS`", produced: 1, reverted: 0 }]] as unknown as T);
                }
                if (/FROM tool_call|FROM spawned/.test(sql)) return Effect.succeed([[]] as unknown as T);
                return Effect.succeed([[]] as unknown as T);
            },
        } as never);

        const stats = await Effect.runPromise(deriveMetrics({ sinceDays: 1 }).pipe(Effect.provide(db)));
        expect(stats.sessionsWritten).toBe(1);
        const metricsIdx = sink.findIndex((s) => /UPSERT session_metrics/.test(s) && s.includes("session:`oldS`"));
        expect(metricsIdx).toBeGreaterThanOrEqual(0);
        // Crash-safety: the pr_merge watermark advances AFTER the rollup write.
        const watermarkIdx = sink.findIndex((s) => /UPSERT ingest_file_state:/.test(s) && s.includes("metrics:pr_merge"));
        expect(watermarkIdx).toBeGreaterThan(metricsIdx);
    });

    // Remote-merge race: gh saw the merge but git ingest hasn't fetched the
    // commit yet. The PR's watermark row must NOT advance (it would record the
    // PR as handled with no recompute) - the empty-dirty path advances only the
    // resolved diff, which excludes the deferred PR.
    test("PR with an unresolvable merge sha does NOT advance the pr_merge watermark", async () => {
        const sink: string[] = [];
        const db = Layer.succeed(SurrealClient, {
            query: <T>(sql: string) => {
                if (/UPSERT session_metrics|UPDATE commit|DELETE fragility_cascade|UPSERT ingest_file_state|DELETE ingest_file_state/.test(sql)) {
                    sink.push(sql);
                    return Effect.succeed([[]] as unknown as T);
                }
                if (/WHERE reverted = true/.test(sql)) return Effect.succeed([[]] as unknown as T);
                if (/FROM pull_request/.test(sql)) {
                    return Effect.succeed([[{ id: "pull_request:`p1`", merge_sha: "notLocalYet", merged_at: "2026-06-01T00:00:00Z" }]] as unknown as T);
                }
                if (/FROM ingest_file_state/.test(sql)) return Effect.succeed([[]] as unknown as T);
                // The merge sha is NOT in the local commit graph.
                if (/FROM commit WHERE sha IN/.test(sql)) return Effect.succeed([[]] as unknown as T);
                if (/FROM session WHERE/.test(sql)) return Effect.succeed([[]] as unknown as T);
                return Effect.succeed([[]] as unknown as T);
            },
        } as never);

        const stats = await Effect.runPromise(deriveMetrics({ sinceDays: 1 }).pipe(Effect.provide(db)));
        expect(stats.sessionsWritten).toBe(0);
        // No pr_merge watermark row was written - the PR re-diffs next run.
        expect(sink.some((s) => /UPSERT ingest_file_state:/.test(s) && s.includes("metrics:pr_merge"))).toBe(false);
    });
});
