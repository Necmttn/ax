# Studio cost view + interactive routing tuner - `/cost`

Date: 2026-06-16
Status: design (pre-implementation)
Branch: feat/studio-cost-view
Follows: the Effect HttpApi insights contract (`packages/lib/src/shared/api-contract.ts`),
the cost query layer (`fetchCostSplit`, `fetchDispatches`/`fetchDispatchCandidates`,
`fetchRoutability`), the shared routing matcher (`packages/hooks-sdk/src/routing-table.ts`
`matchRoutingTable`) + stored-table io (`apps/axctl/src/queries/routing-table-io.ts`),
studio routing (`apps/studio/src/router.tsx` + `<Shell>`).

## Problem

Routing is regex at its core: routing classes are regex patterns on the dispatch description
(`^implement`, `^Fix\s`, `^issue\s+\d+\b`) → a cheaper model; `ax routing tune` mines new
regexes; the judgment guard + routability classifier are regex too. But tuning is blind: you
edit a pattern, run `ax routing tune --emit-brief`, an agent backtests it, you apply IDs. No
live "what does this pattern actually catch?", and the false-positive problem (a class regex
that also matches judgment work) is only caught by that slow brief loop.

Meanwhile studio has no cost view at all (only `/usage`, command utilization). This builds one
`/cost` dashboard that does both halves:
- **Measure** (read-only): the spend split, dispatch candidates, and main-thread routability.
- **Tune** (interactive): a regex playground over your real dispatch history - edit a class
  pattern, see matches vs misses + est savings live, flag false positives (→ persisted
  exclusions), add/edit/remove classes, all written back to `~/.ax/hooks/routing-table.json`
  which the route-dispatch hook reads live.

v1 scope (user-chosen): full interactive incl. save-to-table, combined into one `/cost` view.

## Non-goals

- No new spend analytics - surfaces existing query fns. No new mining algorithm (the live
  backtest reuses the candidate/repricing logic; `ax routing tune`'s clustering stays CLI).
- Measure payloads stay `Schema.Unknown` (mirror `costModels`); the query fns own the shape.

## New cross-cutting piece: routing-class exclusions

`RoutingClass` gains `exclude?: readonly string[]` (regex strings). In `matchRoutingTable`:
after a class's `pattern` (or agentType) matches, if ANY `exclude` regex matches the
description, the class does **not** route down (treated as no-match / falls through). This is
the persistent false-positive mechanism, and because the hook fire-path and
`ax dispatches --candidates` both call `matchRoutingTable`, exclusions take effect everywhere
with one change. Touch points:
- `packages/hooks-sdk/src/routing-table.ts`: add `exclude` to the schema + `RoutingClass` +
  matcher logic (compile each exclude once; invalid regex → ignore that entry, never throw -
  fail-open like the rest of the hook).
- `routing-table-io.ts`: preserve `exclude` on user classes through merge/compile/save.
- Defaults (`ROUTING_CLASSES`) may omit `exclude` (optional); user/tuned classes carry it.

## API (contract + handlers)

### Read endpoints - `InsightsGroup` (mirror `costModels`, `success: Schema.Unknown`)
- `GET /api/cost/split?days` → `fetchCostSplit({sinceDays})`
- `GET /api/cost/dispatches?days&candidates` → `fetchDispatches` / `fetchDispatchCandidates`
- `GET /api/cost/routability?days&minRun` → `fetchRoutability`
- `GET /api/routing/table` → the effective stored table (classes w/ origin + agentTypes +
  exclude) for the tuner list.

### Backtest endpoint (read, but takes a candidate class)
- `POST /api/routing/backtest` body `{pattern, suggest, agentType?, exclude?: string[], days}`
  → over dispatch history: `matched` (dispatches the pattern catches, with child_cost +
  est savings repriced to `suggest`, minus those killed by `exclude`), `excluded` (matches
  the exclude removed), `missed` (expensive inherit dispatches the pattern does NOT catch -
  candidates for widening). Reuses the candidate/repricing path with an ad-hoc one-class table.
  POST (not GET) so `exclude[]` rides a JSON body cleanly. Read-only (no write).

### Write endpoints (follow `skillDecide`/`improveAction` POST precedent; localhost-bound)
- `POST /api/routing/classes` body `{id, pattern, suggest, agentType?, exclude?: string[]}` -
  upsert a `user`-origin class into routing-table.json via the merge-preserving compile/save
  logic (refuses to clobber a corrupt file, same as `ax routing compile`). Validate regex
  before write (400 on invalid pattern/exclude).
- `DELETE /api/routing/classes/:id` - remove a `user` class (default classes are not
  deletable; return 400/409). 
- Writes go through `routing-table-io` save (single source of truth), so the CLI + hook + UI
  all agree. The route-dispatch hook re-reads the file at fire time → edits are live.

## Studio `/cost` view (`apps/studio/src/routes/cost.tsx`)

`useQuery` per section (mirror `UsageRoute`'s panel/loading/error). Sections:

1. **Spend split** - proportional stacked bar (main vs subagent of total) + per-model bars
   (cost-weighted, fable peak). Native studio bar primitive (do NOT import the site blog kit).
2. **Dispatch candidates** - table/bars of inherit+expensive dispatches matching a route-down
   class, suggested model + est savings.
3. **Main-thread routability** - routable-class rollup + est savings.
4. **Routing tuner** (the interactive half):
   - List current classes (default vs user, each with pattern/suggest/exclude).
   - A pattern editor: type/edit `pattern` + `suggest` (+ optional agentType); debounced
     `POST /api/routing/backtest` shows **matched** dispatches (green, with $ saved),
     **missed** expensive ones, running est savings. Live regex feedback (invalid pattern →
     inline error, no crash).
   - **Flag false positive**: click a wrong match → its description seeds an `exclude` entry;
     re-backtest shows it moved to `excluded`. Exclusions editable as a list.
   - **Save**: `POST /api/routing/classes` (upsert) or `DELETE` (remove user class).
     Optimistic refresh of the table + candidates.
   - A mutation confirms with a toast + shows the equivalent CLI (`ax routing ...`) for
     transparency.

### Register + nav
`router.tsx`: add `costRoute` (`path: "/cost"`). Add a `/cost` link to `<Shell>` nav.

## Testing
- **Exclusion matcher** (hooks-sdk): unit tests - class matches, exclude kills it, invalid
  exclude ignored, no exclude = unchanged. This is the highest-risk logic (touches the live
  hook) → exhaustive.
- **io merge**: exclude preserved on user classes across compile/merge/save.
- **Backtest**: pure repricing/match over a fixture dispatch set → matched/excluded/missed
  partition + savings math.
- **Write handlers**: upsert + delete round-trip through routing-table-io (temp file), invalid
  regex → 400, default class not deletable.
- studio render: light smoke if harness supports; else cmux live verification.

## Verification
- `bun test` (hooks-sdk matcher, io, backtest, handlers) + `bun run typecheck` green for
  touched packages.
- `ax dispatches --candidates` still correct WITH an exclude present (regression - the shared
  matcher now skips excluded).
- Live: `ax serve` + studio dev, open `/cost` via cmux against the local DB; edit a pattern,
  watch matches; flag an FP; save; confirm routing-table.json updated and `ax routing show`
  reflects it. Screenshot for the article.

## Safety
- Dashboard binds 127.0.0.1 by default - write endpoints are local-only (same trust boundary
  as the CLI writing the file). Note: with `AX_SERVE_HOST=0.0.0.0` the write surface is
  exposed on the LAN; gate the routing write endpoints behind a localhost check (or a
  capability flag) so 0.0.0.0 exposure stays read-only. Decide at build: simplest is reject
  routing writes when the request isn't from loopback.
- All regex compiled in try/catch; invalid never throws into the hook path.
- routing-table-io already refuses to overwrite a corrupt file.

## Phase 3 (separate, after this lands)
- Update `/showcases` to reference the studio cost+tuner view.
- Screenshot the live `/cost` view (measure + tuner); embed as a `<Figure>` in the
  routing-tune blog post.

## Risks
- Biggest: the exclusion change touches the live route-dispatch hook matcher. Fail-open +
  exhaustive matcher tests are mandatory.
- `viaContract` casts the `Schema.Unknown` measure payloads (same trade-off as the rest of the
  insights surface).
- Studio bundles ship to hosted studio via `stage-studio.ts`; the write endpoints are daemon
  (local) only - hosted studio simply won't have a daemon to write to (read parts degrade,
  tuner save disabled when `api.isLive()` is false). Handle the not-live case in the UI.
