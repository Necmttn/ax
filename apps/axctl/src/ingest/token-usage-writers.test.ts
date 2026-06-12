import { describe, expect, test } from "bun:test";
import { surrealJsonOption } from "@ax/lib/shared/surql";
import type { CostEstimate } from "./model-pricing.ts";
import {
    buildSessionTokenUsageStatement,
    buildTurnTokenUsageStatement,
    surrealOptionFloat,
} from "./token-usage-writers.ts";

const cost: CostEstimate = {
    inputUsd: 0.123456789,
    outputUsd: null,
    cacheCreationUsd: null,
    cacheReadUsd: 0.5,
    totalUsd: 0.623456789,
    pricingSource: "model_pricing.ts",
};

describe("surrealOptionFloat", () => {
    test("rounds to 8 decimals and NONEs nullish / non-finite values", () => {
        expect(surrealOptionFloat(0.123456789)).toBe("0.12345679");
        expect(surrealOptionFloat(1)).toBe("1");
        expect(surrealOptionFloat(null)).toBe("NONE");
        expect(surrealOptionFloat(undefined)).toBe("NONE");
        expect(surrealOptionFloat(Number.NaN)).toBe("NONE");
    });
});

describe("buildSessionTokenUsageStatement", () => {
    test("emits the cost-less shape (pi) without model_ref/cost/pricing fields", () => {
        const sql = buildSessionTokenUsageStatement({
            sessionId: "session-1",
            source: "pi",
            model: "gpt-x",
            promptTokens: 10,
            completionTokens: 20,
            cacheCreationInputTokens: null,
            cacheReadInputTokens: 5,
            estimatedTokens: 30,
            contextWindow: null,
            labels: surrealJsonOption({ k: "v" }),
            metrics: surrealJsonOption(null),
            ts: "2026-06-13T00:00:00.000Z",
        });
        expect(sql).toStartWith("UPSERT session_token_usage:`session_1` MERGE {");
        expect(sql).toContain('source: "pi"');
        expect(sql).toContain("workflow_epoch: NONE");
        expect(sql).toContain("prompt_tokens: 10");
        expect(sql).toContain("cache_creation_input_tokens: NONE");
        expect(sql).toContain("context_window: NONE");
        expect(sql).not.toContain("model_ref");
        expect(sql).not.toContain("estimated_cost_usd");
        expect(sql).not.toContain("pricing_source");
        expect(sql).toContain('ts: d"2026-06-13T00:00:00.000Z"');
    });

    test("emits the costed shape (codex) with the model_ref..pricing_source block before labels", () => {
        const sql = buildSessionTokenUsageStatement({
            sessionId: "session-1",
            source: "codex",
            model: "gpt-5.1-codex",
            promptTokens: 10,
            completionTokens: 20,
            cacheCreationInputTokens: null,
            cacheReadInputTokens: 5,
            estimatedTokens: 30,
            contextWindow: 272000,
            cost: { modelRefKey: "gpt-5.1-codex", estimate: cost },
            labels: surrealJsonOption({ k: "v" }),
            metrics: surrealJsonOption({ m: 1 }),
            ts: "2026-06-13T00:00:00.000Z",
        });
        expect(sql).toContain("model_ref: agent_model:`gpt-5.1-codex`");
        expect(sql).toContain("estimated_input_cost_usd: 0.12345679");
        expect(sql).toContain("estimated_output_cost_usd: NONE");
        expect(sql).toContain("estimated_cost_usd: 0.62345679");
        expect(sql).toContain('pricing_source: "model_pricing.ts"');
        expect(sql).toContain("context_window: 272000");
        // Field order: cost block sits between context_window and labels.
        expect(sql.indexOf("context_window")).toBeLessThan(sql.indexOf("model_ref"));
        expect(sql.indexOf("pricing_source")).toBeLessThan(sql.indexOf("labels"));
    });

    test("NONEs model_ref when the cost block has no model key", () => {
        const sql = buildSessionTokenUsageStatement({
            sessionId: "s",
            source: "codex",
            model: null,
            promptTokens: null,
            completionTokens: null,
            cacheCreationInputTokens: null,
            cacheReadInputTokens: null,
            estimatedTokens: 0,
            contextWindow: null,
            cost: { modelRefKey: null, estimate: cost },
            labels: "NONE",
            metrics: "NONE",
            ts: "2026-06-13T00:00:00.000Z",
        });
        expect(sql).toContain("model_ref: NONE");
    });
});

describe("buildTurnTokenUsageStatement", () => {
    const base = {
        sessionId: "session-1",
        seq: 4,
        source: "codex",
        model: "gpt-5.1-codex",
        promptTokens: 100,
        completionTokens: 50,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: 25,
        freshInputTokens: 75,
        estimatedTokens: 150,
        modelRefKey: "gpt-5.1-codex",
        cost,
        usageSource: "codex_token_count.last_token_usage",
        usageQuality: "provider_turn",
        ts: "2026-06-13T00:00:00.000Z",
    };

    test("includes the raw column only when a pre-rendered literal is given", () => {
        const withRaw = buildTurnTokenUsageStatement({
            ...base,
            raw: surrealJsonOption({ input_tokens: 100 }),
        });
        expect(withRaw).toContain("UPSERT turn_token_usage:");
        expect(withRaw).toContain("fresh_input_tokens: 75");
        expect(withRaw).toContain('usage_source: "codex_token_count.last_token_usage"');
        expect(withRaw).toContain("raw: ");
        expect(withRaw.indexOf("usage_quality")).toBeLessThan(withRaw.indexOf("raw: "));
        expect(withRaw.indexOf("raw: ")).toBeLessThan(withRaw.indexOf('ts: d"'));

        const withoutRaw = buildTurnTokenUsageStatement(base);
        expect(withoutRaw).not.toContain("raw: ");
        expect(withoutRaw).toContain('usage_quality: "provider_turn", ts: d"');
    });

    test("keys the row and the turn link by the same turn record key", () => {
        const sql = buildTurnTokenUsageStatement(base);
        const key = sql.slice("UPSERT turn_token_usage:`".length, sql.indexOf("` MERGE"));
        expect(key).toStartWith("session_1__");
        expect(key).toEndWith("__seq_000004");
        expect(sql).toContain(`turn: turn:\`${key}\``);
        expect(sql).toContain("seq: 4");
    });
});
