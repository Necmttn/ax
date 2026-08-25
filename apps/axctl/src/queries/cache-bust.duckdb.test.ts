/**
 * The cache-bust model + `fetchCacheBustCost` (#868) end-to-end against a
 * REAL published DuckDB snapshot.
 *
 * Pins what a mocked seam cannot see:
 *  1. The model materializes ONLY reason-carrying rows with the ingest cache
 *     cost. Query-time corroboration compares full root transcript cost with
 *     independent OTLP cost once per root.
 *  2. The read window actually FILTERS (one bust is seeded 60 days back).
 *  3. Coverage is claude-only (a codex usage row must not inflate the
 *     denominator) while the reason rollup itself is provider-agnostic.
 *  4. The version-marked cutover: first run rebuilds, second run with the
 *     same SQL is windowed + idempotent (same row count, no duplicates).
 */
import { describe, expect } from "bun:test";
import { Effect, Schema } from "effect";
import { CacheRead, type CacheWriteService } from "@ax/lib/duckdb/seam";
import { publishCacheFixture, readFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { evaluateCacheLensCandidate } from "../ingest/derive-proposals.ts";
import { runCacheBustModels, type CacheBustModelStats } from "../ingest/models/cache-bust-models.ts";
import { fetchCacheBustCost, fetchCacheLensCandidates } from "./cache-bust.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("cache bust cost", { requireFts: true });

const hoursAgo = (h: number): Date => new Date(Date.now() - h * 60 * 60 * 1000);
const daysAgo = (d: number): Date => new Date(Date.now() - d * 24 * 60 * 60 * 1000);

const SESSION_A = "019e2531-b552-7b53-a029-c780adbb6560";
const SESSION_B = "019e2531-ffff-7b53-a029-c780adbb6561";
const SESSION_C = "019e2531-aaaa-7b53-a029-c780adbb6562";
const SESSION_D = "019e2531-bbbb-7b53-a029-c780adbb6563";

interface UsageSeed {
    readonly id: string;
    readonly session: string;
    readonly seq: number;
    readonly ts: Date;
    readonly source: string;
    readonly cacheCreationTokens: bigint;
    readonly cacheCreationUsd: number | null;
    readonly estimatedCostUsd?: number;
    readonly skill?: string | null;
    readonly agent?: string | null;
    readonly cacheMiss?: string | null;
}

const usageRow = (seed: UsageSeed) => ({
    id: seed.id,
    session: seed.session,
    turn: seed.id,
    seq: seed.seq,
    source: seed.source,
    model: "claude-opus-4-8",
    model_ref: null,
    prompt_tokens: 1000n,
    completion_tokens: 100n,
    cache_creation_input_tokens: seed.cacheCreationTokens,
    cache_read_input_tokens: 0n,
    fresh_input_tokens: 1000n,
    estimated_tokens: 1100n,
    estimated_cache_creation_cost_usd: seed.cacheCreationUsd,
    estimated_cost_usd: seed.estimatedCostUsd ?? (seed.cacheCreationUsd ?? 0) + 1,
    usage_source: "claude_transcript.message_usage",
    usage_quality: "provider_turn",
    attribution_skill: seed.skill ?? null,
    attribution_agent: seed.agent ?? null,
    cache_miss_reason_type: seed.cacheMiss ?? null,
    api_error_status: null,
    ts: seed.ts,
});

const otlpCostRow = (id: string, sessionId: string, value: number) => ({
    id,
    harness: "claude",
    metric: "claude_code.cost.usage",
    value,
    unit: "USD",
    session_id: sessionId,
    model: null,
    skill_name: null,
    agent_name: null,
    attrs: null,
    observed_at: hoursAgo(1),
});

const seedFixture = (write: CacheWriteService) =>
    Effect.gen(function* () {
        yield* write.putMany("turn_token_usage", [
            // This root has a current bust, a normal usage row, and an older
            // usage row. Root corroboration includes all three costs.
            usageRow({
                id: "ttu:1", session: SESSION_A, seq: 1, ts: hoursAgo(2), source: "claude",
                cacheCreationTokens: 1_000_000n, cacheCreationUsd: 20,
                skill: "superpowers:subagent-driven-development", cacheMiss: "messages_changed",
            }),
            usageRow({
                id: "ttu:2", session: SESSION_B, seq: 1, ts: hoursAgo(3), source: "claude-subagent",
                cacheCreationTokens: 200_000n, cacheCreationUsd: 4,
                agent: "design-curator", cacheMiss: "previous_message_not_found",
            }),
            // No reason: contributes to the coverage denominator only.
            usageRow({
                id: "ttu:3", session: SESSION_A, seq: 2, ts: hoursAgo(4), source: "claude",
                cacheCreationTokens: 500_000n, cacheCreationUsd: 10,
            }),
            // OUTSIDE the 7-day read window - proves the bound filters.
            usageRow({
                id: "ttu:old", session: SESSION_A, seq: 3, ts: daysAgo(60), source: "claude",
                cacheCreationTokens: 100_000n, cacheCreationUsd: 2,
                cacheMiss: "messages_changed",
            }),
            // A codex row - no reason today, must not enter claude coverage.
            usageRow({
                id: "ttu:codex", session: SESSION_B, seq: 4, ts: hoursAgo(1), source: "codex",
                cacheCreationTokens: 300_000n, cacheCreationUsd: 6,
            }),
        ]);
        yield* write.putMany("otel_metric_point", [
            otlpCostRow("otel:a", SESSION_A, 35),
            otlpCostRow("otel:b", SESSION_B, 5),
        ]);
    });

describe("cache-bust model + fetchCacheBustCost over a published snapshot", () => {
    dtest("removes a recent bust when reparse clears its cache miss reason", async () => {
        let before = -1;
        let after = -1;
        await runWithPlatform(
            publishCacheFixture(tempDir("cache-bust-cleared-reason"), dylibPath, (write) =>
                Effect.gen(function* () {
                    yield* write.put("turn_token_usage", usageRow({
                        id: "ttu:cleared", session: SESSION_A, seq: 1, ts: hoursAgo(2), source: "claude",
                        cacheCreationTokens: 100_000n, cacheCreationUsd: 2,
                        cacheMiss: "cold",
                    }));
                    yield* runCacheBustModels(write, 1);
                    const beforeRows = yield* write.rows(
                        Schema.Struct({ n: Schema.Number }),
                        "SELECT count(*)::INTEGER AS n FROM cache_bust_event WHERE id = 'ttu:cleared'",
                    );
                    before = beforeRows[0]!.n;

                    yield* write.exec(
                        "UPDATE turn_token_usage SET cache_miss_reason_type = NULL WHERE id = 'ttu:cleared'",
                    );
                    yield* runCacheBustModels(write, 1);
                    const afterRows = yield* write.rows(
                        Schema.Struct({ n: Schema.Number }),
                        "SELECT count(*)::INTEGER AS n FROM cache_bust_event WHERE id = 'ttu:cleared'",
                    );
                    after = afterRows[0]!.n;
                }),
            ),
        );

        expect({ before, after }).toEqual({ before: 1, after: 0 });
    });

    dtest("derives priced busts and rolls them up with a filtering window", async () => {
        const dir = tempDir("cache-bust-cost");
        let first: CacheBustModelStats | undefined;
        let second: CacheBustModelStats | undefined;
        const fixture = await runWithPlatform(
            publishCacheFixture(dir, dylibPath, (write) =>
                Effect.gen(function* () {
                    yield* seedFixture(write);
                    // First run: no marker yet -> version cutover, unwindowed.
                    first = yield* runCacheBustModels(write, 30);
                    // Second run: marker matches -> windowed, idempotent UPSERT.
                    second = yield* runCacheBustModels(write, 30);
                }),
            ),
        );
        expect(first?.rebuilt).toBe(true);
        expect(first?.written).toBe(3);
        expect(second?.rebuilt).toBe(false);
        // The windowed re-run re-upserts the in-window busts only (the 60-day
        // row falls outside the 30-day model window).
        expect(second?.written).toBe(2);

        const layer = readFixture(fixture.snapshotPath, dylibPath);
        const { week, quarter } = await Effect.runPromise(
            Effect.gen(function* () {
                const read = yield* CacheRead;
                return {
                    week: yield* fetchCacheBustCost(read, { sinceDays: 7, limit: 20 }),
                    quarter: yield* fetchCacheBustCost(read, { sinceDays: 90, limit: 20 }),
                };
            }).pipe(Effect.provide(layer)),
        );

        expect(week.reasons).toEqual([
            { reason: "messages_changed", busts: 1, sessions: 1, tokens: 1_000_000, costUsd: 20 },
            { reason: "previous_message_not_found", busts: 1, sessions: 1, tokens: 200_000, costUsd: 4 },
        ]);
        expect(week.skills).toEqual([
            { name: "superpowers:subagent-driven-development", busts: 1, sessions: 1, costUsd: 20 },
        ]);
        expect(week.agents).toEqual([
            { name: "design-curator", busts: 1, sessions: 1, costUsd: 4 },
        ]);

        // Coverage: 4 claude rows in-window... 3 in the 7d window (ttu:old is
        // out), 2 busted; codex excluded from the denominator.
        expect(week.coverage).toEqual({
            totalTurns: 3,
            bustTurns: 2,
            totalCacheCreationUsd: 34,
            bustCostUsd: 24,
        });

        // Both current-bust roots have independent OTLP cost. The first root
        // also includes its 60-day transcript row because root cost is whole
        // session cost, not a cache-bust window subtotal.
        expect(week.corroboration).toEqual({ comparableRoots: 2, estimatedUsd: 40, otlpUsd: 40 });

        // The wider window picks up the 60-day-old bust.
        expect(quarter.reasons[0]).toEqual({
            reason: "messages_changed", busts: 2, sessions: 1, tokens: 1_100_000, costUsd: 22,
        });
        expect(quarter.coverage.bustTurns).toBe(3);
    });
});

describe("fetchCacheLensCandidates over a published snapshot (slice B, #868)", () => {
    dtest("aggregates each nested root once and excludes roots without OTLP cost", async () => {
        const dir = tempDir("cache-lens-candidates");
        const fixture = await runWithPlatform(
            publishCacheFixture(dir, dylibPath, (write) =>
                Effect.gen(function* () {
                    yield* write.putMany("spawned", [
                        { id: "spawn:a-b", in_id: SESSION_A, out_id: SESSION_B },
                        { id: "spawn:b-c", in_id: SESSION_B, out_id: SESSION_C },
                    ]);
                    yield* write.putMany("turn_token_usage", [
                        // The two busts are children of SESSION_A. Their root
                        // transcript and OTLP costs must count once, not twice.
                        usageRow({
                            id: "ttu:d1", session: SESSION_B, seq: 1, ts: hoursAgo(2), source: "claude",
                            cacheCreationTokens: 1_000_000n, cacheCreationUsd: 20, estimatedCostUsd: 25,
                            skill: "design-curator", cacheMiss: "messages_changed",
                        }),
                        usageRow({
                            id: "ttu:d2", session: SESSION_C, seq: 1, ts: hoursAgo(26), source: "claude-subagent",
                            cacheCreationTokens: 1_000_000n, cacheCreationUsd: 20, estimatedCostUsd: 50,
                            skill: "design-curator", cacheMiss: "messages_changed",
                        }),
                        usageRow({
                            id: "ttu:root", session: SESSION_A, seq: 1, ts: daysAgo(20), source: "claude",
                            cacheCreationTokens: 0n, cacheCreationUsd: null, estimatedCostUsd: 25,
                        }),
                        // SESSION_D has a bust, but no OTLP row. It stays in
                        // materiality and recurrence data, never corroboration.
                        usageRow({
                            id: "ttu:a1", session: SESSION_D, seq: 1, ts: hoursAgo(1), source: "claude",
                            cacheCreationTokens: 200_000n, cacheCreationUsd: 10, estimatedCostUsd: 10,
                            skill: "design-curator", cacheMiss: "previous_message_not_found",
                        }),
                    ]);
                    yield* write.put("otel_metric_point", otlpCostRow("otel:root", SESSION_A, 100));
                    yield* runCacheBustModels(write, 30);
                }),
            ),
        );

        const layer = readFixture(fixture.snapshotPath, dylibPath);
        const candidates = await Effect.runPromise(
            Effect.gen(function* () {
                const read = yield* CacheRead;
                return yield* fetchCacheLensCandidates(read, { sinceDays: 7 });
            }).pipe(Effect.provide(layer)),
        );

        const skill = candidates.find((c) => c.kind === "skill" && c.name === "design-curator");
        expect(skill).toMatchObject({
            kind: "skill", name: "design-curator", busts: 3, sessions: 3,
            bustCostUsd: 50, comparableRoots: 1, comparableEstimatedUsd: 100,
        });
        expect(skill?.comparableOtlpUsd).toBe(100);
        expect(skill?.reasonCounts).toEqual(expect.arrayContaining([
            { reason: "messages_changed", count: 2 },
            { reason: "previous_message_not_found", count: 1 },
        ]));
    });

    // Regression (#943): the recurrence guard used to count DISTINCT UTC
    // CALENDAR DAYS (`count(DISTINCT CAST(ts AS DATE))`), which miscounts for
    // any non-UTC operator. It now counts DISTINCT SESSIONS instead - these
    // two cases are exactly the pairs the old proxy got backwards.
    dtest("recurrence guard: two sessions on ONE UTC date pass (old UTC-day proxy would fail this)", async () => {
        const dir = tempDir("cache-lens-same-utc-date-two-sessions");
        // Both busts sit at UTC noon today, 2 hours apart - guaranteed to
        // share a UTC calendar date, but attributed to two DISTINCT sessions.
        const now = new Date();
        const utcNoonToday = new Date(Date.UTC(
            now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0,
        ));
        const fixture = await runWithPlatform(
            publishCacheFixture(dir, dylibPath, (write) =>
                Effect.gen(function* () {
                    yield* write.putMany("turn_token_usage", [
                        usageRow({
                            id: "ttu:same-date-1", session: SESSION_A, seq: 1, ts: utcNoonToday, source: "claude",
                            cacheCreationTokens: 1_000_000n, cacheCreationUsd: 20,
                            skill: "same-utc-date-skill", cacheMiss: "messages_changed",
                        }),
                        usageRow({
                            id: "ttu:same-date-2", session: SESSION_B, seq: 1,
                            ts: new Date(utcNoonToday.getTime() + 2 * 60 * 60 * 1000), source: "claude",
                            cacheCreationTokens: 1_000_000n, cacheCreationUsd: 20,
                            skill: "same-utc-date-skill", cacheMiss: "messages_changed",
                        }),
                    ]);
                    yield* write.putMany("otel_metric_point", [
                        otlpCostRow("otel:same-date-a", SESSION_A, 21),
                        otlpCostRow("otel:same-date-b", SESSION_B, 21),
                    ]);
                    yield* runCacheBustModels(write, 30);
                }),
            ),
        );

        const layer = readFixture(fixture.snapshotPath, dylibPath);
        const candidates = await Effect.runPromise(
            Effect.gen(function* () {
                const read = yield* CacheRead;
                return yield* fetchCacheLensCandidates(read, { sinceDays: 7 });
            }).pipe(Effect.provide(layer)),
        );
        const candidate = candidates.find((c) => c.kind === "skill" && c.name === "same-utc-date-skill");
        expect(candidate?.sessions).toBe(2);
        // Full guard pipeline (corroboration + recurrence + materiality)
        // passes - the old distinct-UTC-day proxy would have read 1 day here
        // and rejected it.
        expect(candidate ? evaluateCacheLensCandidate(candidate, 7) : null).not.toBeNull();
    });

    dtest("recurrence guard: one session spanning TWO UTC dates fails (old UTC-day proxy would pass this)", async () => {
        const dir = tempDir("cache-lens-two-utc-dates-one-session");
        // Two busts on the SAME session, exactly 24h apart - guaranteed to
        // fall on two distinct UTC calendar dates (UTC has no DST, so +24h
        // always advances the calendar date by exactly one), but only ONE
        // distinct session.
        const now = new Date();
        const utcNoonToday = new Date(Date.UTC(
            now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0,
        ));
        const utcNoonYesterday = new Date(utcNoonToday.getTime() - 24 * 60 * 60 * 1000);
        const fixture = await runWithPlatform(
            publishCacheFixture(dir, dylibPath, (write) =>
                Effect.gen(function* () {
                    yield* write.putMany("turn_token_usage", [
                        usageRow({
                            id: "ttu:two-dates-1", session: SESSION_A, seq: 1, ts: utcNoonYesterday, source: "claude",
                            cacheCreationTokens: 1_000_000n, cacheCreationUsd: 20,
                            skill: "two-utc-dates-skill", cacheMiss: "messages_changed",
                        }),
                        usageRow({
                            id: "ttu:two-dates-2", session: SESSION_A, seq: 2, ts: utcNoonToday, source: "claude",
                            cacheCreationTokens: 1_000_000n, cacheCreationUsd: 20,
                            skill: "two-utc-dates-skill", cacheMiss: "messages_changed",
                        }),
                    ]);
                    yield* write.put("otel_metric_point", otlpCostRow("otel:two-dates", SESSION_A, 42));
                    yield* runCacheBustModels(write, 30);
                }),
            ),
        );

        const layer = readFixture(fixture.snapshotPath, dylibPath);
        const candidates = await Effect.runPromise(
            Effect.gen(function* () {
                const read = yield* CacheRead;
                return yield* fetchCacheLensCandidates(read, { sinceDays: 7 });
            }).pipe(Effect.provide(layer)),
        );
        const candidate = candidates.find((c) => c.kind === "skill" && c.name === "two-utc-dates-skill");
        // Corroboration passes (one comparable root, exact OTLP agreement)
        // and materiality passes ($40 over 7d), so recurrence is the ONLY
        // guard standing between this candidate and a mint.
        expect(candidate?.comparableRoots).toBe(1);
        expect(candidate?.sessions).toBe(1);
        expect(candidate ? evaluateCacheLensCandidate(candidate, 7) : null).toBeNull();
    });
});
