# Development

Everything you need to hack on `ax` locally - setup, schema, queries, tests,
benchmarks.

For the contribution flow (PR conventions, commit style, ground rules) see
[`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Setup

`ax` embeds DuckDB (the graph, published as a read-only snapshot) and a SQLite
sidecar (judgment/proposal state, schema applied automatically on open) - no
daemon to start.

```bash
git clone https://github.com/Necmttn/ax ~/Projects/ax
cd ~/Projects/ax
bun install
bash scripts/build-duckdb.sh              # builds libduckdb (fts linked statically) into dist/duckdb/
export AX_DUCKDB_DYLIB="$PWD/dist/duckdb/libduckdb.dylib"   # libduckdb.so on Linux
bun apps/axctl/src/cli/index.ts ingest --since=7
```

`AX_DUCKDB_DYLIB` must point at a real file - there is no upstream-release
fallback for FTS (the shipped build links the `fts` extension statically;
upstream `libduckdb` release artifacts cannot `LOAD fts`). Export it once in
your shell profile.

Requirements: Bun ≥ 1.3.

## Verify

```bash
bun test                 # full suite
bun run typecheck
```

CI runs both - failing either blocks merge.

## Run from source

While developing, skip the compiled binary and run the TypeScript directly:

```bash
bun apps/axctl/src/cli/index.ts serve --port=1738
bun apps/axctl/src/cli/index.ts insights friction --limit=10
bun apps/axctl/src/cli/index.ts recall "auth middleware"
```

## `ax-dev` - dev build alongside stable `ax`

Install a global `ax-dev` that runs **this source checkout** against an
**isolated data dir**, so you can test latest changes without touching your
real graph. The stable `ax` (released binary) is left untouched.

```bash
bash scripts/install-dev.sh        # writes ~/.local/bin/ax-dev (a source shim)
ax-dev ingest --since=1            # ingest into the dev data dir
ax-dev serve                       # dev dashboard (full live ingest works - runs from source)
ax-dev -v                          # shows git provenance: which sha/branch you're on
rm -rf ~/.local/share/ax-dev       # nuke the dev stack entirely
```

How the isolation works:

- The shim exports `AX_DATA_DIR=~/.local/share/ax-dev`, then
  `exec bun <checkout>/apps/axctl/src/cli/index.ts`. No rebuild - it always
  runs your current working tree.
- Re-run `scripts/install-dev.sh` from a different checkout to re-point `ax-dev`
  at it (the checkout path is baked into the shim).

Notes:

- Tune the location with `AX_DEV_DATA_DIR` before running `install-dev.sh`, or
  override `AX_DATA_DIR` per invocation.
- `AX_DUCKDB_DYLIB` (see Setup) applies to `ax-dev` the same as `ax` - it isn't
  part of the per-checkout data isolation.

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

The graph is a plain DuckDB file, published as a read-only snapshot at
`AX_DUCKDB_SNAPSHOT` (default `~/.ax/cache/ax-snapshot.duckdb`). Open it
directly with the `duckdb` CLI shell built by `scripts/build-duckdb.sh`
(`dist/duckdb/duckdb`), read-only so you never race a live ingest:

```bash
dist/duckdb/duckdb -readonly ~/.ax/cache/ax-snapshot.duckdb
```

Some queries to try:

```sql
-- which commands fail most often
SELECT name, command_norm, exit_code, count(*) AS failures
FROM tool_call
WHERE has_error = true
GROUP BY name, command_norm, exit_code
ORDER BY failures DESC
LIMIT 20;

-- recent friction events with context
SELECT f.kind, f.text, s.project, f.ts
FROM friction_event f
JOIN session s ON s.id = f.session
ORDER BY f.ts DESC
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

- launchd watcher on `~/.claude/projects/` and `~/.codex/sessions/`
- background `axctl ingest --since=1` after recent transcript changes
- onboarding for git-tracking your global Claude/Codex/skill dirs

No daemon holds the graph open - each `axctl ingest` writes the live DuckDB
database and publishes a fresh read-only snapshot for query commands to read.

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
