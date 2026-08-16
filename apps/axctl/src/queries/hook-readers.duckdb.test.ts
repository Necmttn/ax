/**
 * The hook read surfaces against a REAL published snapshot.
 *
 * Two defect classes live here and neither is visible to a stubbed seam or to a
 * SQL-text assertion, which is why this file exists at all:
 *
 *  1. A predicate DuckDB refuses to BIND. The windowed reads use
 *     {@link daysAgoExpr}; the obvious spelling (`CURRENT_TIMESTAMP - (? *
 *     INTERVAL '1 day')`) does not run at all against the static build ax ships,
 *     because TIMESTAMPTZ arithmetic needs the ICU extension.
 *  2. A column DECODED at the wrong width. `exit_code`, `duration_ms` and
 *     `max(duration_ms)` are all BIGINT, so they arrive as JS bigints; a row
 *     contract that says `Schema.Number` fails to decode - and under the
 *     defensive read policy that surfaces as an EMPTY result, not an error.
 */
import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { publishCacheFixture, readFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { queryHookInvocations, queryHookSummary } from "./hooks.ts";
import { fetchHookLatencyRegression } from "./hook-latency.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("hook readers", { requireFts: true });

const hoursAgo = (h: number): Date => new Date(Date.now() - h * 60 * 60 * 1000);

const fire = (id: string, ts: Date, durationMs: number | null, exitCode: number | null) => ({
    id,
    hook_event: "hook_event:1",
    session: "session-1",
    ts,
    harness: "claude",
    event_name: "PreToolUse",
    hook_name: "PreToolUse:Bash",
    tool_call_id: null,
    tool_call: null,
    command: "bun ~/.ax/hooks/dispatch.ts",
    command_hash: "hash-1",
    provider_status: "success",
    effect: "allowed",
    exit_code: exitCode,
    duration_ms: durationMs,
    stdout_excerpt: null,
    stderr_excerpt: null,
    blocking_error_excerpt: null,
});

describe("hook readers over a published snapshot", () => {
    dtest("summary, invocations and latency all decode their BIGINT columns", async () => {
        const dir = tempDir("hook-readers");
        const fixture = await runWithPlatform(
            publishCacheFixture(dir, dylibPath, (write) =>
                Effect.gen(function* () {
                    // Two recent fires inside every window used below, plus one
                    // old enough that a --since window must exclude it.
                    yield* write.put("hook_command_invocation", fire("hci:1", hoursAgo(2), 40, 0));
                    yield* write.put("hook_command_invocation", fire("hci:2", hoursAgo(3), 120, 1));
                    yield* write.put(
                        "hook_command_invocation",
                        fire("hci:old", new Date(Date.now() - 60 * 24 * 60 * 60 * 1000), 5, 0),
                    );
                }),
            ),
        );
        const layer = readFixture(fixture.snapshotPath, dylibPath);

        const result = await Effect.runPromise(
            Effect.all({
                summaryAll: queryHookSummary({ tail: 50 }),
                summaryWindowed: queryHookSummary({ tail: 50, sinceDays: 7 }),
                invocations: queryHookInvocations({ tail: 50, sinceDays: 7 }),
                latency: fetchHookLatencyRegression({ recentDays: 7, baselineDays: 30 }),
            }).pipe(Effect.provide(layer)),
        );

        // One group (same command/hook/status/effect), all three rows.
        expect(result.summaryAll).toHaveLength(1);
        expect(result.summaryAll[0]!.count).toBe(3);
        // BIGINT -> number, not bigint: a wrong width would have failed the
        // decode and left this list empty.
        expect(result.summaryAll[0]!.max_duration_ms).toBe(120);
        expect(typeof result.summaryAll[0]!.max_duration_ms).toBe("number");

        // The day window is applied, so the 60-day-old fire drops out.
        expect(result.summaryWindowed[0]!.count).toBe(2);
        expect(result.invocations).toHaveLength(2);
        expect(result.invocations.map((row) => row.exit_code).sort()).toEqual([0, 1]);
        expect(result.invocations.every((row) => typeof row.duration_ms === "number")).toBe(true);

        // The latency lens reads the same column and reports the hook it saw.
        expect(result.latency.rows.map((row) => row.hook_name)).toContain("PreToolUse:Bash");
    });
});
