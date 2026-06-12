---
name: efficient-dispatch
description: Model-routing orchestration for any expensive frontier model (Fable, Opus, GPT-5.x) - the main model keeps judgment and Q&A review, mechanical subagent dispatches carry an explicit cheaper model, and ax measures whether the routing actually worked. Use when orchestrating codebase-heavy or token-heavy work with subagents, when dispatching Agent tasks without a model, when the user says "route to cheaper models", "efficient dispatch", "optimize model spend", or asks where their token spend goes. Pairs with the route-dispatch hook (deterministic backstop) and `ax dispatches` (evidence). Do NOT fire on single-shot questions or tiny tasks with no dispatching.
---

# efficient-dispatch - routed, measured, verified

The main model is the orchestrator and Q&A reviewer. Mechanical work runs on
cheaper models - and unlike guidance-only approaches, every claim here is
checkable against your own ax graph.

## The split

**Main model keeps** (never route down): decomposition, architecture and
product tradeoffs, plan synthesis, quality review, PR review, judging
conflicting subagent reports, final integration, taste-heavy design/copy.

**Cheaper models take** mechanical work - dispatch with an explicit
`model:` per the routing table below.

## Routing table

Source of truth: `~/.ax/hooks/routing-table.json` (regenerate with
`ax dispatches compile-routing`). Consult it when present; these built-ins
mirror it:

<!-- ax:routing-table -->
| class | description pattern | model |
|---|---|---|
| spec-review | `^spec review` | sonnet |
| search-locate | `^(pattern-find\|locate\|find\|map\|sweep\|grep)` | haiku |
| research | `^(research\|investigate docs\|study)` | sonnet |
| well-specified-impl | `^implement ` | sonnet |
| bulk-mechanical | `^(write announcements\|regenerate\|standardize\|merge main)` | sonnet |
| task-N-impl | `^Task \d+:` | sonnet |
| bug-fix | `^Fix\s` | sonnet |
| feature-add | `^Add\s` | sonnet |
| agent types | Explore, codebase-locator, codebase-pattern-finder → haiku; codebase-analyzer → sonnet | |
<!-- /ax:routing-table -->

Anything unmatched: leave the model unset only if the work genuinely needs
main-model judgment - otherwise pick sonnet.

## Dispatch discipline

1. Decompose into independent slices BEFORE reading everything yourself;
   run slices as parallel subagents in isolated worktrees when they edit files.
2. Every brief is self-contained: repo path, exact objective, in/out of scope,
   evidence format to return (files, line refs, commands, diffs, failures),
   verification commands, stop conditions.
3. Set `model:` explicitly on every mechanical dispatch. The route-dispatch
   hook warns when you forget - treat the warning as a re-dispatch signal,
   not noise.
4. Treat subagent reports as leads. Before acting on a high-impact finding or
   declaring done, reopen the cited files and re-run the key verification
   yourself. Expect to find one real bug per delegated phase.

## Measure (what guidance-only skills can't do)

- `ax dispatches --days=7` - your inherit rate (target: explicit model on all
  mechanical classes)
- `ax dispatches --candidates` - missed routings + est savings, repriced from
  real token buckets
- `ax cost split --days=7` - main vs subagent spend by model; the dominant
  cost is usually main-loop cache reads, so move tool-heavy loops (build/test
  cycles, browser QA) into subagents entirely
- `ax improve recommend` - surfaces a routing proposal automatically when
  missed savings accumulate

## Verify

After adopting this skill, compare windows: `ax cost split` + inherit rate
before vs after. If the inherit rate doesn't drop, the routing isn't
happening - check `ax hooks backtest ~/.ax/hooks/route-dispatch.ts --days=7`
and whether dispatches are bypassing the table.
