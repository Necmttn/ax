---
name: agentctl
description: Query the local agentctl skill+transcript graph (SurrealDB) before assuming a skill exists. Use when the user asks "is there a skill for X", "what skills do I use most", "find a skill that does Y", "show recent skill invocations", "which skills are unused", or any taste/discovery question about the user's own agent history. Replaces guessing-from-the-listing with data-backed answers.
---

# agentctl

`agentctl` is the user's local taste+telemetry graph. It indexes:
- All installed skills (name, scope, description, body)
- Every `Skill` tool invocation across all Claude Code transcripts
- Every Edit/Write tool invocation + which file it touched
- Sessions, turns, projects

Stored in a dedicated SurrealDB on `127.0.0.1:8521` (ns=`agentctl`, db=`main`).

## When to use

ALWAYS before:
- Suggesting a skill ("you could use skill X" → first verify X exists in the index, was used recently, and matches the user's request)
- Recommending a workflow that touches multiple skills
- Telling the user a feature/skill is missing
- Listing "your most-used skills"

## Commands

```bash
agentctl search "<keywords>"        # lexical match on name+description, ranked by 30d usage
agentctl stats <skill-name>         # full drill-down: 7d/30d/90d/total + recent sessions
agentctl recent [--limit=N]         # last N invocations across all sessions
agentctl unused [--days=N]          # skills with zero invocations in N days
agentctl taste [--limit=N]          # composite taste score: invocations × clean-runs
agentctl ingest [--since=DAYS]      # refresh index (skills + transcripts)
```

## How to read results

Each search row is `name [scope] usage  description`. `usage` is `<7d>×7d / <30d>×30d / <total>×total`.

A skill that returns `0×7d / 0×30d / 0×total` exists on disk but has never been explicitly invoked via the `Skill` tool. It may still auto-load via SessionStart hooks or description-match - invocation count is a partial signal, not absolute truth.

## Caveats

- Some skills auto-load (caveman, find-skills, effect-best-practices, frontend-design, full-output-enforcement, expect, commit, superpowers:using-superpowers) and won't show invocations even when active.
- Slash commands (e.g. `/simplify`, `/review-all`, `/wait-for-staging`) appear in invocations because Claude Code routes them through the `Skill` tool - they may not have skill records on disk if they live in `.claude/commands/`.
- The DB updates on session end via the Stop hook in `~/.claude/settings.json`. Weekly self-improve cron does a deep-scan backfill.

## Examples

```bash
# User: "is there a skill that helps with reviewing PRs?"
agentctl search "review pull request"

# User: "what skills did I use this week?"
agentctl recent --limit=50

# User: "this skill seems redundant, anyone using it?"
agentctl stats <skill-name>

# Before deprecating: which skills have I never touched?
agentctl unused --days=90
```

## When NOT to use

- For discovering NEW skills to install from the open ecosystem → use `find-skills` skill (which calls `npx skills find`).
- For raw cost analytics per turn → outside scope. Use `cct` if installed.
