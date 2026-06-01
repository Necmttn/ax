import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { fetchCostSummary } from "./cost-query.ts";
import { SurrealClient } from "@ax/lib/db";

const layerWith = (rows: ReadonlyArray<Record<string, unknown>>) =>
    Layer.succeed(SurrealClient, {
        query: <T>(_sql: string) => Effect.succeed([rows] as unknown as T),
    } as never);

const layerCapturing = (capture: { sql: string[] }) =>
    Layer.succeed(SurrealClient, {
        query: <T>(sql: string) => {
            capture.sql.push(sql);
            return Effect.succeed([[]] as unknown as T);
        },
    } as never);

describe("fetchCostSummary", () => {
    test("summarizes session token usage rows by model", async () => {
        const rows = [
            {
                session: "session:`s1`",
                source: "codex",
                model: "gpt-5.5",
                estimated_tokens: 100,
                prompt_tokens: 70,
                completion_tokens: 20,
                cache_creation_input_tokens: 1,
                cache_read_input_tokens: 9,
                estimated_cost_usd: 0.5,
                pricing_source: "test",
                evidence: "turn_text_search",
            },
            {
                session: "session:`s2`",
                source: "codex",
                model: "gpt-5.5",
                estimated_tokens: 50,
                prompt_tokens: 30,
                completion_tokens: 10,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 10,
                estimated_cost_usd: 0.25,
                pricing_source: "test",
                evidence: "turn_text_search",
            },
        ];

        const summary = await Effect.runPromise(
            fetchCostSummary({ kind: "query", q: "provider support", limit: 10 }).pipe(
                Effect.provide(layerWith(rows)),
            ),
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

    test("query selector can be constrained by since and project scope", async () => {
        const capture = { sql: [] as string[] };

        await Effect.runPromise(
            fetchCostSummary({
                kind: "query",
                q: "live-traces",
                limit: 20,
                since: new Date("2026-05-28T00:00:00.000Z"),
                project: "/Users/necmttn/Projects/ax",
            }).pipe(Effect.provide(layerCapturing(capture))),
        );

        expect(capture.sql[0]).toContain('session.started_at >= d"2026-05-28T00:00:00.000Z"');
        expect(capture.sql[0]).toContain('session.cwd = "/Users/necmttn/Projects/ax"');
        expect(capture.sql[0]).toContain('session.project = "/Users/necmttn/Projects/ax"');
    });

    test("query selector can be constrained by repository checkout scope", async () => {
        const capture = { sql: [] as string[] };

        await Effect.runPromise(
            fetchCostSummary({
                kind: "query",
                terms: ["live-traces"],
                limit: 20,
                repositoryKey: "repo-key",
            }).pipe(Effect.provide(layerCapturing(capture))),
        );

        expect(capture.sql[0]).toContain("session.repository = repository:`repo-key`");
    });

    test("query selector can match any of several text terms", async () => {
        const capture = { sql: [] as string[] };

        await Effect.runPromise(
            fetchCostSummary({
                kind: "query",
                terms: ["live trace", "livetrace", "live-traces"],
                limit: 20,
            }).pipe(Effect.provide(layerCapturing(capture))),
        );

        expect(capture.sql[0]).toContain('text_excerpt @0@ "live trace"');
        expect(capture.sql[0]).toContain('OR text_excerpt @0@ "livetrace"');
        expect(capture.sql[0]).toContain('OR text_excerpt @0@ "live-traces"');
    });
});
