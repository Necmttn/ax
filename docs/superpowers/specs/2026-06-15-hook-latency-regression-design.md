# Hook-latency regression tracking

Date: 2026-06-15
Status: final design, pre-implementation
Follows: `ax hooks bench` (`apps/axctl/src/hooks/bench.ts`), the hook telemetry
tables, the dispatch-economy / churn "windowed lens" pattern.

## Problem

Hooks run on the agent hot path (~70 ms budget). `ax hooks bench` measures a
candidate's latency *synthetically* (real bun spawns) at a point in time, but
nothing tracks whether an installed hook is getting **slower over time** in real
use - a latency regression (a new dep, a heavier query, a bigger routing table)
silently erodes the hot-path budget.

The real per-fire latency is already in the graph: `hook_command_invocation` has
`duration_ms` (option<int>), `hook_name`, `harness`, `ts`. So regression tracking
can be a **windowed read** over existing telemetry - no new storage - matching
the `ax dispatches --economy` / `ax sessions churn` idiom.

## Decision (locked)

- **Telemetry-lens now.** Ship a windowed regression lens over
  `hook_command_invocation.duration_ms`. No new schema/table.
- **Bench-snapshot table later (noted follow-up).** If real-fire `duration_ms`
  proves too sparse to trust (it is provider-reported and may be absent for some
  harnesses/events), a future PR can persist `ax hooks bench` snapshots to a new
  table for dense, deterministic history. Out of scope here; flagged in the PR.

## Design

### Query: `fetchHookLatencyRegression`

New `apps/axctl/src/queries/hook-latency.ts`:

```ts
export interface HookLatencyWindow {
  readonly p50: number; readonly p95: number; readonly samples: number;
}
export interface HookLatencyRow {
  readonly hook_name: string;
  readonly recent: HookLatencyWindow;
  readonly baseline: HookLatencyWindow;
  readonly p95_delta_ms: number;     // recent.p95 - baseline.p95
  readonly p95_ratio: number;        // recent.p95 / baseline.p95 (0 if baseline.p95 === 0)
  readonly regressed: boolean;
}
export interface HookLatencyReport {
  readonly recent_days: number;
  readonly baseline_days: number;
  readonly rows: ReadonlyArray<HookLatencyRow>;   // sorted: regressed first, then p95_delta desc
  readonly total_fires_with_latency: number;      // for the empty-state guard
}
export const fetchHookLatencyRegression = (opts: {
  recentDays: number; baselineDays: number;
  factor?: number; minDeltaMs?: number; minSamples?: number;
}): Effect.Effect<HookLatencyReport, DbError, SurrealClient>
```

Mechanics:
- **Windows.** recent = `ts > now - recentDays·d`. baseline = the span of
  `baselineDays` immediately BEFORE the recent window:
  `now - (recentDays+baselineDays)·d < ts <= now - recentDays·d`. (Disjoint, so a
  regression compares "now" against "the period before now," not against itself.)
- **Fetch** `hook_name`, `ts`, `duration_ms` from `hook_command_invocation`
  WHERE `duration_ms != NONE` AND `ts > now - (recentDays+baselineDays)·d`. Flat
  fields only (no graph traversal/derefs). Bucket each row into recent/baseline
  by `ts` in JS.
- **Percentiles.** Reuse the exported `percentiles()` from `apps/axctl/src/hooks/bench.ts`
  (DRY - same p50/p95 helper the bench ledger uses) on each hook×window duration
  array. (If reusing forces an awkward import direction, lift `percentiles` to a
  small shared util both import; prefer reuse first.)
- **Regression flag** (all must hold, to suppress noise):
  `recent.samples >= minSamples` (default 20) AND `baseline.samples >= minSamples`
  AND `recent.p95 - baseline.p95 >= minDeltaMs` (default 15) AND
  `recent.p95 >= baseline.p95 * factor` (default 1.5).
- **Sort** rows: regressed first, then by `p95_delta_ms` desc.

### CLI: `ax hooks latency`

`apps/axctl/src/hooks/cli.ts` - new subcommand mirroring `benchCommand`:
`ax hooks latency [--days=N] [--baseline=M] [--json]` (defaults: days 7,
baseline 21).
- Table: `hook_name · recent p50/p95 (n) · baseline p50/p95 (n) · Δp95 · ratio · ⚠`
  for regressed rows. Sorted regressed-first.
- Footer: count regressed / total hooks with telemetry.
- **Empty-state:** when `total_fires_with_latency === 0`, print a clear line:
  "no hook latency telemetry in this window - `duration_ms` is provider-reported
  and may be absent; try a wider --days or run `ax hooks bench <file>` for a
  synthetic measure." (Exit 0, not an error.)
- `--json` emits the `HookLatencyReport`.

### Format helper
Put rendering in a small pure `renderHookLatency(report) → string` (testable)
next to the query or in the existing hooks-format location, mirroring how bench
splits `benchHook` (compute) from `renderLedger` (format).

## Tests
- `fetchHookLatencyRegression`: route-stub test layer (like
  `thinking-analytics.test.ts`) - seed recent+baseline fires for two hooks, one
  regressed (recent p95 ≫ baseline) one stable; assert the regressed flag, delta,
  ratio, sort order, and that sub-`minSamples` hooks are NOT flagged. Assert
  `duration_ms == NONE` rows are excluded.
- `renderHookLatency`: regressed row shows ⚠; empty report shows the empty-state
  line.
- Window bucketing: a fire exactly at the recent/baseline boundary lands in the
  intended window.

## Docs (check:cli-reference gate - this IS a new subcommand)
- `README.md` + `docs/cli.md`: `axctl hooks latency` entry.
- `apps/site/public/llms.txt`: the `ax hooks latency` line.
- `CLAUDE.md` Hooks SDK section: a bullet for `ax hooks latency`.
Run `bun run check:cli-reference` to confirm coverage.

## Verify
- Unit tests above; `bun run typecheck`; touched-package `bun test`.
- **Live validation (report it):** run `ax hooks latency --days=7 --baseline=21`
  against the local DB and report whether `duration_ms` is populated enough to be
  useful. If the lens is empty (sparse telemetry), that's an expected degrade -
  confirm the empty-state renders and note it in the PR (it's the trigger for the
  snapshot-table follow-up).

## Out of scope / later
- Bench-snapshot persistence table (the "dense history" alternative) - follow-up
  if telemetry is too sparse.
- MCP `hook_latency` tool - add later if wanted (read-only, would fit).
- Per-event / per-harness latency breakdown (v1 is per `hook_name`).
- Alerting / CI gate on regression (v1 is a lens you run).

## Module map
```
apps/axctl/src/queries/hook-latency.ts        NEW fetchHookLatencyRegression + types + renderHookLatency + tests
apps/axctl/src/hooks/cli.ts                    + `ax hooks latency` subcommand
apps/axctl/src/hooks/bench.ts                  reuse exported percentiles() (no change, or lift to shared util)
README.md / docs/cli.md / llms.txt / CLAUDE.md  new-subcommand docs (check:cli-reference)
```
