---
name: setup
description: Install + verify ax (the agent experience layer). Triggers when the user says "install ax", "set up ax", "ax not found", "ax doctor", "is ax running", "fix ax install", "first-time ax setup", or any setup question about the ax CLI / skills / daemon. Walks the install via the install.sh + skills.sh + first ingest, validates with `ax doctor`, and points the user at ax:retro (experiment loop) and ax:extract-workflow (reconstruct workflow behind shipped artifacts).
---

# ax:setup

Install and verify ax - the local agent-experience graph. After this skill
the user has the `ax` CLI on PATH, a running SurrealDB, the launchd watcher
reacting to new transcripts, and the ax skills loaded into Claude Code.

This skill is intentionally narrow: install + verify only. For day-to-day
use see `ax:retro` (experiment loop), `ax:extract-workflow` (reconstruct
the recipe behind a shipped artifact), or run the CLI directly.

## When to fire

Trigger phrases:
- "install ax" / "set up ax" / "first-time ax setup"
- "ax not found" / "where is axctl"
- "ax doctor" / "is ax running" / "is ax working"
- "what does ax give me"

Do NOT auto-trigger on unrelated work or when the user is already deep in
an ax workflow (`ax improve list`, `ax recall …`).

## Install

```bash
# 1. CLI binary (downloads the latest GitHub release; macOS-first,
#    Linux works for ingest + CLI without launchd reactivity).
curl -fsSL https://raw.githubusercontent.com/Necmttn/ax/main/install.sh | bash

# 2. Skills - installs this skill + ax:retro + ax:extract-workflow
#    into ~/.claude/skills/ (and ~/.agents/skills/ for codex).
npx skills add Necmttn/ax

# 3. First ingest - seeds the graph from the user's last 7 days of
#    Claude Code + Codex transcripts.
PATH="$HOME/.local/bin:$PATH" ax ingest --since=7
```

If any step fails, run `ax doctor --json` and surface the blocker. If
`ax` itself isn't found after step 1, the user probably has a custom
shell rc - tell them to add `$HOME/.local/bin` to PATH.

## Verify

```bash
ax --version              # expect axctl v0.1.x
ax doctor --json          # expect ok: true for db + watcher + skills
ax skills taste --limit=5 # rank top skills - proof the graph populated
```

Specific failure modes:
- DB connection refused → `scripts/db-start.sh` from the ax repo, or
  `brew services start surrealdb`.
- Watcher not loaded (macOS) → `axctl install` re-runs the launchd
  registration. On Linux the watcher isn't supported - manual
  `ax ingest --since=1` periodically.
- Zero skill invocations after ingest → user has a different Claude
  transcripts path. Set `AX_TRANSCRIPTS_DIR` and re-ingest.

## Label skills ax can't classify (do this for the user)

ax tags skills with *roles* (e.g. framing, execution, verification) so
`ax skills weighted` ranks by usage × role, not raw count. A skill the user
invokes ≥3× with no role is "unclassified" - ax hands each one back to YOU as a
task brief to fill. This is the core agent-in-the-loop step; don't skip it.

```bash
ax skills classify        # writes .ax/tasks/classify-<skill>.md per unclassified skill
```

For each brief written:
1. Read the skill (its SKILL.md / what it does) and the brief's evidence.
2. Fill the YAML at the bottom of the brief: `primary_role:` (required, one
   label), plus optional `secondary_roles:`, `confidence:` (0–1), `rationale:`.
   Run `ax roles` to see labels already in use; reuse them when they fit.
3. Apply + check:

```bash
ax skills lint            # reads filled briefs → writes plays_role edges
ax skills weighted        # the re-ranked list, now role-weighted
```

If `classify` reports "no unclassified skills", the user hasn't used enough yet -
say so and revisit after a few days (the watcher keeps ingesting). One-off
override without a brief: `ax skills tag <skill> <role>`.

Also surface the config front door when relevant:
- `ax skills config` - skill lifecycle (live / orphan / out-of-scope / parked).
- `ax hooks config` - hooks across claude/cursor/codex/opencode (+ add/remove/edit).
- `ax hooks init` - scaffold `~/.ax/hooks` for authoring custom TypeScript guards (`defineHook` from `@ax/hooks-sdk`); validate with `ax hooks backtest` before `ax hooks install`.
- `ax agents config` - agent definitions and the skills they scope.

## What's installed

| Component | Where | Owner |
|---|---|---|
| `ax` / `axctl` CLI | `~/.local/bin/ax` (symlink to `~/.local/share/ax/bin/axctl`) | install.sh |
| SurrealDB | `127.0.0.1:8521` (ns=`ax`, db=`main`) | scripts/db-start.sh |
| Launchd watcher (macOS) | `com.necmttn.ax-watch` reacts to new transcripts | `axctl install` |
| Weekly checkpoint (optional) | `com.necmttn.ax-checkpoint` runs experiment-loop math | `bun run checkpoint:install` from the repo |
| Claude skills | `ax:setup` (this one), `ax:retro` (experiment loop), `ax:extract-workflow` (recipe reconstruction), `ax:release-announcement` (release notes from git + session evidence) | `npx skills add Necmttn/ax` |

## After install

To run the experiment loop:

> let's do an ax retro

That fires `ax:retro` which walks the user through proposal triage +
verdict review against their recent work.

For ad-hoc queries the CLI is direct:

```bash
ax skills taste --limit=10      # most-used skills (with clean-run boost)
ax recall "auth middleware"     # cross-session text search
ax insights tools --limit=5     # tool-failure leaderboard
ax project context --json       # grounding for the current repo
```

## Common questions

- **"What does ax do?"** Local typed graph of every Claude Code + Codex
  session, skill invocation, edit, and commit. Surfaces what skills you
  actually use, what context to ground on, and which repeated workflows
  are worth packaging.
- **"Is my data shared?"** No. Everything stays in your local SurrealDB
  at `127.0.0.1:8521`. No telemetry leaves the box.
- **"How do I uninstall?"**
  ```bash
  bash scripts/uninstall-watcher.sh
  bash scripts/uninstall-daemon.sh
  rm ~/.local/bin/ax ~/.local/bin/axctl
  rm -rf ~/.local/share/ax
  ```

## What this skill is NOT for

- Experiment-loop workflow → use `ax:retro`.
- Reconstructing how a shipped artifact was built → use
  `ax:extract-workflow`.
- Drafting release notes or changelog pages → use
  `ax:release-announcement`.
- Day-to-day skill queries → run the CLI directly; no skill mediation
  needed.
- Schema / dev work on the ax repo itself → see `docs/development.md` in
  the repo.
