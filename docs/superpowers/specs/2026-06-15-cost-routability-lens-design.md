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
   (**default 1** - see calibration note). `--min-run` stays a flag for users who want to
   require clustering.

### CALIBRATION NOTE (2026-06-15, post-smoke-test on real data)

Two design assumptions in the original draft were refuted by the data and corrected:

- **`thinking_tokens` is a dead signal.** It is 0 on **96.6%** of main-agent turns (p99
  = 1317; only 0.8% cross 1500) because transcripts strip thinking text (schema caveat).
  The `THINK_HI` threshold was a no-op (the "think+edit" bucket it protected was empty,
  $0/n=0). **Dropped entirely.** Judgment protection now rests on `JUDGMENT_GUARD_RE`
  (turn text) + the interactive/adjacency rules. (`thinking_blocks`, a populated count,
  is a candidate reasoning signal for a later version - deferred.)
- **Class-runs of length ≥3 barely exist** (77.7% length 1, 18.7% length 2, 3.6% ≥3):
  Claude turns interleave tools, user turns split runs, and the adjacency rule forces the
  first assistant turn of each segment to `interactive`. `minRun=3` gated out ~everything
  (0.0% routable). The **turn is the natural unit**, so the default is `minRun=1`.

At `minRun=1` on the reference machine, ~34% of main-agent assistant cost ($5.2K/30d)
lands in routable classes - larger than the entire subagent routing leak. The class-run
grouping mechanic is retained (it still merges adjacent same-class turns and powers the
`--min-run` knob), just defaulted to 1.

## Work-class taxonomy (tool composition + text-judgment guard)

Each main-agent turn is assigned ONE class from its tool composition, with
`JUDGMENT_GUARD_RE` (turn text) + adjacency/intent as the judgment guard. Routable classes
carry a target tier; the rest stay main. (The thinking-token signal was dropped - see the
calibration note above.)

| class              | signal                                                            | verdict            |
|--------------------|-------------------------------------------------------------------|--------------------|
| `gather`           | Read/Grep/Glob/LS present, no edits                               | routable → haiku   |
| `niche-research`   | WebFetch/WebSearch present                                        | routable → sonnet  |
| `mechanical-impl`  | Edit/Write/NotebookEdit/Bash dominant                            | routable → sonnet  |
| `design-decision`  | `JUDGMENT_GUARD_RE` matches the turn text                        | stays main         |
| `interactive`      | turn follows a user turn, or correction/preference intent, or no classifiable tool | stays main |
| `synthesis`        | (unreachable in v0 - kept in the union for a future reasoning signal) | stays main      |

Classification precedence (first match wins, judgment-first so it can never be routed):
1. `interactive` - turn immediately follows a user turn in the session, or
   `intent_kind ∈ {correction, preference, wrapper_instruction}`.
2. `design-decision` - `JUDGMENT_GUARD_RE` matches the turn text.
3. `mechanical-impl` - edit tools dominate (`editCount ≥ readCount` and `≥ researchCount`).
4. `niche-research` - research tools (WebFetch/WebSearch) present.
5. `gather` - read-only tools present.
6. fallback → `interactive` (conservative: pure-text / coordination / Task-dispatch turns
   stay main - this is the bulk of main spend and is genuinely judgment/coordination).

`--min-run` is the one tunable (default 1). Tool-class sets reuse the routing-table grain
(search-locate→haiku, well-specified-impl→sonnet). Adjacency = *follows* a user turn
(the agent's first response); the turn before the next user turn is classified on its own
merits.

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

`ax cost routability [--days=N] [--min-run=1] [--json]` - in the `cost` namespace
(cost-analytics already owns the main/subagent origin logic). Default window 30d to match the
other cost commands. `--json` returns the `RoutabilityResult` envelope.

Render:

```
$ ax cost routability --days=30

main-agent spend: $15,137   routable: $5,162 (34%)   est. savings: ~$X

class            runs   turns   main_cost   tier     repriced   est_savings
mechanical-impl  ...    ...     $4,498      sonnet   ...        ...
gather           ...    ...     $  628      haiku    ...        ...
niche-research   ...    ...     $   35      sonnet   ...        ...
stays main (interactive/design-decision)             $9,975     -

estimate from historical token counts; judgment work left on frontier by design.
next: ax dispatches --candidates   # the subagent-side leak
```

(Numbers from the reference-machine smoke test at minRun=1; est_savings filled at run.)

## Reactivity / MCP

- Add `cost_routability` to the read-only MCP tool registry (mirrors `cost_models`,
  `cost_split`).
- No ingest change - reads existing `turn` / `tool_call` / `turn_token_usage` graph.
- Docs: CLAUDE.md "Cost analytics" block gains the new subcommand (the new-subcommand docs
  gate).

## Risks / open calibration

- **Accuracy rests on tool composition alone** (thinking signal dropped). A turn that
  reasons hard *then* does a mechanical edit reads as `mechanical-impl` (routable) - the
  lens can't see the reasoning that preceded the edit. This is a known over-count direction;
  `JUDGMENT_GUARD_RE` on the turn text is the only judgment catch. Acceptable for an
  estimate; a populated reasoning signal (`thinking_blocks`) is the v2 refinement.
- **Non-Claude main spend is under-counted.** ~$3K/30d of main spend (GPT-5.x, etc.) has no
  per-turn `turn_token_usage` cost row, so `mainSpendUsd` (~$15.1K) sits below the
  `ax cost split` main total (~$18.1K). The lens is Claude-main accurate; note the gap.
- The biggest pool - the `interactive` fallback ($9.7K/64%, pure-text/coordination/Task
  turns) - is left as stays-main by design. If a future version wants to probe it (e.g.
  Task-dispatch turns vs genuine reasoning), that's a separate classification problem.
- `intent_kind` is sparsely populated on older sessions → precedence rule 7 fallback
  (`interactive`/stays) keeps it conservative (never over-claims savings).

## v2 (out of scope)

- Phase labeling (research/implement/review) as a second grouping dimension.
- Per-session routability drill-down (`ax cost routability --here` / `<session>`).
- Tie the lens to the dispatch-rate trend (the 6× ramp) as a "how much did pushing work out
  actually save" before/after.
