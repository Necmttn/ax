import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { fetchSessionHealthMap, fetchSessionMetrics } from "./session-metrics-query.ts";
import { SurrealClient } from "@ax/lib/db";

/** Dispatching mock: metrics listing vs health batch vs token-usage batch vs pricing fetch. */
const db = (input: {
    metrics: Array<Record<string, unknown>>;
    health?: Array<Record<string, unknown>>;
    usage?: Array<Record<string, unknown>>;
    pricing?: Array<Record<string, unknown>>;
    seenSql?: string[];
}) =>
    Layer.succeed(SurrealClient, {
        query: <T>(sql: string) => {
            input.seenSql?.push(sql);
            if (sql.includes("FROM session_health")) {
                return Effect.succeed([input.health ?? []] as unknown as T);
            }
            if (sql.includes("FROM session_token_usage")) {
                return Effect.succeed([input.usage ?? []] as unknown as T);
            }
            if (sql.includes("agent_model")) {
                return Effect.succeed([input.pricing ?? []] as unknown as T);
            }
            return Effect.succeed([input.metrics] as unknown as T);
        },
    } as never);

describe("fetchSessionMetrics", () => {
    test("maps joined rows into typed SessionMetricsRow[] (stored cost preserved)", async () => {
        const out = await Effect.runPromise(fetchSessionMetrics({ since: null, limit: 50 }).pipe(Effect.provide(db({
            metrics: [{
                session: "session:`s1`", source: "claude",
                durability_ratio: 0.75, produced_commits: 4, time_to_land_ms: 3600000,
                lines_added: 120, lines_removed: 30,
            }],
            health: [{ session: "session:`s1`", task_label: "add login", user_corrections: 1 }],
            usage: [{
                session: "session:`s1`", model: "gpt-5-codex",
                prompt_tokens: 1000, completion_tokens: 100,
                estimated_tokens: 1100, estimated_cost_usd: 0.42, pricing_source: "litellm",
            }],
        }))));
        expect(out[0]).toMatchObject({
            session: "session:`s1`", taskLabel: "add login", durabilityRatio: 0.75,
            producedCommits: 4, timeToLandMs: 3600000, linesAdded: 120, linesRemoved: 30,
            estimatedCostUsd: 0.42, costPricingSource: "litellm",
            userCorrections: 1, source: "claude",
        });
    });

    test("null/missing numeric fields map to null (durability/ttl/cost) or 0 (counts)", async () => {
        const out = await Effect.runPromise(fetchSessionMetrics({ since: null, limit: 50 }).pipe(Effect.provide(db({
            metrics: [{ session: "session:`s2`", durability_ratio: null, time_to_land_ms: null, produced_commits: 0, lines_added: 0, lines_removed: 0 }],
        }))));
        expect(out[0].durabilityRatio).toBe(null);
        expect(out[0].timeToLandMs).toBe(null);
        expect(out[0].estimatedCostUsd).toBe(null);
        expect(out[0].costPricingSource).toBe(null);
        expect(out[0].producedCommits).toBe(0);
    });

    test("unpriced Claude byte-estimate row gets a read-time cost estimate (#175)", async () => {
        const out = await Effect.runPromise(fetchSessionMetrics({ since: null, limit: 50 }).pipe(Effect.provide(db({
            metrics: [{ session: "session:`s3`", source: "claude", produced_commits: 1, lines_added: 0, lines_removed: 0 }],
            usage: [{
                session: "session:`s3`", model: "claude-haiku-4-5-20251001",
                prompt_tokens: null, completion_tokens: null,
                estimated_tokens: 2_000_000, estimated_cost_usd: null, pricing_source: null,
            }],
            pricing: [{
                name: "claude-haiku-4-5-20251001", provider: "anthropic",
                input_per_million_usd: 1, output_per_million_usd: 5, pricing_source: "litellm",
            }],
        }))));
        // 2M tokens × $1/M input rate (no output split available)
        expect(out[0].estimatedCostUsd).toBeCloseTo(2.0, 8);
        expect(out[0].costPricingSource).toBe("estimated:litellm");
    });

    test("health is a batch lookup bounded to the returned sessions (no correlated subqueries)", async () => {
        const seenSql: string[] = [];
        await Effect.runPromise(fetchSessionMetrics({ since: null, limit: 50 }).pipe(Effect.provide(db({
            metrics: [{ session: "session:`s1`", produced_commits: 0, lines_added: 0, lines_removed: 0 }],
            seenSql,
        }))));
        const metricsSql = seenSql.find((s) => s.includes("FROM session_metrics"))!;
        expect(metricsSql).not.toContain("$parent");
        expect(metricsSql).not.toContain("session_health");
        const healthSql = seenSql.find((s) => s.includes("FROM session_health"))!;
        expect(healthSql).toContain("WHERE session IN [session:`s1`]");
    });

    test("unknown model leaves cost null (unknown ≠ $0)", async () => {
        const out = await Effect.runPromise(fetchSessionMetrics({ since: null, limit: 50 }).pipe(Effect.provide(db({
            metrics: [{ session: "session:`s4`", produced_commits: 0, lines_added: 0, lines_removed: 0 }],
            usage: [{
                session: "session:`s4`", model: "mystery-model-9000",
                estimated_tokens: 500, estimated_cost_usd: null, pricing_source: null,
            }],
        }))));
        expect(out[0].estimatedCostUsd).toBe(null);
    });
});

describe("fetchSessionHealthMap", () => {
    test("keys are normalized session ids; values map task_label + user_corrections", async () => {
        const out = await Effect.runPromise(fetchSessionHealthMap(["session:`s1`"]).pipe(Effect.provide(db({
            metrics: [],
            health: [{ session: "session:⟨s1⟩", task_label: "fix the thing", user_corrections: 2 }],
        }))));
        expect(out.get("s1")).toEqual({ taskLabel: "fix the thing", userCorrections: 2 });
    });

    test("empty id list short-circuits without querying", async () => {
        const seenSql: string[] = [];
        const out = await Effect.runPromise(fetchSessionHealthMap([]).pipe(Effect.provide(db({ metrics: [], seenSql }))));
        expect(out.size).toBe(0);
        expect(seenSql).toHaveLength(0);
    });

    test("null = unbounded full scan (aggregate fallback)", async () => {
        const seenSql: string[] = [];
        await Effect.runPromise(fetchSessionHealthMap(null).pipe(Effect.provide(db({ metrics: [], health: [], seenSql }))));
        const sql = seenSql.find((s) => s.includes("FROM session_health"))!;
        expect(sql).not.toContain("WHERE");
    });
});
