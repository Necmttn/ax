import { describe, expect, test } from "bun:test";
import { mapCostRows, summarizeCostRows } from "./cost-query.ts";

describe("cost query token quality mapping", () => {
    test("maps explicit provider labels and unpriced reasons", () => {
        const rows = mapCostRows([
            {
                session: "session:`codex-token-count`",
                source: "codex",
                model: "gpt-5-codex",
                estimated_tokens: 190,
                prompt_tokens: 123,
                completion_tokens: 67,
                cache_read_input_tokens: 45,
                labels: JSON.stringify({
                    token_source_quality: "explicit",
                    token_source_detail: "codex_token_count.total_token_usage",
                    model_source_quality: "explicit",
                    unpriced_model_reason: "pricing_not_computed",
                }),
            },
        ]);

        expect(rows[0]).toMatchObject({
            tokenSourceQuality: "explicit",
            tokenSourceDetail: "codex_token_count.total_token_usage",
            modelSourceQuality: "explicit",
            unpricedModelReason: "pricing_not_computed",
        });
    });

    test("summarizes estimated provider rows by model and quality", () => {
        const summary = summarizeCostRows(mapCostRows([
            {
                session: "session:`cursor-estimate`",
                source: "cursor",
                model: "unknown-cursor-model",
                estimated_tokens: 50,
                labels: JSON.stringify({
                    token_source_quality: "estimate",
                    token_source_detail: "transcript_byte_estimate",
                    model_source_quality: "explicit",
                    unpriced_model_reason: "pricing_not_computed",
                }),
            },
        ]));

        expect(summary.totals).toMatchObject({
            sessions: 1,
            estimatedTokens: 50,
        });
        expect(summary.byModel[0]).toMatchObject({
            source: "cursor",
            model: "unknown-cursor-model",
            tokenSourceQuality: "estimate",
            sessions: 1,
            estimatedTokens: 50,
            unpricedModelReason: "pricing_not_computed",
        });
    });
});
