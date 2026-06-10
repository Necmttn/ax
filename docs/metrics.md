# Session metrics (graph-derived)

Per-session metrics derived from the ax graph and surfaced via
`ax sessions metrics`. Design: `docs/superpowers/specs/2026-06-09-session-metrics-design.md`.
Decision record: `docs/adr/0011-session-metrics-thin-slice-over-signal-framework.md`.

## What ships in wave 1

| metric | column on `session_metrics` | meaning |
|---|---|---|
| durability_ratio | `durability_ratio` (`option<float>`) | share of the session's produced commits NOT later reverted; **NONE** when the session produced no commits (distinct from 0) |
| produced / reverted | `produced_commits`, `reverted_commits` | commit counts behind durability |
| time_to_land_ms | `time_to_land_ms` (`option<int>`) | fastest commit→merge latency: min over produced commits of `pull_request.merged_at − commit.ts` where `merge_sha` matches; NONE when nothing landed. (Anchored on commit ts, not `ended_at` - long sessions merge PRs while still open, which made the old anchor negative.) |
| lines_added / lines_removed | `lines_added`, `lines_removed` | whole-line counts over the session's edit-class tool calls: Claude Edit/Write (reuses `ax loc`'s `editDelta`) + codex/pi `apply_patch` (tool name or `exec_command` `command_norm`; counts +/- patch lines) |

Surfaced by `ax sessions metrics [--here|--project P|--since N|--limit N|--json]`
(sorted by lowest durability). `--here` scopes to the pwd repo; from inside a
`.claude/worktrees/*` worktree it resolves the worktree path, so use `--project`
with the canonical repo path/slug there.

## The freshness backbone (`commit.reverted`)

The hard part. `commit.reverted` (`option<bool>` on the `commit` table) is the
Layer-0 primitive durability reads. It is recomputed **over full history** every
ingest by `apps/axctl/src/metrics/commit-reverted.ts`, reusing closure's pure
`deriveClosureRows` fix detection - NOT the `later_fixed_by` edge, which
`closure.ts` rebuilds window-bounded and would leave old sessions stale (the bug
ADR-0011 fixes). `derive-metrics` then recomputes the **dirty set** - sessions in
the ingest window OR producing a now-reverted commit - so an old session's
durability updates when a NEW fix lands for its OLD commit. `reverted` is written
diff-only (no full-table reset). NONE means "not known reverted".

## How a metric is added today (no framework yet)

Per ADR-0011 we deliberately did NOT build a registry/DAG/codegen first. Adding
a metric today is a small, explicit set of edits:

1. Write `apps/axctl/src/metrics/<name>.ts` exporting a `compute…(sessionIds)`
   Effect that returns a `Map<sessionId, value>`. Follow `durability.ts` /
   `session-loc.ts`: one set-based aggregate, tombstone-filter in JS, default
   absent sessions, NONE vs 0 semantics. **Never** stack per-edge derefs over
   large edge sets, and **never** put a graph-traversing `COMPUTED` field on a
   listing surface (both hang - see `weighted-query-per-edge-deref-hang`).
2. Add a column to the `session_metrics` table in
   `packages/schema/src/schema.surql` (`option<…>` for nullable; register the
   table is already done). If you change a field type on an existing table, use
   `DEFINE FIELD OVERWRITE` and prefer `option<…>` over a bare non-optional type
   on a populated table (else NONE-coercion crashes ingest).
3. Wire it into `apps/axctl/src/ingest/derive-metrics.ts`: add it to the
   `Effect.all([...])` and into the per-session UPSERT.
4. Add a field to `SessionMetricsRow` + the SELECT in
   `apps/axctl/src/metrics/session-metrics-query.ts`, and a column in
   `formatSessionMetrics` in `apps/axctl/src/cli/index.ts`.
5. **Run the live smoke** (below) - mocked unit tests do not catch SurrealQL
   parse errors, schema-coercion crashes, or record-id key-format mismatches.
   Every one of those bit wave 1 and was only caught live.

## Live smoke (do this for every metric)

```bash
bun run db:schema
AX_PROGRESS=plain bun apps/axctl/src/cli/index.ts ingest \
  --stages=git,github-pr,session-health,closure,derive-metrics
bun apps/axctl/src/cli/index.ts sessions metrics --project /path/to/repo --limit 10
```
Then sanity-check counts (ns=ax db=main on 127.0.0.1:8521):
`SELECT count() AS rows, count(durability_ratio != NONE) AS with_durab FROM session_metrics GROUP ALL;`

## What ships in wave 2

| metric | column on `session_metrics` | meaning |
|---|---|---|
| time_to_first_edit_ms | `time_to_first_edit_ms` (`option<int>`) | ms from `session.started_at` to the session's first edit-class tool call (Edit/Write, `apply_patch`, shell `tee`/`patch`/`dd` via `command_norm`); NONE when the session never edited |
| cold_start_reads | `cold_start_reads` (`int`) | count of read/search tool calls (Read/Grep/Glob + shell `cat`/`sed`/`rg`/... via `command_norm`) before the session's first edit (how much orientation the session needed before acting) |
| delegation_ratio | `delegation_ratio` (`option<float>`) | share of the session's produced commits attributable to spawned sub-agents vs. direct work; NONE when the session produced nothing |

## What ships in wave 3

The `ax signals` surface - the ADR-0011 "framework earns itself" point, kept
minimal (a flat catalog array + a switch, NOT a registry/DAG/codegen).

- `ax signals list` - browse the signal catalog: one line per signal
  (`id  [kind]  label - description`).
- `ax signals show <id> [--limit N] [--json]` - render a signal by id. For a
  `relation` signal it prints `origin → downstream  (weight N)` edges sorted by
  weight (top `--limit`, default 30). Unknown id → stderr error + exit 2 listing
  valid ids; `--json` emits the raw edges.
- `fragility_cascade` (relation, cross-session) is now browsable through this
  surface - the bounded `fragility-cascade.ts` computation wired to the CLI.
  Catalog: `apps/axctl/src/metrics/catalog.ts`.

## Deferred

- **Remaining aggregate / relation signals**: `skill_durability_efficacy`,
  `error_recovery_efficacy`, `expertise_leverage`, `file_handoff`, `rework_chain`.
  These are cross-ALL-session aggregates whose naive `invoked`/`edited` `in.session`
  deref over ~87k edges would HANG (see `weighted-query-per-edge-deref-hang`). They
  need a hang-safe **bounded** design - e.g. a derive-stage precompute that joins
  the already-stored `session_metrics.durability_ratio` rather than an on-demand
  per-edge deref - and are deferred to a later wave.
- **`fragility_cascade` is gated, not live.** It returns empty today because the
  `touched` (git) file keys (`file:remote_*`) and `edited` (tool-call) file keys
  (`file:repository__*`) are **disjoint namespaces** - the cross-session join can
  never match. The signal logic + surface are correct; before it produces real
  edges, the file-key derivation across the git and tool-call ingest paths must be
  reconciled (join on file `path` within a repo, or unify the keys). AND, once the
  namespace gap is fixed, the on-demand `edited WHERE out IN [files]` + `in.session`
  deref must move to a **derive-stage precompute with limits** - reverted-touched
  files can be numerous, so a broad fileRefs set would reproduce the documented
  87k-edge deref hang (the `edited_out` index helps the lookup but not the deref).
- **Incremental freshness gaps (reconciled by deep/full ingest).** On the daemon's
  `--since=1` path, `time_to_land_ms` can stay stale for an OLD session whose PR
  merges LATER (the dirty set keys on the time window + changed reverted commits,
  not on PR changes). Likewise delegation depends on the spawn-tree. A full ingest
  (no `--since`, or `AX_REDERIVE_METRICS=1`) recomputes all sessions and reconciles
  these; the weekly deep-scan backfill is the intended reconciler. A PR-driven dirty
  source (sessions producing commits whose PR `merge_sha`/`merged_at` changed) is
  the proper incremental fix - deferred.
- The registry/DAG/`fn::` extraction - only once ~5–6 signals make the
  per-metric edits feel like copy-paste (the ADR-0011 gate).
- **Multi-provider tool-name parity** (#170): DONE for `time_to_first_edit_ms`,
  `cold_start_reads`, and `lines_added`/`lines_removed` - classification is
  centralized in `apps/axctl/src/metrics/tool-classes.ts` (mirrors the ingest
  file-evidence classifier `ingest/tool-file-evidence.ts`): Claude tool names
  PLUS codex/pi `apply_patch` and shell read/search/edit commands via the
  stored `tool_call.command_norm` column, classified in JS over the
  session-bounded rows (no extra derefs). Still deferred: cursor/opencode
  provider-specific read tool names (`read_file`, `codebase_search`, ...) and
  loc estimates for non-`apply_patch` shell edits (`tee`/`patch`/`dd` count as
  edits but contribute 0/0 lines).
