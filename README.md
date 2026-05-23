# ax

Local evidence graph for AI coding agents.

`ax` turns Claude Code and Codex history into a queryable SurrealDB graph:
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
GH_TOKEN="$(gh auth token)" bash -c 'curl -fsSL -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github.raw" https://api.github.com/repos/Necmttn/ax/contents/install.sh | bash && PATH="$HOME/.local/bin:$PATH" axctl ingest --since=7'
```

Public-repo form, if the repo is public:

```bash
curl -fsSL https://raw.githubusercontent.com/Necmttn/ax/main/install.sh | bash && PATH="$HOME/.local/bin:$PATH" axctl ingest --since=7
```

From source:

```bash
git clone https://github.com/Necmttn/ax ~/Projects/ax
cd ~/Projects/ax
bun install
bun run build
./dist/axctl install
axctl ingest --since=7
```

Requirements for source/dev use: Bun >= 1.3 and SurrealDB >= 3.0.

## Daily Use

Refresh the local graph and open the live dashboard:

```bash
axctl ingest --since=7
axctl ingest --insights-only
axctl serve
```

`axctl serve` runs the live web dashboard; `axctl report` writes a one-shot
static HTML snapshot instead.

Check or update the installed release:

```bash
axctl version --check
axctl update --check
axctl update
```

Check local services:

```bash
axctl daemon status --json
axctl doctor --json
```

`axctl install` also creates an `ax` convenience alias that points at the same binary.

Ground an agent before and after repo work:

```bash
axctl project context --json
axctl project verify --json
axctl project harness --json
axctl doctor --json
```

Inspect the graph:

```bash
axctl insights schema
axctl insights repositories
axctl insights checkouts
axctl insights git
axctl insights friction
axctl insights tools
axctl insights sessions
axctl insights feedback-loops
axctl insights verification-gaps
axctl insights user-language
axctl insights token-impact
axctl insights cache-health
axctl insights workflow-impact
axctl insights codex-health
axctl insights closure
axctl insights post-feature-fixes
axctl insights skill-candidates
```

Recall past work with full-text search across user and assistant turns:

```bash
axctl recall "auth middleware" --skill=tdd --json
```

Skill and command hygiene:

```bash
axctl skills search "<keywords>"
axctl skills stats <skill>
axctl skills recent --limit=25
axctl skills unused --days=90
axctl skills taste --limit=50
axctl skills pairs <skill>
axctl skills recovery
```

Self-improve queries:

```bash
axctl evidence guidance-next --json
axctl evidence session-summary --json
axctl evidence weekly --json
axctl interventions list --json
axctl interventions candidates --json
axctl interventions regressions --json
```

## CLI Reference

```text
axctl ingest [--since=N] [--reset] [--insights-only] [--skills-only|--transcripts-only|--codex-only|--git-only|--claude-only] [--progress=auto|pipeline|plain|json|off] [--verbose]
axctl derive-signals [--since=N] [--progress=...] [--verbose]
axctl insights <view> [--limit=N]
axctl interventions <action> [--limit=N] [--json]
axctl serve [--port=N]
axctl report [--limit=N] [--out=path]
axctl recall <query> [--project=...] [--skill=...] [--since=...] [--json]
axctl skills <search|stats|recent|unused|taste|pairs|recovery>
axctl context file [--files=path,path] [--json] <query>
axctl project <context|verify|harness> [--json]
axctl evidence <guidance-next|session-summary|weekly> [--json]
axctl version [--check] [--json]
axctl update [--check] [--json]
axctl tui
axctl install
axctl daemon <status|start|stop|restart>
axctl doctor [--json]
axctl uninstall
```

### Graph Explorer

`axctl serve` exposes `/graph`, a typed graph explorer over agent
telemetry.

Implemented mode:

- `File attention`: files connected to sessions through existing edited-file
  evidence. This is the first concrete `/graph` query.

Staged/planned modes:

- `Ask -> Outcome`: planned user asks connected to sessions, phase spans,
  delivery outcomes, and feedback.
- `Phase balance`: planned planning, implementation, verification, review, and
  hands-free work duration view.
- `Delivery`: planned branches, commits, PRs, reviews, checks, and mainline
  promotion view.
- `Patterns`: planned cross-session pattern candidates backed by messages,
  files, sessions, and outcomes.
- `Skill pairs`: planned compatibility mode for the existing skill
  co-occurrence graph.

The new delivery, phase, and ask/outcome tables and classifiers are groundwork
for these views. User-message mentions, read/search references, touched
outcomes, ingestion writers/population, and backing graph queries are follow-on
work; staged modes stay disabled/empty until those pieces exist. The delivery
classifier distinguishes local-only work, open PRs, closed-unmerged PRs, merged
PRs without mainline evidence, promoted-without-PR work, and merged-to-main
work.

### Development (AX_DEV=1)

These subcommands are only exposed when `AX_DEV=1` is set in the environment.
Run `AX_DEV=1 axctl dogfood terminal --help` for the full flag list.

```text
axctl dogfood terminal [--scenario=...] [--agent=...] [--transport=...] [--command=...] [--success-marker=...] [--timeout=...] [--port=...] [--json]
```

## What Gets Stored

Core records:

- `session`, `turn`, `tool_call`, `plan`, `plan_snapshot`
- `skill`, `tool`, `repository`, `checkout`, `commit`, `file`
- `insight`, `friction_event`, `diagnostic_event`, `recommendation`
- staged Harness Doctor records: `guidance_source`, `guidance_revision`,
  `stack`, `agent_tooling`, `harness_learning`, `intervention`,
  `intervention_observation`

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

`axctl project harness --json` computes the Harness Doctor report at read
time. Default `axctl ingest` also persists the report into the staged Harness
Doctor tables through the `harness/doctor` ingest stage.

## Agent Integration

This repo ships installable agent skills:

- `axctl` at `skill/SKILL.md` for day-to-day project grounding.
- `ax-retro` at `skills/ax-retro/SKILL.md` for evidence-backed retrospectives.

Install them for Claude Code and Codex:

```bash
npx skills add git@github.com:Necmttn/ax.git --skill axctl -g -a claude-code -a codex -y
npx skills add git@github.com:Necmttn/ax.git --skill ax-retro -g -a claude-code -a codex -y
```

Local development symlink:

```bash
mkdir -p ~/.claude/skills ~/.agents/skills
ln -sfn "$PWD/skill" ~/.claude/skills/axctl
ln -sfn "$PWD/skill" ~/.agents/skills/axctl
ln -sfn "$PWD/skills/ax-retro" ~/.claude/skills/ax-retro
ln -sfn "$PWD/skills/ax-retro" ~/.agents/skills/ax-retro
```

Agent checklist:

1. Run `axctl project context --json` before work.
2. Use the returned stack, instructions, git state, and checks.
3. Run `axctl project verify --json` before reporting completion.
4. Run the recommended verification commands.
5. Use `axctl project harness --json` when changing agent guidance,
   verification tooling, branch/worktree policy, or local harness setup.

## Reactivity

`axctl install` sets up local automation on macOS:

- SurrealDB daemon on `127.0.0.1:8521`
- watcher for `~/.claude/projects/` and `~/.codex/sessions/`
- `axctl ingest --since=1` after recent transcript changes
- onboarding guidance for git-tracking global Claude/Codex/shared harness dirs

Manual watcher commands for source checkouts:

```bash
bun run watcher:install
bun run watcher:uninstall
```

Logs are written to `~/.local/share/ax/logs/`.

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

Benchmark a clean DB without touching `ax/main`:

```bash
scripts/bench-empty-db.sh --since=90
```

The benchmark writes artifacts under:

```text
~/.local/share/ax/benchmarks/<db>/
```

## SurrealDB

Local connection:

- endpoint: `ws://127.0.0.1:8521`
- namespace: `ax`
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
- concept/entity resolution
- guidance lifecycle and outcome tracking
- richer live dashboard views
- activity-first code tracing
- OTEL/dev-run diagnostics
- Effect service-boundary cleanup

See the `Original inspiration completion` milestone for the active roadmap.

## License

MIT
