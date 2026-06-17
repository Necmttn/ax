---
name: efficient-dispatch
description: Model-routing orchestration for any expensive frontier model (Fable, Opus, GPT-5.x) - the main model keeps judgment and Q&A review, mechanical subagent dispatches carry an explicit cheaper model, and ax measures whether the routing actually worked. Use when orchestrating codebase-heavy or token-heavy work with subagents, when dispatching Agent tasks without a model, when the user says "route to cheaper models", "efficient dispatch", "optimize model spend", or asks where their token spend goes. Pairs with the route-dispatch hook (deterministic backstop) and `ax dispatches` (evidence). Do NOT fire on single-shot questions or tiny tasks with no dispatching.
---

# efficient-dispatch - routed, measured, verified

The main model is the orchestrator and Q&A reviewer. Mechanical work runs on
cheaper models - and unlike guidance-only approaches, every claim here is
checkable against your own ax graph.

## The split

Two axes. First, **main model vs subagent**: the main model orchestrates and
reviews; mechanical work goes to subagents. Second, and the one that actually
controls spend - **the tier of each subagent dispatch:**

- **Implementer subagents** (well-specified plan tasks, mechanical edits, search,
  bulk transforms) → dispatch with **`model: sonnet`** (or haiku for pure
  search/locate, per the table).
- **Reviewer / judgment subagents** (quality / PR / final / adversarial / code
  review, design, audit, architect, critique, judge) → **keep the strong model**:
  inherit the main model, or set `model: opus`/`fable` explicitly. Review is the
  catch-rate gate; a cheap reviewer misses real bugs.

Get this backwards and you pay twice: in one ax session implementers ran on the
expensive inherited model while reviewers were sent to a cheap one - ~$130 over,
weaker catch rate, three fix rounds (memory `feedback-review-gets-strong-model`).
The default-inherit trap is implementers, not reviewers: a forgotten `model:` on
an `implement …` dispatch silently runs expensive. Set it.

**Main model keeps** (never dispatched at all): decomposition, architecture and
product tradeoffs, plan synthesis, judging conflicting subagent reports, final
integration, taste-heavy design/copy.

## Isolate heavy context (the second reason to dispatch)

Cost-tier is one reason to dispatch. The other is **context isolation** - and it
applies even when the work needs the strong model. A large input read into the
main thread does not cost once: it sits in the context window and is re-sent as
input on every later turn. A 0.5 MB screenshot Read on turn 5 of a 40-turn
session is re-billed ~35 times and crowds out earlier reasoning.

The biggest offender is **images**. Reading screenshots for visual judgment
(does this match the spec? rate this design, find the visual bug) floods the main
context with vision tokens that persist for the rest of the session. Route it:

- **Dispatch a subagent that returns the judgment as text.** The subagent pays
  the vision tokens in its own short-lived context and returns a verdict; the
  main thread keeps the cheap text, never the image bytes. Use the strong model
  for the subagent if the judgment is hard - the win here is isolation, not tier.
- **When to route:** the image (or any large output) would otherwise persist
  across many later main-thread turns AND the question is a returnable verdict.
- **When NOT to:** tightly iterative visual exploration (look, tweak, look again
  interleaved with main reasoning - the round-trips cost more than they save),
  read-once-then-done short sessions (no persistence tail), or when you cannot
  state the judgment criteria up front (the text verdict is lossy).

Same logic applies to any bulky tool output you only need a conclusion from:
giant logs, large query dumps, full-file reads for one fact. If you need the
answer, not the bytes, dispatch for it.

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
   hook is quota-aware and ADVISORY (Claude Code hooks cannot enforce model on
   subagent dispatches - they can only inject context via additionalContext):
   in conserve mode it advises re-dispatching a forgotten mechanical dispatch
   with `model:<cheaper>`; near a 7d quota reset (splurge) it stays quiet so
   work runs on the strong inherited model; it advises when judgment work
   (review/design/audit) is sent on a cheap model. Real enforcement is your
   discipline + setting `model:` explicitly on every dispatch.
   Treat the advisory as a re-dispatch signal, not noise.
4. **Workflow scripts** (`.claude/workflows/*.js`) run sandboxed and cannot
   import ax code. Set `model:` on every `agent(...)` call by hand, per
   `ax routing show`: mechanical stages → `model: 'sonnet'`; judgment/review
   stages → keep the strong model. `routing-tune.workflow.js` is the reference.
   In-tree Effect/axctl code that dispatches should call `resolveDispatchModel`
   (from `@ax/hooks-sdk`) instead of hardcoding.
5. Treat subagent reports as leads. Before acting on a high-impact finding or
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
- `ax cost images --days=7` - image-read context per session, main vs subagent.
  High main-thread MB = screenshots persisting in the main window; route that
  visual judgment to a subagent (see "Isolate heavy context" above)
- `ax improve recommend` - surfaces a routing proposal automatically when
  missed savings accumulate

## Verify

After adopting this skill, compare windows: `ax cost split` + inherit rate
before vs after. If the inherit rate doesn't drop, the routing isn't
happening - check `ax hooks backtest ~/.ax/hooks/route-dispatch.ts --days=7`
and whether dispatches are bypassing the table.
