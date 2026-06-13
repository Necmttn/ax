---
name: dojo
description: Surplus-quota training loop over the ax graph - the agent burns the remaining 5h/7d plan-quota window on self-improvement: locking pending verdicts, filling briefs, backtesting routing classes, minting proposals, running worktree experiments, and drafting upstream issue reports. Triggers when the user says "/dojo", "enter the dojo", "dojo time", "train overnight", "burn my surplus quota", "dream mode" (legacy name), or invokes /loop /dojo. Requires ax (axctl) on PATH and the local SurrealDB running. Do NOT auto-trigger on unrelated work or when the user merely mentions quotas.
---

# ax:dojo - overnight training loop

You are entering a budget-bounded self-improvement loop. The brain is
`ax dojo agenda --json`; you are the thin driver. Spec:
docs/superpowers/specs/2026-06-13-ax-dojo-design.md (in the Necmttn/ax repo).

## Entry

1. Run `ax dojo agenda --json`. If it fails with a connection error, tell the user
   to run `ax doctor` and STOP.
2. If `budget.has_surplus` is false: report the envelope and STOP unless the
   user re-invokes with `--force` (then pass `--force` on every lap).
3. On Claude Code: enter loop mode now - invoke the `/loop` skill with
   `/dojo` as the recurring prompt (dynamic mode, self-paced). Each wakeup
   re-runs this skill from the top; that is expected and correct.
   On Codex (no /loop): run as ONE long turn - do not end the turn until a
   stop condition below is met.

## The lap

1. `ax dojo agenda --json` -> agenda.
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
- **New hooks specifically** - author via @ax/hooks-sdk, then run BOTH
  validators and embed their output in the proposal:
  1. `ax hooks backtest <file> --json` → cases caught (benefit side): would-block/
     would-warn rates, false-positive count, cases with evidence.
  2. `ax hooks bench <file> --json` → per-fire p50/p95 from real bun spawns,
     est fires/day from tool_call history, installed-chain budget vs --budget-ms
     default 250 (cost side).
  Reject the hook when daily cost (fires/day × p95) or an installed-chain budget
  overrun outweighs the benefit shown by backtest. Both ledgers must appear in
  the proposal; neither alone is sufficient.
- **spar** - only present when invoked with --spar and spendable >= 30%.
  One task, one delta, scored. Concrete flow:
  1. Pick a landed task: `ax sessions here --days=30` - note its commit sha from `ax sessions near <sha>` or `git log`.
  2. `ax dojo spar-plan <sha>` - captures the baseline (prompt + cost/turns/churn) and writes `~/.ax/dojo/spar/<id>.md`; the command prints the exact `git worktree add` command to run next.
  3. Read the brief at `~/.ax/dojo/spar/<id>.md`; run the printed `git worktree add .claude/worktrees/dojo-spar-<id> -b dojo/spar-<id> <parentSha>` command to pin the worktree at the parent SHA.
  4. Apply exactly ONE delta in the delta section (skill on/off, hook on/off, prompt change, thinking level, or model override) - no compound changes.
  5. Do the task in that worktree; let it finish naturally.
  6. `ax dojo spar-score <id>` - auto-discovers the variant session from the worktree cwd; or pass `--variant-session=<id>` if there are multiple sessions. Writes the receipt to `~/.ax/dojo/spar/<id>-report.md`.
  7. Append the receipt to the dojo report. Track multi-run campaigns as goal files under docs/superpowers/goals/ so the next session can resume.
- **explore** - free investigation, retro-meta style: follow a hunch
  through `ax recall` / `ax sessions churn`, and convert anything real
  into a proposal or outbox draft.
- **Upstream findings (any lap)** - an ax bug or improvement found while
  training (items of kind `upstream_draft` are handled by this same rule):
  run `ax dojo draft --title=<title> --kind=bug|improvement` to stage it
  to `~/.ax/dojo/outbox/<slug>.md` (complete issue draft: title, body,
  repro, session refs written by the command). NEVER publish from the dojo -
  the user reviews and publishes in the morning (ax-repo skill / gh).

## Exit - the morning report

Run `ax dojo report --since=<loop-start-iso> --notes-file=<lap-notes-path>` to
write `~/.ax/dojo/reports/<YYYY-MM-DD>.md`. The command collects the budget
envelope, per-lap item log (from the lap notes file), proposals created,
verdicts locked, and outbox drafts awaiting review - pass it the ISO timestamp
you recorded when the loop started and the scratch file you appended notes to.
Then tell the user the report path and the top 3 things awaiting their review.

For upstream findings (ax bugs or improvements discovered during training), stage
them with `ax dojo draft --title=<title> --kind=bug|improvement` before the
report step - never publish directly. The draft lands in
`~/.ax/dojo/outbox/<slug>.md`; the user reviews and publishes via ax-repo skill /
gh in the morning.

## Hard rails

- worktrees only; never write on main; never merge anything
- proposals are the only activation path
- outbox only; nothing leaves the machine
- respect the deadline even mid-item: checkpoint, report, stop
