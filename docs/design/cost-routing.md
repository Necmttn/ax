# Cost routing: model spend visibility + dispatch routing loop

How ax answers "where does my model spend go, and which subagent dispatches
should run on cheaper models" - and how that answer feeds back into the
harness automatically.

Shipped across PRs #300-#304 (2026-06-12).

## The problem this solves

A 3-day window of Claude Code work on this machine showed:

- **Main-loop fable: ~$4.2k (49%)** - dominated by cache reads (~250k context
  re-read on every tool-call turn; grunt loops like Bash/Edit/browser QA run
  IN the expensive main context)
- **Subagent fable: ~$1.3k (16%)** - 77% of Agent dispatches carry no explicit
  `model`, inheriting the parent's expensive model for mechanical work
- **Cheap models: <1%** - sonnet/haiku barely used despite being 3-10x cheaper

None of this was visible: subagent token-usage rows had `model = null` (two
compounding ingest bugs), and no query surface existed over the cost data.

## Data layer (fixed in #300)

- Subagent transcripts (`<session>/subagents/agent-*.jsonl`) were already
  ingested, but `derive-claude-subagents` dropped the extracted model on the
  session upsert, AND `session-health`'s token-usage UPSERT clobbered the
  correct `model` with `session.model` (null) on every pass. `model_ref`
  survived, which is how the bug was diagnosed.
- `writeTokenUsageForSubagents` now writes `source = "claude-subagent"` so
  origin rollups don't depend on writer order.
- `spawned` edges (parent -> subagent) carry `agent_type`, `description`,
  `agent_name`, `tool_use_id` from `agent-<id>.meta.json`. `tool_use_id` joins
  the parent's `tool_call.call_id`, which exposes the dispatch-time `model`
  override without parsing input JSON blobs at query time.
- Backfill: `AX_REDERIVE_SUBAGENTS=1 ax ingest --stages=subagents`.

## Read surface (#301, #303)

```
ax cost models   [--days=N]                  # per-model rollup
ax cost sessions [--days=N] [--model=X]      # top sessions by cost
ax cost split    [--days=N]                  # main vs subagent x model matrix
ax dispatches    [--days=N] [--limit=N]      # dispatch table, % inherit
ax dispatches --candidates [--days=N]        # downgrade candidates + est savings
```

MCP tools `cost_models`, `cost_split`, `dispatches` expose the same queries
read-only, so an agent can ask "where is the spend" mid-session without the
user prompting it.

Query discipline: GROUP BY stays on scalar fields of the scanned table;
derived dimensions (origin) and all joins happen in JS after flat scans.
Record derefs inside aggregates hang SurrealDB 3.x at this table size.

Candidate repricing delegates to the ingest's `estimateCost` with the
`agent_model` table as pricing catalog. `prompt_tokens` on usage rows is
TOTAL billed input (fresh + both cache buckets); naive per-bucket math
double-counts cache and zeroes the savings.

## Routing policy

One typed constant - `ROUTING_CLASSES` in
`apps/axctl/src/queries/dispatch-analytics.ts`, mirrored as the built-in
defaults of the `route-dispatch` hook:

| class | pattern | suggest |
|---|---|---|
| spec-review | `^spec review` | sonnet |
| search-locate | `^(pattern-find\|locate\|find\|map\|sweep\|grep)` | haiku |
| research | `^(research\|investigate docs\|study)` | sonnet |
| well-specified-impl | `^implement ` | sonnet |
| bulk-mechanical | `^(write announcements\|regenerate\|standardize\|merge main)` | sonnet |
| agent types | Explore, codebase-locator, codebase-pattern-finder → haiku; codebase-analyzer → sonnet | |

**Deliberately unrouted:** quality reviews, PR reviews, plan synthesis,
design/copy taste work. The main model is the orchestrator and Q&A reviewer
in this workflow; only mechanical work routes down.

`ax dispatches compile-routing` regenerates `~/.ax/hooks/routing-table.json`
from the constant. The hook reads that file at fire time and falls back to
its built-in copy of the same defaults.

## Apply surface (#302, #304)

`route-dispatch` hook (hooks-sdk, PreToolUse on the Agent tool, Claude-only):
a dispatch with no explicit `model` whose description/agent-type matches a
routing class gets a `warn` verdict -

> ax routing: "Spec review Task 2" looks like spec-compliance checklist
> review work - consider model: "sonnet" on this dispatch (est ~2-3x
> cheaper). Explicit model silences this.

`warn` (not `block`): the suggestion reaches the model so it can re-dispatch
with `model:` pinned; the call is never prevented. Every failure path fails
open. Install:

```
ax hooks init                                                  # scaffolds it
ax hooks install ~/.ax/hooks/route-dispatch.ts --providers=claude
ax hooks backtest ~/.ax/hooks/route-dispatch.ts --days=7       # replay history
```

Backtest on this machine: 396 dispatches replayed, 156 would-warn (39%),
0 would-block.

## The loop

```
ingest (model attribution, spawned metadata)
  -> read     ax cost split / ax dispatches --candidates  (CLI + MCP)
  -> apply    route-dispatch hook warns at dispatch time
  -> compile  ax dispatches compile-routing regenerates the table
  -> verify   ax cost split before/after; workflow_epoch stamps (planned)
```

Planned next: a `deriveRoutingProposalRows` rule in the proposals derive
stage (form=hook) so accumulated candidate savings surface in
`ax improve recommend`, and epoch stamping on accept for before/after deltas.

## Workflow guidance (the human side)

- Fable/opus main loop orchestrates, plans, and reviews diffs.
- Well-specified implementation, spec reviews, searches, research, bulk copy
  -> dispatch with `model: "sonnet"` (or haiku for pure search).
- Keep tool-heavy loops (build/test cycles, browser QA) OUT of the expensive
  main context - the dominant cost is the main loop re-reading ~250k context
  on every tool call, not subagent output tokens.
- Measured on this machine (30d window): ~$404 of identified redirectable
  dispatch spend with the hand-written classes, ~$573 after `/routing-tune`
  mined three more (+42% detector coverage). Several times that is available
  from moving grunt loops out of the main context.

## Reading the numbers honestly

`--candidates` totals are **identified redirectable spend** - a retrospective,
hypothetical repricing of past dispatches, NOT realized savings and NOT a
spend change. Growing the number means the detector got better at naming the
leak; no dollars moved. Realized savings only appear go-forward, as the hook
and skill change dispatch behavior - measure them as the inherit rate
dropping (`ax dispatches`) and subagent spend shifting toward cheap models
(`ax cost split`) across an adoption boundary. And compare like windows:
a 3-day figure and a 30-day figure are different questions.

Scope note vs billing tools (ccusage etc.): ax prices from `agent_model`
list rates and counts subagent transcripts as separate rows; billing tools
see plan-level accounting and usually only main session files. Use ax for
"where inside the work did it go", billing data for "what did I pay".
