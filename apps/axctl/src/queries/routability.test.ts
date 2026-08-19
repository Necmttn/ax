import { describe, expect, it } from "bun:test";
import { classifyTurn, codexToolClass, type TurnFacts, type ToolCallFact } from "./routability.ts";

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
  it("no tools, no text -> interactive (thinking signal dropped)", () => {
    expect(classifyTurn({ ...base, thinkingTokens: 4000, toolNames: [] }, false)).toBe("interactive");
  });
  it("edits with no judgment text -> mechanical-impl (thinking signal dropped)", () => {
    expect(classifyTurn({ ...base, thinkingTokens: 4000, toolNames: ["Edit"] }, false)).toBe("mechanical-impl");
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

describe("buildSpans judgment carry (Claude prose->edit split)", () => {
  // Claude splits one assistant message into separate turn rows: a prose turn
  // (text, no tools) then its tool-use turns (empty text). The judgment guard
  // only reads ONE turn's text, so edit turns riding behind judgment reasoning
  // misclassify as mechanical-impl. The carry propagates judgment text from a
  // prose turn onto the following tool-only turns of the same message.
  it("demotes edit turns riding behind judgment prose out of routable", () => {
    const turns = [
      turn(1, "user", []),
      turn(2, "assistant", ["Read"]), // interactive (adjacent to user)
      turn(3, "assistant", [], { text: "Let me review the design before editing" }), // design-decision, sets sticky
      turn(4, "assistant", ["Edit"]), // empty text, sticky -> demoted (would be mechanical-impl)
      turn(5, "assistant", ["Edit"]), // demoted
    ];
    const spans = buildSpans(turns, 1);
    expect(spans.find((s) => s.cls === "mechanical-impl")).toBeUndefined();
    const judgment = spans.find((s) => s.cls === "design-decision");
    expect(judgment?.turnCount).toBe(3); // prose + 2 edits
    expect(judgment?.routable).toBe(false);
  });

  it("leaves edits mechanical when the leading prose carries no judgment", () => {
    const turns = [
      turn(1, "user", []),
      turn(2, "assistant", ["Read"]),
      turn(3, "assistant", [], { text: "Now let me update the file" }), // no judgment keyword
      turn(4, "assistant", ["Edit"]), // mechanical-impl (no carry)
    ];
    const mech = buildSpans(turns, 1).find((s) => s.cls === "mechanical-impl");
    expect(mech?.turnCount).toBe(1);
    expect(mech?.routable).toBe(true);
  });

  it("resets the carry at the next message's prose turn", () => {
    const turns = [
      turn(1, "user", []),
      turn(2, "assistant", ["Read"]),
      turn(3, "assistant", [], { text: "review the plan" }), // sticky on
      turn(4, "assistant", ["Edit"]), // demoted
      turn(5, "assistant", [], { text: "now apply the rename" }), // non-judgment text -> sticky off
      turn(6, "assistant", ["Edit"]), // mechanical-impl (carry reset)
    ];
    const spans = buildSpans(turns, 1);
    // exactly one mechanical-impl span (turn 6); turn 4 was demoted
    expect(spans.filter((s) => s.cls === "mechanical-impl")).toHaveLength(1);
    expect(spans.some((s) => s.cls === "design-decision")).toBe(true);
  });

  it("resets the carry at a user boundary", () => {
    const turns = [
      turn(1, "user", []),
      turn(2, "assistant", [], { text: "audit the security model" }), // adjacent->interactive, but sticky on
      turn(3, "assistant", ["Edit"]), // demoted (sticky survives the forced-interactive turn)
      turn(4, "user", []), // boundary -> sticky reset
      turn(5, "assistant", ["Edit"]), // adjacent->interactive
      turn(6, "assistant", ["Edit"]), // mechanical-impl (carry was reset)
    ];
    const spans = buildSpans(turns, 1);
    // exactly one mechanical-impl span (turn 6); turn 3 was demoted pre-boundary
    expect(spans.filter((s) => s.cls === "mechanical-impl")).toHaveLength(1);
    expect(spans.some((s) => s.cls === "design-decision")).toBe(true);
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

// ---------------------------------------------------------------------------
// Codex tool classification
// ---------------------------------------------------------------------------

describe("codexToolClass", () => {
  it("apply_patch / write_stdin / send_input -> edit", () => {
    expect(codexToolClass("apply_patch", null)).toBe("edit");
    expect(codexToolClass("write_stdin", null)).toBe("edit");
    expect(codexToolClass("send_input", null)).toBe("edit");
  });
  it("read-like exec_command norms -> read", () => {
    for (const n of ["rg", "cat", "ls", "git diff", "git status", "git log"]) {
      expect(codexToolClass("exec_command", n)).toBe("read");
    }
  });
  it("write/build exec_command norms -> edit", () => {
    for (const n of ["git add", "rm", "bun test", "bun run", "python3"]) {
      expect(codexToolClass("exec_command", n)).toBe("edit");
    }
  });
  it("ambiguous sed -> null (conservative; never routable)", () => {
    expect(codexToolClass("exec_command", "sed")).toBeNull();
  });
  it("unknown norm / unknown tool -> null", () => {
    expect(codexToolClass("exec_command", "some-novel-binary")).toBeNull();
    expect(codexToolClass("exec_command", null)).toBeNull();
    expect(codexToolClass("update_plan", null)).toBeNull();
  });
});

describe("classifyTurn with Codex toolCalls", () => {
  const codex = (calls: ToolCallFact[], extra: Partial<TurnFacts> = {}): TurnFacts => ({
    seq: 2, role: "assistant", toolNames: calls.map((c) => c.name), toolCalls: calls,
    thinkingTokens: 0, intentKind: null, text: null, usage: null, ...extra,
  });

  it("read-like exec_command run -> gather", () => {
    const t = codex([{ name: "exec_command", commandNorm: "rg" }, { name: "exec_command", commandNorm: "cat" }]);
    expect(classifyTurn(t, false)).toBe("gather");
  });
  it("apply_patch dominant -> mechanical-impl", () => {
    const t = codex([{ name: "apply_patch", commandNorm: null }, { name: "exec_command", commandNorm: "bun test" }]);
    expect(classifyTurn(t, false)).toBe("mechanical-impl");
  });
  it("ambiguous-only exec turn -> interactive (no confident class)", () => {
    const t = codex([{ name: "exec_command", commandNorm: "sed" }]);
    expect(classifyTurn(t, false)).toBe("interactive");
  });
  it("judgment text still wins for codex turns", () => {
    const t = codex([{ name: "exec_command", commandNorm: "rg" }], { text: "Review the design of this module" });
    expect(classifyTurn(t, false)).toBe("design-decision");
  });
});

import { combineRoutability, codexRoleKind } from "./routability.ts";

describe("buildSpans with codexRoleKind (per-event turns)", () => {
  const ev = (seq: number, role: string, calls: ToolCallFact[], cost: number): TurnFacts => ({
    seq, role, toolNames: calls.map((c) => c.name), toolCalls: calls, thinkingTokens: 0,
    intentKind: null, text: null,
    usage: { prompt_tokens: 0, completion_tokens: 0, cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: cost },
  });

  it("attributes a tool OUTPUT's cost to the preceding tool_call's class", () => {
    const turns = [
      ev(1, "user", [], 0),
      ev(2, "reasoning", [], 0.01), // first work turn after user -> interactive
      ev(3, "tool_call", [{ name: "exec_command", commandNorm: "rg" }], 1), // gather
      ev(4, "function_call_output", [], 9), // carry -> folds into gather span
    ];
    const spans = buildSpans(turns, 1, codexRoleKind);
    const gather = spans.find((s) => s.cls === "gather");
    expect(gather?.usage.cost_usd).toBe(10); // tool_call $1 + its output $9
    expect(gather?.routable).toBe(true);
  });

  it("skips noise roles (system/attachment) without breaking runs", () => {
    const turns = [
      ev(1, "user", [], 0),
      ev(2, "tool_call", [{ name: "exec_command", commandNorm: "rg" }], 1), // adjacent -> interactive
      ev(3, "tool_call", [{ name: "exec_command", commandNorm: "cat" }], 1), // gather
      ev(4, "system", [], 0), // skip, no flush
      ev(5, "tool_call", [{ name: "exec_command", commandNorm: "ls" }], 1), // gather (run continues)
    ];
    const gather = buildSpans(turns, 2, codexRoleKind).find((s) => s.cls === "gather");
    expect(gather?.turnCount).toBe(2); // turns 3 & 5 grouped across the skipped system row
    expect(gather?.routable).toBe(true);
  });
});

describe("aggregateRoutability provider tiers + combineRoutability", () => {
  // Catalog must price the codex drop targets for repricing to bite.
  const catalog2 = new Map<string, ModelPricing>([
    [MODEL_ALIASES.sonnet, { provider: "anthropic", inputPerMillionUsd: 3, outputPerMillionUsd: 15, cacheReadPerMillionUsd: 0.3, cacheCreationPerMillionUsd: 3.75, fastMultiplier: 1, pricingSource: "test" }],
    [MODEL_ALIASES.haiku, { provider: "anthropic", inputPerMillionUsd: 0.8, outputPerMillionUsd: 4, cacheReadPerMillionUsd: 0.08, cacheCreationPerMillionUsd: 1, fastMultiplier: 1, pricingSource: "test" }],
    ["gpt-5-mini", { provider: "openai", inputPerMillionUsd: 0.25, outputPerMillionUsd: 2, cacheReadPerMillionUsd: 0.025, cacheCreationPerMillionUsd: null, fastMultiplier: 1, pricingSource: "test" }],
    ["gpt-5-nano", { provider: "openai", inputPerMillionUsd: 0.05, outputPerMillionUsd: 0.4, cacheReadPerMillionUsd: 0.005, cacheCreationPerMillionUsd: null, fastMultiplier: 1, pricingSource: "test" }],
  ]);
  const bigUsage: RepriceUsage = { prompt_tokens: 2_000_000, completion_tokens: 400_000, cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: 50 };

  it("codex gather row drops to gpt-5-nano (not haiku)", () => {
    const r = aggregateRoutability([{ cls: "gather", turnCount: 5, usage: bigUsage, routable: true }], catalog2, { days: 30, minRun: 3 }, "codex");
    const gather = r.rows.find((row) => row.class === "gather");
    expect(r.provider).toBe("codex");
    expect(gather?.tier).toBe("gpt-5-nano");
    expect(gather!.estSavingsUsd!).toBeGreaterThan(0);
  });

  it("combineRoutability sums providers and exposes the breakdown", () => {
    const claude = aggregateRoutability([{ cls: "gather", turnCount: 5, usage: bigUsage, routable: true }], catalog2, { days: 30, minRun: 3 }, "claude");
    const codex = aggregateRoutability([{ cls: "mechanical-impl", turnCount: 4, usage: bigUsage, routable: true }], catalog2, { days: 30, minRun: 3 }, "codex");
    const all = combineRoutability([claude, codex], { days: 30, minRun: 3 });
    expect(all.provider).toBe("all");
    expect(all.providers.map((p) => p.provider)).toEqual(["claude", "codex"]);
    expect(all.mainSpendUsd).toBe(claude.mainSpendUsd + codex.mainSpendUsd);
    expect(all.estSavingsUsd).toBe(claude.estSavingsUsd + codex.estSavingsUsd);
  });

  it("empty providers -> zeroed combined result", () => {
    const all = combineRoutability([], { days: 7, minRun: 1 });
    expect(all.mainSpendUsd).toBe(0);
    expect(all.routablePct).toBe(0);
    expect(all.providers).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// #911 Phase 5 landed slice: learned judgment classifier (AX_JUDGMENT_MODEL=learned)
// ---------------------------------------------------------------------------

describe("classifyTurn default path is byte-identical with `learned` omitted", () => {
  // A broad fixture matrix over every WorkClass + edge case the regex path
  // produces today, called with NO third argument - pins today's expected
  // values so a future change to the learned branch cannot silently alter
  // the default. (routability.test.ts's earlier describes already exercise
  // this implicitly by never passing `learned`; this block makes the
  // guarantee explicit and self-contained.)
  const cases: [string, TurnFacts, boolean, ReturnType<typeof classifyTurn>][] = [
    ["read-only tools -> gather", { ...base, toolNames: ["Read", "Grep"] }, false, "gather"],
    ["research tools -> niche-research", { ...base, toolNames: ["WebFetch", "WebSearch"] }, false, "niche-research"],
    ["edit-dominant -> mechanical-impl", { ...base, toolNames: ["Edit", "Bash"] }, false, "mechanical-impl"],
    ["no tools, no text -> interactive", { ...base }, false, "interactive"],
    ["judgment text wins over read tools -> design-decision", { ...base, text: "Review the design of this module", toolNames: ["Read"] }, false, "design-decision"],
    ["adjacent to user -> interactive", { ...base, toolNames: ["Read"] }, true, "interactive"],
    ["correction intent -> interactive", { ...base, intentKind: "correction", toolNames: ["Edit"] }, false, "interactive"],
    ["empty tool list, judgment text -> design-decision", { ...base, text: "audit the security model" }, false, "design-decision"],
    ["non-judgment prose, no tools -> interactive", { ...base, text: "looks good, thanks" }, false, "interactive"],
  ];
  for (const [name, facts, adjacent, expected] of cases) {
    it(name, () => {
      expect(classifyTurn(facts, adjacent)).toBe(expected);
    });
  }
});

describe("classifyTurn learned path (AX_JUDGMENT_MODEL=learned)", () => {
  it("a regex-flagged turn UNDER threshold is NOT design-decision", () => {
    // Text matches JUDGMENT_GUARD_RE ("review"), but the learned model's
    // weights ignore regexOwn and gate on otherToolCount, which is 0 here -
    // demonstrating the learned branch fully REPLACES the regex decision
    // rather than OR-ing with it.
    const learned = { threshold: 0.5, weights: { bias: -10, otherToolCount: 5 } };
    const t: TurnFacts = { ...base, text: "Review the design of this module", toolNames: ["Read"] };
    expect(classifyTurn(t, false, learned)).not.toBe("design-decision");
    // Same facts, no `learned` -> regex path still flags it (unchanged default).
    expect(classifyTurn(t, false)).toBe("design-decision");
  });

  it("a turn OVER threshold without any regex hit IS design-decision", () => {
    const learned = { threshold: 0.5, weights: { bias: -10, otherToolCount: 5 } };
    const t: TurnFacts = { ...base, text: "run the build", toolNames: ["some_mcp_tool", "some_mcp_tool", "some_mcp_tool"] };
    expect(classifyTurn(t, false)).not.toBe("design-decision"); // regex path: no match
    expect(classifyTurn(t, false, learned)).toBe("design-decision"); // learned path: otherToolCount=3 crosses threshold
  });

  it("regexPrev feature reads TurnFacts.prevAssistantText, not the turn's own text", () => {
    const learned = { threshold: 0.5, weights: { bias: -10, regexPrev: 20 } };
    const judgmentPrev: TurnFacts = { ...base, prevAssistantText: "let's review the tradeoffs here" };
    expect(classifyTurn(judgmentPrev, false, learned)).toBe("design-decision");
    const plainPrev: TurnFacts = { ...base, prevAssistantText: "run the build" };
    expect(classifyTurn(plainPrev, false, learned)).not.toBe("design-decision");
    const noPrev: TurnFacts = { ...base };
    expect(classifyTurn(noPrev, false, learned)).not.toBe("design-decision");
  });

  it("interactive guards and tool-composition fallthrough are unaffected by `learned`", () => {
    const learned = { threshold: 0.99, weights: {} }; // score always ~0.5 sigmoid(0), never >= 0.99
    expect(classifyTurn({ ...base, toolNames: ["Read"] }, true, learned)).toBe("interactive");
    expect(classifyTurn({ ...base, intentKind: "correction", toolNames: ["Edit"] }, false, learned)).toBe("interactive");
    expect(classifyTurn({ ...base, toolNames: ["Edit", "Bash"] }, false, learned)).toBe("mechanical-impl");
    expect(classifyTurn({ ...base, toolNames: ["WebFetch"] }, false, learned)).toBe("niche-research");
  });
});

describe("buildSpans + learned model", () => {
  it("a non-judgment-text, tool-heavy run classifies differently learned-vs-default", () => {
    // No prose anywhere in this fixture, so the always-on regex sticky demotion
    // never engages - isolates the learned model's non-regex features
    // (otherToolCount) as the thing that changes the outcome.
    const heavy = (seq: number) => turn(seq, "assistant", ["some_mcp_tool", "some_mcp_tool", "some_mcp_tool"]);
    const turns = [turn(1, "user", []), heavy(2), heavy(3), heavy(4)];

    const defaultSpans = buildSpans(turns, 1);
    expect(defaultSpans.some((s) => s.cls === "design-decision")).toBe(false); // no tool self-classifies as edit/read/research -> interactive

    const learned = { threshold: 0.5, weights: { bias: -10, otherToolCount: 5 } };
    const learnedSpans = buildSpans(turns, 1, undefined, learned);
    expect(learnedSpans.some((s) => s.cls === "design-decision")).toBe(true);
  });

  it("without `learned`, buildSpans is unaffected (identity default path)", () => {
    const turns = [turn(1, "user", []), turn(2, "assistant", [], { text: "review the plan" }), turn(3, "assistant", ["Edit"])];
    // No throw, no behavior change - buildSpans without `learned` takes the
    // untouched default branch (sticky-only demotion, as pinned above).
    const spans = buildSpans(turns, 1);
    expect(spans.some((s) => s.cls === "design-decision")).toBe(true);
  });
});
