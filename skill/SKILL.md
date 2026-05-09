---
name: agentctl
description: Use the local agentctl CLI for AI-agent grounding. Query the user's skill+transcript graph before assuming a skill exists, and run project context/verify before or after repo work. Use when the user asks "is there a skill for X", "what skills do I use most", "find a skill that does Y", "show recent skill invocations", "which skills are unused", or when project-local git, stack, instruction, verification, or diagnostics context would help.
---

# agentctl

`agentctl` is the user's local taste+telemetry graph and project-grounding CLI. It indexes:
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
- Starting non-trivial repo work where git state, project instructions, stack, and likely checks matter
- Claiming repo work is done, when changed files should drive verification

## Commands

```bash
agentctl search "<keywords>"        # lexical match on name+description, ranked by 30d usage
agentctl stats <skill-name>         # full drill-down: 7d/30d/90d/total + recent sessions
agentctl recent [--limit=N]         # last N invocations across all sessions
agentctl unused [--days=N]          # skills with zero invocations in N days
agentctl taste [--limit=N]          # composite taste score: invocations × clean-runs
agentctl ingest [--since=DAYS]      # refresh index (skills + transcripts)
agentctl project context --json     # read-only repo grounding: git, stack, instructions, checks
agentctl project verify --json      # diff-aware checks + optional live diagnostics
```

## Setup checklist

If `agentctl` is not on PATH, tell the user the CLI must be installed first:

```bash
git clone https://github.com/Necmttn/agentctl ~/Projects/agentctl
cd ~/Projects/agentctl
bun install
bun run build
./dist/agentctl install
agentctl ingest --since=7
```

If this skill itself is missing in a new agent environment, install it with:

```bash
npx skills add Necmttn/agentctl --skill agentctl -g -a claude-code -a codex -y
```

## Project workflow

At the start of repo work, run:

```bash
agentctl project context --json
```

Use `git.changes` to understand the user's current worktree, `stack.signals` for detected frameworks, `stack.instructions` for relevant AGENTS/CLAUDE rules, and `verification` for likely checks.

Before reporting completion or when debugging a changed project, run:

```bash
agentctl project verify --json
```

Run the returned `checks[].command` values that match the scope of the change unless the user only asked for analysis. Treat `diagnostics.issues` as live project feedback when `.agentctl/config.json` is configured.

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

# Starting work in a repo
agentctl project context --json

# Before claiming a repo change is complete
agentctl project verify --json

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
