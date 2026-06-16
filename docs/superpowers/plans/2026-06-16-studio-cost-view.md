# Studio /cost View + Interactive Routing Tuner - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A studio `/cost` dashboard that measures spend (split / dispatches / routability) and lets the user interactively tune routing regexes against real dispatch history - flag false positives (persisted as class exclusions) and save classes back to `routing-table.json`, which the route-dispatch hook reads live.

**Architecture:** Add `exclude?: string[]` to the shared routing matcher (one change → hook + `ax dispatches --candidates` both honor it). Surface existing cost queries + a live regex backtest + routing-table writes over the Effect HttpApi contract (read = `Schema.Unknown` like `costModels`; writes follow the `skillDecide` POST/DELETE precedent, loopback-gated). A studio `/cost` route renders measure bars + an interactive tuner.

**Tech Stack:** bun ≥1.3, TS strict, effect@beta (`HttpApi*`, `Effect.fn`, `Schema`), bun:test, React 19 (studio).

**Spec:** `docs/superpowers/specs/2026-06-16-studio-cost-view-design.md`
**Worktree:** `/Users/necmttn/Projects/ax/.claude/worktrees/studio-cost` (branch `feat/studio-cost-view`, deps installed). All paths relative to it. Do NOT push.

---

## File Structure
- `packages/hooks-sdk/src/routing-table.ts` - add `exclude` to schema + `RoutingClass` + matcher.
- `packages/hooks-sdk/src/routing-table.test.ts` - exclusion matcher tests.
- `apps/axctl/src/queries/routing-table-io.ts` - preserve `exclude` on user classes; upsert/remove helpers.
- `apps/axctl/src/queries/routing-backtest.ts` (new) - pure backtest over dispatch rows.
- `apps/axctl/src/queries/routing-backtest.test.ts` (new).
- `packages/lib/src/shared/api-contract.ts` - read + backtest + write endpoints.
- `apps/axctl/src/dashboard/contract/insights.ts` - read + backtest handlers.
- `apps/axctl/src/dashboard/contract/routing.ts` (new) - write handlers (loopback-gated) OR add to insights; see Task 5.
- `apps/studio/src/api.ts` - client methods.
- `apps/studio/src/routes/cost.tsx` (new) - the view.
- `apps/studio/src/components/cost-bars.tsx` (new) - studio bar primitive.
- `apps/studio/src/router.tsx` + the `<Shell>` nav - register + link.

---

## Task 1: `exclude[]` in the shared matcher (highest risk - it's in the live hook path)

**Files:** Modify `packages/hooks-sdk/src/routing-table.ts`; Test `packages/hooks-sdk/src/routing-table.test.ts`.

- [ ] **Step 1: Write the failing tests** - append to `packages/hooks-sdk/src/routing-table.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { matchRoutingTable, type RoutingTableShape } from "./routing-table.ts";

const tbl = (cls: object): RoutingTableShape => ({
  version: 1,
  classes: [{ id: "impl", pattern: "^implement", flags: "i", suggest: "sonnet", reason: "impl", ...cls }],
  agentTypes: {},
});

describe("matchRoutingTable exclude", () => {
  it("matches when no exclude", () => {
    expect(matchRoutingTable(tbl({}), "Implement task 3", null)?.suggest).toBe("sonnet");
  });
  it("exclude regex suppresses a match (falls through to null)", () => {
    const t = tbl({ exclude: ["design"] });
    expect(matchRoutingTable(t, "Implement the design review", null)).toBeNull();
  });
  it("exclude that does not match leaves the class matching", () => {
    const t = tbl({ exclude: ["zzz"] });
    expect(matchRoutingTable(t, "Implement task 3", null)?.suggest).toBe("sonnet");
  });
  it("invalid exclude regex is ignored (fail-open, still matches)", () => {
    const t = tbl({ exclude: ["("] }); // invalid regex
    expect(matchRoutingTable(t, "Implement task 3", null)?.suggest).toBe("sonnet");
  });
  it("a later class still matches after an excluded earlier one", () => {
    const t: RoutingTableShape = {
      version: 1, agentTypes: {},
      classes: [
        { id: "impl", pattern: "^implement", flags: "i", suggest: "sonnet", reason: "i", exclude: ["design"] },
        { id: "any", pattern: "design", flags: "i", suggest: "haiku", reason: "d" },
      ],
    };
    expect(matchRoutingTable(t, "Implement the design", null)?.suggest).toBe("haiku");
  });
});
```

- [ ] **Step 2: Run - expect FAIL** (`exclude` not honored): `bun test packages/hooks-sdk/src/routing-table.test.ts`

- [ ] **Step 3: Implement.** In `packages/hooks-sdk/src/routing-table.ts`:

(a) Add to `RoutingClassSchema` (after `reason`): `exclude: Schema.optional(Schema.Array(Schema.String)),`
(b) Add to the `RoutingClass` interface: `readonly exclude?: readonly string[];`
(c) In `matchRoutingTable`, replace the matched-class `return {...}` block so an exclude can veto it:

```ts
      try {
        const re = new RegExp(cls.pattern, cls.flags ?? "");
        if (re.test(description)) {
          const excluded = (cls.exclude ?? []).some((ex) => {
            try { return new RegExp(ex, cls.flags ?? "").test(description); }
            catch { return false; } // invalid exclude regex → ignore (fail-open)
          });
          if (excluded) continue; // false-positive carve-out: skip, try next class
          return {
            classId: cls.id,
            suggest: cls.suggest,
            reason: cls.reason,
            source: "description",
          };
        }
      } catch {
        continue;
      }
```

- [ ] **Step 4: Run - expect PASS** (all 5 + existing matcher tests): `bun test packages/hooks-sdk/src/routing-table.test.ts`
- [ ] **Step 5: Typecheck** `bun run typecheck 2>&1 | rg "routing-table" || echo clean`
- [ ] **Step 6: Commit** `git add packages/hooks-sdk/src/routing-table.ts packages/hooks-sdk/src/routing-table.test.ts && git commit -m "feat(hooks-sdk): routing-class exclude[] regex carve-out in matchRoutingTable"`

---

## Task 2: Preserve `exclude` + upsert/remove in routing-table-io

**Files:** Modify `apps/axctl/src/queries/routing-table-io.ts`; Test `apps/axctl/src/queries/routing-table-io.test.ts` (append).

- [ ] **Step 1: Read the file first** to see `StoredRoutingClass`, the merge fn, and the save/load fns: `sed -n '1,140p' apps/axctl/src/queries/routing-table-io.ts`. `StoredRoutingClass extends RoutingClass` so it inherits `exclude` automatically - verify the merge spreads the whole class (`{...c, origin}`) so `exclude` survives. If merge reconstructs fields explicitly, add `exclude`.

- [ ] **Step 2: Write failing tests** - append to `routing-table-io.test.ts` (mirror existing test style; use the existing merge/save fn names found in Step 1 - shown here as `mergeRoutingTable`/`upsertUserClass`/`removeUserClass`, RENAME to match the file):

```ts
import { describe, expect, it } from "bun:test";
import { upsertUserClass, removeUserClass, type StoredRoutingTable } from "./routing-table-io.ts";

const base: StoredRoutingTable = { version: 1, classes: [], agentTypes: {} };

describe("routing-table-io exclude + upsert/remove", () => {
  it("upsert adds a user class with exclude preserved", () => {
    const t = upsertUserClass(base, { id: "issue-n", pattern: "^issue", flags: "i", suggest: "sonnet", reason: "issue", exclude: ["design"] });
    const c = t.classes.find((x) => x.id === "issue-n");
    expect(c?.origin).toBe("user");
    expect(c?.exclude).toEqual(["design"]);
  });
  it("upsert replaces an existing user class by id", () => {
    const t1 = upsertUserClass(base, { id: "x", pattern: "^a", flags: "", suggest: "sonnet", reason: "a" });
    const t2 = upsertUserClass(t1, { id: "x", pattern: "^b", flags: "", suggest: "haiku", reason: "b", exclude: ["q"] });
    expect(t2.classes.filter((c) => c.id === "x").length).toBe(1);
    expect(t2.classes.find((c) => c.id === "x")?.suggest).toBe("haiku");
    expect(t2.classes.find((c) => c.id === "x")?.exclude).toEqual(["q"]);
  });
  it("removeUserClass removes a user class", () => {
    const t1 = upsertUserClass(base, { id: "x", pattern: "^a", flags: "", suggest: "sonnet", reason: "a" });
    expect(removeUserClass(t1, "x").classes.find((c) => c.id === "x")).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run - expect FAIL** (`upsertUserClass`/`removeUserClass` not exported): `bun test apps/axctl/src/queries/routing-table-io.test.ts`

- [ ] **Step 4: Implement** in `routing-table-io.ts` - add two pure helpers (place near the existing merge fn; match the real `StoredRoutingTable`/`StoredRoutingClass` type names):

```ts
/** Upsert a user-origin class by id (replaces same-id, else appends). */
export function upsertUserClass(
  table: StoredRoutingTable,
  cls: Omit<StoredRoutingClass, "origin">,
): StoredRoutingTable {
  const next: StoredRoutingClass = { ...cls, origin: "user" };
  const rest = table.classes.filter((c) => c.id !== cls.id);
  return { ...table, classes: [...rest, next] };
}

/** Remove a user-origin class by id. Default classes are not removable. */
export function removeUserClass(table: StoredRoutingTable, id: string): StoredRoutingTable {
  return {
    ...table,
    classes: table.classes.filter((c) => !(c.id === id && c.origin !== "default")),
  };
}
```

Confirm the merge fn (Step 1) spreads `exclude`; if it whitelists fields, add `exclude`.

- [ ] **Step 5: Run - expect PASS** + typecheck: `bun test apps/axctl/src/queries/routing-table-io.test.ts && bun run typecheck 2>&1 | rg routing-table-io || echo clean`
- [ ] **Step 6: Commit** `git add apps/axctl/src/queries/routing-table-io.ts apps/axctl/src/queries/routing-table-io.test.ts && git commit -m "feat(routing): upsert/remove user classes + preserve exclude in io"`

---

## Task 3: Pure backtest logic

**Files:** Create `apps/axctl/src/queries/routing-backtest.ts` + `.test.ts`.

Read `apps/axctl/src/queries/dispatch-analytics.ts` first for the dispatch row shape + `reprice`/`MODEL_ALIASES` (now in `./reprice.ts`) so the backtest reprices identically.

- [ ] **Step 1: Write failing test** `apps/axctl/src/queries/routing-backtest.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { backtestPattern, type BacktestDispatch } from "./routing-backtest.ts";

const d = (description: string, childModel: string, cost: number): BacktestDispatch => ({
  description, agent_type: "general-purpose", child_model: childModel, child_cost_usd: cost, dispatch_model: "inherit",
});

const rows: BacktestDispatch[] = [
  d("Implement task 3", "claude-fable-5", 50),     // matches ^implement, expensive → candidate
  d("Implement the design review", "claude-fable-5", 40), // matches, but exclude 'design' → excluded
  d("Fix the build", "claude-fable-5", 30),         // misses ^implement → missed (expensive inherit)
  d("Implement small", "claude-sonnet-4-6", 5),     // matches but already cheap → matched, ~0 savings
];

describe("backtestPattern", () => {
  it("partitions matched / excluded / missed with savings", () => {
    const r = backtestPattern(rows, { pattern: "^implement", flags: "i", suggest: "sonnet", exclude: ["design"] }, new Map());
    expect(r.matched.map((m) => m.description)).toContain("Implement task 3");
    expect(r.excluded.map((m) => m.description)).toContain("Implement the design review");
    expect(r.missed.map((m) => m.description)).toContain("Fix the build");
    expect(r.estSavingsUsd).toBeGreaterThan(0);
  });
  it("no exclude → nothing excluded", () => {
    const r = backtestPattern(rows, { pattern: "^implement", flags: "i", suggest: "sonnet" }, new Map());
    expect(r.excluded.length).toBe(0);
  });
  it("invalid pattern → empty matched, all expensive go to missed, no throw", () => {
    const r = backtestPattern(rows, { pattern: "(", flags: "", suggest: "sonnet" }, new Map());
    expect(r.matched.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run - expect FAIL.** `bun test apps/axctl/src/queries/routing-backtest.test.ts`

- [ ] **Step 3: Implement** `apps/axctl/src/queries/routing-backtest.ts`:

```ts
import { reprice, MODEL_ALIASES, type RepriceUsage } from "./reprice.ts";
import type { ModelPricing } from "../ingest/model-pricing.ts";

const EXPENSIVE_RE = /fable|opus/i;

export interface BacktestDispatch {
  description: string | null;
  agent_type: string | null;
  child_model: string | null;
  child_cost_usd: number;
  dispatch_model: string;
  usage?: RepriceUsage | null; // when present, savings repriced precisely; else 0
}

export interface BacktestPattern {
  pattern: string; flags?: string; suggest: string; exclude?: readonly string[];
}
export interface BacktestRow { description: string | null; childModel: string | null; costUsd: number; estSavingsUsd: number; }
export interface BacktestResult {
  matched: BacktestRow[]; excluded: BacktestRow[]; missed: BacktestRow[];
  estSavingsUsd: number; matchedCount: number;
}

export function backtestPattern(
  rows: ReadonlyArray<BacktestDispatch>,
  p: BacktestPattern,
  pricingCatalog: Map<string, ModelPricing>,
): BacktestResult {
  let re: RegExp | null = null;
  try { re = new RegExp(p.pattern, p.flags ?? ""); } catch { re = null; }
  const excludeRes = (p.exclude ?? []).map((ex) => {
    try { return new RegExp(ex, p.flags ?? ""); } catch { return null; }
  }).filter((x): x is RegExp => x !== null);

  const matched: BacktestRow[] = [], excluded: BacktestRow[] = [], missed: BacktestRow[] = [];
  let estSavingsUsd = 0;
  const target = MODEL_ALIASES[p.suggest] ?? p.suggest;

  for (const row of rows) {
    const desc = row.description ?? "";
    const hit = re ? re.test(desc) : false;
    const isExpensiveInherit = row.dispatch_model === "inherit" && !!row.child_model && EXPENSIVE_RE.test(row.child_model);
    const saving = row.usage
      ? Math.max(0, row.child_cost_usd - Math.min(reprice(row.usage, target, pricingCatalog), row.child_cost_usd))
      : 0;
    const out: BacktestRow = { description: row.description, childModel: row.child_model, costUsd: row.child_cost_usd, estSavingsUsd: saving };
    if (hit && excludeRes.some((ex) => ex.test(desc))) { excluded.push(out); continue; }
    if (hit) { matched.push(out); estSavingsUsd += saving; continue; }
    if (isExpensiveInherit) missed.push(out);
  }
  return { matched, excluded, missed, estSavingsUsd, matchedCount: matched.length };
}
```

- [ ] **Step 4: Run - expect PASS** + typecheck. `bun test apps/axctl/src/queries/routing-backtest.test.ts && bun run typecheck 2>&1 | rg routing-backtest || echo clean`
- [ ] **Step 5: Commit** `git add apps/axctl/src/queries/routing-backtest.ts apps/axctl/src/queries/routing-backtest.test.ts && git commit -m "feat(routing): pure backtestPattern (matched/excluded/missed + savings)"`

---

## Task 4: Contract endpoints (read + backtest + write)

**Files:** Modify `packages/lib/src/shared/api-contract.ts`.

- [ ] **Step 1: Read** the `InsightsGroup` `costModels` endpoint (~line 363) and the `SkillsGroup` POST/DELETE endpoints (`skillDecide` ~774, `skillDecideClear` DELETE ~792) to mirror request-body + params shapes exactly.

- [ ] **Step 2: Add read + backtest endpoints to `InsightsGroup`** (after `costModels`):

```ts
        HttpApiEndpoint.get("costSplit", "/api/cost/split", {
          query: { days: Schema.optionalKey(Schema.Number) },
          success: Schema.Unknown, error: InternalError,
        }),
        HttpApiEndpoint.get("costDispatches", "/api/cost/dispatches", {
          query: { days: Schema.optionalKey(Schema.Number), candidates: Schema.optionalKey(Schema.Boolean) },
          success: Schema.Unknown, error: InternalError,
        }),
        HttpApiEndpoint.get("costRoutability", "/api/cost/routability", {
          query: { days: Schema.optionalKey(Schema.Number), minRun: Schema.optionalKey(Schema.Number) },
          success: Schema.Unknown, error: InternalError,
        }),
        HttpApiEndpoint.get("routingTable", "/api/routing/table", {
          success: Schema.Unknown, error: InternalError,
        }),
        HttpApiEndpoint.post("routingBacktest", "/api/routing/backtest", {
          payload: {
            pattern: Schema.String, flags: Schema.optionalKey(Schema.String),
            suggest: Schema.String, exclude: Schema.optionalKey(Schema.Array(Schema.String)),
            days: Schema.optionalKey(Schema.Number),
          },
          success: Schema.Unknown, error: [BadRequestError, InternalError],
        }),
```

- [ ] **Step 3: Add write endpoints.** Put them in a new group `RoutingGroup` (cleaner than overloading Insights) OR in InsightsGroup - match the file's grouping style. Group form:

```ts
export const RoutingGroup = HttpApiGroup.make("routing")
  .add(
    HttpApiEndpoint.post("routingUpsertClass", "/api/routing/classes", {
      payload: {
        id: Schema.String, pattern: Schema.String, flags: Schema.optionalKey(Schema.String),
        suggest: Schema.String, reason: Schema.optionalKey(Schema.String),
        exclude: Schema.optionalKey(Schema.Array(Schema.String)),
      },
      success: Schema.Unknown, error: [BadRequestError, InternalError],
    }),
    HttpApiEndpoint.del("routingRemoveClass", "/api/routing/classes/:id", {
      params: { id: Schema.String },
      success: Schema.Unknown, error: [BadRequestError, InternalError],
    }),
  );
```

Then `.add(RoutingGroup)` to the `AxApi` (`HttpApi.make(...)` list near line 968). (Verify the exact `.del` vs `.delete` builder name from the `skillDecideClear` precedent - use whatever that file uses.)

- [ ] **Step 4: Typecheck the contract** `bun run typecheck 2>&1 | rg "api-contract" || echo clean`
- [ ] **Step 5: Commit** `git add packages/lib/src/shared/api-contract.ts && git commit -m "feat(contract): cost read + routing backtest/table + class write endpoints"`

---

## Task 5: Dashboard handlers (read + backtest + loopback-gated writes)

**Files:** Modify `apps/axctl/src/dashboard/contract/insights.ts`; create `apps/axctl/src/dashboard/contract/routing.ts`; register the new group where groups are assembled (find via `rg -n "InsightsGroupLive|HttpApiBuilder|\.group\(" apps/axctl/src/dashboard`).

- [ ] **Step 1: Read** `insights.ts` imports + `orInternal`/`asJsonValue` (`./common.ts`) + how groups are registered into the server.

- [ ] **Step 2: Add read + backtest handlers** to `InsightsGroupLive` (after `costModels`). Import `fetchCostSplit` (cost-analytics), `fetchDispatches`/`fetchDispatchCandidates` (dispatch-analytics), `fetchRoutability` (routability), `loadEffectiveRoutingTable` (routing-table-io), `backtestPattern` (routing-backtest), plus the agent_model→pricingCatalog builder (copy the small loop from dispatch-analytics, or extract a helper):

```ts
.handle("costSplit", ({ query }) =>
  orInternal(fetchCostSplit({ sinceDays: query.days ?? 30 }).pipe(Effect.map(asJsonValue))))
.handle("costDispatches", ({ query }) =>
  orInternal((query.candidates
    ? fetchDispatchCandidates({ sinceDays: query.days ?? 30 })
    : fetchDispatches({ sinceDays: query.days ?? 30 })
  ).pipe(Effect.map(asJsonValue))))
.handle("costRoutability", ({ query }) =>
  orInternal(fetchRoutability({ days: query.days ?? 30, minRun: query.minRun ?? 1 }).pipe(Effect.map(asJsonValue))))
.handle("routingTable", () =>
  orInternal(loadEffectiveRoutingTable().pipe(Effect.map(asJsonValue))))
.handle("routingBacktest", ({ payload }) =>
  orInternal(runRoutingBacktest(payload).pipe(Effect.map(asJsonValue))))
```

Where `runRoutingBacktest` is an `Effect.fn` you add (in routing-backtest.ts or a dashboard helper): query dispatch history for the window (reuse the SQL/shape `fetchDispatches` uses), build the pricing catalog, call `backtestPattern(rows, payload, catalog)`. Confirm `fetchDispatches`/`fetchDispatchCandidates` input field names against dispatch-analytics.ts.

- [ ] **Step 3: Write handlers** - create `apps/axctl/src/dashboard/contract/routing.ts` (`RoutingGroupLive`), loopback-gated. The handler context exposes the request; gate non-loopback:

```ts
import { Effect } from "effect";
import { HttpApiBuilder, HttpServerRequest } from "effect/unstable/httpapi"; // confirm import path from insights.ts
import { AxApi } from "@ax/lib/shared/api-contract";
import { BadRequestError } from "@ax/lib/shared/api-contract";
import { orInternal, asJsonValue } from "./common.ts";
import { loadStoredRoutingTable, saveRoutingTable, upsertUserClass, removeUserClass } from "../../queries/routing-table-io.ts";

const requireLoopback = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const host = req.headers["host"] ?? "";
  const ok = host.startsWith("127.0.0.1") || host.startsWith("localhost") || host.startsWith("[::1]");
  if (!ok) return yield* Effect.fail(new BadRequestError({ error: "routing writes are loopback-only" }));
});

function validateRegex(pattern: string, flags?: string): boolean {
  try { new RegExp(pattern, flags ?? ""); return true; } catch { return false; }
}

export const RoutingGroupLive = HttpApiBuilder.group(AxApi, "routing", (h) =>
  h
    .handle("routingUpsertClass", ({ payload }) =>
      requireLoopback.pipe(Effect.andThen(
        !validateRegex(payload.pattern, payload.flags) || (payload.exclude ?? []).some((e) => !validateRegex(e, payload.flags))
          ? Effect.fail(new BadRequestError({ error: "invalid regex" }))
          : orInternal(Effect.gen(function* () {
              const t = yield* loadStoredRoutingTable();
              const next = upsertUserClass(t, {
                id: payload.id, pattern: payload.pattern, flags: payload.flags ?? "",
                suggest: payload.suggest, reason: payload.reason ?? payload.id,
                ...(payload.exclude ? { exclude: payload.exclude } : {}),
              });
              yield* saveRoutingTable(next);
              return asJsonValue(next);
            }))
      )))
    .handle("routingRemoveClass", ({ params }) =>
      requireLoopback.pipe(Effect.andThen(orInternal(Effect.gen(function* () {
        const t = yield* loadStoredRoutingTable();
        const next = removeUserClass(t, params.id);
        yield* saveRoutingTable(next);
        return asJsonValue(next);
      })))))
);
```

(Names `loadStoredRoutingTable`/`saveRoutingTable`/`loadEffectiveRoutingTable` are indicative - use the REAL exports from routing-table-io.ts found in Task 2 Step 1. Confirm the `HttpServerRequest` import + builder names against an existing handler file.)

- [ ] **Step 4: Register `RoutingGroupLive`** in the server's layer assembly (next to `InsightsGroupLive`).

- [ ] **Step 5: Typecheck + dashboard tests** `bun run typecheck 2>&1 | rg "dashboard|insights|routing" | head; bun test apps/axctl/src/dashboard 2>&1 | tail -4`
- [ ] **Step 6: Commit** `git add apps/axctl/src/dashboard apps/axctl/src/queries/routing-backtest.ts && git commit -m "feat(dashboard): cost reads + routing backtest + loopback-gated class writes"`

---

## Task 6: Studio API client

**Files:** Modify `apps/studio/src/api.ts`.

- [ ] **Step 1: Read** the `costModels` + a POST client method (`skillDecide`/`improveAction`) to mirror `viaContract` request shapes.

- [ ] **Step 2: Add methods** (after `costModels`); import result types from the query modules for casts:

```ts
costSplit: (days = 30): Promise<unknown> =>
  viaContract("/api/cost/split", (c) => c.insights.costSplit({ query: { days } })),
costDispatches: (days = 30, candidates = false): Promise<unknown> =>
  viaContract("/api/cost/dispatches", (c) => c.insights.costDispatches({ query: { days, candidates } })),
costRoutability: (days = 30, minRun = 1): Promise<unknown> =>
  viaContract("/api/cost/routability", (c) => c.insights.costRoutability({ query: { days, minRun } })),
routingTable: (): Promise<unknown> =>
  viaContract("/api/routing/table", (c) => c.insights.routingTable()),
routingBacktest: (body: { pattern: string; flags?: string; suggest: string; exclude?: string[]; days?: number }): Promise<unknown> =>
  viaContract("/api/routing/backtest", (c) => c.insights.routingBacktest({ payload: body })),
routingUpsertClass: (body: { id: string; pattern: string; flags?: string; suggest: string; reason?: string; exclude?: string[] }): Promise<unknown> =>
  viaContract("/api/routing/classes", (c) => c.routing.routingUpsertClass({ payload: body })),
routingRemoveClass: (id: string): Promise<unknown> =>
  viaContract(`/api/routing/classes/${encodeURIComponent(id)}`, (c) => c.routing.routingRemoveClass({ params: { id } })),
```

(Adjust `c.routing.*` to the actual generated client group accessor. Tighten `unknown` to the real result types where cheap.)

- [ ] **Step 3: Typecheck** `bun run typecheck 2>&1 | rg "studio/src/api" || echo clean`
- [ ] **Step 4: Commit** `git add apps/studio/src/api.ts && git commit -m "feat(studio): api client for cost + routing tuner endpoints"`

---

## Task 7: Studio `/cost` route - measure bars + interactive tuner

**Files:** Create `apps/studio/src/components/cost-bars.tsx` + `apps/studio/src/routes/cost.tsx`.

- [ ] **Step 1: Read** `apps/studio/src/routes/usage.tsx` (panel/useQuery/loading/error pattern) + an existing studio mutation component (a skill-decide button) for the write+refetch pattern, and the studio CSS class conventions (`panel`, `meta`, `badge`).

- [ ] **Step 2: Build `cost-bars.tsx`** - a small presentational bar primitive (no data fetching):

```tsx
export function SplitBar({ segs }: { segs: { label: string; value: number; tone: "ink" | "green" }[] }) {
  const total = segs.reduce((s, x) => s + x.value, 0) || 1;
  return (
    <div className="cost-splitbar" style={{ display: "flex", width: "100%", height: 28 }}>
      {segs.map((s) => (
        <div key={s.label} title={`${s.label} ${(100 * s.value / total).toFixed(1)}%`}
          style={{ width: `${(100 * s.value / total).toFixed(2)}%`, background: s.tone === "green" ? "var(--ax-green, #2f9e44)" : "var(--ax-ink, #222)" }} />
      ))}
    </div>
  );
}
export function BarRow({ label, value, max, sub }: { label: string; value: number; max: number; sub?: string }) {
  return (
    <div className="cost-bar-row" style={{ margin: "6px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}><span>{label}</span><span>{sub}</span></div>
      <div style={{ height: 8, background: "var(--ax-line,#eee)" }}>
        <div style={{ width: `${Math.max(2, (100 * value / (max || 1))).toFixed(1)}%`, height: 8, background: "var(--ax-ink,#222)" }} />
      </div>
    </div>
  );
}
```

(Use the real studio CSS tokens/classes found in Step 1; keep inline styles minimal or move to studio CSS.)

- [ ] **Step 3: Build `cost.tsx`** - `CostRoute` with `useQuery` per section (split/dispatches/routability/routingTable) and the tuner. The tuner: controlled `pattern`/`suggest`/`exclude[]` state, a debounced `api.routingBacktest(...)` call rendering matched (green, $ saved) / missed / excluded; a "flag false positive" button on a matched row that pushes a token from its description into `exclude`; a Save button → `api.routingUpsertClass(...)` then refetch `routingTable` + `costDispatches`. Guard the whole tuner behind `api.isLive()` (writes need the daemon). Loading/error/empty states like `UsageRoute`. Keep it one focused component; extract sub-parts if it grows past ~250 lines.

  Write it to compile + render with real data; exact JSX is the implementer's craft, but it MUST: (a) call all 4 read endpoints, (b) call backtest on edit (debounced), (c) call upsert/remove and refetch, (d) degrade when `!api.isLive()`.

- [ ] **Step 4: Verify it builds** `cd apps/studio && bun run typecheck 2>&1 | rg "cost.tsx|cost-bars" || echo clean` (studio typecheck; from repo root if studio has no own script).
- [ ] **Step 5: Commit** `git add apps/studio/src/routes/cost.tsx apps/studio/src/components/cost-bars.tsx && git commit -m "feat(studio): /cost view - spend bars + interactive routing tuner"`

---

## Task 8: Register route + nav

**Files:** Modify `apps/studio/src/router.tsx` + the `<Shell>` nav component.

- [ ] **Step 1: Add the route** in `router.tsx` (mirror `usageRoute`):

```ts
import { CostRoute } from "./routes/cost.tsx";
const costRoute = createRoute({ getParentRoute: () => rootRoute, path: "/cost", component: CostRoute });
```
Add `costRoute` to the `rootRoute.addChildren([...])` / route tree array (find where `usageRoute` is added).

- [ ] **Step 2: Add nav link.** Find `<Shell>` (`rg -n "Shell" apps/studio/src/*.tsx apps/studio/src/components/*.tsx`); add a `<Link to="/cost">Cost</Link>` next to the Usage link.

- [ ] **Step 3: Build studio + verify** `cd apps/studio && bun run build:web 2>&1 | tail -5` (or the staged build); fix any route-tree type errors.
- [ ] **Step 4: Commit** `git add apps/studio/src/router.tsx apps/studio/src/components && git commit -m "feat(studio): register /cost route + nav link"`

---

## Final verification
- [ ] `bun test` (repo) - hooks-sdk matcher, io, backtest, dashboard handlers green; no new failures.
- [ ] `bun run typecheck` - no NEW errors in touched packages (note studio's pre-existing baseline).
- [ ] Live: `ax serve` running (LaunchAgent) + `cd apps/studio && bun run dev`; open `/cost` via cmux against the local DB. Confirm: split bar ≈ `ax cost split`; edit a pattern → live matches; flag an FP → moves to excluded; Save → `ax routing show` reflects the new user class with `exclude`; `ax dispatches --candidates` still correct.
- [ ] `ax dispatches --candidates` regression check WITH an exclude present (shared matcher).
- [ ] Do NOT push / PR until asked.

## Self-Review
- **Spec coverage:** exclude mechanism (T1) ✓; io preserve+upsert/remove (T2) ✓; backtest (T3) ✓; read+backtest+write contract (T4) ✓; handlers incl loopback gate (T5) ✓; client (T6) ✓; /cost measure+tuner UI (T7) ✓; route+nav (T8) ✓; fail-open regex (T1/T3) ✓; localhost-only writes (T5) ✓; not-live degrade (T7) ✓. Phase 3 (showcases+screenshot+article) intentionally out of this plan.
- **Type consistency:** `exclude?: readonly string[]` consistent T1→T2; `BacktestPattern`/`BacktestResult` T3 used by T5; client method names T6 match contract endpoint ids T4. Indicative io fn names flagged "use real exports" where the file wasn't fully read.
- **Placeholders:** DB-touching/import-path specifics are flagged "confirm against <file>" (existing symbols that must be read, not invented) rather than guessed - deliberate; pure-logic tasks (T1–T3) carry complete code + tests.
