# ForesightJS predictive prefetch for studio + site

Date: 2026-07-02
Issue: #661
Status: approved (brainstorm)

## Goal

Wire ForesightJS (`js.foresight@4.x`) into both React frontends so predicted
user intent (mouse trajectory, tab stops, scroll direction, viewport-entry on
touch) triggers prefetch of the destination route chunk AND its data before
the click lands. Nav feels instant; effectiveness is proven by dev-only
hit-rate counters.

- **Studio** (`apps/studio`, TanStack Router + React Query): session lists →
  `/sessions/<id>`, shell nav, project/skills/cost rows. Data prefetch =
  `queryClient.prefetchQuery` on the destination's existing query keys.
- **Site** (`apps/site`, TanStack Start on CF Pages): nav links, `/leaders`
  rows → `/u/<login>` (prefetch gist raw JSON), pitch-page CTAs (route chunk
  only).

## Decisions (locked)

1. **Target: both apps** via one shared package.
2. **Prefetch depth: route + data.** Callback fires `router.preloadRoute()`
   and an optional per-link `prefetchData()` thunk.
3. **Measurement: dev-only counters.** No schema/backend work in v1. Counts
   prefetch-fired vs navigated-within-5s → hit rate, exposed in console +
   ForesightJS devtools overlay, dev builds only.
4. **Approach A: shared `@ax/foresight` package** (mirrors `@ax/recap-deck`
   precedent - shared React lib consumed by studio + site).

## Architecture

### `packages/foresight` (`@ax/foresight`)

Raw `.ts`/`.tsx` per-file exports, no build step, extends `tsconfig.base.json`,
react as peer dep, `js.foresight` + `js.foresight-devtools` pinned in the root
`workspaces.catalog`.

Modules:

- `init.ts` - `initForesight(config?)`: idempotent, browser-only guard (site
  SSR), one-time `ForesightManager.initialize`. Dev builds also boot the
  devtools overlay.
- `use-foresight.ts` - `useForesight(ref, callback, opts?)`: registers the
  element on mount, unregisters on unmount (verify exact
  register/unregister return shape against `js.foresight@4.2.0` at
  implementation time - pin the version).
- `foresight-link.tsx` - `<ForesightLink>` wrapping TanStack `Link`. Props:
  everything `Link` takes plus optional `prefetchData?: () => Promise<unknown>`.
  Callback = `router.preloadRoute(destination)` + `prefetchData()`,
  fire-and-forget, errors caught + counted, never blocks nav. Keeps
  TanStack's own `preload="intent"` as fallback (they compose; foresight
  just fires earlier on trajectory).
- `ledger.ts` - pure hit-rate ledger: `recordPrefetch(key)`,
  `recordNavigate(key)`, hit = navigate within 5s of prefetch;
  `snapshot()` → `{ fired, hits, errors, hitRate }`. No DOM, fully
  unit-tested. Dev-only wiring exposes `window.__axForesight` + periodic
  console summary.

### Studio wiring

- `initForesight()` in `main.tsx`.
- Swap hot `Link`s to `ForesightLink`: shell nav, session list rows,
  project/skills/cost drill-ins. `prefetchData` uses the destination
  route's existing React Query keys via `queryClient.prefetchQuery`, so the
  detail route renders from warm cache.

### Site wiring

- `initForesight()` in the root client entry (browser-only guard is
  load-bearing - Start SSRs).
- `ForesightLink` on header nav, `/leaders` roster rows → `/u/<login>`
  (`prefetchData` fetches the gist raw JSON the profile route consumes),
  CTAs route-chunk-only.

## Error handling

- All prefetch callbacks fire-and-forget; rejections caught, counted in the
  ledger, never surfaced to the user.
- `initForesight` no-ops on server / repeated calls.
- If ForesightJS fails to load or register, links degrade to plain TanStack
  `Link` behavior (preload=intent still works).

## Out of scope (v1)

- Full telemetry to daemon/otel graph (possible v2: ledger → `/api/ingest`
  or otel event; would go through ship-checklist).
- Tiered prefetch (trajectory→chunk, hover→data).
- Non-link registrations (buttons triggering expensive queries) - API
  supports it via `useForesight`, but no call sites wired in v1.

## Testing

- `bun:test` unit tests: ledger (hit window, error counting), init
  idempotence/SSR guard, register/unregister lifecycle (happy-dom or mock).
- Manual verify: foresight devtools overlay shows trajectory hits; network
  tab shows route chunk + data request firing before click; studio session
  detail renders without loading spinner after predicted nav.
- CI: repo-wide `bun test` + `bun run typecheck` (root tsconfig sweeps
  packages - exclude/`@jsxImportSource` pragma like apps/studio if the React
  TSX trips the CLI config; see root-tsconfig-sweeps-web-packages).

## Risks

- **Wasted daemon queries** (studio): false-positive trajectories fire real
  `/api/*` queries. Mitigation: React Query dedupe + staleTime means a
  wasted prefetch is one extra local query; ledger quantifies waste.
- **TanStack `preloadRoute` API drift** between studio (router ^1.169) and
  site (^1.166) - wrapper takes the router via hook (`useRouter()`), not a
  hard version pin.
- **SSR**: any `ForesightManager` touch at module top-level breaks site
  build - all access behind `initForesight`/hooks.
