# Development

Everything you need to hack on `ax` locally - setup, schema, queries, tests,
benchmarks.

For the contribution flow (PR conventions, commit style, ground rules) see
[`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Setup

```bash
git clone https://github.com/Necmttn/ax ~/Projects/ax
cd ~/Projects/ax
bun install
bun scripts/db-start.sh          # SurrealDB on 127.0.0.1:8521
bun scripts/apply-schema.sh
bun src/cli/index.ts ingest --since=7
```

Requirements: Bun ≥ 1.3, SurrealDB ≥ 3.0.

## Verify

```bash
bun test                 # full suite
bun run typecheck
```

CI runs both - failing either blocks merge.

## Run from source

While developing, skip the compiled binary and run the TypeScript directly:

```bash
bun src/cli/index.ts serve --port=1738
bun src/cli/index.ts insights friction --limit=10
bun src/cli/index.ts recall "auth middleware"
```

## `ax-dev` - disposable dev build alongside stable `ax`

Install a global `ax-dev` that runs **this source checkout** against an
**isolated, disposable DB**, so you can test latest changes without touching
your real graph. The stable `ax` (released binary, prod DB on `:8521`) is left
untouched.

```bash
bash scripts/install-dev.sh        # writes ~/.local/bin/ax-dev (a source shim)
ax-dev db                          # start a disposable SurrealDB on :8522 (data: ~/.local/share/ax-dev)
ax-dev ingest --since=1            # ingest into the dev DB
ax-dev serve                       # dev dashboard (full live ingest works - runs from source)
ax-dev -v                          # shows git provenance: which sha/branch you're on
ax-dev db --reset                  # wipe + restart the dev DB
ax-dev db stop                     # stop it
rm -rf ~/.local/share/ax-dev       # nuke the dev stack entirely
```

How the isolation works:

- The shim exports `AX_DATA_DIR=~/.local/share/ax-dev` and
  `AX_DB_URL=ws://127.0.0.1:8522`, then `exec bun <checkout>/apps/axctl/src/cli/index.ts`.
  No rebuild - it always runs your current working tree.
- `ax-dev db` runs SurrealDB **on demand** (no launchd agent, so no label
  collision with the stable daemon) and applies the schema with bucket paths
  rewritten to the dev data dir.
- Re-run `scripts/install-dev.sh` from a different checkout to re-point `ax-dev`
  at it (the checkout path is baked into the shim).

Notes:

- Use `ax-dev db status` (not `ax-dev doctor`) for the dev DB - `doctor` reports
  the stable launchd daemon, which the dev stack intentionally doesn't run.
- Tune the location/port with `AX_DEV_DATA_DIR` / `AX_DEV_DB_URL` before running
  `install-dev.sh`, or override `AX_DATA_DIR` / `AX_DB_URL` per invocation.

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
tool_call  -> read_file    -> file
tool_call  -> searched_file -> file
tool_call  -> concerns     -> skill
insight    -> concerns     -> session
```

Files are canonicalized by repository-relative path, so worktrees and
machine-specific checkout paths don't fragment the same file history.

Domain language (Repository vs. Checkout vs. Worktree vs. Workspace) is
defined in [`CONTEXT.md`](../CONTEXT.md). Architectural decisions live in
[`docs/adr/`](adr/).

## Inspecting the graph

Local connection defaults:

- endpoint: `ws://127.0.0.1:8521`
- namespace: `ax`, database: `main`
- credentials: `root` / `root` (loopback only)

Open with [Surrealist](https://surrealdb.com/surrealist) or hit it from the
CLI. Some queries to try:

```sql
-- which commands fail most often
SELECT name, command_norm, exit_code, count() AS failures
FROM tool_call
WHERE has_error = true
GROUP BY name, command_norm, exit_code
ORDER BY failures DESC
LIMIT 20;

-- recent friction events with context
SELECT kind, text, session.project AS project, ts
FROM friction_event
ORDER BY ts DESC
LIMIT 20;

-- repositories with the most checkouts (worktrees)
SELECT name, remote_url, array::len(->has_checkout->checkout) AS checkouts
FROM repository
ORDER BY updated_at DESC
LIMIT 20;
```

## Benchmarking

Run ingest against a clean throwaway database without touching `ax/main`:

```bash
scripts/bench-empty-db.sh --since=90
```

Artifacts land under `~/.local/share/ax/benchmarks/<db>/`.

## CLI reference

Full surface in [`docs/insights-cli-reference.md`](insights-cli-reference.md).

## Reactivity (macOS)

`axctl install` sets up:

- SurrealDB daemon on `127.0.0.1:8521`
- launchd watcher on `~/.claude/projects/` and `~/.codex/sessions/`
- background `axctl ingest --since=1` after recent transcript changes
- onboarding for git-tracking your global Claude/Codex/skill dirs

Logs land in `~/.local/share/ax/logs/`. Manual control:

```bash
axctl daemon status --json
axctl daemon start | stop | restart
axctl doctor --json
```

## Effect

`ax` uses Effect v4-beta for ingest pipelines and the service layer.
Patterns are non-obvious if you haven't seen Effect before - always check
[`CLAUDE.md`](../CLAUDE.md) for the best-practices entry point before
introducing new Effect code. The Effect source is shallow-cloned to
`.references/effect-smol/` (run `bun refs:setup`) for fast lookup.

## Roadmap

Working today: Claude + Codex transcript ingest, skill / slash-command
ingest, git repository / checkout / commit / file ingest, derived signals
(friction, diagnostics, skill pairs, recovery, recommendations), project
context + verify commands, live dashboard + static HTML report,
self-improve guidance queries, launchd reactivity (macOS).

Tracked next: project memory (`changeset`, `file_memory`), concept/entity
resolution, guidance lifecycle + outcome tracking, richer live dashboard
views, activity-first code tracing, OTEL/dev-run diagnostics, Effect
service-boundary cleanup.

Active milestones live in GitHub Issues; see the `Original inspiration
completion` milestone for the current focus.
