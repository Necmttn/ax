import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { publishCacheFixture, readThroughFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { fetchCostSummary } from "./cost-query.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("cost-query", { requireFts: true });

const SESSIONS = (w: CacheWriteService) =>
    w.putMany("session", [
        { id: "s1", project: "/w/ax", cwd: "/w/ax", started_at: new Date("2026-05-28T00:00:00.000Z") },
        { id: "s2", project: "/w/ax", cwd: "/w/ax", started_at: new Date("2026-05-27T00:00:00.000Z") },
    ]);

const TOKEN_USAGE = (w: CacheWriteService) =>
    w.putMany("session_token_usage", [
        {
            id: "stu1",
            session: "s1",
            source: "codex",
            model: "gpt-5.5",
            estimated_tokens: 100,
            transcript_bytes: 1000,
            prompt_tokens: 70,
            completion_tokens: 20,
            cache_creation_input_tokens: 1,
            cache_read_input_tokens: 9,
            estimated_cost_usd: 0.5,
            pricing_source: "test",
        },
        {
            id: "stu2",
            session: "s2",
            source: "codex",
            model: "gpt-5.5",
            estimated_tokens: 50,
            transcript_bytes: 500,
            prompt_tokens: 30,
            completion_tokens: 10,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 10,
            estimated_cost_usd: 0.25,
            pricing_source: "test",
        },
    ]);

const TURNS = (w: CacheWriteService) =>
    w.putMany("turn", [
        {
            id: "t1",
            session: "s1",
            seq: 1,
            ts: new Date("2026-05-28T00:00:00.000Z"),
            role: "user",
            // #921: the FTS index reads full `text`; excerpt derives from it on real rows.
            text: "we discussed provider support for live-traces",
            text_excerpt: "we discussed provider support for live-traces",
        },
        {
            id: "t2",
            session: "s2",
            seq: 1,
            ts: new Date("2026-05-27T00:00:00.000Z"),
            role: "user",
            text: "provider support ticket follow-up",
            text_excerpt: "provider support ticket follow-up",
        },
    ]);

const baseFixture = (w: CacheWriteService) =>
    Effect.gen(function* () {
        yield* SESSIONS(w);
        yield* TOKEN_USAGE(w);
        yield* TURNS(w);
    });

describe("fetchCostSummary", () => {
    dtest("summarizes session token usage rows by model, matched on turn text", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-cost-query-"), dylibPath, baseFixture));

        const summary = await readThroughFixture(
            fixture,
            dylibPath,
            fetchCostSummary({ kind: "query", q: "provider support", limit: 10 }),
        );

        expect(summary.totals).toMatchObject({
            sessions: 2,
            estimatedTokens: 150,
            promptTokens: 100,
            completionTokens: 30,
            cacheCreationInputTokens: 1,
            cacheReadInputTokens: 19,
            estimatedCostUsd: 0.75,
        });
        expect(summary.byModel[0]).toMatchObject({
            source: "codex",
            model: "gpt-5.5",
            sessions: 2,
            estimatedCostUsd: 0.75,
        });
    });

    dtest("query selector can be constrained by since and project scope", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-cost-query-since-"), dylibPath, baseFixture));

        const summary = await readThroughFixture(
            fixture,
            dylibPath,
            fetchCostSummary({
                kind: "query",
                q: "provider support",
                limit: 20,
                since: new Date("2026-05-28T00:00:00.000Z"),
                project: "/w/ax",
            }),
        );

        // s2's turn matches the text, but its session started BEFORE the
        // `since` bound - only s1 should survive the project+since filter.
        expect(summary.sessions.map((r) => r.session)).toEqual(["s1"]);
    });

    dtest("query selector can be constrained by repository checkout scope", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-cost-query-repo-"), dylibPath, (w) =>
                Effect.gen(function* () {
                    yield* w.putMany("session", [
                        { id: "s1", repository: "repo-key", started_at: new Date("2026-05-28T00:00:00.000Z") },
                        { id: "s2", repository: "other-repo", started_at: new Date("2026-05-27T00:00:00.000Z") },
                    ]);
                    yield* TOKEN_USAGE(w);
                    yield* TURNS(w);
                }),
            ),
        );

        const summary = await readThroughFixture(
            fixture,
            dylibPath,
            fetchCostSummary({ kind: "query", terms: ["provider"], limit: 20, repositoryKey: "repo-key" }),
        );

        expect(summary.sessions.map((r) => r.session)).toEqual(["s1"]);
    });

    dtest("query selector matches any of several text terms", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-cost-query-terms-"), dylibPath, (w) =>
                Effect.gen(function* () {
                    yield* SESSIONS(w);
                    yield* TOKEN_USAGE(w);
                    yield* w.putMany("turn", [
                        {
                            id: "t1",
                            session: "s1",
                            seq: 1,
                            ts: new Date("2026-05-28T00:00:00.000Z"),
                            role: "user",
                            text: "livetrace rollout notes",
                            text_excerpt: "livetrace rollout notes",
                        },
                        {
                            id: "t2",
                            session: "s2",
                            seq: 1,
                            ts: new Date("2026-05-27T00:00:00.000Z"),
                            role: "user",
                            text: "unrelated turn about deployment",
                            text_excerpt: "unrelated turn about deployment",
                        },
                    ]);
                }),
            ),
        );

        const summary = await readThroughFixture(
            fixture,
            dylibPath,
            fetchCostSummary({ kind: "query", terms: ["live trace", "livetrace"], limit: 20 }),
        );

        expect(summary.sessions.map((r) => r.session)).toContain("s1");
    });

    dtest("session selector fetches the single row directly", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-cost-query-session-"), dylibPath, baseFixture));

        const summary = await readThroughFixture(fixture, dylibPath, fetchCostSummary({ kind: "session", sessionId: "s1" }));

        expect(summary.sessions).toHaveLength(1);
        expect(summary.sessions[0]?.session).toBe("s1");
        expect(summary.evidence).toBe("direct session_token_usage row");
    });

    dtest("commit selector finds sessions that produced the matching commit", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-cost-query-commit-"), dylibPath, (w) =>
                Effect.gen(function* () {
                    yield* SESSIONS(w);
                    yield* TOKEN_USAGE(w);
                    yield* w.put("commit", { id: "c1", sha: "abc123def", repo: "ax", ts: new Date("2026-05-28T00:00:00.000Z") });
                    yield* w.put("produced", { id: "p1", in_id: "s1", out_id: "c1", ts: new Date("2026-05-28T00:00:00.000Z") });
                }),
            ),
        );

        const summary = await readThroughFixture(fixture, dylibPath, fetchCostSummary({ kind: "commit", sha: "abc123" }));

        expect(summary.sessions.map((r) => r.session)).toEqual(["s1"]);
    });

    dtest("commit selector with no matching commit returns an empty summary", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-cost-query-commit-miss-"), dylibPath, baseFixture));

        const summary = await readThroughFixture(fixture, dylibPath, fetchCostSummary({ kind: "commit", sha: "nope" }));

        expect(summary.sessions).toHaveLength(0);
        expect(summary.evidence).toBe("no matching commit node");
    });

    dtest("branch selector finds sessions that produced commits from a branch checkout", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-cost-query-branch-"), dylibPath, (w) =>
                Effect.gen(function* () {
                    yield* SESSIONS(w);
                    yield* TOKEN_USAGE(w);
                    yield* w.put("checkout", { id: "co1", repository: "repo-key", path: "/w/ax", branch: "main" });
                    yield* w.put("produced", { id: "p1", in_id: "s2", out_id: "c1", checkout: "co1", ts: new Date("2026-05-27T00:00:00.000Z") });
                }),
            ),
        );

        const summary = await readThroughFixture(fixture, dylibPath, fetchCostSummary({ kind: "branch", branch: "main", limit: 20 }));

        expect(summary.sessions.map((r) => r.session)).toEqual(["s2"]);
    });
});
