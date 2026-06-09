# Session metrics (graph-derived)

Per-session metrics derived from the ax graph and surfaced via
`ax sessions metrics`. Design: `docs/superpowers/specs/2026-06-09-session-metrics-design.md`.
Decision record: `docs/adr/0011-session-metrics-thin-slice-over-signal-framework.md`.

## What ships in wave 1

| metric | column on `session_metrics` | meaning |
|---|---|---|
| durability_ratio | `durability_ratio` (`option<float>`) | share of the session's produced commits NOT later reverted; **NONE** when the session produced no commits (distinct from 0) |
| produced / reverted | `produced_commits`, `reverted_commits` | commit counts behind durability |
| time_to_land_ms | `time_to_land_ms` (`option<int>`) | ms from `session.ended_at` to the earliest merged PR whose `merge_sha` matches a produced commit; NONE when nothing landed |
| lines_added / lines_removed | `lines_added`, `lines_removed` | whole-line counts over the session's Edit/Write tool calls (reuses `ax loc`'s `editDelta`) |

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

## Deferred to wave 2

- **Cross-session signals** (`fragility-cascade.ts` is built, unit-tested, and
  live-query-correct: a bounded 3-query JS join (reverted-touched -> produced map
  -> edited scoped to the fragile files) that avoids the unsupported `FROM ... AS`
  alias and the all-`edited` per-deref hang). Computed correctly but NOT yet wired
  to a surface (CLI/show/dashboard) - that wiring is wave 2.
- `cold_start_reads`, `handoff_sessions`, `delegation_ratio`,
  `recovery_effective`, `skill_durability_efficacy`, `expertise_leverage`, and the
  rest of the named signals.
- The registry/DAG/`fn::` extraction - only once ~5–6 signals make the
  per-metric edits feel like copy-paste (the ADR-0011 gate).

### Deferred to wave 2/3

- **Multi-provider tool-name parity**: `time_to_first_edit_ms` +
  `cold_start_reads` currently recognize only Claude tool names
  (`Edit`/`Write`/`MultiEdit`/`NotebookEdit` for edits, `Read`/`Grep`/`Glob` for
  reads/searches); Codex/Pi `apply_patch` + shell read/search commands (via
  `tool_call.command_norm`/`command_tool`) are not yet counted -- multi-provider
  parity is a wave-3 refinement.
