# ax

**Local evidence graph for AI coding agents.**

Every session, your AI coding agent starts from zero. It re-reads the same
files, re-discovers the same patterns, re-invokes the same broken tools, and
re-learns the same lessons you taught it last week.

`ax` is the memory layer underneath. It ingests transcripts from Claude Code
and Codex, plus your installed skills and local git history, into a local
SurrealDB graph - then surfaces what's signal vs. noise on demand.

> *Which skills did I actually use this month? Which tool calls keep failing?
> Which files change together? What did I tell the agent that it forgot?*
> `ax` answers these by reading what already happened.

<!-- TODO: add docs/images/dashboard.png hero after capture -->

## Why

LLM agents are good at tasks. They're bad at remembering what happened.
Memory tooling today is either a giant rolling context window (expensive,
slow, lossy) or vague vector retrieval (no structure, no grounding in real
events).

`ax` takes a different shape: a **typed graph of evidence** built from the
agent's own logs. Sessions, turns, tool calls, plans, skills, commits, files,
friction, and derived signals - all queryable in SurrealDB, all local, no
network round-trip, no third party.

Three things fall out of that:

1. **Skill triage** - see which of your installed skills get used, which
   never fire, which correlate with stuck sessions. Decide what to keep.
2. **Pre-flight grounding** - `axctl project context` gives the next agent
   stack info, recent friction, and verification commands before it touches
   the repo.
3. **Retro signal** - query the graph after a hard session to see what
   actually happened: tool retries, plan churn, file edit pairings.

## Install

Public install (post-publication):

```bash
curl -fsSL https://raw.githubusercontent.com/Necmttn/ax/main/install.sh | bash
PATH="$HOME/.local/bin:$PATH" axctl ingest --since=7
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

Requires Bun ≥ 1.3 and SurrealDB ≥ 3.0. macOS-first; Linux works for ingest
+ CLI (no launchd reactivity).

## Quickstart

```bash
axctl ingest --since=7     # backfill last 7 days of transcripts + skills + git
axctl serve                # open the live dashboard at http://127.0.0.1:8520
axctl skills taste         # CLI view: which skills earned their keep
axctl recall "auth bug"    # full-text recall across past sessions
```

## What gets stored

Core tables:

```text
session, turn, tool_call, plan, plan_snapshot
skill, tool, repository, checkout, commit, file
insight, friction_event, diagnostic_event, recommendation
```

Core relations:

```text
repository -> has_checkout -> checkout
session    -> produced     -> commit
commit     -> touched      -> file
turn       -> edited       -> file
turn       -> invoked      -> skill
tool_call  -> concerns     -> skill
insight    -> concerns     -> session
```

Files are canonicalized by repository-relative path, so worktrees and
machine-specific checkout paths don't fragment the same file history.

## Agent integration

`ax` ships two installable skills so a Claude Code / Codex agent can query
its own evidence graph mid-session:

```bash
npx skills add git@github.com:Necmttn/ax.git --skill axctl   -g -a claude-code -a codex -y
npx skills add git@github.com:Necmttn/ax.git --skill ax-retro -g -a claude-code -a codex -y
```

The recommended agent loop:

1. `axctl project context --json` before work - stack, recent friction,
   verification commands.
2. Do the work.
3. `axctl project verify --json` before reporting done - runs the checks
   the project actually expects.

## Reactivity

`axctl install` sets up local automation on macOS:

- SurrealDB daemon on `127.0.0.1:8521`
- launchd watcher on `~/.claude/projects/` and `~/.codex/sessions/`
- background `axctl ingest --since=1` after recent transcript changes
- onboarding for git-tracking your global Claude/Codex/skill dirs

Logs land in `~/.local/share/ax/logs/`.

## CLI reference

The full surface is documented in [`docs/insights-cli-reference.md`](docs/insights-cli-reference.md).
The shape:

```text
axctl ingest [--since=N] [--reset] [--insights-only] [--skills-only|--transcripts-only|--codex-only|--git-only|--claude-only]
axctl serve [--port=N]              # live dashboard
axctl report [--limit=N]            # one-shot static HTML
axctl recall <query> [--json]       # full-text search across turns
axctl skills <search|stats|recent|unused|taste|pairs|recovery>
axctl insights <view>               # 16 read-only graph views
axctl project <context|verify|harness> [--json]
axctl evidence <guidance-next|session-summary|weekly> [--json]
axctl daemon <status|start|stop|restart>
axctl doctor [--json]
axctl install | uninstall | update | version
```

`axctl serve` exposes the live dashboard and `/graph`, a typed graph
explorer. Today the implemented mode is **File attention** - files connected
to sessions through edited-file evidence. Planned modes: Ask→Outcome,
Phase balance, Delivery, Patterns, Skill pairs.

## SurrealDB

Local connection defaults:

- endpoint: `ws://127.0.0.1:8521`
- namespace: `ax`, database: `main`
- credentials: `root` / `root` (loopback only)

Inspect the graph directly with [Surrealist](https://surrealdb.com/surrealist):

```sql
SELECT name, command_norm, exit_code, count() AS failures
FROM tool_call
WHERE has_error = true
GROUP BY name, command_norm, exit_code
ORDER BY failures DESC
LIMIT 20;
```

## Status

Working today:

- Claude + Codex transcript ingest
- Skill and slash-command ingest
- Git repository / checkout / commit / touched-file ingest
- Derived friction, diagnostics, skill-pair, recovery, recommendation signals
- Project context + verification JSON commands
- Live dashboard server + static HTML report
- Self-improve guidance queries
- Local launchd reactivity (macOS)

Tracked next:

- Project memory: `changeset` and `file_memory`
- Concept/entity resolution
- Guidance lifecycle and outcome tracking
- Richer live dashboard views
- Activity-first code tracing
- OTEL / dev-run diagnostics
- Effect service-boundary cleanup

## Dev

```bash
bun install
bun scripts/db-start.sh
bun scripts/apply-schema.sh
bun src/cli/index.ts ingest --since=7

bun test                 # full suite
bun run typecheck
```

Benchmark a clean DB without touching `ax/main`:

```bash
scripts/bench-empty-db.sh --since=90
```

Artifacts land under `~/.local/share/ax/benchmarks/<db>/`.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the contribution flow,
[`CONTEXT.md`](CONTEXT.md) for the domain glossary, and
[`docs/adr/`](docs/adr/) for architecture decisions.

## License

[MIT](LICENSE) © 2025 Necmettin Karakaya
