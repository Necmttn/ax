# Fix #2 - Push the Value: SessionStart Digest

**Date:** 2026-06-15
**Branch:** `feat/team-adoption`
**Parent diagnosis:** `docs/superpowers/specs/2026-06-15-team-adoption-diagnosis.md`

## Problem

ax value is pull-only: ingest runs passively (watcher), but every gram of *value* requires the user to remember to type `ax sessions` / `ax serve`. Nothing brings the user back, so no habit forms - usage is bursty build-days with zero-gaps. This is the highest-leverage adoption leak (Finding 3).

## Goal

Turn passive ingest into a habit loop: **push** a short, ranked digest of the user's own signal into the agent's context at session start, so value arrives without being asked for. Channel plan is phased - **SessionStart first** (this spec), then statusline, then opt-in OS notifications (later specs).

## Constraint

The SessionStart hook fires on every session, ~70ms budget, and must never block or break session boot. Therefore **compute** (slow, DB-bound) is separated from **surface** (fast, read-only) by a snapshot file - the same seam as the quota cache and the ingest-stream bus.

## Architecture

Five focused, independently-testable units, Effect-native + typed end-to-end:

```
apps/axctl/src/digest/
  model.ts       - DigestItem / DigestSnapshot (Effect Schema)
  sources.ts     - 4 typed source fns: improveItems, costItems, churnItems, quotaItems
                   each Effect<DigestItem[], E, Deps>. Pure read, no formatting.
  rank.ts        - salience scoring + top-N selection + suppression. Pure, no IO.
  shown.ts       - dedup/rotation state (~/.ax/digest-shown.json): record + suppress
  snapshot.ts    - orchestrate sources → rank → DigestSnapshot; write ~/.ax/digest.json
  render.ts      - DigestItem[] → the 1-line block (hook + CLI share this)
```

**Three call sites, all reusing the units above:**
- **Ingest derive-stage** → `snapshot.write` runs as the final `derive`-tagged stage in the StageRegistry (ADR-0009). The existing watcher (`ax ingest --since=1`) picks it up with **no watcher change**; the stage is pure DB read so the compiled binary runs it fine. Tagged last + isolated so a snapshot failure never affects the ingest that preceded it.
- **SessionStart hook** `~/.ax/hooks/surface-digest.ts` (hooks-sdk) → reads snapshot + shown-state, picks top 1-3 unshown, `Verdict.inject`s, records shown. Read-only, fail-open, ~5ms.
- **`ax digest` CLI** → `--json` (raw snapshot), plain (render board), `--refresh` (recompute now). Dev preview + the seed for Fix #3's front door.

**Seam:** compute (watcher) vs surface (hook) split by `~/.ax/digest.json`. DB down ⇒ stale snapshot, session still boots.

## Data model

`DigestItem` (Effect Schema):
```
id          string   stable key: "improve:7" | "cost:routing" | "churn:<sess>" | "quota:7d"
kind        "improve" | "cost" | "churn" | "quota"
salience    number   ranked score
text        string   one-line, no command: "routing could save ~$42/wk (38% inherit)"
action      string   copy-paste cmd: "ax dispatches --candidates"
evidence    string?  optional drill ref (session id, proposal id)
computed_at Date
```

`DigestSnapshot`: `{ generated_at: Date, window_days: number, items: DigestItem[] }` - store **top 8** ranked; hook surfaces top 1-3 unshown. Storing more than shown is what enables rotation.

## Ranking (`rank.ts`, pure)

`salience = base[kind] × urgency × recency`
- `base` (tunable seed): churn 1.0 (pain), improve 0.9 (actionable), cost 0.8 (money), quota 0.5 (ambient).
- `urgency` (magnitude): churn = repair-LOC / failed-checks; cost = $/wk; improve = proposals-due count; quota = % of window burned (only >70% lifts it).
- `recency` - newer evidence scores higher; older signal decays.

## Dedup / rotation (`shown.ts`, `~/.ax/digest-shown.json`)

```
{ "<id>": { last_shown_at: Date, shown_count: number } }
```
Suppress an item if: shown within **last 6h**, OR `shown_count ≥ 3` (stop nagging), OR **id absent from current snapshot** (resolved → also drop its shown-state). Hook walks ranked items, skips suppressed, takes first 3.

**Quiet-day fallback:** if all top items suppressed, surface nothing rather than scrape the barrel. The rotating top-8 set + 6h window means a normal multi-session day always has something fresh.

## SessionStart hook

`~/.ax/hooks/surface-digest.ts` via `defineHook`:
```
events: ["SessionStart"]   matcher: none
run: read ~/.ax/digest.json → read shown-state → rank.pickUnshown(top 3)
     → if any: record shown + Verdict.inject(render(items))
     → else: Verdict.allow (inject nothing)
```
`Verdict.inject(context)` = plain stdout; Claude SessionStart adds stdout to context (confirmed in `packages/hooks-sdk/src/adapters/encode.ts`). Pure read, no DB, no GitEnv dep. SDK `catchDefect` already fails open.

**Freshness guard:** if `digest.json` is older than max-age (default 24h, via `generated_at`), the hook stays silent - never surface stale "savings" as current.

### Injection format (what the agent sees)

```
[ax] since last session:
  • 2 repair-loops in auth.ts (14 LOC churned, 1 failed check) → ax sessions churn --here
  • routing could save ~$42/wk (38% inherit dispatches) → ax dispatches --candidates
  • improve proposal #7 pending verdict → ax improve show 7
run `ax` for the full board.
```
Top-3, `• <text> → <action>`; footer points at the Fix #3 front door. Empty snapshot ⇒ no output (no bare `[ax]` header).

## Error handling

- Missing/corrupt `digest.json` → fail-open, silent (SDK `catchDefect`).
- Snapshot derive-stage throws → logged; last good snapshot stays; the ingest run that preceded it is unaffected (snapshot is the last, isolated stage).
- Shown-state write fails → degrade to no-dedup (may repeat once), never crash the hook.

## Testing (bun:test, layer-testable)

- `rank.test.ts` - salience ordering, suppression rules, quiet-day fallback. Pure, no IO.
- `render.test.ts` - snapshot → exact string.
- `shown.test.ts` - dedup window, count cap, resolved-item cleanup; injectable clock + in-memory fs.
- `sources.test.ts` - each source against a seeded test DB layer (reuse existing query fixtures).
- Hook: `ax hooks backtest` replay + a `defineHook` fire test asserting Inject vs Allow.

## CLI

`ax digest` (render top board) · `--json` (raw snapshot) · `--refresh` (recompute now, skip waiting for watcher). Doubles as dev preview and the seed for Fix #3's no-arg `ax` front door.

## Out of scope (later phases / specs)

- Statusline + OS-notification channels (phase 2/3 of "all three").
- Self-telemetry capture (Fix #1).
- Collapsing the 24-subcommand surface (Fix #3) - though `ax digest` seeds its front door.

## Status

- [x] model.ts + schema
- [x] sources.ts (4 source fns over existing queries)
- [x] rank.ts + tests
- [x] shown.ts + tests
- [x] render.ts + tests
- [x] snapshot.ts + watcher wiring
- [x] surface-digest.ts hook + fire test
- [x] ax digest CLI
