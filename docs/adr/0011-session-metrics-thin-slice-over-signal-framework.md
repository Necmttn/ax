# Ship session metrics as thin waved slices; defer the signal framework

We want ax to surface derived per-session metrics and cross-session,
multi-hop graph insights (durability of a session's commits, time-to-land,
fragility cascades, skill→durability efficacy, recovery→outcome, expertise
leverage, …), and to make adding the next insight cheap.

The first design reached for a framework: a declarative `SignalDefinition`
registry (mirroring `StageRegistry`), a topo-ordered derive stage, COMPUTED
fields generated from the registry, a `session_metrics` table, three signal
kinds (`session-scalar` / `aggregate` / `relation`) plus a `primitive` layer,
a `SignalContext.dep` DAG so deep signals reuse cheap precomputed primitives,
and generic CLI/MCP/dashboard surfaces that auto-render any registered signal.
The pitch: adding insight #20 becomes a one-file change.

We reject building that framework first. A five-perspective design review
(two alternative-architecture proposals, an adversarial roast, a YAGNI pass,
and a SurrealDB-feasibility audit) converged on the same conclusion, and one
finding was a genuine correctness bug. This ADR records what we debunked and
why.

## The freshness model was wrong, not just imperfect

The framework's headline claim was that forward-looking signals stay fresh by
being "recomputed each ingest, bounded to the ingest window, as the rows that
move them arrive." Traced against `closure.ts`, this is false. `later_fixed_by`
- the edge `commit_reverted` and therefore `durability_ratio`,
`file_fragility`, `rework_chain`, and `fragility_cascade` all depend on - is
itself a derived edge that `closure.ts` rebuilds **window-bounded**: it
`DELETE`s every `later_fixed_by` and re-`RELATE`s only among commits inside
`--since`. Under the daemon's `ingest --since=1`:

- a fix commit landing today for a three-week-old bug leaves the old feature
  commit outside the window, so the `feature→fix` edge is never recreated; and
  the old session that *owns* the durability number is not in the recompute
  window either. The thing that changed (new fix) and the thing that needs
  recomputing (old session) sit on opposite sides of the window boundary.
- worse, the blanket `DELETE` truncates the old edge, so the old commit flips
  to `reverted = false` and the old session's durability moves the **wrong
  direction** on new data.

Forward-looking is the one direction that justified going graph-native at all,
and the window-bounded model degrades exactly there while *looking* fresh and
authoritative. So regardless of framework-or-not, the freshness model must
change to a **dirty-set recompute**: when an edge changes, recompute the
sessions transitively reachable from it, and compute Layer-0 primitives
(`commit_reverted`) over **full history**, decoupled from `--since`.

## What we debunked

**Framework-first is premature abstraction.** We have ~17 named signals and
zero shipped. Every abstraction boundary - the three kinds, the cost tiers,
the `dep` DAG - was drawn from imagined signals. The likely outcome is paying
for the framework, then discovering at signal #4 that a kind doesn't fit or
`dep` needs windowing we didn't model, and refactoring it anyway. Build the
signals; let the duplication, once real, justify the registry.

**COMPUTED-field codegen is the worst cost/value trade and reintroduces a
known crash class.** Generating `DEFINE FIELD … COMPUTED <sql>` from app code
means the schema is partly generated, and retiring a signal needs `REMOVE
FIELD` reconciliation - a drop mechanism that does not exist in this repo
(schema apply is an append-only `surreal import`). That is the orphan-field
NONE-crash we have already been burned by. COMPUTED is verified to traverse
graph edges per read - which is precisely the per-edge-deref hang on an N-row
listing (`ax sessions metrics`). We keep COMPUTED only as a possible
single-record convenience on `sessions show`, never a graph-traversing column
on a listing, and we do not generate fields from a registry. Derived scalars
are written by the derive stage instead.

**Materialized views (`DEFINE TABLE … AS SELECT`) do not fit our pipeline.**
Verified against the docs: table views are "not triggered when importing
data," and only the `FROM` table's writes trigger them. ax ingest is bulk
import, and the signals are cross-table, so views would silently never refresh.
Rejected for these signals.

**`EXISTS(...)` is not SurrealQL.** The seed formulas used it; existence is
`count(->edge->table) > 0`. Mechanical, but the spec's formulas did not parse
as written.

**The name `signals` is taken.** `derive-signals.ts` already derives
friction/recovery/correction edges. We name this work **metrics**
(`session_metrics`, a `derive-metrics` stage, `ax sessions metrics`), which
also matches the surface users asked for.

**Cross-session `relation` recompute must be gated.** Recomputing
whole-history relations on every daemon transcript is an O(edges) walk per save
and will peg SurrealDB (the re-ingest watcher race). Relations run on
manual/deep ingest, not the `--since=1` daemon path.

## Decision

Ship session metrics as **thin, correctness-first waves**, not a framework:

1. a hand-written `session_metrics` table + a `derive-metrics` stage;
2. `commit_reverted` computed over **full history** via a dirty-set, feeding
   `durability_ratio`, plus `time_to_land`, `lines_added/removed`, and one
   cross-session insight (`fragility_cascade`) as a plain query;
3. `ax sessions metrics` surfacing them.

Every named signal remains deliverable - later waves add them as plain modules
in `apps/axctl/src/metrics/`. We extract a registry/DAG **only after 5–6 real
signals** reveal the true shape (refactor-when-it-hurts), and when we do, the
likely substrate for deep weighted traversal is SurrealDB `fn::` stored
functions with `{1..N}` recursion idioms (verified capable, 256-hop max) rather
than hand-rolled JS DAG joins.

## Consequences

- No registration boilerplate saved up front; adding wave-2/3 signals is a
  small module + a surface line, not a one-field change - acceptable at this
  count.
- The freshness fix (dirty-set + full-history primitives) is now a wave-1
  backbone and a prerequisite for every forward-looking signal.
- We carry a small, explicit deferral: when `apps/axctl/src/metrics/` starts
  feeling like copy-paste (~signal #6), revisit the framework - and it will be
  smaller and correct, because the signals taught it their shape.
- Two deep signals (`fragility_cascade` weight, `error_recovery_efficacy`
  causation-vs-coincidence) need their exact queries pinned before they ship;
  that is signal-definition work, independent of this decision.
