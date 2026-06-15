import { describe, expect, it } from "bun:test";
import { classifyTurn, type TurnFacts } from "./routability.ts";

const base: TurnFacts = {
  seq: 1,
  role: "assistant",
  toolNames: [],
  thinkingTokens: 0,
  intentKind: null,
  text: null,
  usage: null,
};

describe("classifyTurn", () => {
  it("read-only tools, no thinking -> gather", () => {
    expect(classifyTurn({ ...base, toolNames: ["Read", "Grep", "Read", "Glob"] }, false)).toBe("gather");
  });
  it("web research + reads -> niche-research", () => {
    expect(classifyTurn({ ...base, toolNames: ["WebFetch", "Read", "WebSearch"] }, false)).toBe("niche-research");
  });
  it("edit/bash dominant, low thinking -> mechanical-impl", () => {
    expect(classifyTurn({ ...base, toolNames: ["Edit", "Bash", "Edit", "Write"] }, false)).toBe("mechanical-impl");
  });
  it("high thinking, no tools -> synthesis", () => {
    expect(classifyTurn({ ...base, thinkingTokens: 4000, toolNames: [] }, false)).toBe("synthesis");
  });
  it("high thinking + edits -> design-decision", () => {
    expect(classifyTurn({ ...base, thinkingTokens: 4000, toolNames: ["Edit"] }, false)).toBe("design-decision");
  });
  it("judgment text -> design-decision even with read tools", () => {
    expect(classifyTurn({ ...base, text: "Review the design of this module", toolNames: ["Read"] }, false)).toBe("design-decision");
  });
  it("adjacent to a user turn -> interactive", () => {
    expect(classifyTurn({ ...base, toolNames: ["Read", "Grep"] }, true)).toBe("interactive");
  });
  it("correction intent -> interactive", () => {
    expect(classifyTurn({ ...base, intentKind: "correction", toolNames: ["Edit"] }, false)).toBe("interactive");
  });
  it("no signal -> interactive (conservative fallback)", () => {
    expect(classifyTurn(base, false)).toBe("interactive");
  });
});

import { buildSpans, aggregateRoutability, type Span } from "./routability.ts";
import { MODEL_ALIASES, type ModelPricing } from "./reprice.ts";
import type { RepriceUsage } from "./reprice.ts";

const u: RepriceUsage = {
  prompt_tokens: 1000, completion_tokens: 100,
  cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: 1,
};

function turn(seq: number, role: string, tools: string[], extra: Partial<TurnFacts> = {}): TurnFacts {
  return { seq, role, toolNames: tools, thinkingTokens: 0, intentKind: null, text: null, usage: u, ...extra };
}

describe("buildSpans", () => {
  it("groups consecutive same-class assistant turns into one span", () => {
    const turns = [
      turn(1, "user", []),
      turn(2, "assistant", ["Read", "Grep"]),
      turn(3, "assistant", ["Read"]),
      turn(4, "assistant", ["Read", "Glob"]),
    ];
    const spans = buildSpans(turns, 3);
    // turn 2 is adjacentToUser -> interactive (own span); 3 & 4 -> gather run of 2
    const gather = spans.find((s) => s.cls === "gather");
    expect(gather?.turnCount).toBe(2);
  });

  it("a user turn breaks a run even when class would continue", () => {
    const turns = [
      turn(1, "user", []), turn(2, "assistant", ["Edit"]), turn(3, "assistant", ["Edit"]),
      turn(4, "user", []), turn(5, "assistant", ["Edit"]), turn(6, "assistant", ["Edit"]),
    ];
    const mech = buildSpans(turns, 1).filter((s) => s.cls === "mechanical-impl");
    expect(mech.length).toBe(2);
  });

  it("marks a routable span only when run length >= minRun", () => {
    const turns = [
      turn(1, "user", []),
      turn(2, "assistant", ["Read"]), // interactive (adjacent)
      turn(3, "assistant", ["Read"]), turn(4, "assistant", ["Read"]), turn(5, "assistant", ["Read"]), // gather run of 3
    ];
    expect(buildSpans(turns, 3).find((s) => s.cls === "gather")?.routable).toBe(true);
    expect(buildSpans(turns, 4).find((s) => s.cls === "gather")?.routable).toBe(false);
  });

  it("sums usage across a span", () => {
    const turns = [
      turn(1, "user", []), turn(2, "assistant", ["Read"]),
      turn(3, "assistant", ["Read"]), turn(4, "assistant", ["Read"]),
    ];
    const gather = buildSpans(turns, 1).find((s) => s.cls === "gather");
    expect(gather?.usage.cost_usd).toBe(2); // turns 3 & 4 (turn 2 is interactive)
  });
});

describe("aggregateRoutability", () => {
  const catalog = new Map<string, ModelPricing>([
    [MODEL_ALIASES.sonnet, { provider: "anthropic", inputPerMillionUsd: 3, outputPerMillionUsd: 15, cacheReadPerMillionUsd: 0.3, cacheCreationPerMillionUsd: 3.75, fastMultiplier: 1, pricingSource: "test" }],
    [MODEL_ALIASES.haiku, { provider: "anthropic", inputPerMillionUsd: 0.8, outputPerMillionUsd: 4, cacheReadPerMillionUsd: 0.08, cacheCreationPerMillionUsd: 1, fastMultiplier: 1, pricingSource: "test" }],
  ]);

  const bigUsage: RepriceUsage = {
    prompt_tokens: 2_000_000, completion_tokens: 400_000,
    cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: 50,
  };

  const spans: Span[] = [
    { cls: "gather", turnCount: 5, usage: bigUsage, routable: true },
    { cls: "mechanical-impl", turnCount: 4, usage: bigUsage, routable: true },
    { cls: "synthesis", turnCount: 3, usage: bigUsage, routable: false },
    { cls: "gather", turnCount: 2, usage: bigUsage, routable: false },
  ];

  it("rolls up routable spans by class with positive savings", () => {
    const r = aggregateRoutability(spans, catalog, { days: 30, minRun: 3 });
    const gather = r.rows.find((row) => row.class === "gather" && row.verdict === "routable");
    expect(gather?.runs).toBe(1);
    expect(gather?.tier).toBe("haiku");
    expect(gather!.estSavingsUsd!).toBeGreaterThan(0);
  });

  it("aggregates everything else into a single 'stays main' rollup", () => {
    const r = aggregateRoutability(spans, catalog, { days: 30, minRun: 3 });
    const stays = r.rows.find((row) => row.verdict === "stays");
    expect(stays).toBeDefined();
    expect(stays!.mainCostUsd).toBe(100);
  });

  it("totals: routable + est savings + main spend + pct", () => {
    const r = aggregateRoutability(spans, catalog, { days: 30, minRun: 3 });
    expect(r.mainSpendUsd).toBe(200);
    expect(r.routableUsd).toBe(100);
    expect(r.routablePct).toBeCloseTo(50, 0);
    expect(r.estSavingsUsd).toBeGreaterThan(0);
  });

  it("never reports negative savings (already-cheap span contributes 0)", () => {
    const cheap: Span = {
      cls: "gather", turnCount: 5,
      usage: { prompt_tokens: 10, completion_tokens: 1, cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: 0.0001 },
      routable: true,
    };
    const r = aggregateRoutability([cheap], catalog, { days: 30, minRun: 3 });
    expect(r.estSavingsUsd).toBeGreaterThanOrEqual(0);
  });
});
