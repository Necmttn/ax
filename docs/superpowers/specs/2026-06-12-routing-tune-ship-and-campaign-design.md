# Ship `ax routing tune` + cost-routing marketing campaign

Date: 2026-06-12
Status: approved (design), pending implementation plan

## Problem

The cost-routing loop ships to users in pieces: measurement (`ax cost`,
`ax dispatches`), nudge (`route-dispatch` hook), and orchestration pattern
(`efficient-dispatch` skill). The tuning step - mining dispatch history for
new routing classes - exists only as `/routing-tune`, a committed Claude Code
workflow that works solely inside the ax repo clone. Users cannot refresh
their routing table from their own history.

Separately: the loop now has real dogfood numbers worth marketing (14 days:
574 dispatches, 80.7% inherit, $2,116 subagent spend, $487 flagged savings),
and the current public story still points at the internal workflow.

## Sub-project A: `ax routing tune`

### Command surface

```
ax routing tune [--days=N] [--dry-run] [--emit-brief]
ax routing compile [--out=PATH]        # migrated from `ax dispatches compile-routing` (alias kept)
ax routing show                        # print the active table + origins
```

`ax routing` becomes the verb home for routing-table operations.
`ax dispatches compile-routing` remains as a hidden alias.

### Prerequisite: routing-table unify (the deferred step)

`~/.ax/hooks/routing-table.json` becomes the live source of truth:

- `route-dispatch` hook reads routing-table.json at fire time; falls back to
  baked-in `ROUTING_CLASSES` when the file is missing. Fail open.
- `ax routing compile` seeds the file from `ROUTING_CLASSES` defaults and
  preserves user-added classes on regenerate. Merge key: class name. User
  classes carry `"origin": "user"`; compiled defaults carry
  `"origin": "default"`.
- `ax dispatches --candidates` matches against the same file, so the whole
  loop (measure -> nudge -> tune -> verify) sees one table.

### Mining: hybrid (deterministic default, agent flag)

Deterministic path (default):

1. Pull dispatch history via the existing `dispatch-analytics.ts` query.
2. Filter to: dispatch_model = inherit AND child model expensive
   (fable/opus) AND description unmatched by the current table.
3. Cluster descriptions by token n-gram grouping (the shapes the workflow's
   Mine phase produced: "Implement Task N", "Spec review", "Locate X").
4. Score clusters: keep count >= 3; rank by total cost; suggest a target
   model from agent_type precedent (locator/analyzer -> haiku/sonnet,
   well-specified impl -> sonnet).
5. `--dry-run` prints the proposal table + estimated savings and stops.
6. Apply: append surviving classes to routing-table.json with
   `origin: user`, print the diff.

Agent path (`--emit-brief`): writes `.ax/tasks/routing-tune-<date>.md` - the
proposals plus an instruction block to adversarially backtest each class
against judgment-work false positives before applying (same contract as the
workflow's Backtest phase). The user's agent acts on the brief and applies
survivors.

### Safety

The deterministic path never auto-applies a cluster whose description
matches judgment-work keywords (review / critique / design / plan / audit -
the blocklist from the workflow's verifier). Those clusters are routed to
the brief path with a printed note. Rationale: quality reviews and design
work must stay on the main model; a false-positive routing class there
costs more than it saves.

### Tests

- Clustering as pure functions (description list in, clusters out).
- Merge preserves `origin: user` classes across `ax routing compile` runs.
- Table writes against tmp dirs (existing compile-routing test pattern).
- Judgment-keyword blocklist routes to brief, never auto-applies.

### Out of scope

- The `/routing-tune` Claude workflow stays in-repo as the dev-side tool for
  tuning the shipped `ROUTING_CLASSES` defaults. Not deleted, not installed
  for users.
- No LLM API calls from axctl (rejected: key management + cost + new
  dependency class).

## Sub-project B: marketing campaign

Four assets, sequenced after A ships so everything references the real
command. Real (non-anonymized) numbers approved for publication; refresh
figures at publish time.

### Blog post (anchor)

Working title: "Your frontier model is doing intern work". On the ax site
via content-collections (changelog infra) or a new `/blog` route - decide at
implementation. Structure:

1. The leak: 80.7% of 574 dispatches inherit the frontier model; $2,116
   subagent spend in 14 days.
2. The loop: measure (`ax cost split`) -> nudge (`route-dispatch` hook) ->
   tune (`ax routing tune`) -> verify (`ax dispatches`).
3. Receipts: real terminal output; $487 flagged savings; top classes table
   (well-specified-impl $223, bug-fix $62, task-N-impl $55).
4. CTA: install ax.

### X thread

5-7 posts. Hook: the $2,116 / $487 numbers. Screenshots of
`ax dispatches --candidates`, demo GIF mid-thread, blog link last. Drafted
for the user's review; nothing auto-publishes.

### Demo GIF

Terminal capture: `ax dispatches --candidates` -> `ax routing tune` ->
applied diff -> savings footer. VHS (charmbracelet) tape script committed so
the capture is regenerable.

### Landing section

Upgrade README + site "Route the expensive model" section: live numbers,
GIF, and swap the `/routing-tune` (committed workflow) mention for
`ax routing tune`.

## Sequencing

1. A: routing-table unify -> `ax routing tune` -> migrate compile-routing.
2. GIF recorded against the shipped command.
3. Blog + thread + landing, numbers refreshed at publish.
