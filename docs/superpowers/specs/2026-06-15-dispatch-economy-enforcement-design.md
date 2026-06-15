# Quota-aware dispatch economy - proactive window awareness + enforcement

Date: 2026-06-15
Status: design for multi-agent review, pre-implementation
Follows: skills/efficient-dispatch/SKILL.md, the route-dispatch hook, the quota module

## Problem

Two failures, both observed live:

1. **Enforcement gap.** A `well-specified-impl` routing class (`^implement ` → sonnet)
   exists and the route-dispatch hook is installed, yet a full session of
   `Implement …` subagents ran on the expensive inherited model - ~$130 over.
   The hook only **warns**, and a `PreToolUse(Agent)` warn arrives as the
   dispatch already goes out: an ignorable nudge, not a guardrail.

2. **The economy is one-directional and quota-blind.** "Route down to cheaper"
   is correct only while conserving. Plan quota is **use-it-or-lose-it**: late
   in a 5h/7d window with 40% remaining, forcing sonnet *wastes* surplus that
   resets unused. The right rule is **cheap when conserving, best-model
   everywhere when burning surplus near a reset** - and the system should
   **proactively know** which regime it's in, not discover it passively.

## Core: a proactively-fresh spend mode

A single signal, `SpendMode = "conserve" | "splurge"`, derived from the quota
windows and kept **current** so every dispatch decision is accurate.

### `computeSpendMode(snapshot, nowMs, config)` - pure

Input: the `QuotaSnapshot` shape already cached at `~/.ax/quota-cache.json`
(`five_hour`/`seven_day`, each `{ utilization, resets_at }`, plus `fetched_at`).

- **stale guard:** if `nowMs - fetched_at > stalenessMs` (default 5 min) →
  `conserve` (never splurge on uncertainty).
- **splurge** when *either* window satisfies BOTH:
  - `resets_at - now < nearResetMs` (5h window default 90 min; 7d default 24 h), AND
  - `100 - utilization > minRemainingPct` (default 25).
  Rationale: a window about to reset with lots unused = surplus that will
  evaporate; spend it on the best model.
- else **conserve**.
- thresholds (`stalenessMs`, per-window `nearResetMs`, `minRemainingPct`) live
  in `routing-table.json` so they're tunable without a code change.

### Manual override

`AX_SPEND_MODE=auto|conserve|splurge` wins over the computed mode (`auto` = use
the computation). The "I'm willing to throw the best model at everything" switch.

### Proactive freshness (the "system knows" requirement)

`computeSpendMode` is only as good as the cache. Two mechanisms keep it warm so
splurge is detected the moment it's true, not whenever the user happens to run
statusline:

1. **SessionStart refresh hook** (new, `~/.ax/hooks/refresh-quota.ts` via the
   SDK): on `SessionStart`, run a quota refresh (`ax quota` honors its 60s TTL,
   or `--fresh`) so every session begins with a current window picture. Fires
   once per session - latency-tolerant, off the per-tool hot path.
2. **Continuous tick** (recommended, can land in the same PR or follow): the
   existing `com.necmttn.ax-watch` LaunchAgent already runs in the background;
   add a periodic `ax quota` refresh (~every 5 min) so long sessions stay fresh
   between SessionStarts. If deferred, the stale-guard degrades safely to
   conserve.

The dispatch hot path **never** fetches - the route-dispatch hook only *reads*
the local cache file (fast), so the ~70 ms hook budget is preserved.

## Enforcement: route-dispatch hook verdicts

Extend `packages/hooks-sdk/src/hooks/route-dispatch.ts`. Detection (routing
table + `matchTable`) is unchanged; the verdict becomes mode- and
model-conditional.

Let `match` = `matchTable(table, description, subagentType)` (a route-down class
suggesting sonnet/haiku), `explicit` = an explicit `model` in the Agent input,
`cheap` = explicit model matches `/sonnet|haiku/i`, `judgmentStrong` =
description/agent_type is a **stays-strong** judgment kind (see below).

| condition | verdict |
|-----------|---------|
| `match` && !`explicit` && mode=**conserve** | **block** - "looks like `<class>`; dispatch with `model:<suggest>` (or `model:opus` to override)" |
| `match` && !`explicit` && mode=**splurge** | **allow** - surplus is free; the inherited (strong) model runs |
| `match` && `cheap` && mode=**splurge** | **warn** - "splurge window: routing down wastes expiring surplus; prefer the strong model" |
| `judgmentStrong` && `cheap` (any mode) | **warn** - "judgment work is the catch-rate gate; consider the strong model" |
| `explicit` (and none of the above) | allow - an explicit model is a deliberate choice |
| no `match`, not `judgmentStrong` | allow |

`block` reuses the proven enforce-worktree mechanism (deny the `PreToolUse`,
agent re-dispatches with a model). It only fires on a *forgotten* route in
conserve mode - disciplined dispatch (model always set) never trips it.

### stays-strong judgment set

A regex `STAYS_STRONG_RE` matching the kinds the efficient-dispatch skill keeps
on the main model - `quality review`, `pr review`, `final review`,
`adversarial …`, `code review`, `design`, `audit`, `architect…`, `critique`,
`judg…` - and **explicitly excluding** `spec review` / `spec-compliance`
(deliberately a route-down class). Implementation guards the `spec` carve-out so
"spec review" never matches.

## Surface it (maximize-output visibility)

`ax quota` (and `--statusline`) render the current `SpendMode`: e.g.
`5h 9% → 07:00 · 7d 15% · CONSERVE` or `… · SPLURGE ⚡ burn surplus`. So the
operator and the agent both *see* when to crank everything. Reuses
`computeSpendMode` - single source of truth.

## Module shape / dependency note

`computeSpendMode` + a minimal quota-cache reader must be importable by BOTH the
hook (`packages/hooks-sdk`) and the quota render (`apps/axctl/src/quota`).
hooks-sdk is hot-path/dependency-light and cannot import `apps/axctl`. Resolve
the home in the plan:
- preferred: `@ax/lib` (if hooks-sdk may depend on `@ax/lib` - verify the
  current dep direction), exporting `computeSpendMode` + the cache reader + the
  minimal `QuotaSnapshot` type;
- fallback: a self-contained copy in hooks-sdk (the snapshot shape is tiny), with
  `apps/axctl/src/quota` importing from there or duplicating the pure function
  under test parity.

```
<shared home>/spend-mode.ts      computeSpendMode (pure) + readQuotaCache + SpendModeConfig + tests
packages/hooks-sdk/src/hooks/route-dispatch.ts   mode-conditional verdicts + STAYS_STRONG_RE
packages/hooks-sdk/src/hooks/refresh-quota.ts    SessionStart quota refresh (new SDK hook)
apps/axctl/src/quota/format.ts   render SpendMode in table + statusline
routing-table.json schema        + spendMode thresholds block
skills/efficient-dispatch/SKILL.md   document the deterministic conserve/splurge behavior
```

Pure cores (`computeSpendMode`, the verdict decision factored as a pure
`decideVerdict(inputs)`) unit-tested exhaustively (every truth-table row + the
window/threshold boundaries + the spec-review carve-out). The SessionStart hook
+ cache read verified via `ax hooks backtest` and a live smoke.

## Safety / scope

- Hot path only reads a local file; no network on dispatch.
- Splurge requires a fresh cache; stale/missing → conserve (never accidentally
  splurge).
- Block fires only on conserve + route-down-match + inherit. Explicit model
  (incl. `model:opus`) always passes.

## Behavior change to flag

route-dispatch goes **warn → block** (conserve mode) for everyone who has it
installed. Intentional - it's the whole point - but called out in the PR.

## Out of scope (later)

- `ax routing tune` agent_type mining (the `^implement ` class already covers
  the implementers).
- An `ax dispatches` retrospective inversion view (the hook enforces at dispatch
  time, which beats a report).
- dojo budget-envelope integration (lifting the 15% reserve in splurge) - natural
  follow-up once spend mode is shared.

## Open questions (for review)

1. Is the SessionStart refresh enough, or is the watcher tick required in v1 for
   the "proactively knows" guarantee on long sessions?
2. Should splurge **block** an explicit *cheap* model (force the strong model)
   rather than only warn? (Current: warn - an explicit model is intentional.)
3. `computeSpendMode` home: `@ax/lib` vs a hooks-sdk-local copy - which respects
   the hot-path dependency constraint best?
