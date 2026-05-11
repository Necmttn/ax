# agentctl

Local evidence graph for AI coding agents.

`agentctl` turns Claude Code and Codex history into a queryable SurrealDB graph:
sessions, turns, tool calls, plans, skills, repositories, checkouts, commits,
files, friction, diagnostics, and derived signals.

Use it when you want the next agent to know what happened before:

- which commands failed and what fixed them
- which files changed together
- which worktree produced which commits
- which skills, slash commands, and tools are actually useful
- which verification checks fit the current diff

## Install

Current private-repo install:

```bash
GH_TOKEN="$(gh auth token)" bash -c 'curl -fsSL -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github.raw" https://api.github.com/repos/Necmttn/agentctl/contents/install.sh | bash && PATH="$HOME/.local/bin:$PATH" agentctl ingest --since=7'
```

Public-repo form, if the repo is public:

```bash
curl -fsSL https://raw.githubusercontent.com/Necmttn/agentctl/main/install.sh | bash && PATH="$HOME/.local/bin:$PATH" agentctl ingest --since=7
```

From source:

```bash
git clone https://github.com/Necmttn/agentctl ~/Projects/agentctl
cd ~/Projects/agentctl
bun install
bun run build
./dist/agentctl install
agentctl ingest --since=7
```

Requirements for source/dev use: Bun >= 1.3 and SurrealDB >= 3.0.

## Daily Use

Refresh the local graph and open the dashboard:

```bash
agentctl ingest --since=7
agentctl ingest-insights
agentctl dashboard
```

Check or update the installed release:

```bash
agentctl version --check
agentctl update --check
agentctl update
```

Check local services:

```bash
agentctl daemon status --json
agentctl doctor --json
```

Ground an agent before and after repo work:

```bash
agentctl project context --json
agentctl project verify --json
```

Inspect the graph:

```bash
agentctl insights schema
agentctl insights repositories
agentctl insights checkouts
agentctl insights git
agentctl insights friction
agentctl insights tools
agentctl insights sessions
```

Skill and command hygiene:

```bash
agentctl search "<keywords>"
agentctl stats <skill>
agentctl recent --limit=25
agentctl unused --days=90
agentctl taste --limit=50
agentctl pairs <skill>
agentctl recovery
```

Self-improve queries:

```bash
agentctl guidance next --json
agentctl session summary --json
agentctl self-improve weekly --json
```

## CLI Reference

```text
agentctl ingest [filters] [--since=DAYS] [--progress=auto|pipeline|plain|json|off]
agentctl ingest-insights [--progress=auto|pipeline|plain|json|off]
agentctl derive-signals [--since=DAYS] [--progress=auto|pipeline|plain|json|off]
agentctl insights [schema|repositories|checkouts|git|friction|tools|sessions|graph-health] [--limit=N]
agentctl dashboard [--limit=N] [--out=PATH]
agentctl dashboard serve [--port=1738]
agentctl search <query> [--limit=N]
agentctl stats <skill>
agentctl recent [--limit=N]
agentctl unused [--days=N]
agentctl taste [--limit=N]
agentctl pairs <skill> [--limit=N]
agentctl recovery [--limit=N]
agentctl project context [--json]
agentctl project verify [--json]
agentctl guidance next --json
agentctl session summary --json
agentctl self-improve weekly --json
agentctl version [--check] [--json]
agentctl update [--check] [--json]
agentctl tui
agentctl install
agentctl daemon status [--json]
agentctl daemon start|stop|restart
agentctl doctor [--json]
agentctl uninstall
agentctl help
```

## What Gets Stored

Core records:

- `session`, `turn`, `tool_call`, `plan`, `plan_snapshot`
- `skill`, `tool`, `repository`, `checkout`, `commit`, `file`
- `insight`, `friction_event`, `diagnostic_event`, `recommendation`

Core relations:

```text
repository -> has_checkout -> checkout
session    -> produced      -> commit
commit     -> touched       -> file
turn       -> edited        -> file
turn       -> invoked       -> skill
tool_call  -> concerns      -> skill
insight    -> concerns      -> session
```

Files are canonicalized by repository-relative path when possible, so worktrees
and machine-specific checkout paths do not split the same file history.

## Agent Integration

This repo ships an installable skill at `skill/SKILL.md`.

Install it for Claude Code and Codex:

```bash
npx skills add git@github.com:Necmttn/agentctl.git --skill agentctl -g -a claude-code -a codex -y
```

Local development symlink:

```bash
mkdir -p ~/.claude/skills ~/.agents/skills
ln -sfn "$PWD/skill" ~/.claude/skills/agentctl
ln -sfn "$PWD/skill" ~/.agents/skills/agentctl
```

Agent checklist:

1. Run `agentctl project context --json` before work.
2. Use the returned stack, instructions, git state, and checks.
3. Run `agentctl project verify --json` before reporting completion.
4. Run the recommended verification commands.

## Reactivity

`agentctl install` sets up local automation on macOS:

- SurrealDB daemon on `127.0.0.1:8521`
- watcher for `~/.claude/projects/` and `~/.codex/sessions/`
- `agentctl ingest --since=1` after recent transcript changes

Manual watcher commands for source checkouts:

```bash
bun run watcher:install
bun run watcher:uninstall
```

Logs are written to `~/.local/share/agentctl/logs/`.

## Dev

Run from source:

```bash
bun install
bun scripts/db-start.sh
bun scripts/apply-schema.sh
bun src/cli/index.ts ingest --since=7
```

Verify:

```bash
bun test
bun run typecheck
```

Benchmark a clean DB without touching `agentctl/main`:

```bash
scripts/bench-empty-db.sh --since=90
```

The benchmark writes artifacts under:

```text
~/.local/share/agentctl/benchmarks/<db>/
```

## SurrealDB

Local connection:

- endpoint: `ws://127.0.0.1:8521`
- namespace: `agentctl`
- database: `main`
- user/password: `root` / `root`

Open those settings in Surrealist to inspect the graph directly.

Example queries:

```sql
SELECT name, remote_url, array::len(->has_checkout->checkout) AS checkouts
FROM repository
ORDER BY updated_at DESC
LIMIT 20;

SELECT name, command_norm, exit_code, count() AS failures
FROM tool_call
WHERE has_error = true
GROUP BY name, command_norm, exit_code
ORDER BY failures DESC
LIMIT 20;

SELECT kind, text, session.project AS project, ts
FROM friction_event
ORDER BY ts DESC
LIMIT 20;
```

## Status

Working today:

- Claude and Codex transcript ingest
- skill and slash-command ingest
- Git repository, checkout, commit, and touched-file ingest
- derived friction, diagnostics, skill-pair, recovery, and recommendation signals
- project context and verification JSON commands
- static dashboard and local dashboard server
- self-improve guidance query primitives

Tracked next:

- project memory: `changeset` and `file_memory`
- `agentctl recall`
- concept/entity resolution
- guidance lifecycle and outcome tracking
- richer live dashboard views
- activity-first code tracing
- OTEL/dev-run diagnostics
- Effect service-boundary cleanup

See the `Original inspiration completion` milestone for the active roadmap.

## License

MIT
