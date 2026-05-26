---
name: retro-meta
description: Deep retro of retros - investigation pass that surfaces improvements across older retros and the current ax setup. External AI agent drives the reasoning with high thinking enabled. Triggers when user says "deep retro", "investigate ax", "what should I fix in my setup", "retro of retros", or invokes /ax:retro-meta. Use after `ax:retro` if proposals are sparse or you want broader exploration.
---

# ax:retro-meta - deep retro of retros

The companion to `ax:retro`. Where `ax:retro` walks the heuristic-derived
proposals one by one, `retro-meta` asks: *what improvements does the
existing pipeline NOT yet see?*

The external agent (this one, Claude Code or Codex with high thinking)
drives the reasoning. The CLI just produces structured evidence and
takes user-approved plans back.

## When to fire

Explicit triggers only:
- "let's do a deep retro" / "retro of retros"
- "investigate my ax setup" / "what should I fix in my setup"
- "review proposals the heuristic missed"
- `/ax:retro-meta` slash command
- After `ax:retro` finishes if the user wants broader exploration

Do NOT auto-trigger on generic "look at recent work".

## Prerequisites

- `ax` (axctl) is on PATH and the local SurrealDB is reachable. If
  `ax doctor` fails, stop and tell the user `scripts/db-start.sh`.
- At least 3 retros in the last 30 days. Below that, evidence is too
  thin for a meta pass - recommend `ax:retro` first.

## Workflow

### Step 1 - Snapshot

```bash
ax retro meta --since=30 --limit-retros=50 > /tmp/ax-meta.json
```

Read `/tmp/ax-meta.json`. The keys you care about:
- `retros[]` - raw `tried/worked/failed/next` per session.
- `patterns.tool_failures` - sorted by total_count desc.
- `patterns.corrections` - total + max-per-session + session_count.
- `patterns.friction_kinds` - recurring kinds across sessions.
- `current_state.skills` - what's already installed (do NOT propose
  duplicates).
- `current_state.open_proposals` - existing heuristic proposals.
- `current_state.accepted_experiments` - accepted but verdict-pending.
- `current_state.claude_md_user` / `claude_md_project` - guidance file
  paths (null if absent).
- `investigation_prompts[]` - the prompts you must walk.

### Step 2 - Walk the investigation prompts (high thinking)

For EACH prompt in `investigation_prompts`:

1. Inspect referenced state with Read / Glob / Grep:
   - skill files in `~/.claude/skills/` and `~/.agents/skills/`
   - `claude_md_user` if non-null
   - `claude_md_project` if non-null
2. Reason about a candidate improvement. Use a high thinking budget -
   the point is to see what the heuristic missed.
3. If you identify a real improvement (NOT a duplicate of an existing
   skill or open_proposal):
   a. Draft a plan doc to `~/.claude/plans/<YYYY-MM-DD>-<slug>.md`,
      30–100 lines. Sections: Problem, Evidence (cite retro ids),
      Proposed change, Success signal.
   b. Show the user a 4–6 line summary.
   c. Ask explicitly: *"Register this as an accepted experiment? (y/n)"*
   d. ONLY on yes:
      ```bash
      ax retro plan \
        --slug=<kebab-slug> \
        --form=skill|hook|guidance|automation \
        --title="<short title>" \
        --hypothesis="<one sentence>" \
        --plan-path=~/.claude/plans/<file>.md \
        --evidence-retros=<retro:id1,retro:id2> \
        --confidence=low|medium|high
      ```
4. If the prompt resolves to "no change needed" or "duplicate of
   existing", say so out loud and move on.

### Step 3 - Optional: hand off to scaffolder

For each plan you registered, you may run:

```bash
ax improve accept --with-agent <dedupe_sig>
```

This spawns the internal scaffolding agent to draft an artifact
(SKILL.md, hook script, etc) from the plan. Skip if the plan is
already self-sufficient.

### Step 4 - Summary

Print one paragraph:
- N plans registered, M of those scaffolded
- K open_proposals reviewed (and their disposition)
- Any prompts that resolved to "nothing here"
- Suggested next retro window

## Anti-patterns

- NEVER register a plan without an explicit user yes per plan. The
  human is the final filter.
- NEVER auto-accept all open_proposals - the heuristic surfaces them
  but the deep pass exists precisely to triage them by reasoning, not
  by frequency rank.
- NEVER write directly to `~/.claude/skills/`. Use `ax retro plan` +
  `ax improve accept --with-agent`.
- NEVER skip Step 2's duplicate check. Proposing a Pre-Bash guard when
  one is already accepted just wastes the user's time.
- Don't trust frequency alone. A frequency=1 retro can still be
  load-bearing if it represents a category Claude can't get right.

## CLI reference

```bash
# Snapshot only (no side effects)
ax retro meta --since=30 [--limit-retros=50] [--pretty]

# Register a user-approved plan as accepted proposal + experiment
ax retro plan \
  --slug=<kebab> \
  --form=skill|hook|guidance|automation \
  --title="<title>" \
  --hypothesis="<hyp>" \
  --plan-path=<path-to-plan.md> \
  [--evidence-retros=retro:a,retro:b] \
  [--artifact-path=<path>] \
  [--confidence=low|medium|high] \
  [--frequency=<N>] \
  [--json]

# Optionally hand off scaffolding to the internal agent
ax improve accept --with-agent <dedupe_sig>
```

Output of `ax retro meta` defaults to JSON because the reader is you,
not a human.
