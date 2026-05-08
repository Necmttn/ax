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

```bash
git clone https://github.com/Necmttn/agentctl ~/Projects/agentctl
cd ~/Projects/agentctl
bun install
bun scripts/db-start.sh        # starts SurrealDB on :8521
bun scripts/apply-schema.sh    # applies graph schema
bin/agentctl ingest            # ingests skills + transcripts + codex
ln -s "$PWD/bin/agentctl" ~/.local/bin/agentctl   # optional: put on PATH
```

Requirements: bun ≥ 1.3, SurrealDB ≥ 3.0.

## Use

```bash
agentctl search "<keywords>"        # ranked match on name + description
agentctl stats <skill>              # full drill-down
agentctl recent [--limit=N]         # latest invocations
agentctl unused [--days=N]          # zero-invocation candidates
agentctl taste [--limit=N]          # composite signal score
agentctl ingest [--since=DAYS]      # refresh (skills + transcripts + codex)
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
