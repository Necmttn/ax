---
name: dojo
description: Surplus-quota training loop over the ax graph - the agent burns the remaining 5h/7d plan-quota window on self-improvement: locking pending verdicts, filling briefs, backtesting routing classes, minting proposals, running worktree experiments, and drafting upstream issue reports. Triggers when the user says "/dojo", "enter the dojo", "dojo time", "train overnight", "burn my surplus quota", "dream mode" (legacy name), or invokes /loop /dojo. Requires ax (axctl) on PATH and the local SurrealDB running. Do NOT auto-trigger on unrelated work or when the user merely mentions quotas.
---

# ax:dojo - overnight training loop

You are entering a budget-bounded self-improvement loop. The brain is
`ax dojo --json`; you are the thin driver. Spec for humans:
docs/superpowers/specs/2026-06-13-ax-dojo-design.md (in the Necmttn/ax repo).

## Entry

1. Run `ax dojo --json`. If it fails with a connection error, tell the user
   to run `scripts/db-start.sh` (or `ax doctor`) and STOP.
2. If `budget.has_surplus` is false: report the envelope and STOP unless the
   user re-invokes with `--force` (then pass `--force` on every lap).
3. On Claude Code: enter loop mode now - invoke the `/loop` skill with
   `/dojo` as the recurring prompt (dynamic mode, self-paced). Each wakeup
   re-runs this skill from the top; that is expected and correct.
   On Codex (no /loop): run as ONE long turn - do not end the turn until a
   stop condition below is met.

## The lap

1. `ax dojo --json` -> agenda.
2. STOP conditions (write the report, then stop):
   - `budget.has_surplus` is false
   - now >= `budget.deadline`
   - `items` is empty
3. Otherwise: take `items[0]`, follow its playbook below, then go to 1.
   Completed work self-clears: the item vanishes from the next agenda
   because the underlying system recorded it (verdict locked, brief
   consumed, proposal created). If the same item survives 2 laps untouched,
   skip it and note why in the report.

## Playbooks by kind

- **verdict_pending** - `ax improve verdict <id>` to see the suggested
  verdict + checkpoint evidence; confirm with `--set <verdict>` only when
  the evidence supports it. Distinguish "pattern resolved" from "artifact
  never fired" before locking no_longer_needed.
- **brief_unfilled** - open the `.ax/tasks/*.md` brief, do what it says in
  the target files, then run the reconciler it names (`ax skills lint` /
  `ax improve lint`).
- **routing_backtest** - judgment-flagged routing classes: backtest the
  pattern against dispatch history (`ax dispatches --candidates`), check
  false-positive risk, then `ax routing tune --apply=<ids> --days=<window>`
  or reject with a written rationale in the report.
- **proposal_mint** - `ax improve recommend`; accept the grounded ones
  (`ax improve accept <id>`) so briefs exist for the next lap.
- **experiment** - heavy item. Work ONLY in a fresh worktree
  (`git worktree add .claude/worktrees/dojo-<slug> -b dojo/<slug>`).
  Reproduce the churn pattern, attempt the fix/hook/skill, capture evidence.
  If it will not finish inside this budget: package it as a goal file
  (objective + checkpoint index + gates) under docs/superpowers/goals/ so
  the NEXT dojo session resumes it. Output = an improve proposal; merging
  the proposal is what activates anything. NEVER merge, never touch main.
- **New hooks specifically** - author via @ax/hooks-sdk, validate with
  `ax hooks backtest <file>`, and put BOTH sides in the proposal: cases it
  would have caught AND the latency ledger (per-fire cost, est fires/day,
  cumulative installed-chain overhead). Reject your own hook when overhead
  outweighs benefit.
- **spar** - only present when invoked with --spar and spendable >= 30%.
  One task, one delta, scored: pick a landed task (`ax sessions here`),
  pin a worktree at the parent SHA, re-run it with exactly ONE change
  (skill on/off, hook on/off, prompt, thinking level, model via subagent
  override), score against the historical baseline using graph metrics
  (tokens, turns, churn, landed). Append the comparison receipt to the
  report. Track multi-night campaigns as goal files.
- **explore** - free investigation, retro-meta style: follow a hunch
  through `ax recall` / `ax sessions churn`, and convert anything real
  into a proposal or outbox draft.
- **Upstream findings (any lap)** - an ax bug or improvement found while
  training (items of kind `upstream_draft` are handled by this same rule)
  goes to `~/.ax/dojo/outbox/<slug>.md` as a complete issue draft
  (title, body, repro, session refs). NEVER publish from the dojo - the
  user reviews and publishes in the morning (ax-repo skill / gh).

## Exit - the morning report

Write `~/.ax/dojo/reports/<YYYY-MM-DD>.md` (create dirs if missing):
- budget: envelope at start, spendable consumed (re-run `ax quota` and diff)
- per lap: item, what happened, evidence refs
- proposals created/advanced, briefs filled, verdicts locked
- outbox drafts awaiting review (list paths)
- skipped/stuck items and why
Then tell the user the report path and the top 3 things awaiting their
review. Done.

## Hard rails

- worktrees only; never write on main; never merge anything
- proposals are the only activation path
- outbox only; nothing leaves the machine
- respect the deadline even mid-item: checkpoint, report, stop
