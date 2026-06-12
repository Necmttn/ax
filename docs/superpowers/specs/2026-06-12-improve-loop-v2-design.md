# Improve Loop v2 - projected impact, design spec

**Date:** 2026-06-12 · **Status:** draft for review
**Driver vision:** "User lands on the dashboard, sees cool shareable data, a button takes them to what's next - and the improve loop makes them go 'oh, ax can help us.' Each item needs reason, how, the plan, and a projected impact backed by the existing data - backtesting: this will save $X, this would have been resolved."

## Problem

The Improve surface (PR1) is functionally complete but reads like an admin table: a proposal is a row with a hypothesis string. Nothing answers *why should I care*, *what happens if I accept*, or *what is this worth* - the three questions that convert a visitor into a believer. The wrapped CTA (PR4) now drives traffic here; the page must close.

## Design

### 1. Projected impact, backtested per proposal form

New module `apps/axctl/src/improve/impact.ts` - `estimateImpact(proposal)` → `ImpactEstimate`:

```ts
interface ImpactEstimate {
  kind: "savings_usd" | "addressable_failures" | "correction_pressure" | "frequency";
  headline: string;   // "~$297/mo redirectable", "intersects 14 of your last 30 failures"
  detail: string;     // one paragraph: how the number was derived
  basis: string;      // the data window + method, honestly stated ("backtested over 30d of dispatch history")
  confidence: "measured" | "estimated" | "indicative";
}
```

Per form, using machinery that already exists:

| Form | Method | Source |
|---|---|---|
| routing-class hooks (mined) | parse `baseline` JSON (carries est savings + class) or re-run `fetchDispatchCandidates` scoped to the class | `est_savings_usd` (dispatch-analytics.ts) |
| hook (other) | match historical `tool_call` rows on `target_tool`/event scope: "N matching events in 30d, M failed - a guard here intersects M failures" | `fetchRows` slice of hooks/backtest.ts; full `replayRows` only when an artifact exists (post-accept) |
| guidance | correction pressure from `baseline` (corrections × sessions) + churn repair LOC in the matching family | derive-retro baseline + session-churn |
| skill | trigger-pattern frequency: invocations/corrections that match | skill_candidate / baseline |
| automation | trigger-signal frequency in window | signal queries |

Honesty rule: every estimate carries `basis` and the right `confidence` tier - never a naked number. Post-accept, the checkpoint system's *measured* `opportunities/addressed/ratio` replaces the estimate (the loop literally proves itself).

### 2. API

`GET /api/improve/:sig/impact` (contract endpoint, lazily computed per proposal, TTL-cached via `makeTtlCachedFetch`-style per-sig map). Not bulk-computed on `/api/improve` - keep the list fast.

Next-actions proposal/verdict cards get an `impact_chip?: string` (cheap: parsed from baseline only, no recompute) so the panel shows "~$297/mo" at a glance.

### 3. The proposal page (detail pane → narrative)

Selected proposal renders four sections instead of a `<dl>` dump:

1. **Why this fired** - hypothesis, rewritten visual: frequency badge, origin badge, the trigger pattern.
2. **Evidence** - baseline refs expanded: linked sessions (`/sessions/<id>`), counts, the raw signal; payload fields formatted per form.
3. **The plan** - what accept actually does, drawn as a 4-step lifecycle rail: `accept → artifact/task brief → checkpoints at +3/+10/+30 sessions → verdict`. Current stage highlighted for accepted proposals (data already in `experiment` + `latest_checkpoint`).
4. **Projected impact** - the `ImpactEstimate` as the visual centerpiece (big headline number, basis line under it). For accepted experiments with checkpoints: measured ratio shown next to the original estimate ("estimated $297/mo → measured 4/6 opportunities addressed").

### 4. Surface polish

- Proposals table → card-list left rail (title, form, impact chip, freq) - denser than the table, scannable.
- Zone order stays: Next Actions → proposals → decision log.
- Empty/zero states sell the loop ("accept your first proposal; ax measures whether it worked at +3/+10/+30 sessions").

## Out of scope

- True hook replay for *unimplemented* hook proposals (needs a synthetic hook from payload - follow-up; v2 ships the honest "addressable surface" framing instead).
- Auto-accept/auto-apply. Churn perf (#326) unchanged.

## Delivery

1. **PR5a**: impact.ts + per-form estimators (TDD against fixture baselines) + `/api/improve/:sig/impact` + impact chips in next-actions.
2. **PR5b**: detail-pane narrative redesign (why/evidence/plan/impact + lifecycle rail) + card-list rail + empty states.
