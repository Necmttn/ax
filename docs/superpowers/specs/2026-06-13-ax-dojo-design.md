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
| 7 | `spar` | opt-in (`--spar`), needs large surplus | replay benchmark: one variable changed, scored delta (see Sparring) |
| 8 | `explore` | agenda dry | retro-meta style free investigation |

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

**Entry mechanics** (user types `/dojo`, nothing else):

- Claude Code: skills compose - the dojo SKILL.md's first step invokes
  `/loop` dynamic mode with `/dojo` as the prompt, which unlocks
  `ScheduleWakeup` self-pacing between laps (wakeups re-fire the skill, so
  the run survives early turn-ends and context growth). Typing `/loop /dojo`
  directly reaches the same path. A bare skill cannot self-schedule wakeups
  without entering through /loop - that gating is why dojo composes rather
  than reimplements.
- Codex: no /loop equivalent - v1 runs as one long in-turn loop ("do not
  end the turn until budget exhausted or agenda empty"). Weaker resilience,
  acceptable for v1.

The skill text contains no discovery logic - only loop mechanics + per-kind
playbooks.

**Heavy items become goal packages** (`/goal` composition, one level down):

- /loop and /goal terminate differently: /loop ends on budget/deadline
  (dojo's outer driver - "done" is never "objective complete"); /goal ends
  on objective gates. So /goal never drives the night, but a *heavy agenda
  item* - a spar campaign, a multi-replay experiment - is exactly a goal:
  objective, checkpoint index, gates, evidence log (prior art:
  `docs/superpowers/goals/*.md`, e.g. the SetFit goal's E0-E498 arc).
- Dojo lap on a heavy item: create-or-resume its goal file, advance
  checkpoints until the lap budget says stop, leave the checkpoint index
  updated. The NEXT dojo session resumes the same goal where it stopped.
- Net effect: the goals dir is dojo's **curriculum** - cross-night memory
  for experiments too big for one surplus window; gates decide when a
  campaign is concluded and its proposal ships.

### Training output = proposals

- **Code experiments**: worktrees only (existing enforce-worktree hooks
  already block main writes). Branch + evidence, surfaced as an improve
  proposal; optionally a draft PR.
- **New hooks**: authored via `@ax/hooks-sdk`, validated with
  `ax hooks backtest` (evidence attached), shipped as a proposal. Evidence
  must show **both sides of the ledger**:
  - *benefit*: cases from history this hook would have caught/fixed
  - *cost*: per-fire latency (p50/p95 measured during backtest), estimated
    fires/day from tool_call history → daily overhead, and the **cumulative
    installed-chain latency** (every hook rides the ~70ms bun hot path;
    chains add up). Agenda warns when total chain exceeds a budget
    (default ~250ms per event); dojo must reject its own hook when overhead
    outweighs benefit.
- **New skills**: scaffolded draft + usage evidence from the graph, shipped
  as a proposal.
- **Merging the proposal activates it.** Morning user reviews a queue, never
  a surprise diff.

### Sparring - opt-in replay benchmarks (`--spar`)

The dojo metaphor's practice matches. Context: the field needs better
harness/model benchmarks; the user's own transcript history is a benchmark
corpus nobody else has.

Mechanism - **one task, one delta, scored**:

1. Pick a past task with a known outcome from the graph (a session that
   landed a commit; `ax sessions near <sha>` gives the window).
2. Pin a worktree at the parent commit - frozen environment.
3. Re-run the same task prompt with exactly **one variable changed**:
   model, skill present/absent, hook present/absent, thinking level, or
   prompt wording.
4. Score the delta from the graph's own metrics: tokens spent, turns,
   verification churn / episodes, wall time, did-it-land.
5. Output a **spar report** (receipt-style comparison, baseline vs variant)
   into the dojo report + optionally an improve proposal ("adding skill X
   to this task class saves ~N tokens").

Guardrails:

- opt-in only (`--spar` flag or config), `cost_class: xl` - agenda includes
  spar items only when surplus is large (a spar can burn a meaningful slice
  of the window)
- pinned worktree, no pushes; baseline = the historical run (free - already
  in the graph), so one spar = one live re-run, not two
- variant runs are tagged in the graph (so spar traffic never pollutes
  taste/usage analytics)

v1 ships the mechanism for skill/hook/prompt deltas inside the same harness
(model deltas via subagent model override where the harness allows it);
cross-harness sparring (Claude Code vs Codex on the same task) is v2.

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
- hook proposals carry a latency ledger; installed-chain budget warns at
  ~250ms/event
- spar is opt-in, surplus-gated, and tagged so benchmark runs never pollute
  usage analytics

## Out of scope (v1)

- cron/launchd auto-trigger near window end (v2; prior art:
  `~/.claude/self-improve/` launchd setup)
- dashboard dojo surface
- multi-repo experiment selection
- `dojo_run` history table (reports are files first)

## Open questions

- Cost-class estimation: static per-kind, or learned from dispatch history?
- Spar model deltas: subagent model override covers Claude-family swaps on
  plan quota; is that enough for v1, or does model comparison need the
  harness's own model switch?
- Hook latency measurement: extend `ax hooks backtest` with timing, or a
  separate `ax hooks bench`? How to attribute fires/day per event type?
