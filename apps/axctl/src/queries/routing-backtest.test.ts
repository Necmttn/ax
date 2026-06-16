import { describe, expect, it } from "bun:test";
import { backtestPattern, type BacktestDispatch } from "./routing-backtest.ts";

const d = (description: string, childModel: string, cost: number): BacktestDispatch => ({
  description, agent_type: "general-purpose", child_model: childModel, child_cost_usd: cost, dispatch_model: "inherit",
});

const rows: BacktestDispatch[] = [
  d("Implement task 3", "claude-fable-5", 50),
  d("Implement the design review", "claude-fable-5", 40),
  d("Fix the build", "claude-fable-5", 30),
  d("Implement small", "claude-sonnet-4-6", 5),
];

describe("backtestPattern", () => {
  it("partitions matched / excluded / missed", () => {
    const r = backtestPattern(rows, { pattern: "^implement", flags: "i", suggest: "sonnet", exclude: ["design"] }, new Map());
    expect(r.matched.map((m) => m.description)).toContain("Implement task 3");
    expect(r.excluded.map((m) => m.description)).toContain("Implement the design review");
    expect(r.missed.map((m) => m.description)).toContain("Fix the build"); // expensive inherit, not matched
    expect(r.matched.map((m) => m.description)).not.toContain("Fix the build");
  });
  it("no exclude → nothing excluded", () => {
    const r = backtestPattern(rows, { pattern: "^implement", flags: "i", suggest: "sonnet" }, new Map());
    expect(r.excluded.length).toBe(0);
  });
  it("invalid pattern → no matches, no throw", () => {
    const r = backtestPattern(rows, { pattern: "(", flags: "", suggest: "sonnet" }, new Map());
    expect(r.matched.length).toBe(0);
  });
  it("estSavings is 0 without usage rows (cost-only fixtures) and never negative", () => {
    const r = backtestPattern(rows, { pattern: "^implement", flags: "i", suggest: "sonnet" }, new Map());
    expect(r.estSavingsUsd).toBeGreaterThanOrEqual(0);
  });
  it("with a usage row + cheap-tier catalog, matched expensive dispatch yields positive savings", () => {
    const catalog = new Map([["claude-sonnet-4-6", { provider: "anthropic", inputPerMillionUsd: 3, outputPerMillionUsd: 15, cacheReadPerMillionUsd: 0.3, cacheCreationPerMillionUsd: 3.75, fastMultiplier: 1, pricingSource: "test" }]]);
    const withUsage: BacktestDispatch[] = [{
      description: "Implement big", agent_type: "general-purpose", child_model: "claude-fable-5", child_cost_usd: 50, dispatch_model: "inherit",
      usage: { prompt_tokens: 2_000_000, completion_tokens: 200_000, cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: 50 },
    }];
    const r = backtestPattern(withUsage, { pattern: "^implement", flags: "i", suggest: "sonnet" }, catalog as any);
    expect(r.estSavingsUsd).toBeGreaterThan(0);
  });
});
