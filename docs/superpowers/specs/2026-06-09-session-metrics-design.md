# Session Metrics (graph-derived) - Design

**Date:** 2026-06-09
**Status:** approved design, pre-plan
**Branch:** `feat/graph-signals`
**Decision record:** [docs/adr/0011-session-metrics-thin-slice-over-signal-framework.md](../../adr/0011-session-metrics-thin-slice-over-signal-framework.md)

## Problem

ax already derives a lot per session (`session_health`, `session_token_usage`,
`delivery_outcome`, `produced` edges, the `ax loc` line counts), but there is no
unified per-session view, and the highest-value insights are **graph-native** -
they need edge traversal across entities (session→commit→`later_fixed_by`, file
handoff between sessions, spawn trees, recovery→outcome) and cannot be computed
from one session's transcript.

We want to surface those, and to keep adding more, **without** building a
speculative framework first. Per ADR-0011, we ship **thin correctness-first
waves** of plain metric modules, fix the freshness model that the framework
design got wrong, and only extract a registry/DAG once 5–6 real signals reveal
the shape.

**Non-goals (now):** a `SignalDefinition` registry, COMPUTED-field codegen,
generic auto-rendering surfaces, a signal DAG/`dep` resolver, materialized
views. All deferred behind the wave-3 extraction gate. (See ADR-0011 for why
each was debunked.)

## The backbone: a correct freshness model (dirty-set, full-history primitives)

This is wave-1 work and a prerequisite for every forward-looking signal.

The framework design assumed window-bounded recompute keeps forward-looking
signals fresh. It does not: `closure.ts` rebuilds `later_fixed_by`
window-bounded (`DELETE` all, re-`RELATE` only within `--since`), so on the
daemon's `ingest --since=1` an old session's durability never recomputes and its
`later_fixed_by` edges are truncated - the number moves the wrong way. (Full
trace in ADR-0011.)

Fix:
- **Layer-0 primitive over full history.** `commit_reverted` (per commit:
  `count(->later_fixed_by->commit) > 0`) is computed over all commits, decoupled
  from `--since`. Cheap: one set-based pass, stored as a `commit.reverted` bool.
- **Dirty-set recompute.** When `derive-metrics` runs, the set of sessions to
  recompute is *not* "sessions in the window" but **sessions transitively
  reachable from edges that changed this ingest** - i.e. sessions that
  `produced` a commit whose `reverted` flipped, or whose touched files were
  edited by a new session, plus the newly-ingested sessions. This keeps an old
  session's durability correct when a *new* fix lands for its *old* commit.
- The closure step that maintains `later_fixed_by` must stop window-truncating
  the edge (or `derive-metrics` must recompute the primitive itself over full
  history before reading it). Resolved in planning; the constraint is: **the
  primitive `commit_reverted` is always whole-history-correct at read time.**

## Architecture (thin slice)

Plain, typed, Effect-native modules - no registry, no codegen.

```
apps/axctl/src/metrics/
  commit-reverted.ts     # Layer-0 primitive: full-history, stored on commit.reverted
  durability.ts          # durability_ratio per session (joins commit.reverted)
  time-to-land.ts        # session end → linked PR merged_at
  loc.ts                 # lines_added/removed (reuse the ax loc logic, now stored)
  fragility-cascade.ts   # the cross-session insight (plain query)
  session-metrics-query.ts  # typed read: joins session_metrics + session_health
                            # + session_token_usage into one SessionMetricsRow
```

- **`session_metrics` table** (SCHEMAFULL, hand-written DDL): `session` link +
  the wave's scalar columns (`durability_ratio`, `time_to_land_ms`,
  `lines_added`, `lines_removed`, …). Registered in `SCHEMA_TABLES`
  (`insights.ts`) - guarded by a test (known gotcha). Grows by hand, one column
  per shipped scalar; no generated fields.
- **`commit.reverted`** bool column on the existing `commit` table, written by
  the metrics derivation over full history.
- **`derive-metrics` stage** (tag `derive`, deps on `git`/`github-pr`/health):
  computes `commit_reverted` (full history) → `durability_ratio` (dirty-set
  sessions, joining the stored bool - no edge re-walk) → `time_to_land_ms` →
  `lines_*`; UPSERTs one `session_metrics` row per dirty session. Idempotent.
- **Read module `session-metrics-query.ts`**: one typed `SessionMetricsRow`
  joining `session_metrics` + `session_health` (turns/corrections/interruptions/
  context_pressure/task_label) + `session_token_usage` (tokens/cost). Modeled on
  the existing `loc-query.ts` / `cost-query.ts` shape.

### Surface (wave 1)

- **`ax sessions metrics [--here|--since|--limit|--json]`** - one listing,
  hardcoded columns from `SessionMetricsRow`. Sortable in `--json` consumers.
- **`ax sessions show <id>`** - gains a metrics block for that one session.

No `ax signals` catalog, no MCP tool, no generic dashboard rendering in wave 1
(deferred; trivially added later if a registry emerges).

## Hang-safety (the deref lesson)

Every derived query is a **single set-based aggregate**, tombstone-filtered in
JS, never stacked per-edge `out.*`/`in.*` derefs over large edge sets
([[weighted-query-per-edge-deref-hang]]). The expensive `later_fixed_by` walk
happens once (`commit_reverted`); everything downstream joins the stored bool.
`COMPUTED` graph-traversing fields are banned from listing surfaces (verified
per-read hang). A live-DB smoke test asserts each query stays under a latency
budget on the real ~87k-edge graph.

## SurrealDB correctness notes (verified 3.1.0)

- existence is `count(->edge->table) > 0` - **`EXISTS(...)` is not valid
  SurrealQL.**
- materialized views (`DEFINE TABLE … AS SELECT`) are **not triggered on
  import** and only fire on the `FROM` table → rejected for these signals.
- `COMPUTED` is read-time and *can* traverse edges → which is exactly why it is
  banned from N-row listings here.
- datetimes stored on `session_metrics` use JS `Date` via the SDK.

## Waves - all named signals mapped

Every signal we enumerated is delivered; waves sequence them correctness-first.

**Wave 1 - backbone + first insights (this plan):**
`commit_reverted` (full-history primitive) · `durability_ratio` ·
`time_to_land_ms` · `lines_added`/`lines_removed` · `fragility_cascade`
(cross-session, plain query - pin its exact weight formula here) ·
`ax sessions metrics` + `sessions show` block · dirty-set freshness.

**Wave 2 - breadth (plain modules, same patterns):**
`cold_start_reads` / `time_to_first_edit_ms` · `handoff_sessions` /
`file_handoff` (relation; gated off the daemon `--since=1` path) ·
`delegation_ratio` · `recovery_effective` / `error_recovery_efficacy`
(pin causation-vs-coincidence definition) · `skill_durability_efficacy`
(aggregate, reuses `durability_ratio`) · `expertise_leverage`.

**Wave 3 - extraction gate + remaining deep signals:**
When `metrics/` duplication is real (~6 modules), extract a small registry from
the signals that exist; evaluate `fn::` + `{1..N}` recursion as the deep-
traversal substrate. Then add skill-spread, skill-pair-lift,
ignored-review-breakage as cheap additions. Add MCP + generic dashboard
rendering here if warranted.

## Testing

- **Per metric:** unit test on a seeded mini-graph asserting the formula,
  including empty/zero edges (no commits → `durability_ratio` = NONE not 0; no
  PR → `time_to_land_ms` = NONE). Distinguish "no data" from a real 0.
- **Freshness:** a test that a *new* fix commit for an *old* session's commit
  recomputes that old session's `durability_ratio` (the dirty-set behavior the
  framework design got wrong).
- **Stage:** `derive-metrics` writes one row/dirty-session, idempotent on
  re-run; `commit.reverted` is whole-history-correct after a windowed ingest.
- **Surface:** `ax sessions metrics` renders the wave's columns; `--json`
  shape is stable.
- **Live smoke (PR-ingest lesson - mocks miss runtime/schema bugs):** run
  `derive-metrics` against the real DB; confirm rows, non-NONE where expected,
  latency budget, and that `fragility_cascade` yields real cross-session edges.

## Deliverables

- `session_metrics` table + `commit.reverted` column (+ `SCHEMA_TABLES`).
- `derive-metrics` stage with the dirty-set/full-history freshness model.
- `metrics/` modules for the wave-1 signals + `session-metrics-query.ts`.
- `ax sessions metrics` + `ax sessions show` metrics block.
- ADR-0011 (done) + this design doc.
- A short `docs/metrics.md` noting how a new metric is added today (a module +
  a column + a surface line) and the wave-3 extraction gate - *not* a framework
  playbook (that comes with the framework, if it earns itself).

## Open questions (for planning)

- Exact `fragility_cascade` weight (downstream fixers × which commits?) and
  `error_recovery_efficacy` causation model - pin before those ship.
- Whether `derive-metrics` recomputes `commit_reverted` itself over full history,
  or `closure.ts` is changed to stop window-truncating `later_fixed_by`. Either
  satisfies the invariant; pick the smaller change.
- Dirty-set computation: derive the reachable-sessions set from changed edges in
  SurrealQL vs JS - bounded either way.
