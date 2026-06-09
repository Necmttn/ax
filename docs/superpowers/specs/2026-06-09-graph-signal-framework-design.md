# Graph Signal Framework - Design

**Date:** 2026-06-09
**Status:** approved design, pre-plan
**Branch:** `feat/graph-signals`

## Problem

ax already derives a lot per session (`session_health`, `session_token_usage`,
`delivery_outcome`, `produced` edges, the new `ax loc`), but:

1. There is **no unified per-session view** that surfaces these metrics together.
2. The signals that matter most are **graph-native** - they require traversing
   edges across entities (session→commit→`later_fixed_by`, file handoff between
   sessions, spawn trees, recovery→outcome) and are impossible to compute from a
   single session's transcript.
3. New insights keep appearing. Today each would mean a new CLI command / query /
   skill. That does not scale.

**Goal:** a small, declarative **signal framework** where each derived insight is
one registry entry, and a *finite* set of generic surfaces (CLI, MCP, dashboard)
render *any* registered signal automatically. Adding insight #20 is a one-file
change, not a new tool. Plus a playbook so the workflow is repeatable, and clean
docs.

**Non-goals:** new bespoke commands per metric; reworking `session_health`;
real-time/streaming derivation; ML scoring.

## Why a framework (not features)

The 8 graph signals we want are the *seed*, not the point. The point is the
**registry + surfaces + playbook** so the catalog grows cheaply. This mirrors the
existing `StageRegistry` / `ALL_STAGES` pattern in `apps/axctl/src/ingest/stage/`.

## SurrealDB SOTA findings (why the hybrid)

SurrealDB 3.1.0 offers three native derived-data mechanisms; none alone fits our
mix of *expensive* + *forward-looking* signals:

| Mechanism | Freshness | Listing cost | Mismatch |
|---|---|---|---|
| `VALUE <expr>` (write-time, stored) | only when *that* row is written | cheap | misses forward-looking changes (later commits/PRs) |
| `COMPUTED <expr>` (replaces deprecated futures; lazy) | every read | ❌ heavy multi-hop subquery per row per read → "exponential overhead" (the per-edge-deref hang we already hit) | unsafe for N-row listings |
| `DEFINE TABLE … AS SELECT … GROUP BY` (incremental materialized view) | incremental | cheap | trigger fires **only on the `FROM` table**, and **"not triggered when importing data"** → forward-looking signals driven by *later* bulk-ingested rows go stale |

**Decision - hybrid by cost, declared per signal:**
- **pure SurrealQL + cheap** → `cost: "computed"` → generated `COMPUTED` field (always fresh, no storage).
- **needs JS, or expensive, or forward-looking** → `cost: "derived"` → derive stage computes + UPSERTs a scalar (recomputed each ingest, when the rows that move it arrive anyway).

## Architecture

### The unit: `SignalDefinition`

Mirrors `StageDef`. The registry is the single source of truth - it generates
schema (computed fields) *and* drives the derive stage (stored scalars) *and*
drives every surface.

```ts
type SignalKind = "session-scalar" | "aggregate" | "relation";
type SignalCost = "computed" | "derived";
type SignalFormat = "percent" | "duration" | "count" | "ratio" | "bool" | "text";

interface SignalDefinition {
  readonly id: string;            // e.g. "durability_ratio"
  readonly label: string;         // "Durability"
  readonly description: string;
  readonly kind: SignalKind;
  readonly cost: SignalCost;
  readonly category: string;      // "delivery" | "graph" | "effort" | ...
  readonly format: SignalFormat;
  // computed-tier (kind: session-scalar only): a SurrealQL expression over the
  // session_metrics row's `session` link. Framework emits a COMPUTED field.
  readonly sql?: string;
  // derived-tier: an Effect that computes the value(s). Shape depends on kind:
  //   session-scalar → Effect<Map<sessionId, scalar>>
  //   aggregate      → Effect<ReadonlyArray<{ key; value; ... }>>
  //   relation       → Effect<ReadonlyArray<{ from: sessionId; to: sessionId; ...attrs }>>
  readonly compute?: (ctx: SignalContext) => Effect.Effect<unknown, DbError, SurrealClient>;
}
```

### The three kinds

- **`session-scalar`** - one value per session. Rendered as a column in the
  listing and a row in `ax sessions show`. Stored on `session_metrics`
  (derived) or a `COMPUTED` field (computed).
- **`aggregate`** - one ranking/table over a grouping (e.g. per-skill
  `skill_durability_efficacy`). Rendered as its own small table by
  `ax signals show <id>` and a dashboard panel. Always `derived`.
- **`relation`** (cross-session) - session→session edges with attributes
  (A's commit `later_fixed_by` B; file handoff A→B; `spawned` tree). Rendered
  natively in the **dashboard graph view**, as an edge list by
  `ax signals show <id>`, and via MCP. Always `derived`.

### Registry

`SignalRegistry` / `ALL_SIGNALS` - exact `StageRegistry` shape: `byId`,
`byKind`, `byCategory`. Adding a signal = append one entry. Lives in
`apps/axctl/src/signals/registry.ts`.

### Storage - `session_metrics` table (new, SCHEMAFULL)

One row per session. Holds:
- a `session` record link (so `COMPUTED` fields can traverse),
- one scalar column per `session-scalar` + `derived` signal,
- `COMPUTED` field definitions generated from `session-scalar` + `computed`
  signals (idempotent `DEFINE FIELD … COMPUTED <sql>`, applied at schema sync).

`aggregate` and `relation` signals are **not** stored on `session_metrics` -
they are computed by the derive stage into their own rows (`signal_aggregate`,
`signal_relation`, keyed by `signal_id`) or recomputed on demand for the detail
surfaces. (Plan decides stored-vs-on-demand per cost; default: store, recompute
each ingest, like the scalars.)

Register all new tables in `SCHEMA_TABLES` (`insights.ts`) - a test guards this.

### Derive stage - `session-signals`

Tag `derive`; deps on the stages whose data it reads (`git`, `github-pr`,
delivery, health). Iterates `ALL_SIGNALS.filter(cost === "derived")`, computes
each, UPSERTs results. New signal needs no new stage. Bounded to sessions in the
ingest window; forward-looking signals recompute as the new commits/PRs that
move them land.

**Hang-safety (the deref lesson, [[weighted-query-per-edge-deref-hang]]):**
derived computes use aggregate, tombstone-filtered-in-JS queries; never stack
per-edge `out.deleted_at`/`in.session` derefs over large edge sets.

### Computed-field sync

A registry-sync step (runs with `db:schema`) emits
`DEFINE FIELD <id> ON session_metrics TYPE option<…> COMPUTED <sql>` for every
`computed` signal - idempotent, registry-driven. The schema is partly generated
from the registry; this is intentional and documented.

### Read module - `session-metrics-query.ts`

Effect, typed. Joins `session_metrics` + `session_health` + `session_token_usage`
into one `SessionMetricsRow`. Iterates the registry to know which columns exist.
Consumed by all surfaces.

## Surfaces (finite; auto-render the registry)

1. **CLI** (`apps/axctl/src/cli/index.ts`, under the existing `sessions` group):
   - `ax sessions show <id>` - gains a **signals block** (all `session-scalar`
     signals for that session + its `relation`/`aggregate` participation).
   - `ax sessions metrics [--here|--since|--limit|--json]` - listing; columns =
     registered `session-scalar` signals.
   - `ax signals` - catalog of registered signals (id, kind, cost, category,
     description). The one genuinely new verb; pure introspection.
   - `ax signals show <id> [--json]` - render any one signal in its kind's shape
     (scalar distribution, aggregate ranking, or relation edge list).
2. **MCP** (`apps/axctl/src/mcp/`): a `session_metrics` read tool (per-session
   signals) and a `signal_show` tool (any registered signal). Read-only, fits the
   existing 10-tool registry.
3. **Dashboard** (`apps/axctl/src/dashboard/`): the graph-explorer / session
   table reads the same module; `session-scalar` signals appear as sortable
   columns, `relation` signals as graph edges, `aggregate` as a panel.

A new signal lands in all three because they iterate the registry.

## Seed signals (`ALL_SIGNALS` v1)

| id | kind | cost | formula | format |
|---|---|---|---|---|
| `produced_commits` | session-scalar | computed | `count(->produced->commit)` | count |
| `time_to_first_edit_ms` | session-scalar | computed | first `edited.ts` − `started_at` | duration |
| `durability_ratio` | session-scalar | derived | 1 − (produced commits with `later_fixed_by` ÷ produced) | percent |
| `handoff_sessions` | session-scalar | derived | distinct *other* sessions that later `edited` a file this session's commits `touched` | count |
| `time_to_land_ms` | session-scalar | derived | `ended_at` → min linked `pull_request.merged_at` | duration |
| `delegation_ratio` | session-scalar | derived | produced commits from `spawned` subagents ÷ total | percent |
| `cold_start_reads` | session-scalar | derived | `read_file`+`searched_file` before first `edited` | count |
| `recovery_effective` | session-scalar | derived | error turn → `recovered_by`→skill → delivery=merged | bool |
| `lines_added` / `lines_removed` | session-scalar | derived | JS line-count of edit `input_json` (the `ax loc` logic, now stored) | count |
| `skill_durability_efficacy` | aggregate | derived | per-skill mean `durability_ratio` of sessions that `invoked` it | percent |
| `rework_chain` | relation | derived | commit in A `later_fixed_by` commit in B → edge A→B | edge |
| `file_handoff` | relation | derived | A `edited` file F, B later `edited` F → edge A→B over F | edge |

Empty/zero semantics: no commits → `durability_ratio` = NONE (not 0); no linked
PR → `time_to_land_ms` = NONE. Distinguish "no data" from a real 0.

## Testing

- **Per signal:** unit test with a seeded mini-graph asserting the formula,
  including empty/zero edge cases.
- **Framework:** registry round-trips (`byId`/`byKind`/`byCategory`); computed
  field DDL generation produces valid SurrealQL; derive stage writes one
  `session_metrics` row/session and is idempotent on re-run.
- **Surfaces:** CLI listing + `ax signals` + MCP render the registry (snapshot:
  rendered columns == registry ids); `relation` renders an edge list.
- **Live smoke (PR-ingest lesson - mocks miss runtime/schema bugs):** run the
  derive stage against the real DB; confirm one row/session and non-NONE values
  where expected; confirm a `relation` signal yields real session→session edges.

## Deliverables

- The framework: `SignalDefinition`, `SignalRegistry`/`ALL_SIGNALS`,
  `session-signals` derive stage, computed-field sync, `session_metrics` (+
  `signal_aggregate`/`signal_relation`) schema, `session-metrics-query.ts`.
- Surfaces: `ax sessions show` enrichment, `ax sessions metrics`, `ax signals`,
  `ax signals show`; MCP tools; dashboard columns/edges.
- Seed `ALL_SIGNALS` (the 12 above).
- **`docs/signals-playbook.md`** - "Add a graph signal in 4 steps": write the
  definition → pick the cost tier (the rule above) → drop it in `ALL_SIGNALS` →
  it appears in CLI/MCP/dashboard. Worked example + the cost/freshness decision
  rule + the kind→surface mapping.
- This design doc.

## Phasing (for the plan)

1. Framework core: `SignalDefinition` + registry + `session_metrics` schema +
   computed-field sync + derive stage scaffold (no signals yet).
2. Seed `session-scalar` signals (computed + derived) + the read module.
3. CLI surfaces (`sessions show` enrich, `sessions metrics`, `signals`,
   `signals show`).
4. `aggregate` + `relation` kinds + their seeds + dashboard/MCP rendering.
5. Playbook doc + live smoke + verification.

## Open questions

- Store `aggregate`/`relation` results in tables, or recompute on demand for
  their detail surfaces? (Lean: store, recompute each ingest - uniform with
  scalars.) Decide in planning.
- `session_metrics` field churn: when a `computed` signal is removed, its
  generated `COMPUTED` field must be dropped (orphan-field NONE-crash risk,
  [[schema-orphan-field-none-crash]]). The registry-sync should reconcile drops,
  not just adds.
