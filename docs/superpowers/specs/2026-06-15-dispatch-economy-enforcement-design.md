# Quota-aware dispatch economy - proactive window awareness + enforcement

Date: 2026-06-15
Status: final design (after 2 Opus reviews + Codex critique), pre-implementation
Follows: skills/efficient-dispatch/SKILL.md, the route-dispatch hook (`matchRoutingTable`, unified in #411), the quota module

**Locked with the user:** auto-route (silent rewrite, not block) · conserve +
splurge together · **splurge is purely subtractive** (relax the downgrade; never
force a model up).

## Problem

1. **Enforcement gap.** A `well-specified-impl` class (`^implement ` → sonnet)
   exists and the route-dispatch hook is installed, yet a full session of
   `Implement …` subagents ran on the expensive inherited model - ~$130 over.
   The hook only **warns**; a `PreToolUse(Agent)` warn arrives as the dispatch
   already fires - an ignorable nudge. (And `Verdict.block` today encodes as
   exit-2+stderr, whose reason reaches the **user**, not the model - so
   block→re-dispatch wouldn't work autonomously, and would also train the agent
   to set `model:` everywhere and bypass the table. Auto-route avoids both.)

2. **Quota-blind in one direction.** "Route down to cheaper" is right *while
   conserving*. Near a **7-day** reset with budget unspent, forcing sonnet keeps
   the agent cheap when the rate is about to reset anyway. The system should
   **proactively know** the regime and, near a 7d reset with genuine headroom,
   **stop forcing things down** (so work runs on the strong inherited model) -
   *without* forcing things up (running opus on work the table already deemed
   sonnet-adequate burns rate for identical output - a vanity metric, per the
   Codex critique).

## The whole design in one knob

`routeDownEnforced = (spendMode === "conserve")`. Plus one orthogonal,
always-on **judgment warn**. That's it - there is no splurge-specific verdict.

## Spend mode - proactively fresh

### `computeSpendMode(snapshot, nowMs, config) → { mode, reason, stale }` (pure)

Input: cached `QuotaSnapshot` (`~/.ax/quota-cache.json`): `five_hour` /
`seven_day` (each **nullable** `{ utilization /* %used 0–100 */, resets_at }`)
+ `fetched_at`.

- **stale guard:** `nowMs - parse(fetched_at) > stalenessMs` (default 5 min) →
  `conserve` (+ `stale: true`). Never splurge on uncertainty.
- **null `seven_day`** → `conserve`.
- **splurge** iff ALL of:
  - 7d near reset: `parse(seven_day.resets_at) - now < nearResetMs7d` (default 24 h),
  - 7d headroom: `100 - seven_day.utilization > minRemainingPct` (default 25),
  - **no window near its cap** (Codex: the windows draw down the *same*
    consumption, so splurge must not run you into either ceiling):
    `five_hour.utilization < capFloorPct` AND `seven_day.utilization < capFloorPct`
    (default 80). A null `five_hour` is treated as not-near-cap.
- else `conserve`.
- The **5h window never triggers splurge** (it resets every 5 h → a near-reset
  test on it is a 30%-duty-cycle timer, not a surplus signal - the central
  review fix). It only participates as a cap guard.
- `parse(resets_at)` is strict ISO-8601 → epoch ms; a parse failure → treat that
  window as null (→ conserve). Clock is the hook's `Date.now()` equivalent
  passed in as `nowMs` (testable).
- thresholds (`stalenessMs`, `nearResetMs7d`, `minRemainingPct`, `capFloorPct`)
  live in `routing-table.json`.

### Manual override

`AX_SPEND_MODE=auto|conserve|splurge` wins (`auto` = computed). The hook reads
`process.env` (the harness propagates user env to forked hooks - same path the
existing `ALLOW_*` bypasses use; verified in the feasibility review).

### Proactive freshness - both mechanisms, v1

A stale cache silently falls to conserve, which *during a splurge window* would
keep forcing things down - the opposite of intent, invisibly. So freshness is
load-bearing:

1. **SessionStart refresh hook** (`~/.ax/hooks/refresh-quota.ts`, new SDK hook):
   shells out to `ax quota --fresh` once per session (off the hot path), then
   computes the mode. If **splurge**, it `inject`s a one-line **dojo nudge**
   (see below) instead of a bare `Verdict.allow`. Token absent/expired → no-op
   (→ stale → surfaced, below).
2. **Continuous tick** (required, not deferred - splurge on a long session needs
   it): a dedicated **LaunchAgent with `StartInterval` ~5 min** running
   `ax quota` (the existing `com.necmttn.ax-watch` is fswatch-driven, *not* a
   timer, so this is its own unit, installed by `ax install`).

The dispatch hot path **never fetches** - the hook only reads the cache (sync
`node:fs`, matching the routing-table read precedent), preserving ~70 ms.

## Enforcement: route-dispatch hook

Extend `packages/hooks-sdk/src/hooks/route-dispatch.ts`. Matching is the unified
`matchRoutingTable` (#411). The verdict is a pure, ordered `decideVerdict`.

### New SDK capability: `Verdict.route(model)` (auto-route)

Silent rewrite via `updatedInput` (the SDK has no such encoding today):
`Verdict.route(model)` → `{ hookSpecificOutput: { hookEventName: "PreToolUse",
permissionDecision: "allow", updatedInput: { ...event.tool.input, model } } }`.
Claude runs the dispatch on the rewritten model, no agent round-trip. Codex
(no Agent dispatch) → degrades to `allow`. Scoped SDK change: new `Route` case in
`encodeVerdict`, its own tests; existing allow/block/warn untouched.

### `decideVerdict(inputs) → Verdict` - ordered, judgment-first

Inputs: `match` (route-down class from `matchRoutingTable`, suggesting a cheaper
tier), `explicit` (an explicit `model` set), `cheap` (explicit ∈ `/sonnet|haiku/i`),
`judgmentStrong` (description/agent_type is a stays-strong judgment kind),
`routeDownEnforced` (= conserve).

1. `judgmentStrong && cheap` → **warn** ("judgment work is the catch-rate gate;
   prefer the strong model"). *Rule 0 - judgment is never routed or blocked, any
   mode.* Kills the `match ∩ judgmentStrong` collision the reviews flagged.
2. `explicit` → **allow**. A typed model is deliberate; never overridden (incl.
   `model:opus`, and incl. an explicit cheap model in splurge - no force-up).
3. `match && !explicit && routeDownEnforced` → **route(suggest)** - silently
   rewrite the forgotten dispatch to the cheaper tier.
4. otherwise → **allow**. Covers `!match`; `judgmentStrong && inherit` (= main =
   strong ✓); and **splurge + match + inherit** → runs on the strong inherited
   model (best-model-on-everything, subtractively). No splurge warn, no push.

All 32 `(match, explicit, cheap, judgmentStrong, routeDownEnforced)` input cells
are enumerated in the test (many collapse) so no cell rides an unstated default.

### One judgment definition

Collapse the two judgment regexes (`JUDGMENT_RE` in
`apps/axctl/src/queries/routing-tune.ts` + the proposed `STAYS_STRONG_RE`) into a
single exported source of truth in `packages/hooks-sdk/src/spend-mode.ts`
(hot-path importable): matches quality/pr/final/adversarial/code review, design,
audit, architect, critique, judge - **excluding `spec`/spec-compliance** (a
deliberate route-down class). routing-tune imports it. No drift.

## Surface it (visibility + staleness)

`ax quota` / `--statusline` render mode + staleness from the same
`computeSpendMode`: `… · CONSERVE`, `… · SPLURGE ⚡`, or `… · mode? (stale 22m)`.
A silent fall-to-conserve is **visible** (review: a believed-splurge that quietly
conserves is maddening).

## Splurge -> dojo nudge (the proactive trigger)

Splurge means "you have weekly allowance about to reset unused" - which is
exactly the condition the **dojo** loop exists to consume (burn surplus on
self-improvement). The original dojo vision wanted an automatic window-end
trigger, but headless firing was rejected (burns API, not plan) and a cron can't
open an in-harness session. The spend-mode signal solves it the right way: the
system **nudges the operator to fire `/dojo` themselves** at the moment surplus
is detected.

- On `SessionStart`, when `computeSpendMode` returns **splurge**, the
  refresh-quota hook injects one line: e.g.
  `splurge: ~N% of your 7d budget resets in Hh - run /dojo to spend it on self-improvement`.
- Fires at most once per session (SessionStart cadence - no spam).
- The statusline splurge marker mirrors it: `SPLURGE -> /dojo`.
- In-harness, opt-in, proactive: the system tells you *when*, you decide
  *whether*. This is the deferred dojo "window-end trigger" delivered as a
  prompt, not a daemon - and it ties the dispatch-economy + dojo work through one
  shared signal (`computeSpendMode`).

## Measurement (kept in scope - Codex)

A money-affecting, behavior-changing system needs a feedback loop. The route
verdicts already land in `hook_command_invocation` (the `effect` field). Add a
light `ax dispatches` lens that correlates spend mode + route verdicts so you can
answer "did conserve auto-route the forgotten dispatches, and did splurge avoid
burning opus on sonnet-adequate work?" - at minimum, record the mode at dispatch
time. Not a new subsystem; a read over existing telemetry.

## Module shape / dependency (resolved)

`computeSpendMode` + a **new sync** cache reader (`node:fs`; NOT async
`loadQuotaCache`, which pulls `@ax/lib`) + minimal `QuotaSnapshot` + the single
judgment regex live **in `packages/hooks-sdk`** (`spend-mode.ts`). hooks-sdk
stays `effect`-only (`@ax/lib` would drag `surrealdb` into the ~70 ms hot path
and isn't installed in `~/.ax/hooks` - review-confirmed). `apps/axctl/src/quota`
imports the pure fn *from hooks-sdk* - one parser for the on-disk format.

```
packages/hooks-sdk/src/spend-mode.ts          computeSpendMode + readQuotaCacheSync + QuotaSnapshot + judgment regex (pure) + tests
packages/hooks-sdk/src/verdict.ts (+ encode)  Verdict.route(model) + updatedInput encoding + tests
packages/hooks-sdk/src/hooks/route-dispatch.ts   decideVerdict (ordered, pure) + wiring
packages/hooks-sdk/src/hooks/refresh-quota.ts    SessionStart → `ax quota --fresh` + splurge→`/dojo` nudge (inject)
apps/axctl/src/quota/format.ts                render mode + staleness
apps/axctl/src/queries/routing-tune.ts        import the shared judgment regex (drop dup)
apps/axctl/src/queries/dispatch-analytics.ts  + spend-mode-aware effectiveness lens
routing-table.json schema                     + spendMode thresholds block
scripts/ + ax install                         periodic-refresh LaunchAgent (StartInterval)
skills/efficient-dispatch/SKILL.md            RECONCILE "the hook warns" → "auto-routes in conserve; relaxes in splurge"
```

Pure cores (`computeSpendMode`, `decideVerdict`) unit-tested exhaustively
(32 cells, window/threshold boundaries incl. cap guard, spec-review carve-out,
null/stale/parse-fail windows). `Verdict.route` encoding tested. Hooks verified
via `ax hooks backtest` + a **live smoke confirming `updatedInput` actually
rewrites the model** and that `systemMessage` warns reach the model (the SDK's
claim that they do is unverified - gate any warn reliance on this smoke).

## Safety / scope

- Hot path: one local file read; no network on dispatch.
- Splurge requires fresh cache + headroom + no window near cap; stale/null/
  parse-fail → conserve; staleness surfaced.
- Auto-route fires only on conserve + route-down match + **inherit**. Any
  explicit model passes untouched. Judgment work is never routed.
- Splurge never forces a model and never disables an explicit choice - it only
  withholds the conserve rewrite.

## Behavior change to flag (PR)

route-dispatch goes **warn → auto-route** (conserve): a forgotten cheap-able
dispatch now silently runs on the cheaper model. `model:` override +
`AX_SPEND_MODE` give full control.

## Out of scope (later)

- `ax routing tune` agent_type mining (`^implement ` class already covers it).
- Linear-pace/burn-rate splurge refinement (7d-only + cap guard suffices for v1).
- dojo budget-envelope integration (lifting the 15% reserve in splurge).

## Resolved review questions

- 5h-window thrash → splurge is **7d-only** (5h is a cap guard only).
- staleness inverts intent → **watcher tick required in v1** + staleness surfaced.
- truth-table collisions → **ordered `decideVerdict`, judgment rule 0**, 32 cells.
- block reason doesn't reach the model / learned bypass → **auto-route** instead.
- splurge optimizes the wrong objective → **subtractive splurge** (no force-up).
- OR-ing windows burns shared budget → **cap guard on both windows**.
- no feedback loop → **measurement lens kept in scope**.
- `computeSpendMode` home → **hooks-sdk** (not @ax/lib).
