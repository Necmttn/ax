# Main-thread routability lens - `ax cost routability`

Date: 2026-06-15
Status: design (pre-implementation)
Branch: feat/cost-routability-lens
Follows: cost-analytics module (`apps/axctl/src/queries/cost-analytics.ts`), dispatch routing
classes + judgment guard (`apps/axctl/src/queries/routing-tune.ts` `JUDGMENT_GUARD_RE`,
`dispatch-analytics.ts` reprice/MODEL_ALIASES), the route-dispatch / efficient-dispatch loop.

## Problem

`ax cost split` shows the main agent is **78–81% of spend** every window - on one machine,
~$17.7K/30d main vs ~$4.9K subagent. The whole routing-tune loop optimizes the ~20%
subagent tail (the $605/mo addressable leak). The bigger, unmeasured lever is the main
thread itself: work the main agent did *in-line on the frontier model* that could have been
a bounded dispatch to a cheap subagent ("subagent-driven development").

The behavioral shift is already visible - dispatch rate ramped 19→114/day (6×) over 90 days
as the operator pushed work out. But ax cannot yet **quantify** it: subagent dispatches carry
a description (routability-classified), main-agent turns do **not**. So "how much of the main
spend was routable-to-cheap vs genuine judgment" is invisible.

This lens answers that question with a deterministic estimate.

## Non-goals

- Not ground truth. It is a heuristic estimate over tool composition + reasoning signal,
  labeled as such (same honesty as the routing-tune projections).
- Not enforcement / not a hook. A read-only analytics lens.
- Not phase detection (research/implement/review labeling) - that is a clean v2 dimension;
  the schema leaves room (an optional `phase` column) but v0 does not compute it.
- No LLM classification. Deterministic only (fits ax's receipt ethos).

## Core idea: classify main-thread **class-runs**

Routable main-agent work is multi-turn (a research sweep, a mechanical refactor), and a
**user turn is a judgment boundary** (the human stepped in). So:

1. Take main-agent turns only (`turn_token_usage.source != 'claude-subagent'`), ordered by
   `(session, seq)`.
2. Split the thread at every `role = 'user'` turn → **segments**.
3. Within each segment, group **consecutive turns sharing a work-class** → a **span**
   (a maximal class-run).
4. A span is **routable** iff its class is routable AND its run length ≥ `--min-run`
   (default 3) - so a stray `Read` between decisions is never billed as "should've been a
   subagent." Routable work clusters; the threshold enforces that.

Class-runs are *finer than phases*: a "research" segment decomposes into alternating
`gather` runs (routable) and `synthesis` runs (stays main) automatically - which captures
"niche research → subagent, reasoning → smart agent" without modeling phases.

## Work-class taxonomy (the A+B blend)

Each main-agent turn is assigned ONE class from its tool composition (A) with
`thinking_tokens`/`intent_kind` as tiebreak (B). Routable classes carry a target tier;
the rest stay main.

| class              | signal                                                              | verdict            |
|--------------------|---------------------------------------------------------------------|--------------------|
| `gather`           | Read/Grep/Glob/LS dominant, `thinking_tokens` ≈ 0                    | routable → haiku   |
| `niche-research`   | reads + WebFetch/WebSearch/docs, low thinking                       | routable → sonnet  |
| `mechanical-impl`  | Edit/Write/Bash dominant, low thinking, no decision `intent_kind`   | routable → sonnet  |
| `synthesis`        | high `thinking_tokens`, few/no tools                                | stays main         |
| `design-decision`  | thinking + edits together, or `JUDGMENT_GUARD_RE`/decision intent   | stays main         |
| `interactive`      | turn adjacent to a user turn, `intent_kind` correction/preference   | stays main         |

Classification precedence (first match wins, judgment-first so it can never be routed):
1. `interactive` - turn immediately follows/precedes a user turn in the segment, or
   `intent_kind ∈ {correction, preference, wrapper_instruction}`.
2. `design-decision` - `JUDGMENT_GUARD_RE` matches the turn text, OR (`thinking_tokens` ≥
   `THINK_HI` AND has edits).
3. `synthesis` - `thinking_tokens` ≥ `THINK_HI` AND tool count ≤ `TOOL_LO`.
4. `mechanical-impl` - edit/bash tools dominate, `thinking_tokens` < `THINK_HI`.
5. `niche-research` - research tools (WebFetch/WebSearch) present, read-heavy.
6. `gather` - read-only tools dominate.
7. fallback → `interactive` (conservative: unclassified stays main).

Thresholds (`THINK_HI`, `TOOL_LO`, `min-run`) are module constants, `--min-run` overridable.
Default `THINK_HI` calibrated against real data during build (start ~1500 output tokens of
thinking); `TOOL_LO` ~1. Tool-class sets reuse the routing-table grain
(search-locate→haiku, well-specified-impl→sonnet).

## Cost + repricing

Per-turn cost = `turn_token_usage.estimated_cost_usd` joined to its `turn`. A span's
`main_cost` = sum over its turns. Repricing reuses `dispatch-analytics` `reprice(usage,
modelName)` + `MODEL_ALIASES` (haiku/sonnet → full model id) on each routable span's token
counts. `est_savings` = `main_cost − repriced`. Spans with non-positive savings (already
cheap) contribute 0, never negative.

Honest caveats surfaced in output: estimate from historical token counts, not A/B parity;
assumes the routable chunk would run equivalently one tier down; main turns that genuinely
needed frontier judgment are deliberately left in "stays main."

## Module shape

```
apps/axctl/src/queries/routability.ts        classifyTurn (pure) + buildSpans (pure) +
                                              fetchRoutability (Effect.fn, SurrealClient)
apps/axctl/src/queries/routability.test.ts   pure-core unit tests (classify + span build
                                              + reprice math) over fixture turns
apps/axctl/src/cli/commands/ax-cost.ts        wire `routability` subcommand + flags + render
```

Pure cores (`classifyTurn`, `buildSpans`, savings math) are exhaustively unit-tested over
fixture turn/tool_call/usage rows - no DB. `fetchRoutability` follows the existing
`fetchCostSplit` shape: one `db.query` pulling main-agent turns with their tool names,
thinking tokens, intent, and per-turn cost; all span-grouping + classification happens in JS
(matches the module's "derived dimensions in JS" precedent - see cost-analytics.ts:5).

### Query inputs / outputs

```ts
interface RoutabilityInput { days: number; minRun: number }       // contract object
interface RoutabilityClassRow {
  class: string; verdict: "routable" | "stays";
  runs: number; turns: number; mainCostUsd: number;
  tier: string | null; repricedUsd: number | null; estSavingsUsd: number | null;
}
interface RoutabilityResult {
  mainSpendUsd: number; routableUsd: number; routablePct: number; estSavingsUsd: number;
  rows: ReadonlyArray<RoutabilityClassRow>;   // routable rows + a single "stays main" rollup
  days: number; minRun: number;
}
```

## CLI surface

`ax cost routability [--days=N] [--min-run=3] [--json]` - in the `cost` namespace
(cost-analytics already owns the main/subagent origin logic). Default window 30d to match the
other cost commands. `--json` returns the `RoutabilityResult` envelope.

Render:

```
$ ax cost routability --days=30

main-agent spend: $17,756   routable: $6,120 (34%)   est. savings: $4,890

class            runs   turns   main_cost   tier     repriced   est_savings
gather             142    518    $2,310      haiku    $  185     $2,125
mechanical-impl     88    402    $2,740      sonnet   $  822     $1,918
niche-research      41    160    $1,070      sonnet   $  321     $  749
stays main (synthesis/design-decision/interactive)   $11,636    -

estimate from historical token counts; judgment work left on frontier by design.
next: ax dispatches --candidates   # the subagent-side leak
```

(Numbers illustrative; real figures computed at run.)

## Reactivity / MCP

- Add `cost_routability` to the read-only MCP tool registry (mirrors `cost_models`,
  `cost_split`).
- No ingest change - reads existing `turn` / `tool_call` / `turn_token_usage` graph.
- Docs: CLAUDE.md "Cost analytics" block gains the new subcommand (the new-subcommand docs
  gate).

## Risks / open calibration

- `THINK_HI` / `TOOL_LO` thresholds are the accuracy knob - calibrate against a hand-labeled
  sample of real main spans during build; print the chosen constants in `--json` so a run is
  auditable.
- Codex/other harnesses: `thinking_tokens` coverage varies (claude mixed turns read 0 →
  lower bound). The lens is most accurate on Claude main sessions; non-claude main turns fall
  to `mechanical-impl`/`gather` on tool mix alone (no reasoning signal) - acceptable, noted.
- `intent_kind` is sparsely populated on older sessions → precedence rule 7 fallback
  (`interactive`/stays) keeps it conservative (never over-claims savings).

## v2 (out of scope)

- Phase labeling (research/implement/review) as a second grouping dimension.
- Per-session routability drill-down (`ax cost routability --here` / `<session>`).
- Tie the lens to the dispatch-rate trend (the 6× ramp) as a "how much did pushing work out
  actually save" before/after.
