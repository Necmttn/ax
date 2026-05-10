# agentctl

Local evidence graph for AI coding agents.

`agentctl` ingests Claude Code transcripts, Codex transcripts, installed agent skills, CLI/tool calls, plans, Git repositories, commits, checkouts, touched files, and Claude `/insights` exports into a dedicated SurrealDB graph. The goal is simple: preserve the operational memory that normally disappears when an agent finishes a session.

The primitive is the graph. Sessions, turns, tools, plans, repositories, checkouts, commits, files, insights, and friction events are first-class records. Relations keep the shape traversable: sessions use tools, commits touch files, repositories have checkouts, and agent work can be tied back to the files and commands that made it happen.

## Why

Claude Code and Codex already write detailed local transcripts. They contain the reasoning, plans, failed commands, tool outputs, file edits, user corrections, and commit context that explain how work actually happened. Without a graph, that evidence is buried in thousands of jsonl files and cannot guide the next agent.

`agentctl` turns that raw history into reusable signals:

- **Better agent memory**: recover why a file was edited, what plan led there, which commands failed, and what eventually worked.
- **Better repo understanding**: track repositories, checkouts, commits, and canonical file identities so worktrees and machine-specific paths do not split the same file history.
- **Better process metrics**: measure friction from lint/test failures, tool mistakes, root-checkout edits, missing Git context, or repeated failed attempts.
- **Better skill hygiene**: see which skills and slash commands are used, ignored, paired together, or correlated with corrections.
- **Better product surface**: expose the same data through CLI JSON queries, direct SurrealQL in Surrealist, and a static dashboard that is useful immediately after ingest.

## Install

### Release artifact (recommended)

Release artifacts are built by GitHub Actions and installed by `install.sh`.
For the current private repo, this single command uses `gh` auth to fetch the
installer and release artifact:

```bash
GH_TOKEN="$(gh auth token)" bash -c 'curl -fsSL -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github.raw" https://api.github.com/repos/Necmttn/agentctl/contents/install.sh | bash && PATH="$HOME/.local/bin:$PATH" agentctl ingest --since=7'
```

If the repo is public later, this also works:

```bash
curl -fsSL https://raw.githubusercontent.com/Necmttn/agentctl/main/install.sh | bash && PATH="$HOME/.local/bin:$PATH" agentctl ingest --since=7
```

`install.sh` downloads `agentctl-<os>-<arch>.tar.gz` from the latest GitHub
Release, verifies `checksums.txt` when present, installs the binary to
`~/.local/share/agentctl/bin/agentctl`, symlinks `~/.local/bin/agentctl`, then
runs `agentctl install` on macOS.

### Build from source

```bash
git clone https://github.com/Necmttn/agentctl ~/Projects/agentctl
cd ~/Projects/agentctl
bun install
bun run build               # compiles to dist/agentctl (~70MB, includes runtime)
./dist/agentctl install     # symlinks binary, installs daemon + watcher LaunchAgents, applies schema
agentctl ingest             # initial fill
```

`agentctl install` is idempotent: it stops any old plists, writes fresh ones into `~/Library/LaunchAgents/`, loads them via `launchctl`, waits for the daemon to bind on `127.0.0.1:8521`, and applies the embedded schema. `agentctl uninstall` reverses everything except your data dir.

After install, two LaunchAgents run on boot:
- `com.necmttn.agentctl-db` - SurrealDB daemon with `--allow-experimental=files` and bucket allowlist
- `com.necmttn.agentctl-watch` - fires `agentctl ingest --since=1` on changes to `~/.claude/projects` or `~/.codex/sessions` (60s throttle)

### Manual releases

GitHub Actions has a `Release Please` workflow with `workflow_dispatch`.
Run it manually from the Actions tab to open or update the release PR. Merge
that PR, and the next `main` push creates the GitHub Release, builds native
artifacts, and uploads checksums.

To rebuild assets for an existing release, run the workflow manually with
`tag_name` set to the release tag, for example `v0.1.0`.

Published assets:

- `agentctl-darwin-arm64.tar.gz`
- `agentctl-linux-x64.tar.gz`
- `checksums.txt`

### Agent skill

This repo ships an installable agent skill at `skill/SKILL.md` so Claude Code,
Codex, and other skill-aware agents know when to call `agentctl`.

Install through Vercel's `skills` CLI from the current private GitHub repo:

```bash
npx skills add git@github.com:Necmttn/agentctl.git --skill agentctl -g -a claude-code -a codex -y
```

Before installing, you can inspect what the repo exposes:

```bash
npx skills add git@github.com:Necmttn/agentctl.git --list
```

If the repo is made public later, the shorter form also works:
`npx skills add Necmttn/agentctl --skill agentctl -g -a claude-code -a codex -y`.

For local development against this checkout:

```bash
# from the agentctl repo
mkdir -p ~/.claude/skills ~/.agents/skills
ln -sfn "$PWD/skill" ~/.claude/skills/agentctl
ln -sfn "$PWD/skill" ~/.agents/skills/agentctl
```

Agent checklist after install:

1. Confirm `agentctl` exists with `command -v agentctl`.
2. If missing, install the CLI with `./install.sh` from this repo checkout.
3. Run `agentctl ingest --since=7` to refresh skill and transcript data.
4. At the start of repo work, run `agentctl project context --json`.
5. Before reporting completion, run `agentctl project verify --json` and follow the returned checks.

### Dev mode (run from source)

```bash
git clone https://github.com/Necmttn/agentctl ~/Projects/agentctl
cd ~/Projects/agentctl
bun install
bun scripts/db-start.sh
bun scripts/apply-schema.sh
bun src/cli/index.ts ingest
```

Requirements: bun ≥ 1.3, SurrealDB ≥ 3.0 CLI on PATH (`brew install surrealdb/tap/surreal`).

## Use

```bash
agentctl ingest [--since=DAYS]      # skills + Claude + Codex + Git + derived signals
agentctl ingest-insights            # import Claude ~/.claude/usage-data insights
agentctl insights schema            # table counts with active/staged status
agentctl insights repositories      # repo + checkout coverage as JSON
agentctl insights checkouts         # worktree/checkout activity counts
agentctl insights git               # sessions linked to git commits/touched files
agentctl insights friction          # recent friction events as JSON
agentctl insights tools             # failing tool/command clusters as JSON
agentctl insights sessions          # sessions with tool/plan/friction density
agentctl dashboard [--limit=N] [--out=PATH] # write a self-contained HTML dashboard
agentctl search "<keywords>"        # ranked match on skill name + description
agentctl stats <skill>              # skill drill-down
agentctl recent [--limit=N]         # latest invocations
agentctl unused [--days=N]          # zero-invocation candidates
agentctl taste [--limit=N]          # composite signal score
```

Typical local refresh:

```bash
agentctl ingest --since=7
agentctl ingest-insights
agentctl dashboard
```

`agentctl dashboard` writes `~/.local/share/agentctl/dashboard.html` by default and prints a `file://` URL. It is intentionally static, so it can be opened, archived, or attached to a review without running a web server.

### Empty DB Benchmark

Benchmark a clean database without touching `agentctl/main`:

```bash
scripts/bench-empty-db.sh --since=90
```

The script creates a unique database such as `agentctl/bench_20260510_090000`,
applies the schema, runs ingest, imports Claude insights, writes schema/git
JSON reports, and generates a dashboard under
`~/.local/share/agentctl/benchmarks/<db>/`.

Use `--db=NAME` when you want a stable benchmark database. The script does not
drop or clear databases, so the default unique name is the safest empty run.

### Repository Discovery

You do not need to initialize every project separately. Git ingest derives
repository roots from `session.cwd` in Claude and Codex transcripts, then
links matching sessions to `repository` and `checkout` records. If a repo has
never appeared in a transcript, add its absolute path to
`~/.local/share/agentctl/agentctl-repos.txt` or point `AGENTCTL_REPO_LIST` at a
file with one repo path per line.

Session-to-commit correlation uses the linked checkout plus commit timestamps:
if a commit lands inside a session's `[started_at, ended_at]` window, ingest
writes `session -> produced -> commit`; commits then traverse to files through
`commit -> touched -> file`.

Use `agentctl insights checkouts` to see the worktree-level shape: sessions,
turns, tool calls, tool failures, produced commits, and touched files per
checkout. This is the view that answers questions like "which feature worktree
absorbed most of the agent work?"

### Project Grounding

```bash
agentctl project context --json   # repo stack, instructions, git state, checks
agentctl project verify --json    # diff-aware verification + live diagnostics
```

These commands are read-only and designed for Claude Code, Codex, and
self-improve jobs that need grounded repo context before acting.

Optional diagnostics config in `.agentctl/config.json`:

```json
{ "diagnostics": { "healthUrl": "http://localhost:4319/internal/health", "timeoutMs": 1000 } }
```

`--since=N` limits ingest to files modified in the last N days - useful for the Stop-hook fast path.

### Surrealist

The local database is a normal SurrealDB instance:

- endpoint: `ws://127.0.0.1:8521`
- namespace: `agentctl`
- database: `main`
- user/password: `root` / `root` by default

Open those settings in Surrealist to inspect the graph directly. The schema is `SCHEMAFULL`; JSON-ish nested payloads such as labels, metrics, raw tool output excerpts, and imported insight payloads are stored as strings so the same records work consistently on SurrealDB v3.

Some tables are deliberately staged. `workspace`, `changeset`, `file_memory`, `artifact`, `feedback_event`, `guidance`, and their artifact/memory relations are present so migrations and query design can settle before the next writer lands. Use `agentctl insights schema` or the dashboard's Schema Coverage section to see which tables are active, conditional, or staged in the current prototype.

Example queries:

```sql
SELECT name, remote_url, root_path, array::len(->has_checkout->checkout) AS checkouts
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

## Reactivity

Three layers, no daemon:

1. **Stop hook** (`~/.claude/settings.json`) fires `agentctl ingest --since=1` after every Claude Code session ends.
2. **launchd WatchPaths** (macOS) - fallback for non-Claude tools writing into `~/.claude/projects/` or `~/.codex/sessions/`.
3. **Weekly cron** via your existing self-improve runs full ingest as deep-scan backfill.

Stop hook is enough for ~99% of cases. The other two are insurance.

### launchd watcher (macOS)

Belt-and-suspenders fallback to the Stop hook. A `LaunchAgent` watches
`~/.claude/projects/` and `~/.codex/sessions/`; whenever those paths change
it runs `agentctl ingest --since=1`. `ThrottleInterval=60` coalesces bursts
so a flurry of writes triggers a single ingest at most once per minute.

```bash
bun run watcher:install      # renders + loads ~/Library/LaunchAgents/com.necmttn.agentctl-watch.plist
bun run watcher:uninstall    # unloads + removes it
```

What `watcher:install` does:

- renders `scripts/com.necmttn.agentctl-watch.plist` (a template) into
  `~/Library/LaunchAgents/com.necmttn.agentctl-watch.plist`, substituting
  absolute paths for `$HOME`, the repo, and the log dir
- `launchctl unload`s any previous version (idempotent)
- `launchctl load -w`s the fresh plist

Logs land in `~/.local/share/agentctl/logs/`:

- `watcher.log` - stdout/stderr of each `bun ... ingest --since=1` invocation
- `watcher.out` / `watcher.err` - launchd's own pipes

Verify it's loaded:

```bash
launchctl list | grep com.necmttn.agentctl-watch
```

## Schema

```
repository -> has_checkout -> checkout
session    -> produced      -> commit
commit     -> touched       -> file
turn       -> edited        -> file
turn       -> invoked       -> skill
turn       -> corrected_by  -> turn
tool_call  -> concerns      -> skill
insight    -> concerns      -> session
```

Records also hold direct references where a relation would be too noisy: `session.repository`, `session.checkout`, `tool_call.turn`, `tool_call.tool`, `plan_snapshot.plan`, and `plan_item.plan`.

Files are canonicalized relative to the repository root when possible, so the same file can be tracked across worktrees and machine-specific checkout paths. Edge tables hold useful values, not just links; for example `touched` records file paths, status, additions/deletions, and commit context.

Sessions are tagged `source: "claude" | "codex"`. Codex tools (`exec_command`, `apply_patch`, …) are ingested as synthetic skills `codex:<tool>` so they appear in the same `taste` view as Claude skills.

See `schema/schema.surql` for the full SurrealQL definitions.

## Status

Prototype works end to end for local ingest, query adapters, Claude insights import, derived evidence signals, and the static dashboard.

Current focus:

- richer semantic/BM25 search over commit messages, plans, tool failures, and touched files
- language-aware file structure tracing inspired by Composto-style dependency graphs
- just-in-time guidance hooks from repeated friction patterns
- OpenTUI/live dashboard after the static report stabilizes
- paid/team surfaces later, once the local evidence model is useful enough to justify sync and sharing

## License

MIT.
