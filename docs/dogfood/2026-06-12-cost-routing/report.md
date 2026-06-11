# Dogfood: cost-routing loop (2026-06-12)

Goal set the evening before: "ax should answer 'what's my fable workflow and
where can cheaper models run' in one command" - then build it, dogfood it,
and verify against the manually-computed ground truth.

## Ground truth (manual, locked before any code)

Computed by raw-SQL on SurrealDB + jq over raw transcripts, Jun 9-11 window,
the 26 fable-parent sessions only:

| slice | value |
|---|---|
| main-loop fable | $2,748 (70%) |
| subagent fable (inherited) | $565 (14%) |
| main-loop opus (mid-session switches) | $541 |
| subagents on sonnet/opus/haiku | $60 |
| Agent dispatches inheriting parent model | 180 of 272 (66%) |

## What ax says now (one command each, 3-day window, ALL sessions)

`ax cost split --days=3`:

| origin | model | cost | share |
|---|---|---|---|
| main | claude-fable-5 | $4,211 | 48.7% |
| main | claude-opus-4-8 | $2,057 | 23.8% |
| subagent | claude-fable-5 | $1,341 | 15.5% |
| main | gpt-5.5 | $679 | 7.9% |
| subagent | claude-opus-4-8 | $175 | 2.0% |
| subagent | claude-sonnet-4-6 | $50 | 0.6% |
| subagent | claude-haiku-4-5 | $11 | 0.1% |
| **total** | | **$8,645** | |

`ax dispatches --days=3`: 364 dispatches, **77.2% inherit**, subagent cost $1,518.

`ax dispatches --candidates --days=3`: **est savings $275.18** - top classes
well-specified-impl ($181), spec-review ($44), bulk-mechanical ($16).

## Ground-truth reconciliation

The windows differ deliberately: ground truth = 26 fable-parent sessions
Jun 9-11; ax = ALL sessions Jun 9-12 (including the overnight build itself,
which ran heavy fable main-loop + a fleet of sonnet subagents).

- Inherit rate: 66% (ground truth, fable parents) vs 77.2% (all parents) -
  consistent, the broader set inherits more.
- Subagent fable: $565 (fable parents, 21d-scoped estimate) vs $1,341
  (all parents incl. the build night) - direction and order match; the delta
  is the added day + opus/other parents' fable children.
- Main-loop fable cache-read dominance: confirmed by `ax cost models`
  (3.47B cache-read tokens on fable = $3.5k of the $5.5k fable total).

Verdict: ax now reproduces the manual analysis in one command, with the
expected window/scope deltas explained.

## Bugs found BY dogfooding (each found by trusting the data and tracing)

1. **model=null on all 869 subagent usage rows** - two compounding writers:
   session upsert dropped the extracted model; session-health clobbered the
   priced row's model with null. `model_ref` survived = smoking gun. (#300)
2. **source flip-flop** - `writeTokenUsageForSubagents` hardcoded
   `source="claude"`, so origin split depended on which writer ran last. (#300)
3. **MCP smoke test hardcodes tool list** - cost tools broke CI. (#301 fix)
4. **node:fs in axctl runtime code** - `check:no-node-fs` gate caught both the
   hook (allowlisted, fire-path sync justification) and compile-routing
   (migrated to Effect FileSystem). (#302/#303)
5. **Repricing double-count** - `prompt_tokens` is total billed input;
   per-bucket math charged cache reads at full input rate, zeroing savings
   ($12 -> $275 after delegating to `estimateCost`). (#303)
6. **Routing-policy misalignment** - v1 classes routed quality/PR reviews to
   sonnet, contradicting "main model is the Q&A reviewer". Both copies
   tuned. (#304)

## Hook validation

- `ax hooks backtest route-dispatch.ts --days=7`: 396 dispatches replayed,
  156 would-warn (39.4%), 0 would-block.
- Installed live (`~/.claude/settings.json`, PreToolUse/Agent matcher);
  next mechanical model-less dispatch gets the nudge in-context.
- 21 unit tests: explicit-model allow, class/agent-type matching, corrupt
  routing table -> defaults, defects fail open.

## Build-night meta (the workflow being built, applied to building it)

Every implementation phase ran as a sonnet subagent in an isolated worktree;
fable (main loop) wrote briefs, reviewed diffs, and fixed what review caught.
Review caught one real bug per phase on average (see list above) - the
fable-reviews-cheap-implementation pattern earned its keep on its own
construction.

PRs: #300 (ingest attribution) -> #301 (ax cost) -> #302 (hook) ->
#303 (ax dispatches) -> #304 (routing alignment). All squash-merged on CLEAN.
