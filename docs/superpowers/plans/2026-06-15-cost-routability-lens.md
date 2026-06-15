# Main-thread Routability Lens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `ax cost routability` - a read-only lens that estimates how much main-agent spend sat in routable class-runs (gather / mechanical-impl / niche-research) vs genuine judgment, repricing the routable spans one tier down for an est-savings figure.

**Architecture:** Deterministic class-run classification over the existing `turn` / `tool_call` / `turn_token_usage` graph. Pure cores (`classifyTurn`, `buildSpans`, `aggregateRoutability`) are unit-tested with no DB; `fetchRoutability` (Effect.fn + SurrealClient) pulls main-agent turns with tool names + thinking + intent + per-turn usage + the pricing catalog, then runs the pure cores in JS (the cost-analytics "derived dimensions in JS" precedent). A small shared `reprice.ts` is extracted from `dispatch-analytics.ts` so both callers use one repricing path.

**Tech Stack:** bun ≥1.3, TypeScript strict, effect@beta (`Command`/`Flag` from `effect/unstable/cli`, `Effect.fn`, `SurrealClient`), bun:test. CI gates: `bun test` + `bun run typecheck`.

**Spec:** `docs/superpowers/specs/2026-06-15-cost-routability-lens-design.md`

**Worktree:** `/Users/necmttn/Projects/ax/.claude/worktrees/cost-routability` (branch `feat/cost-routability-lens`). All commands below run from there.

---

## File Structure

- **Create** `apps/axctl/src/queries/reprice.ts` - `MODEL_ALIASES`, `RepriceUsage`, `reprice(usage, targetModelName, pricingCatalog)`. Shared repricing.
- **Create** `apps/axctl/src/queries/reprice.test.ts` - reprice math + alias resolution.
- **Modify** `apps/axctl/src/queries/dispatch-analytics.ts` - import the shared reprice instead of the two local closures (DRY; behavior unchanged).
- **Create** `apps/axctl/src/queries/routability.ts` - `WorkClass`, `ROUTABLE_TIER`, `TurnFacts`, `Span`, `classifyTurn`, `buildSpans`, `aggregateRoutability`, `RoutabilityInput/Result`, `fetchRoutability`.
- **Create** `apps/axctl/src/queries/routability.test.ts` - pure-core tests (classify, spans, aggregate).
- **Modify** `apps/axctl/src/cli/commands/ax-cost.ts` - add `routability` subcommand + render.
- **Modify** `apps/axctl/src/mcp/tools.ts` - register read-only `cost_routability`.
- **Modify** `CLAUDE.md` - document the new subcommand under "Cost analytics".

---

## Task 1: Extract shared repricing module

**Files:**
- Create: `apps/axctl/src/queries/reprice.ts`
- Test: `apps/axctl/src/queries/reprice.test.ts`
- Modify: `apps/axctl/src/queries/dispatch-analytics.ts` (replace the two local `reprice` closures + private `MODEL_ALIASES`)

- [ ] **Step 1: Write the failing test**

Create `apps/axctl/src/queries/reprice.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { MODEL_ALIASES, reprice, type RepriceUsage } from "./reprice.ts";

const usage: RepriceUsage = {
  prompt_tokens: 1_000_000,
  completion_tokens: 200_000,
  cache_read_tokens: 0,
  cache_create_tokens: 0,
  cost_usd: 5,
};

describe("MODEL_ALIASES", () => {
  it("resolves sonnet and haiku to full ids", () => {
    expect(MODEL_ALIASES.sonnet).toBe("claude-sonnet-4-6");
    expect(MODEL_ALIASES.haiku).toBe("claude-haiku-4-5-20251001");
  });
});

describe("reprice", () => {
  it("returns a positive cost cheaper than a frontier original for a known tier", () => {
    const catalog = new Map([
      ["claude-sonnet-4-6", {
        inputPerMillionUsd: 3,
        outputPerMillionUsd: 15,
        cacheReadPerMillionUsd: 0.3,
        cacheCreationPerMillionUsd: 3.75,
      }],
    ]);
    const cost = reprice(usage, "claude-sonnet-4-6", catalog);
    expect(cost).toBeGreaterThan(0);
    // 1M input @ $3 + 200k output @ $15 = ~$6 (catalog-driven; far below a fable original)
    expect(cost).toBeLessThan(20);
  });

  it("falls back to usage.cost_usd when the target model is unknown to the catalog", () => {
    const cost = reprice(usage, "unknown-model", new Map());
    expect(cost).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/queries/reprice.test.ts`
Expected: FAIL - `Cannot find module './reprice.ts'`.

- [ ] **Step 3: Write minimal implementation**

First inspect the exact `ModelPricing` shape and `estimateCost` signature so the call matches:

Run: `rg -n "export interface ModelPricing|export function estimateCost|export const estimateCost" apps/axctl/src/ingest/model-pricing.ts`

Then create `apps/axctl/src/queries/reprice.ts` (mirror the existing closure at `dispatch-analytics.ts:657`):

```ts
/**
 * Shared repricing - estimate what a token bundle would cost on a target model.
 * Extracted from dispatch-analytics so cost-routability and dispatch candidates
 * use ONE repricing path (was two identical local closures).
 */
import { estimateCost, type ModelPricing } from "../ingest/model-pricing.ts";

// Model name resolution for repricing suggestions.
export const MODEL_ALIASES: Record<string, string> = {
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
};

export interface RepriceUsage {
  prompt_tokens: number;
  completion_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
  cost_usd: number;
}

/**
 * Reprice `usage` as if it ran on `targetModelName`, using the supplied
 * agent_model pricing catalog. Falls back to the original `usage.cost_usd`
 * when the target model / pricing is unknown (never invents a number).
 */
export const reprice = (
  usage: RepriceUsage,
  targetModelName: string,
  pricingCatalog: Map<string, ModelPricing>,
): number => {
  const cost = estimateCost({
    modelKey: targetModelName,
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    cacheCreationInputTokens: usage.cache_create_tokens,
    cacheReadInputTokens: usage.cache_read_tokens,
    estimatedTokens: usage.prompt_tokens + usage.completion_tokens,
    ...(pricingCatalog.size > 0 ? { pricingCatalog } : {}),
  });
  return cost.totalUsd ?? usage.cost_usd;
};
```

> If `rg` in this step shows different `ModelPricing` field names (e.g. `input_per_million_usd`) or a different `estimateCost` key than `modelKey`, copy them verbatim from `dispatch-analytics.ts:657-668` - that closure is the source of truth.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/queries/reprice.test.ts`
Expected: PASS (both describes).

- [ ] **Step 5: Refactor dispatch-analytics to use the shared module**

In `apps/axctl/src/queries/dispatch-analytics.ts`:
1. Delete the private `const MODEL_ALIASES = {...}` (around line 50).
2. Add to imports: `import { MODEL_ALIASES, reprice as repriceUsage, type RepriceUsage } from "./reprice.ts";`
3. Replace BOTH local `const reprice = (usage: UsageRow, targetModelName) => {...}` closures (around lines 657 and 891) with a thin adapter that calls the shared one with the local `pricingCatalog`:

```ts
const reprice = (usage: UsageRow, targetModelName: string): number =>
  repriceUsage(usage, targetModelName, pricingCatalog);
```

`UsageRow` already has `prompt_tokens/completion_tokens/cache_read_tokens/cache_create_tokens/cost_usd`, so it is structurally a `RepriceUsage` - no row reshaping needed.

- [ ] **Step 6: Run the full dispatch-analytics + typecheck to verify no behavior change**

Run: `bun test apps/axctl/src/queries/dispatch-analytics.test.ts && bun run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/axctl/src/queries/reprice.ts apps/axctl/src/queries/reprice.test.ts apps/axctl/src/queries/dispatch-analytics.ts
git commit -m "refactor(queries): extract shared reprice module from dispatch-analytics"
```

---

## Task 2: `classifyTurn` pure core

**Files:**
- Create: `apps/axctl/src/queries/routability.ts`
- Test: `apps/axctl/src/queries/routability.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/axctl/src/queries/routability.test.ts`:

```ts
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
    expect(classifyTurn({ ...base, toolNames: ["Read", "Grep", "Read", "Glob"] }, false))
      .toBe("gather");
  });

  it("web research + reads -> niche-research", () => {
    expect(classifyTurn({ ...base, toolNames: ["WebFetch", "Read", "WebSearch"] }, false))
      .toBe("niche-research");
  });

  it("edit/bash dominant, low thinking -> mechanical-impl", () => {
    expect(classifyTurn({ ...base, toolNames: ["Edit", "Bash", "Edit", "Write"] }, false))
      .toBe("mechanical-impl");
  });

  it("high thinking, no tools -> synthesis", () => {
    expect(classifyTurn({ ...base, thinkingTokens: 4000, toolNames: [] }, false))
      .toBe("synthesis");
  });

  it("high thinking + edits -> design-decision", () => {
    expect(classifyTurn({ ...base, thinkingTokens: 4000, toolNames: ["Edit"] }, false))
      .toBe("design-decision");
  });

  it("judgment text -> design-decision even with read tools", () => {
    expect(classifyTurn(
      { ...base, text: "Review the design of this module", toolNames: ["Read"] },
      false,
    )).toBe("design-decision");
  });

  it("adjacent to a user turn -> interactive (judgment-first, never routed)", () => {
    expect(classifyTurn({ ...base, toolNames: ["Read", "Grep"] }, true))
      .toBe("interactive");
  });

  it("correction intent -> interactive", () => {
    expect(classifyTurn({ ...base, intentKind: "correction", toolNames: ["Edit"] }, false))
      .toBe("interactive");
  });

  it("no tools, no thinking, no signal -> interactive (conservative fallback)", () => {
    expect(classifyTurn(base, false)).toBe("interactive");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/queries/routability.test.ts`
Expected: FAIL - `Cannot find module './routability.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/axctl/src/queries/routability.ts`:

```ts
/**
 * Main-thread routability lens - classify main-agent class-runs by whether they
 * could have been a cheaper subagent dispatch, and reprice routable spans.
 * Deterministic: tool composition (A) + thinking signal (B). No LLM.
 * Spec: docs/superpowers/specs/2026-06-15-cost-routability-lens-design.md
 */
import { JUDGMENT_GUARD_RE } from "./routing-tune.ts";
import type { RepriceUsage } from "./reprice.ts";

export type WorkClass =
  | "gather"
  | "niche-research"
  | "mechanical-impl"
  | "synthesis"
  | "design-decision"
  | "interactive";

/** Routable classes and the tier they should drop to. Others stay on main. */
export const ROUTABLE_TIER: Partial<Record<WorkClass, "haiku" | "sonnet">> = {
  gather: "haiku",
  "niche-research": "sonnet",
  "mechanical-impl": "sonnet",
};

export interface TurnFacts {
  seq: number;
  role: string; // 'user' | 'assistant' | 'tool_result' | ...
  toolNames: ReadonlyArray<string>;
  thinkingTokens: number;
  intentKind: string | null;
  text: string | null;
  usage: RepriceUsage | null;
}

// Classification thresholds (calibrated in Task 5 against real data; documented
// constants so a run is auditable).
export const THINK_HI = 1500; // output tokens of thinking that marks "reasoning"
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS"]);
const RESEARCH_TOOLS = new Set(["WebFetch", "WebSearch"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "Bash"]);
const INTERACTIVE_INTENTS = new Set([
  "correction",
  "preference",
  "wrapper_instruction",
]);

/**
 * Assign one work-class to a main-agent turn. Judgment-first precedence so
 * review/design/interactive can never be classed routable.
 * `adjacentToUser` is computed by buildSpans (turn neighbors a user turn).
 */
export function classifyTurn(t: TurnFacts, adjacentToUser: boolean): WorkClass {
  if (adjacentToUser) return "interactive";
  if (t.intentKind && INTERACTIVE_INTENTS.has(t.intentKind)) return "interactive";

  const hasEdit = t.toolNames.some((n) => EDIT_TOOLS.has(n));
  const editCount = t.toolNames.filter((n) => EDIT_TOOLS.has(n)).length;
  const readCount = t.toolNames.filter((n) => READ_TOOLS.has(n)).length;
  const researchCount = t.toolNames.filter((n) => RESEARCH_TOOLS.has(n)).length;

  if (t.text && JUDGMENT_GUARD_RE.test(t.text)) return "design-decision";
  if (t.thinkingTokens >= THINK_HI && hasEdit) return "design-decision";
  if (t.thinkingTokens >= THINK_HI && t.toolNames.length <= 1) return "synthesis";

  if (editCount > 0 && editCount >= readCount && editCount >= researchCount) {
    return "mechanical-impl";
  }
  if (researchCount > 0) return "niche-research";
  if (readCount > 0) return "gather";

  return "interactive"; // conservative: unclassified stays on main
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/queries/routability.test.ts`
Expected: PASS (all `classifyTurn` cases).

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/queries/routability.ts apps/axctl/src/queries/routability.test.ts
git commit -m "feat(routability): classifyTurn work-class core (tool comp + thinking)"
```

---

## Task 3: `buildSpans` pure core

**Files:**
- Modify: `apps/axctl/src/queries/routability.ts`
- Modify: `apps/axctl/src/queries/routability.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/axctl/src/queries/routability.test.ts`:

```ts
import { buildSpans, type Span } from "./routability.ts";

const u: RepriceUsage = {
  prompt_tokens: 1000,
  completion_tokens: 100,
  cache_read_tokens: 0,
  cache_create_tokens: 0,
  cost_usd: 1,
};

function turn(seq: number, role: string, tools: string[], extra: Partial<TurnFacts> = {}): TurnFacts {
  return {
    seq, role, toolNames: tools, thinkingTokens: 0, intentKind: null,
    text: null, usage: u, ...extra,
  };
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
      turn(1, "user", []),
      turn(2, "assistant", ["Edit"]),
      turn(3, "assistant", ["Edit"]),
      turn(4, "user", []),
      turn(5, "assistant", ["Edit"]),
      turn(6, "assistant", ["Edit"]),
    ];
    const spans = buildSpans(turns, 1);
    const mech = spans.filter((s) => s.cls === "mechanical-impl");
    // two separate runs (split by the user turn at seq 4), not one of 4
    expect(mech.length).toBe(2);
  });

  it("marks a routable span only when its run length >= minRun", () => {
    const turns = [
      turn(1, "user", []),
      turn(2, "assistant", ["Read"]),   // interactive (adjacent)
      turn(3, "assistant", ["Read"]),   // gather
      turn(4, "assistant", ["Read"]),   // gather
      turn(5, "assistant", ["Read"]),   // gather  -> run of 3
    ];
    expect(buildSpans(turns, 3).find((s) => s.cls === "gather")?.routable).toBe(true);
    expect(buildSpans(turns, 4).find((s) => s.cls === "gather")?.routable).toBe(false);
  });

  it("sums usage across a span", () => {
    const turns = [
      turn(1, "user", []),
      turn(2, "assistant", ["Read"]),
      turn(3, "assistant", ["Read"]),
      turn(4, "assistant", ["Read"]),
    ];
    const gather = buildSpans(turns, 1).find((s) => s.cls === "gather");
    expect(gather?.usage.cost_usd).toBe(2); // turns 3 & 4 (turn 2 is interactive)
  });

  it("does not group across sessions (caller passes per-session ordered turns)", () => {
    // buildSpans assumes a single session's turns in seq order; verified by Task 5 query
    const spans = buildSpans([turn(1, "user", []), turn(2, "assistant", ["Read"])], 1);
    expect(spans.every((s) => s.turnCount >= 1)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/queries/routability.test.ts`
Expected: FAIL - `buildSpans`/`Span` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `apps/axctl/src/queries/routability.ts`:

```ts
export interface Span {
  cls: WorkClass;
  turnCount: number;
  usage: RepriceUsage; // summed across the span's turns
  routable: boolean; // cls is routable AND turnCount >= minRun
}

const ZERO_USAGE = (): RepriceUsage => ({
  prompt_tokens: 0,
  completion_tokens: 0,
  cache_read_tokens: 0,
  cache_create_tokens: 0,
  cost_usd: 0,
});

function addUsage(a: RepriceUsage, b: RepriceUsage | null): RepriceUsage {
  if (!b) return a;
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    cache_read_tokens: a.cache_read_tokens + b.cache_read_tokens,
    cache_create_tokens: a.cache_create_tokens + b.cache_create_tokens,
    cost_usd: a.cost_usd + b.cost_usd,
  };
}

/**
 * Group ONE session's main-agent turns (seq order) into class-run spans.
 * Splits at every user turn (judgment boundary); within a segment, groups
 * consecutive assistant turns sharing a class. A turn neighbouring a user
 * turn is forced to `interactive`. A span is routable iff its class is
 * routable AND its run length >= minRun.
 */
export function buildSpans(turns: ReadonlyArray<TurnFacts>, minRun: number): Span[] {
  const spans: Span[] = [];
  let cur: { cls: WorkClass; turnCount: number; usage: RepriceUsage } | null = null;

  const flush = () => {
    if (!cur) return;
    const tier = ROUTABLE_TIER[cur.cls];
    spans.push({
      cls: cur.cls,
      turnCount: cur.turnCount,
      usage: cur.usage,
      routable: tier !== undefined && cur.turnCount >= minRun,
    });
    cur = null;
  };

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.role === "user" || t.role === "tool_result") {
      flush(); // user/tool_result turns are boundaries, never classified
      continue;
    }
    if (t.role !== "assistant") {
      flush();
      continue;
    }
    const prevIsUser = i > 0 && turns[i - 1].role === "user";
    const nextIsUser = i + 1 < turns.length && turns[i + 1].role === "user";
    const cls = classifyTurn(t, prevIsUser || nextIsUser);

    if (cur && cur.cls === cls) {
      cur.turnCount += 1;
      cur.usage = addUsage(cur.usage, t.usage);
    } else {
      flush();
      cur = { cls, turnCount: 1, usage: addUsage(ZERO_USAGE(), t.usage) };
    }
  }
  flush();
  return spans;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/queries/routability.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/queries/routability.ts apps/axctl/src/queries/routability.test.ts
git commit -m "feat(routability): buildSpans class-run grouping with min-run gate"
```

---

## Task 4: `aggregateRoutability` pure core

**Files:**
- Modify: `apps/axctl/src/queries/routability.ts`
- Modify: `apps/axctl/src/queries/routability.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/axctl/src/queries/routability.test.ts`:

```ts
import { aggregateRoutability } from "./routability.ts";
import { MODEL_ALIASES } from "./reprice.ts";

describe("aggregateRoutability", () => {
  // Pricing catalog: sonnet/haiku cheap so repricing clearly < original.
  const catalog = new Map([
    [MODEL_ALIASES.sonnet, { inputPerMillionUsd: 3, outputPerMillionUsd: 15, cacheReadPerMillionUsd: 0.3, cacheCreationPerMillionUsd: 3.75 }],
    [MODEL_ALIASES.haiku, { inputPerMillionUsd: 0.8, outputPerMillionUsd: 4, cacheReadPerMillionUsd: 0.08, cacheCreationPerMillionUsd: 1 }],
  ]);

  const bigUsage: RepriceUsage = {
    prompt_tokens: 2_000_000, completion_tokens: 400_000,
    cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: 50, // expensive original
  };

  const spans: Span[] = [
    { cls: "gather", turnCount: 5, usage: bigUsage, routable: true },
    { cls: "mechanical-impl", turnCount: 4, usage: bigUsage, routable: true },
    { cls: "synthesis", turnCount: 3, usage: bigUsage, routable: false },
    { cls: "gather", turnCount: 2, usage: bigUsage, routable: false }, // below min-run
  ];

  it("rolls up routable spans by class with positive savings", () => {
    const r = aggregateRoutability(spans, catalog, { days: 30, minRun: 3 });
    const gather = r.rows.find((row) => row.class === "gather" && row.verdict === "routable");
    expect(gather?.runs).toBe(1); // only the routable run of 5
    expect(gather?.tier).toBe("haiku");
    expect(gather!.estSavingsUsd!).toBeGreaterThan(0);
  });

  it("aggregates everything else into a single 'stays main' rollup", () => {
    const r = aggregateRoutability(spans, catalog, { days: 30, minRun: 3 });
    const stays = r.rows.find((row) => row.verdict === "stays");
    expect(stays).toBeDefined();
    // synthesis span + the below-min-run gather span both stay
    expect(stays!.mainCostUsd).toBe(100);
  });

  it("totals: routable + est savings + main spend + pct", () => {
    const r = aggregateRoutability(spans, catalog, { days: 30, minRun: 3 });
    expect(r.mainSpendUsd).toBe(200); // 4 spans * $50
    expect(r.routableUsd).toBe(100); // 2 routable spans * $50
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/queries/routability.test.ts`
Expected: FAIL - `aggregateRoutability` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `apps/axctl/src/queries/routability.ts` (add import at top: `import { MODEL_ALIASES, reprice } from "./reprice.ts";` and `import type { ModelPricing } from "../ingest/model-pricing.ts";`):

```ts
export interface RoutabilityInput {
  days: number;
  minRun: number;
}

export interface RoutabilityClassRow {
  class: string;
  verdict: "routable" | "stays";
  runs: number;
  turns: number;
  mainCostUsd: number;
  tier: string | null;
  repricedUsd: number | null;
  estSavingsUsd: number | null;
}

export interface RoutabilityResult {
  mainSpendUsd: number;
  routableUsd: number;
  routablePct: number;
  estSavingsUsd: number;
  rows: ReadonlyArray<RoutabilityClassRow>;
  days: number;
  minRun: number;
}

/**
 * Roll spans up into per-class routable rows + one "stays main" rollup, and
 * compute est savings (routable spans repriced one tier down, never negative).
 */
export function aggregateRoutability(
  spans: ReadonlyArray<Span>,
  pricingCatalog: Map<string, ModelPricing>,
  input: RoutabilityInput,
): RoutabilityResult {
  const routableByClass = new Map<WorkClass, { runs: number; turns: number; main: number; repriced: number }>();
  let staysMain = 0;
  let staysTurns = 0;
  let staysRuns = 0;

  for (const s of spans) {
    if (!s.routable) {
      staysMain += s.usage.cost_usd;
      staysTurns += s.turnCount;
      staysRuns += 1;
      continue;
    }
    const tierAlias = ROUTABLE_TIER[s.cls]!; // routable guarantees a tier
    const targetModel = MODEL_ALIASES[tierAlias] ?? tierAlias;
    const repriced = reprice(s.usage, targetModel, pricingCatalog);
    const acc = routableByClass.get(s.cls) ?? { runs: 0, turns: 0, main: 0, repriced: 0 };
    acc.runs += 1;
    acc.turns += s.turnCount;
    acc.main += s.usage.cost_usd;
    acc.repriced += Math.min(repriced, s.usage.cost_usd); // clamp: never "save" by repricing up
    routableByClass.set(s.cls, acc);
  }

  const rows: RoutabilityClassRow[] = [];
  let routableUsd = 0;
  let estSavingsUsd = 0;

  for (const [cls, acc] of routableByClass) {
    const savings = Math.max(0, acc.main - acc.repriced);
    routableUsd += acc.main;
    estSavingsUsd += savings;
    rows.push({
      class: cls,
      verdict: "routable",
      runs: acc.runs,
      turns: acc.turns,
      mainCostUsd: acc.main,
      tier: ROUTABLE_TIER[cls] ?? null,
      repricedUsd: acc.repriced,
      estSavingsUsd: savings,
    });
  }

  rows.sort((a, b) => (b.estSavingsUsd ?? 0) - (a.estSavingsUsd ?? 0));

  if (staysRuns > 0) {
    rows.push({
      class: "stays main",
      verdict: "stays",
      runs: staysRuns,
      turns: staysTurns,
      mainCostUsd: staysMain,
      tier: null,
      repricedUsd: null,
      estSavingsUsd: null,
    });
  }

  const mainSpendUsd = routableUsd + staysMain;
  return {
    mainSpendUsd,
    routableUsd,
    routablePct: mainSpendUsd > 0 ? (routableUsd / mainSpendUsd) * 100 : 0,
    estSavingsUsd,
    rows,
    days: input.days,
    minRun: input.minRun,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/queries/routability.test.ts && bun run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/queries/routability.ts apps/axctl/src/queries/routability.test.ts
git commit -m "feat(routability): aggregateRoutability rollup + est-savings math"
```

---

## Task 5: `fetchRoutability` (Effect.fn + SurrealClient)

**Files:**
- Modify: `apps/axctl/src/queries/routability.ts`

This is the DB integration. It mirrors `fetchCostSplit` (`cost-analytics.ts:200`). Read that function first for the exact `SurrealClient` import path, `Effect.fn` naming, and the `sinceDays` window pattern.

- [ ] **Step 1: Inspect the patterns to copy**

Run:
```bash
sed -n '1,30p;196,260p' apps/axctl/src/queries/cost-analytics.ts
rg -n "agent_model|agentModelsResult|pricingCatalog.set" apps/axctl/src/queries/dispatch-analytics.ts | head
rg -n "DEFINE FIELD (model|prompt_tokens|completion_tokens|cache_read_input_tokens|cache_creation_input_tokens|estimated_cost_usd|source) ON turn_token_usage" packages/schema/src/schema.surql
```
Note the exact field names (the schema uses `cache_read_input_tokens` / `cache_creation_input_tokens` - map them to `RepriceUsage.cache_read_tokens` / `cache_create_tokens` in JS).

- [ ] **Step 2: Write the implementation**

Append to `apps/axctl/src/queries/routability.ts` (add imports mirroring cost-analytics: `import { Effect } from "effect";` and the `SurrealClient` import exactly as cost-analytics.ts has it):

```ts
import { SurrealClient } from "../lib/db.ts"; // COPY exact path/name from cost-analytics.ts:1-20

/**
 * Pull main-agent turns (source != 'claude-subagent') in the window with their
 * tool names, thinking tokens, intent, and per-turn usage; plus the agent_model
 * pricing catalog. Group + classify in JS (cost-analytics "derived in JS"
 * precedent). One row per turn; tool names aggregated per turn.
 */
export const fetchRoutability = Effect.fn("queries.fetchRoutability")(
  function* (input: RoutabilityInput) {
    const db = yield* SurrealClient;

    // Per-turn facts for MAIN-agent turns, ordered (session, seq). tool names
    // come from tool_call joined by turn; usage from turn_token_usage.
    const [turnRows] = yield* db.query<[Array<Record<string, unknown>>]>(
      /* surql */ `
      LET $since = time::now() - ${"" + input.days}d;
      SELECT
        session AS session_id,
        seq,
        role,
        intent_kind,
        text,
        (thinking_tokens OR 0) AS thinking_tokens,
        (SELECT VALUE name FROM tool_call WHERE turn = $parent.id) AS tool_names,
        (SELECT * FROM turn_token_usage WHERE turn = $parent.id LIMIT 1)[0] AS usage
      FROM turn
      WHERE ts >= $since
        AND (usage.source != 'claude-subagent' OR usage.source = NONE)
      ORDER BY session_id, seq;
      `,
    );

    // agent_model -> pricing catalog (same construction as dispatch-analytics).
    const [agentModelRows] = yield* db.query<[Array<Record<string, unknown>>]>(
      /* surql */ `SELECT name, input_per_million_usd, output_per_million_usd,
        cache_read_per_million_usd, cache_creation_per_million_usd FROM agent_model;`,
    );
    const pricingCatalog = new Map<string, ModelPricing>();
    for (const r of agentModelRows ?? []) {
      pricingCatalog.set(String(r.name), {
        // COPY the exact ModelPricing field names from dispatch-analytics.ts:642
        inputPerMillionUsd: Number(r.input_per_million_usd ?? 0),
        outputPerMillionUsd: Number(r.output_per_million_usd ?? 0),
        cacheReadPerMillionUsd: Number(r.cache_read_per_million_usd ?? 0),
        cacheCreationPerMillionUsd: Number(r.cache_creation_per_million_usd ?? 0),
      });
    }

    // Group rows by session, build TurnFacts, then spans per session.
    const bySession = new Map<string, TurnFacts[]>();
    for (const r of turnRows ?? []) {
      const sid = String(r.session_id ?? "");
      const usageRaw = r.usage as Record<string, unknown> | null | undefined;
      const facts: TurnFacts = {
        seq: Number(r.seq ?? 0),
        role: String(r.role ?? ""),
        toolNames: Array.isArray(r.tool_names) ? (r.tool_names as string[]) : [],
        thinkingTokens: Number(r.thinking_tokens ?? 0),
        intentKind: r.intent_kind == null ? null : String(r.intent_kind),
        text: r.text == null ? null : String(r.text),
        usage: usageRaw
          ? {
              prompt_tokens: Number(usageRaw.prompt_tokens ?? 0),
              completion_tokens: Number(usageRaw.completion_tokens ?? 0),
              cache_read_tokens: Number(usageRaw.cache_read_input_tokens ?? 0),
              cache_create_tokens: Number(usageRaw.cache_creation_input_tokens ?? 0),
              cost_usd: Number(usageRaw.estimated_cost_usd ?? 0),
            }
          : null,
      };
      const arr = bySession.get(sid) ?? [];
      arr.push(facts);
      bySession.set(sid, arr);
    }

    const allSpans: Span[] = [];
    for (const turns of bySession.values()) {
      allSpans.push(...buildSpans(turns, input.minRun));
    }

    return aggregateRoutability(allSpans, pricingCatalog, input);
  },
);
```

> The surql is a first cut. Step 3 verifies it runs against the real DB; adjust subquery syntax to whatever the existing queries use (check `cost-analytics.ts` / `dispatch-analytics.ts` for the project's sub-SELECT idiom - e.g. `$parent.id` vs `$this`). Keep the JS shaping identical.

- [ ] **Step 3: Smoke-test against the real DB + calibrate THINK_HI**

Run (the daemon DB must be up - `ax serve status`):
```bash
cd apps/axctl && bun -e "import {Effect} from 'effect'; import {fetchRoutability} from './src/queries/routability.ts'; import {DbLive} from './src/lib/db.ts'; /* COPY runner from an existing query script */ Effect.runPromise(fetchRoutability({days:30,minRun:3}).pipe(Effect.provide(DbLive))).then(r=>console.log(JSON.stringify(r,null,2)))"
```
Expected: a `RoutabilityResult` with `mainSpendUsd` in the ballpark of `ax cost split` main total (~$17.7K/30d). If `routablePct` looks absurd (e.g. >80% - too aggressive - or ~0% - too conservative), adjust `THINK_HI` and re-run. Document the chosen value in a comment.

> If you cannot write an ad-hoc runner cleanly, defer the smoke test to Task 6 (run the actual CLI command) and calibrate there.

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/queries/routability.ts
git commit -m "feat(routability): fetchRoutability DB query + main-thread span pipeline"
```

---

## Task 6: CLI subcommand `ax cost routability`

**Files:**
- Modify: `apps/axctl/src/cli/commands/ax-cost.ts`

- [ ] **Step 1: Read the existing split subcommand to mirror**

Run: `sed -n '162,255p' apps/axctl/src/cli/commands/ax-cost.ts`
Note: `Command.make`, `Flag` usage, the `--days` parse + `fail(...)`, `--json` branch, `fetchCostSplit({ sinceDays })`, render helpers, and how subcommands are added to `costCommand` (the `withSubcommands([...])` array).

- [ ] **Step 2: Add the subcommand**

In `apps/axctl/src/cli/commands/ax-cost.ts`:
1. Import: `import { fetchRoutability, type RoutabilityResult } from "../../queries/routability.ts";`
2. Add a render function:

```ts
function renderRoutability(r: RoutabilityResult): string {
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const lines: string[] = [];
  lines.push(
    `main-agent spend: ${usd(r.mainSpendUsd)}   routable: ${usd(r.routableUsd)} (${r.routablePct.toFixed(0)}%)   est. savings: ${usd(r.estSavingsUsd)}`,
  );
  lines.push("");
  lines.push("class            runs  turns  main_cost   tier     repriced   est_savings");
  for (const row of r.rows) {
    if (row.verdict === "stays") {
      lines.push(`stays main       ${String(row.runs).padStart(4)}  ${String(row.turns).padStart(5)}  ${usd(row.mainCostUsd).padStart(9)}   -        -          -`);
    } else {
      lines.push(
        `${row.class.padEnd(15)} ${String(row.runs).padStart(4)}  ${String(row.turns).padStart(5)}  ${usd(row.mainCostUsd).padStart(9)}   ${(row.tier ?? "").padEnd(7)} ${usd(row.repricedUsd ?? 0).padStart(9)}  ${usd(row.estSavingsUsd ?? 0).padStart(9)}`,
      );
    }
  }
  lines.push("");
  lines.push("estimate from historical token counts; judgment work left on frontier by design.");
  lines.push("next: ax dispatches --candidates   # the subagent-side leak");
  return lines.join("\n");
}
```

3. Define the command (mirror `costSplitCommand` exactly for flags + runtime):

```ts
// ax cost routability [--days=N] [--min-run=N] [--json]
const costRoutabilityCommand = Command.make(
  "routability",
  {
    days: Flag.integer("days").pipe(Flag.withDefault(30)),
    minRun: Flag.integer("min-run").pipe(Flag.withDefault(3)),
    json: Flag.boolean("json").pipe(Flag.withDefault(false)),
  },
  (input) =>
    Effect.gen(function* () {
      if (input.days <= 0) fail(`ax cost routability: --days must be a positive integer`);
      if (input.minRun <= 0) fail(`ax cost routability: --min-run must be a positive integer`);
      const result = yield* fetchRoutability({ days: input.days, minRun: input.minRun });
      if (input.json) {
        yield* Console.log(JSON.stringify(result, null, 2));
      } else {
        yield* Console.log(renderRoutability(result));
      }
    }),
).pipe(
  Command.withDescription(
    "Estimate how much main-agent spend was routable to a cheaper subagent",
  ),
);
```

> Copy the EXACT `Flag`/`Command`/`Console`/`fail`/runtime-provision idiom from `costSplitCommand` - names above are indicative; match the file.

4. Add `costRoutabilityCommand` to the `Command.withSubcommands([...])` array on `costCommand`.

- [ ] **Step 3: Build + run the real command**

Run:
```bash
bun run build 2>/dev/null || true
./bin/axctl cost routability --days=30
./bin/axctl cost routability --days=30 --json | head -30
```
Expected: the table renders; `mainSpendUsd` ≈ the `ax cost split` main total. Calibrate `THINK_HI` (Task 5) now if the smoke test was deferred.

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/cli/commands/ax-cost.ts apps/axctl/src/queries/routability.ts
git commit -m "feat(cli): ax cost routability subcommand + render"
```

---

## Task 7: MCP registration

**Files:**
- Modify: `apps/axctl/src/mcp/tools.ts`

- [ ] **Step 1: Read how cost_split is registered**

Run: `rg -n "cost_split|cost_models|fetchCostSplit" apps/axctl/src/mcp/tools.ts`
Mirror that registration exactly (name, input schema with `days`/`min_run`, the handler calling `fetchRoutability`).

- [ ] **Step 2: Register `cost_routability`**

Add an entry mirroring `cost_split`, e.g.:

```ts
{
  name: "cost_routability",
  description: "Estimate how much main-agent spend was routable to a cheaper subagent (gather/mechanical/niche-research class-runs), with est savings.",
  inputSchema: { /* COPY the cost_split schema shape; days default 30, min_run default 3 */ },
  handler: (args) => fetchRoutability({ days: args.days ?? 30, minRun: args.min_run ?? 3 }),
},
```

Add the import: `import { fetchRoutability } from "../queries/routability.ts";` (match the file's import style).

- [ ] **Step 3: Typecheck + test**

Run: `bun run typecheck && bun test apps/axctl/src/mcp`
Expected: no errors; MCP registry tests (if any) pass.

- [ ] **Step 4: Commit**

```bash
git add apps/axctl/src/mcp/tools.ts
git commit -m "feat(mcp): expose cost_routability read-only tool"
```

---

## Task 8: Docs

**Files:**
- Modify: `CLAUDE.md` (the "Cost analytics" block)

- [ ] **Step 1: Add the subcommand line**

In `CLAUDE.md`, under `### Cost analytics`, after the `ax cost split` line, add:

```
`ax cost routability [--days=N] [--min-run=N] [--json]` - main-thread routability lens: of main-agent spend, how much sat in routable class-runs (gather→haiku, mechanical-impl/niche-research→sonnet) vs genuine judgment, with est savings repriced one tier down. Deterministic (tool composition + thinking signal); reuses JUDGMENT_GUARD_RE + shared reprice. MCP: `cost_routability`. Spec: docs/superpowers/specs/2026-06-15-cost-routability-lens-design.md.
```

- [ ] **Step 2: Verify the new-subcommand docs gate passes**

Run: `bun test 2>&1 | rg -i "docs|subcommand|claude.md" | head` (and the full `bun test` below).

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: ax cost routability subcommand"
```

---

## Final verification

- [ ] **Step 1: Full gates**

Run: `bun test && bun run typecheck`
Expected: all pass, no type errors.

- [ ] **Step 2: End-to-end sanity**

Run: `./bin/axctl cost routability --days=30`
Expected: main spend ≈ `ax cost split` main total; routable% plausible (calibrated); judgment classes in the "stays main" rollup.

- [ ] **Step 3: Push branch + open PR (only when asked)**

Do not push/PR unless the user requests it.

---

## Self-Review (completed during authoring)

- **Spec coverage:** class-run unit (T3) ✓; A+B taxonomy + judgment-first precedence (T2) ✓; reprice/savings (T1,T4) ✓; `fetchRoutability` mirrors fetchCostSplit (T5) ✓; `ax cost routability` command (T6) ✓; MCP `cost_routability` (T7) ✓; CLAUDE.md docs gate (T8) ✓; honest-estimate framing in render (T6) ✓; thresholds documented/auditable (T2,T5) ✓. Phase-awareness explicitly v2 - not planned ✓.
- **Type consistency:** `RepriceUsage`, `TurnFacts`, `Span`, `RoutabilityInput/Result`, `WorkClass`, `ROUTABLE_TIER` names identical across T2–T7. `reprice(usage, targetModelName, pricingCatalog)` signature identical in T1 and used in T4/T5.
- **Placeholder scan:** the surql query (T5) and exact Flag/ModelPricing/SurrealClient idioms are flagged "copy from <file:line>" rather than guessed - deliberate, since those are existing project symbols whose exact form must be read from source, not invented. Every pure-core step has complete code + tests.
