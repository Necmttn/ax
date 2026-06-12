# ax dojo - overnight training loop for agents

Date: 2026-06-13
Status: approved design, pre-implementation

## Problem

First-run ax story is clear: install → ingest → dashboard shows routes,
insights, improve section. The recurring story is not. After setup, what does
the user *do* with ax week over week?

Vision: users end their 5h/weekly quota windows with unspent tokens. One
command, triggered inside their harness of choice (Claude Code or Codex),
sends the agent into detective mode - backtest history, drain pending
judgment queues, run experiments, mint new skills/hooks, draft upstream bug
reports - burning the surplus before the window resets. Like dreaming, but
more than memory consolidation: the agent *trains*. Hence **dojo** - agents
train overnight and come back with solutions.

## Decisions (locked)

1. **Runner**: v1 is an in-session skill loop on the user's plan quota. No
   headless `claude -p` (that burns API, not plan). Cron/launchd automation
   deferred until the loop works manually.
2. **Blast radius**: full-autonomy *capable*, proposal-*gated*. All code work
   happens in worktrees, backed by backtests against prior transcript
   history. Output lands as `ax improve` proposals - **merging a proposal is
   what activates it**. Dojo never merges, never touches main.
3. **Brain location**: `ax dojo` CLI emits a machine-readable agenda; the
   skill is a thin loop driver. Logic is typed, Effect-native, testable; the
   Codex port is free because the brain lives in the CLI.
4. **Budget**: the agenda carries the budget envelope, computed from the
   quota module. Skill re-checks every lap.
5. **Upstream reporting**: draft locally to an outbox, publish only on
   morning review. Nothing leaves the machine unattended.
6. **Name**: dojo. `ax dojo` subcommand, `ax:dojo` skill.

## Architecture

Two pieces, one brain:

```
ax:dojo skill (thin loop)            ax dojo CLI (brain)
┌─────────────────────────┐          ┌──────────────────────────────┐
│ loop:                   │  --json  │ budget envelope (QuotaEnv)   │
│   ax dojo --json ───────┼─────────▶│ + prioritized agenda items   │
│   budget gone / empty?  │          │   derived from existing      │
│     → write report, stop│          │   queries - self-clearing    │
│   else: top item        │          └──────────────────────────────┘
│     → execute playbook  │
│     → repeat            │
└─────────────────────────┘
```

### `ax dojo [--json]` - the agenda

New module `apps/axctl/src/dojo/`. Composes two things:

**Budget envelope** (reuses `apps/axctl/src/quota/` QuotaEnv seam):

- `spendable` = remaining tokens in the current window − reserve
  (default 15% headroom)
- `deadline` = next window reset (min of 5h and 7d resets)
- starting with no surplus → warn, proceed only with `--force`
- overrides: `--budget=N%`, `--until=HH:MM`

**Agenda items**, priority order (cheap + high-signal first):

| # | kind | source | playbook sketch |
|---|------|--------|-----------------|
| 1 | `verdict_pending` | improve loop pending verdicts | confirm/override verdict with retro evidence |
| 2 | `brief_unfilled` | `.ax/tasks/*.md` (classify, routing-tune, improve accept) | fill brief, run the matching lint/apply command |
| 3 | `routing_backtest` | judgment-flagged routing-tune candidates | backtest class against history, apply or reject |
| 4 | `proposal_mint` | fresh `ax improve recommend` pass | generate new grounded proposals |
| 5 | `experiment` | churn hotspots (`ax sessions churn`) | worktree experiment: fix/hook/skill, backtest, emit proposal |
| 6 | `upstream_draft` | findings during any item | write issue draft to outbox with repro + session refs |
| 7 | `explore` | agenda dry | retro-meta style free investigation |

Each item: `id`, `kind`, `commands` (exact CLI invocations), `success`
criteria, `cost_class` (s/m/l). The agenda is **derived state** - a locked
verdict, filled brief, or created proposal disappears from the next lap's
agenda automatically. No new SurrealDB table in v1.

### `ax:dojo` skill - the loop

Lives in the ax skills set (installable via `npx skills add Necmttn/ax`).
Per lap:

1. `ax dojo --json`
2. budget exhausted, deadline passed, or agenda empty → write report, stop
3. take the top item, follow its playbook
4. goto 1

On Claude Code it pairs naturally with `/loop` dynamic mode; on Codex the
same SKILL.md drives the loop. The skill text contains no discovery logic -
only loop mechanics + per-kind playbooks.

### Training output = proposals

- **Code experiments**: worktrees only (existing enforce-worktree hooks
  already block main writes). Branch + evidence, surfaced as an improve
  proposal; optionally a draft PR.
- **New hooks**: authored via `@ax/hooks-sdk`, validated with
  `ax hooks backtest` (evidence attached), shipped as a proposal.
- **New skills**: scaffolded draft + usage evidence from the graph, shipped
  as a proposal.
- **Merging the proposal activates it.** Morning user reviews a queue, never
  a surprise diff.

### Outbox + report

- `~/.ax/dojo/outbox/*.md` - upstream issue drafts (full evidence). Publish
  on review via the existing `ax-repo` skill / `gh`.
- `~/.ax/dojo/reports/<date>.md` - what trained, what was proposed, tokens
  spent vs envelope.
- v2: dojo report feeds the dashboard next-actions panel.

### Scope

Graph chores (verdicts, briefs, routing, proposals) are global. Code
experiments are scoped to the current repo in v1; multi-repo selection
later.

## Safety rails (summary)

- worktree-only edits (deterministic hooks, not skill prose)
- proposals, never merges
- outbox, never unattended publishing
- budget reserve keeps 15% of the window untouched
- `--force` required to dojo with no surplus

## Out of scope (v1)

- cron/launchd auto-trigger near window end (v2; prior art:
  `~/.claude/self-improve/` launchd setup)
- dashboard dojo surface
- multi-repo experiment selection
- `dojo_run` history table (reports are files first)

## Open questions

- Does Codex expose enough loop control for parity, or does v1 Codex run as
  a single long turn?
- Cost-class estimation: static per-kind, or learned from dispatch history?
