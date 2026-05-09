# agentctl

Local taste & telemetry graph for AI coding agents.

`agentctl` ingests every Claude Code and Codex transcript on your machine into a dedicated SurrealDB graph, then surfaces *what skills you actually use*, *what you ignore*, and *which tools correlate with successful outcomes* - on demand, no daemon.

The primitive is the graph. Skills are nodes. Invocations are relations. Edits, corrections, and commits are signals. Cost optimization, deprecation, and taste-based recommendations are queries you write on top.

## Why

Claude Code and Codex both leave detailed transcripts on disk. They contain everything: which skills got invoked, which files got edited, where you pushed back on the agent, what made the cut into a commit. But the data sits in 5,000+ jsonl files no one reads.

`agentctl` flattens that into a graph you can query in 50ms, and a CLI that answers questions like:

- *Which of my 100 installed skills have I actually invoked in the last 30 days?*
- *Which skill did I push back on most often last week?*
- *Find a skill matching "review pull request"*
- *What tools does Codex use most? (`exec_command` × 4269 in a week, turns out.)*

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
agentctl search "<keywords>"        # ranked match on name + description
agentctl stats <skill>              # full drill-down
agentctl recent [--limit=N]         # latest invocations
agentctl unused [--days=N]          # zero-invocation candidates
agentctl taste [--limit=N]          # composite signal score
agentctl ingest [--since=DAYS]      # refresh (skills + transcripts + codex)
```

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
skill   ← invoked   ← turn → edited       → file
                     turn → corrected_by  → turn   (planned v0.1)
                     session → produced   → commit (planned v0.1)
                                             commit → touched → file
```

Sessions tagged `source: "claude" | "codex"`. Codex tools (`exec_command`, `apply_patch`, …) are ingested as synthetic skills `codex:<tool>` so they appear in the same `taste` view as Claude skills.

See `schema/schema.surql` for the full SurrealQL definitions.

## Status

v0 - scaffolding + skills + Claude transcripts + Codex transcripts + CLI. Works.

Planned (v0.1):
- Effect v4 refactor (foundation)
- SurrealDB file buckets for transcript snapshots + codex artifacts
- OpenTUI dashboard (`agentctl tui`)
- Correction signal (next-user-turn negation detection)
- Proposed-but-not-invoked signal (assistant text mentions skill, never calls it)
- Git ingest (commits + file touches)
- Self-improve `lib/deprecate.ts` integration (auto-PR deprecation of zero-use skills)
- Live queries in TUI

## License

MIT.
