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
import { queryHookInvocations, queryHookSession, queryHookSummary } from "./hooks.ts";
import { fetchHookLatencyRegression } from "./hook-latency.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("hook readers", { requireFts: true });

const hoursAgo = (h: number): Date => new Date(Date.now() - h * 60 * 60 * 1000);

/**
 * A session id in the shape the cache actually stores: BARE. `sessionRowId`
 * returns the provider's id verbatim, so there is no `session:` prefix on any
 * row - which is the whole point of the session-scoped case below.
 */
const SESSION_A = "019e2531-b552-7b53-a029-c780adbb6560";
const SESSION_B = "019e2531-ffff-7b53-a029-c780adbb6561";

const fire = (
    id: string,
    ts: Date,
    durationMs: number | null,
    exitCode: number | null,
    session: string = SESSION_A,
) => ({
    id,
    hook_event: "hook_event:1",
    session,
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

    /**
     * The session-scoped path, which the first case never reaches.
     *
     * `hook_command_invocation.session` refs `session.id`, and `sessionRowId`
     * keeps the provider id VERBATIM - so binding `session:<id>` matches no row.
     * That is not an error: the defensive read policy turns it into `[]`, so a
     * broken filter and a genuinely quiet session are indistinguishable at the
     * CLI. Only a fixture with rows on TWO sessions can tell them apart, which
     * is why both are seeded and both directions are asserted.
     */
    dtest("session-scoped reads match bare ids, and discriminate between sessions", async () => {
        const dir = tempDir("hook-readers-session");
        const fixture = await runWithPlatform(
            publishCacheFixture(dir, dylibPath, (write) =>
                Effect.gen(function* () {
                    yield* write.put("hook_command_invocation", fire("hci:a1", hoursAgo(2), 40, 0, SESSION_A));
                    yield* write.put("hook_command_invocation", fire("hci:a2", hoursAgo(1), 60, 0, SESSION_A));
                    yield* write.put("hook_command_invocation", fire("hci:b1", hoursAgo(2), 90, 1, SESSION_B));
                }),
            ),
        );
        const layer = readFixture(fixture.snapshotPath, dylibPath);

        const result = await Effect.runPromise(
            Effect.all({
                // queryHookSession, bare id - the form every caller should pass.
                sessionA: queryHookSession(SESSION_A),
                sessionB: queryHookSession(SESSION_B),
                // The same read given a Surreal-DECORATED id. A caller may still
                // hold one (an older deeplink, a copied record id), so the reader
                // normalizes DOWN rather than trusting the caller.
                sessionAPrefixed: queryHookSession(`session:${SESSION_A}`),
                sessionABackticked: queryHookSession(`session:\`${SESSION_A}\``),
                // The sessionId filter on the OTHER entry point.
                invocationsA: queryHookInvocations({ tail: 50, sessionId: SESSION_A }),
                // A session with no fires must still be empty - proof the two
                // assertions above are not just "everything matches".
                invocationsMissing: queryHookInvocations({ tail: 50, sessionId: "no-such-session" }),
            }).pipe(Effect.provide(layer)),
        );

        expect(result.sessionA).toHaveLength(2);
        expect(result.sessionA.every((row) => row.session === SESSION_A)).toBe(true);
        expect(result.sessionB).toHaveLength(1);
        expect(result.sessionB[0]!.session).toBe(SESSION_B);

        // Decorated ids resolve to the same rows as the bare one.
        expect(result.sessionAPrefixed).toHaveLength(2);
        expect(result.sessionABackticked).toHaveLength(2);

        expect(result.invocationsA).toHaveLength(2);
        expect(result.invocationsA.every((row) => row.session === SESSION_A)).toBe(true);
        expect(result.invocationsMissing).toHaveLength(0);
    });
});
