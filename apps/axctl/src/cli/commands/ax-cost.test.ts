import { describe, expect, test } from "bun:test";
import {
    COST_SESSIONS_LEGEND,
    renderCostModelsTable,
    renderCostSessionsTable,
} from "./ax-cost.ts";
import type {
    CostModelsResult,
    CostSessionsResult,
} from "../../queries/cost-analytics.ts";

describe("renderCostModelsTable", () => {
    test("does not clip large token counts or large costs", () => {
        const result: CostModelsResult = {
            total_cost_usd: 10999.397,
            rows: [
                {
                    model: "claude-opus-4-8",
                    sessions: 502,
                    prompt_tokens: 15_171_682_086,
                    completion_tokens: 48_223_592,
                    cache_read_tokens: 14_781_735_443,
                    cache_create_tokens: 361_331_748,
                    cost_usd: 10_999.397,
                },
            ],
        };

        const out = renderCostModelsTable(result);

        expect(out).toContain("15,171,682,086");
        expect(out).toContain("14,781,735,443");
        expect(out).toContain("$10999.3970");
        expect(out).not.toContain("14,781,735,4 ");
        expect(out).not.toContain("$10999.397\n");
    });
});

describe("renderCostSessionsTable", () => {
    const result: CostSessionsResult = {
        rows: [
            {
                session_id: "session:`18338926-1b38-4fa2-999b-08aab8f03d64`",
                project: "-Users-frankjames--super",
                model: "claude-fable-5",
                started_at: "2026-07-06T15:25:28",
                cost_usd: 114.9523,
                completion_tokens: 823_193,
                cache_read_tokens: 33_915_145,
            },
        ],
    };

    test("labels token columns as out_tok / cache_tok and strips the session id wrapping", () => {
        const out = renderCostSessionsTable(result);
        const [header] = out.split("\n");

        // Self-documenting headers: the two token columns are no longer the
        // ambiguous "completion" / "cache_read".
        expect(header).toContain("out_tok");
        expect(header).toContain("cache_tok");
        // session: prefix + backtick wrapping stripped to a bare uuid.
        expect(out).toContain("18338926-1b38-4fa2-999b-08aab8f03d64");
        expect(out).not.toContain("session:`");
        // Money + token cells render intact (no clipping).
        expect(out).toContain("$114.9523");
        expect(out).toContain("823,193");
        expect(out).toContain("33,915,145");
    });

    test("legend spells out every money/token column", () => {
        expect(COST_SESSIONS_LEGEND).toContain("cost = est. USD");
        expect(COST_SESSIONS_LEGEND).toContain("out_tok = output");
        expect(COST_SESSIONS_LEGEND).toContain("cache_tok = cache-hit");
    });
});
