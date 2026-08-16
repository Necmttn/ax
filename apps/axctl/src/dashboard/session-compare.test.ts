import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { publishCacheFixture, readThroughFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { computeWinners, fetchSessionCompare } from "./session-compare.ts";
import type { SessionCompareEntry, SessionId, SessionTokenUsageDetail } from "@ax/lib/shared/dashboard-types";

const sid = (s: string): SessionId => s as unknown as SessionId;

const usage = (over: Partial<SessionTokenUsageDetail> = {}): SessionTokenUsageDetail => ({
    model: "claude-opus-4-8",
    prompt_tokens: null,
    completion_tokens: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    estimated_tokens: 1_000,
    estimated_cost_usd: null,
    pricing_source: null,
    ...over,
});

const entry = (over: Partial<SessionCompareEntry> & { session_id: SessionId }): SessionCompareEntry => ({
    source: "claude",
    model: "claude-opus-4-8",
    project: null,
    started_at: null,
    ended_at: null,
    duration_ms: null,
    token_usage: null,
    health: null,
    commit_count: 0,
    noise_score: null,
    ...over,
});

const A = sid("a-session");
const B = sid("b-session");

describe("computeWinners - cheapest with unknown costs (#175)", () => {
    test("no cheapest winner when any session's cost is unknown", () => {
        const winners = computeWinners([
            entry({ session_id: A, token_usage: usage({ estimated_cost_usd: 209 }) }),
            entry({ session_id: B, token_usage: usage({ estimated_cost_usd: null }) }),
        ]);
        // B's cost is UNKNOWN, not $0 - the priced session must not win by default.
        expect(winners.cheapest).toBeNull();
    });

    test("no cheapest winner when a session has no token usage at all", () => {
        const winners = computeWinners([
            entry({ session_id: A, token_usage: usage({ estimated_cost_usd: 1.5 }) }),
            entry({ session_id: B, token_usage: null }),
        ]);
        expect(winners.cheapest).toBeNull();
    });

    test("cheapest awarded when every session has a known cost", () => {
        const winners = computeWinners([
            entry({ session_id: A, token_usage: usage({ estimated_cost_usd: 3.4 }) }),
            entry({ session_id: B, token_usage: usage({ estimated_cost_usd: 5.1 }) }),
        ]);
        expect(winners.cheapest).toBe(A);
    });

    test("tied costs → no cheapest winner", () => {
        const winners = computeWinners([
            entry({ session_id: A, token_usage: usage({ estimated_cost_usd: 2 }) }),
            entry({ session_id: B, token_usage: usage({ estimated_cost_usd: 2 }) }),
        ]);
        expect(winners.cheapest).toBeNull();
    });

    test("fewest_tokens unaffected by unknown costs", () => {
        const winners = computeWinners([
            entry({ session_id: A, token_usage: usage({ estimated_tokens: 100 }) }),
            entry({ session_id: B, token_usage: usage({ estimated_tokens: 900 }) }),
        ]);
        expect(winners.fewest_tokens).toBe(A);
    });
});

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("session-compare");

describe("fetchSessionCompare (DuckDB fixture)", () => {
    dtest("joins overview, token usage, health and produced count per session; flags a missing id", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-session-compare-"), dylibPath, (w: CacheWriteService) =>
                Effect.gen(function* () {
                    yield* w.putMany("session", [
                        {
                            id: "session-s1",
                            source: "claude",
                            model: "claude-opus-4-8",
                            project: "ax",
                            started_at: new Date("2026-05-28T00:00:00.000Z"),
                            ended_at: new Date("2026-05-28T00:10:00.000Z"),
                        },
                    ]);
                    yield* w.putMany("session_token_usage", [
                        { id: "stu1", session: "session-s1", source: "claude", estimated_tokens: 500, transcript_bytes: 100 },
                    ]);
                    yield* w.putMany("session_health", [
                        { id: "sh1", session: "session-s1", source: "claude", tool_errors: 1, user_corrections: 2, interruptions: 0, task_label: "fix the bug" },
                    ]);
                    yield* w.putMany("produced", [{ id: "p1", in_id: "session-s1", out_id: "c1", ts: new Date() }]);
                    yield* w.putMany("turn", [
                        { id: "t1", session: "session-s1", seq: 1, ts: new Date("2026-05-28T00:00:00.000Z"), role: "user" },
                        { id: "t2", session: "session-s1", seq: 2, ts: new Date("2026-05-28T00:01:00.000Z"), role: "assistant" },
                    ]);
                }),
            ),
        );

        const result = await readThroughFixture(
            fixture,
            dylibPath,
            fetchSessionCompare(["session-s1", "does-not-exist"], { includeTurns: true }),
        );

        expect(result.not_found).toEqual(["does-not-exist"]);
        expect(result.sessions).toHaveLength(1);
        const [s1] = result.sessions;
        expect(s1).toMatchObject({
            session_id: "session-s1",
            duration_ms: 10 * 60 * 1000,
            commit_count: 1,
            noise_score: 3, // tool_errors(1) + user_corrections(2) + interruptions(0)
        });
        expect(s1?.health?.task_label).toBe("fix the bug");
        expect(s1?.token_usage?.estimated_tokens).toBe(500);
        expect(s1?.turns).toHaveLength(2);
        expect(s1?.turns?.[0]).toMatchObject({ seq: 1, role: "user" });
    });
});
