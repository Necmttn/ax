import { describe, expect, test } from "bun:test";
import { renderCostModelsTable } from "./ax-cost.ts";
import type { CostModelsResult } from "../../queries/cost-analytics.ts";

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
