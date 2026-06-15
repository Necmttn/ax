# Fix #1a - Self-Telemetry + Personal Utilization View

**Date:** 2026-06-15
**Branch:** `feat/usage-telemetry`
**Parent diagnosis:** `docs/superpowers/specs/2026-06-15-team-adoption-diagnosis.md`

## Problem

ax cannot see its own adoption (diagnosis Finding 1). It measures *agent transcripts* but never *whether ax itself is run* - the only way to see usage was mining Bash `tool_call` rows, which misses direct-terminal (human) invocations entirely. A team buyer's first question - "are my devs using it?" - has no answer surface.

This is **Fix #1**, scoped to its foundational half: **self-telemetry capture + a personal utilization view**. The team aggregate (the buyer's multi-user surface) is a follow-up spec that publishes from the `ax_invocation` table this one creates.

## Goal

ax records its own CLI invocations (redacted) into the graph, and surfaces "what you actually run" - commands/day, active-days, top commands, agent-vs-human split, and the never-used surface - in `ax serve` plus a thin `ax usage --json`.

## Constraint

Every `ax` command must stay fast and DB-free at the call site (`ax --help`, `ax quota`, `ax serve`). So **capture** (every invocation, cheap, local file append) is split from **graph** (batch parse into the DB on the next ingest) - the same compute/surface seam as the push-value digest.

## Architecture

```
apps/axctl/src/usage/
  model.ts        - UsageRecord (Effect Schema) + JSONL line parse/encode
  record.ts       - redact + append one JSONL line to ~/.ax/usage-log.jsonl (fail-silent)
  usage-stage.ts  - derive-tagged ingest stage: parse log → ax_invocation rows, truncate consumed log
  query.ts        - utilization rollups (pure over decoded rows + CLI registry)
apps/axctl/src/cli/commands/usage.ts          - thin `ax usage [--json] [--days=N]`
apps/axctl/src/dashboard/router/routes/...     - read-only "Utilization" route serving query.ts
apps/studio/...                                - Utilization SPA view
packages/schema/src/schema.surql               - ax_invocation table DDL (+ SCHEMA_TABLES)
```

**Capture (cheap, no DB):** the CLI entrypoint (`apps/axctl/src/cli/index.ts`, around `BunRuntime.runMain`) stamps start, and on fiber completion appends one redacted line - subcommand, flag *names*, exit code, duration_ms, repo_key, origin, ax_version, ts. Pure file append, fail-silent: a recorder error never breaks or slows the command.

**Graph (batch):** a `derive`-tagged ingest stage parses `~/.ax/usage-log.jsonl` into `ax_invocation` on the next ingest (the watcher runs after every session), then truncates the consumed lines. Failure-isolated via `Effect.catchCause` so a parse error never aborts the surrounding ingest (lesson from the digest stage).

**Surface:** `query.ts` rollups feed both the `ax serve` Utilization route and `ax usage --json`. No heavy new CLI surface - respects the Fix #3 anti-sprawl goal; `ax usage` is also the exact payload the future team-publish gists.

## Data model & redaction

`UsageRecord` (Effect Schema; one JSONL line per invocation):
```
ts          Date              invocation start
command     string            resolved subcommand path: "sessions churn" | "digest" | "ingest"
flags       string[]          flag NAMES only, sorted: ["--here","--json"]  (never values)
exit_code   number            0 = ok
duration_ms number
origin      "tty" | "agent"   process.stderr.isTTY ? "tty" : "agent"
repo_key    string | null     basename(git toplevel), lowercased; null outside a repo
ax_version  string
```

**Redaction (at `record.ts`, before anything hits disk):**
- Drop ALL positional args (`sessions show <id>`, `recall "<query>"` → `command` + `flags` only).
- Drop flag *values* (`--days=30` → `"--days"`, `--project=/Users/...` → `"--project"`).
- `repo_key` = `basename` only - never the absolute path; null when not in a git repo.
- No env, no cwd beyond repo_key, no usernames, no positional values.

A row says *"someone ran `sessions churn --here` from repo `ax`, 1.2s, exit 0, from an agent"* - enough for utilization, nothing sensitive. This redacted shape IS what the future team-publish aggregates, so the privacy boundary is set once, here.

`ax_invocation` table (SCHEMAFULL): top-level fields explicit; `flags` JSON-encoded as `string` (v3 rule); `ts` as JS `Date`. Record id = stable hash of (ts, command, repo_key, origin) so re-parsing a not-yet-truncated log is idempotent. Registered in `SCHEMA_TABLES`.

## Utilization rollups (`query.ts`, pure, default 30d window)

- **`activity`** - invocations/day series + active-days count (days with ≥1 run) + current streak.
- **`topCommands`** - count + last-used per command, descending.
- **`unusedSurface`** - every visible subcommand (from the CLI registry, same source the cli-reference freshness gate reads) minus ever-invoked commands → commands never run. Finding 2 made measurable.
- **`originSplit`** - agent vs tty counts + per-command %.
- **`reliability`** - exit-code≠0 rate per command (only flagged above a threshold).

Each is a pure function over decoded rows (+ the registry for `unusedSurface`), unit-testable with fixture rows, no DB.

## Surfaces

**`ax serve` "Utilization" route** (read-only; serves `query.ts` JSON, SPA renders):
- Hero: active-days/window + invocations/day sparkline + streak.
- Top-commands list with last-used + inline origin split.
- "Never used" chips (unused surface) as a discovery nudge.
- Reliability flags only when a command's failure rate is non-trivial.

> **Visual scope note:** the v0 studio view is **functional-but-minimal** - correct data, restrained layout, NOT a finished visual. The data path + backend `/api/usage` route is the substance; the visual treatment is deliberately left for a taste pass after review (avoids over-investing in a design that may be redirected, per the radar/wrapped house style). The backend route + `ax usage --json` fully expose the data regardless of the view's polish.

**`ax usage [--json] [--days=N]`** - thin command: `--json` prints the rollup bundle (the future team-publish payload); plain TTY prints a compact summary. Registered with a card in BOTH cli-reference gates (`scripts/check-cli-reference.ts` docs + `apps/site/app/routes/docs/-cli-reference.data.ts`), and in README/docs/cli.md + llms.txt.

## Error handling

- **Recorder** (`record.ts`): wrapped so ANY fault (fs error, no HOME, git not installed) is swallowed - the invocation proceeds and exits normally. Never adds latency on the hot path beyond a single append; if the append would block, skip it.
- **Stage** (`usage-stage.ts`): `Effect.catchCause` → logs a warning, returns a zero-row stat; a corrupt log line is skipped (parse-or-skip per line), not fatal. Truncation only removes lines successfully parsed + written.
- **Log growth:** the stage truncates consumed lines each ingest; between ingests the log is bounded by invocation volume. A safety cap (e.g. skip-append above N MB) prevents unbounded growth if ingest never runs.
- **Query/view:** empty table → empty-state ("no usage recorded yet - run some ax commands"), never an error.

## Testing (bun:test, layer-testable)

- `model.test.ts` - UsageRecord encode/decode round-trip; JSONL parse skips malformed lines.
- `record.test.ts` - redaction: positional args dropped, flag values stripped to names, repo_key is basename-only, origin from injected isTTY; append is fail-silent on a stubbed failing fs.
- `usage-stage.test.ts` - parse fixture log → rows; idempotent re-parse (stable id); truncation; failure-isolation (failing DB layer → Success with 0 rows).
- `query.test.ts` - each rollup against fixture rows: active-days, streak, top-commands ordering, unusedSurface against a fixture registry, origin split, reliability threshold.
- `usage.test.ts` - `ax usage` renderer (pure) + `--json` shape.
- Stage registered: `resolveIngestStages` default count +1, `usage`-stage in the derive set (update `effect-cli.test.ts`).
- Both cli-reference gates updated for `ax usage`.

## Out of scope (next spec)

- **Team aggregation + buyer dashboard** - multi-user rollup. Publishes from `ax_invocation` via the community-rails pattern (gist → nightly compile → board). This spec deliberately ends at the single-user table + view that the team layer will consume.
- Wiring utilization into the digest/front-door (Fix #2/#3 follow-up).

## Status

- [ ] schema: ax_invocation + SCHEMA_TABLES
- [ ] model.ts + JSONL parse
- [ ] record.ts (redact + append, fail-silent) + entrypoint wiring
- [ ] usage-stage.ts (parse → rows, truncate, isolated) + registry
- [ ] query.ts rollups
- [ ] ax usage CLI (+ both cli-reference gates, docs)
- [ ] dashboard Utilization route + studio view
