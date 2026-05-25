---
name: ax-retro
description: Run an evidence-backed retrospective over the ax agent-experience graph - recent transcripts, native harness hooks, feedback cases, and interventions. Closes the self-improvement loop by turning observed agent behavior into concrete experiment candidates. Use when the user asks for an agent retro, weekly retrospective, ax doctor, ax-doctor, ax-retro, hook effectiveness review, intervention review, self-improvement report, or wants to understand what hooks, skills, context, and interventions helped or hurt.
---

# ax retro

Read-only retrospective over the ax agent-experience graph: recent
transcripts, native harness hooks, feedback cases, and interventions. The
goal is to produce pragmatic experiment candidates from real evidence, not
to praise or condemn hooks from isolated events.

## Defaults

- Window: last 7 days. Widen to 30 days if the evidence is sparse.
- Backtest window: next 3 transcript events after a hook signal.
- Backtest tail: 50 recent candidate cases unless the user asks for a broader run.
- V1 is read-only. Do not edit hook settings, skills, or intervention files unless the user explicitly asks.

## Workflow

1. Refresh evidence:

```bash
axctl ingest --claude-only --since=7 --progress=plain
```

If `axctl` is unavailable, use `bun src/cli/index.ts ...` from the ax repo. If the DB is unavailable, run `axctl doctor --json` and report the blocker.

2. Summarize native hook activity:

```bash
axctl hooks summary --since=7 --tail=20
```

If there are few or no rows, retry with `--since=30`.

3. Backtest known feedback cases:

```bash
axctl hooks backtest enforce-worktree --tail=50 --window=3
```

Treat this as one case type, not a special table per user hook. Future hook rules should become generic feedback cases with their own evaluator.

4. Inspect current intervention state when available:

```bash
axctl interventions list --json
axctl interventions impact --json
axctl interventions regressions --json
```

Optionally run `axctl evidence weekly --json` if the command exists.

## Interpretation Rules

- A blocking hook error is not automatically bad. It can be a useful corrective signal if the next few agent actions show corrected behavior.
- A successful hook is not automatically useful. Look for downstream behavior change, fewer repeated mistakes, or better context use.
- `hook_progress` without a terminal success or blocking event is usually a telemetry gap unless correlated with visible behavior.
- Injected context is useful only if it changes later agent behavior.
- Prefer deterministic backtests over model judgment. Use model judgment to propose new cases, then backtest them when possible.

## Report Shape

Return a concise report with these sections:

- Executive summary: what changed, what looks useful, what is noise.
- Evidence snapshot: commands run, time window, row counts, and any command failures.
- Hook signals: top hooks, blocking patterns, context injections, high-latency commands, progress-only gaps.
- Feedback cases: pass/fail/inconclusive counts and what they imply.
- Intervention candidates: keep, change, remove, or investigate, with confidence and evidence.
- Next experiments: at most 3 reversible experiments, each with metric, time window, and rollback note.

If evidence is missing, say exactly what is missing and which ingest or CLI command should produce it.

## Safety

Retrospectives can recommend changes, but they should not silently apply them. If the user asks to implement experiments, keep edits git-tracked, reversible, and fail-open by default. Broken pre-tool hooks can make an agent session unusable; preserve a documented rollback path.
