import { describe, expect, test } from "bun:test";
import type { ContextBudgetResult } from "./context-budget.ts";

describe("ContextBudgetResult", () => {
  test("carries a contentTypes breakdown field", () => {
    const sample: ContextBudgetResult["contentTypes"] = {
      rows: [{ category: "code", calls: 1, bytes: 4, estTokens: 1, tokenShare: 1 }],
      totals: { calls: 1, bytes: 4, estTokens: 1 },
    };
    expect(sample.rows[0].category).toBe("code");
  });
});
