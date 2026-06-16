# Studio cost view - `/cost` dashboard

Date: 2026-06-16
Status: design (pre-implementation)
Branch: feat/studio-cost-view
Follows: the Effect HttpApi insights contract (`packages/lib/src/shared/api-contract.ts`
`InsightsGroup`, `costModels` is the precedent), the cost query layer
(`fetchCostSplit`, `fetchDispatches`/`fetchDispatchCandidates`, `fetchRoutability`),
studio routing (`apps/studio/src/router.tsx` + `<Shell>` nav).

## Problem

The blog article's signature visuals (main-vs-subagent split, per-model bars, dispatch
candidates, the routability lens) live only in the CLI + the article's hand-built figures.
Studio - the live dashboard - has **no cost view**; its only spend-adjacent route is
`/usage` (command utilization, not $). There's nothing to screenshot as "the live product"
for cost, and a user who installs ax can't *see* their bill broken down in the dashboard.

This adds a `/cost` studio route backed by the existing cost queries, exposed over the
dashboard HTTP API. v1 scope (user-chosen): **split + dispatches + routability**.

## Non-goals

- No new analytics. Pure surfacing of `fetchCostSplit` / `fetchDispatchCandidates` /
  `fetchRoutability` (already built + tested) through the dashboard API into studio.
- No curated payload schemas. Mirror `costModels` (`success: Schema.Unknown`) - these are
  read-only display payloads; the query fns own the shape. (A later tightening pass can add
  schemas, same as the rest of the insights surface.)
- Not the article embed. The `/showcases` update + screenshot into the post is Phase 3,
  separate.

## Architecture (mirror `costModels` × 3)

### 1. Contract - `packages/lib/src/shared/api-contract.ts` `InsightsGroup`

Add three GET endpoints (alongside `costModels`):

```ts
HttpApiEndpoint.get("costSplit", "/api/cost/split", {
  query: { days: Schema.optionalKey(Schema.Number) },
  success: Schema.Unknown, error: InternalError,
}),
HttpApiEndpoint.get("costDispatches", "/api/cost/dispatches", {
  query: {
    days: Schema.optionalKey(Schema.Number),
    candidates: Schema.optionalKey(Schema.Boolean),
  },
  success: Schema.Unknown, error: InternalError,
}),
HttpApiEndpoint.get("costRoutability", "/api/cost/routability", {
  query: {
    days: Schema.optionalKey(Schema.Number),
    minRun: Schema.optionalKey(Schema.Number),
  },
  success: Schema.Unknown, error: InternalError,
}),
```

### 2. Handlers - `apps/axctl/src/dashboard/contract/insights.ts`

```ts
.handle("costSplit", ({ query }) =>
  orInternal(fetchCostSplit({ sinceDays: query.days ?? 30 }).pipe(Effect.map(asJsonValue))))
.handle("costDispatches", ({ query }) =>
  orInternal((query.candidates
    ? fetchDispatchCandidates({ sinceDays: query.days ?? 30 })
    : fetchDispatches({ sinceDays: query.days ?? 30 })
  ).pipe(Effect.map(asJsonValue))))
.handle("costRoutability", ({ query }) =>
  orInternal(fetchRoutability({ days: query.days ?? 30, minRun: query.minRun ?? 1 })
    .pipe(Effect.map(asJsonValue))))
```

Import the three fns (`cost-analytics.ts`, `dispatch-analytics.ts`, `routability.ts`).
Verify the exact `fetchDispatches`/`fetchDispatchCandidates` input field names at build time.

### 3. Studio client - `apps/studio/src/api.ts`

Three `viaContract` methods mirroring `costModels`:

```ts
costSplit: (days = 30): Promise<CostSplitResult> =>
  viaContract("/api/cost/split", (c) => c.insights.costSplit({ query: { days } })) as ...,
costDispatches: (days = 30, candidates = false): Promise<...> =>
  viaContract("/api/cost/dispatches", (c) => c.insights.costDispatches({ query: { days, candidates } })) as ...,
costRoutability: (days = 30, minRun = 1): Promise<RoutabilityResult> =>
  viaContract("/api/cost/routability", (c) => c.insights.costRoutability({ query: { days, minRun } })) as ...,
```

Reuse the query result types (`CostSplitResult`, `RoutabilityResult`, dispatch types) imported
from the query modules for the casts.

### 4. Studio route - `apps/studio/src/routes/cost.tsx` (`/cost`)

`CostRoute` component (mirror `UsageRoute`'s `useQuery` + `panel` shape), three sections:
- **Spend split** - a proportional stacked bar (main vs subagent of total) + per-model bars
  (cost-weighted, fable peak). The article's hero visual, native in studio styling.
- **Dispatch candidates** - table/bars of inherit+expensive dispatches matching a route-down
  class, with suggested model + est savings (from `costDispatches({candidates:true})`).
- **Main-thread routability** - the routable-class rollup + est savings bars (from
  `costRoutability`).
Small shared bar primitive in studio (studio owns its CSS; do NOT import the site's
`bk-*` blog kit - separate app). Light empty/loading/error states like `UsageRoute`.

### 5. Register + nav

`router.tsx`: add `costRoute` (`getParentRoute: () => rootRoute, path: "/cost"`) to the route
tree. Add a `/cost` link to the `<Shell>` nav (find the nav in the Shell component).

## Testing

- Contract/handler: the dashboard contract has a wiring test pattern - add coverage that the
  three endpoints resolve (or at least typecheck into the group). Follow existing insights
  handler test precedent if present.
- Pure query fns are already unit-tested (cost-analytics, routability). No new query logic.
- studio render: a light smoke if the studio test harness supports it; else rely on the live
  cmux screenshot for verification.

## Verification

- `bun run typecheck` (repo) green for the touched packages (lib/axctl/studio); baseline noise
  excluded.
- `bun test` for axctl dashboard + lib contract.
- Build studio (`stage-studio.ts` or studio's `build:web`); run `ax serve` + studio dev,
  open `/cost` via cmux against the live local DB, screenshot. mainSpend etc. should match
  `ax cost split` / `ax cost routability`.

## Phase 3 (separate, after this lands)

- Update `/showcases` to reference/show the studio cost view.
- Screenshot the live `/cost` view; embed as a `<Figure>` in the routing-tune blog post.

## Risks

- `viaContract` returns the typed contract result but `success: Schema.Unknown` means the
  client casts - same trade-off the rest of the insights surface already makes (acceptable;
  the query types carry the real shape).
- studio bundles ship to the hosted studio (`stage-studio.ts` → site). Keep the new route
  code-split-friendly; verify the staged build still works (the blog PR's CF build is the
  precedent gate).
