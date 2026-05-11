# Repository Evidence Graph Queries

`src/queries/insights.ts` is the shared adapter for dashboard-grade evidence
graph queries. CLI, TUI, and integration tests should reuse these builders
instead of embedding ad hoc SurrealQL that can drift from the schema.

Example commands:

```bash
agentctl insights
agentctl insights schema
agentctl insights repositories --limit=25
agentctl insights checkouts --limit=25
agentctl insights git --limit=25
agentctl insights friction --limit=50
agentctl insights tools --limit=20
agentctl insights sessions --limit=20
agentctl insights graph-health --limit=10
agentctl dashboard --limit=25
```

The builders target the current schema fields directly:

- `repositoryOverviewSql` reads `repository` and counts
  `->has_checkout->checkout`.
- `checkoutActivitySql` reads `checkout` and counts linked sessions, turns,
  tool calls, failures, produced commits, and touched files per worktree or
  local checkout.
- `gitCorrelationSql` reads repository-linked sessions, commits, `produced`,
  and `touched` evidence so a dashboard can show whether transcript activity
  is attached to Git history.
- `recentFrictionSql` reads `friction_event` and returns the JSON-encoded
  `labels`, `metrics`, and `raw` fields rather than flattened draft fields.
- `toolFailuresSql` groups `tool_call` rows with `WHERE has_error = true`.
- `sessionEvidenceSql` summarizes session-linked tool calls, failures,
  friction events, and plan snapshots.
- `schemaCoverageSql` reports every schema table as `active`, `conditional`,
  or `staged`, so intentionally empty tables are visible instead of surprising
  in Surrealist.

## Harness Doctor Tables And Ingestion Status

The Harness Doctor slice adds schema support for these tables:

- `guidance_source`
- `guidance_revision`
- `stack`
- `agent_tooling`
- `harness_learning`
- `intervention`
- `intervention_observation`

Current implementation status:

- `agentctl project harness` scans repo-local and global guidance sources at
  report time.
- `agentctl project harness --json` returns Guidance Sources, Guidance
  Revisions, Stack signals, Agent Tooling signals, Harness Doctor findings, the
  first local Harness Learning candidate, an Intervention suggestion, and an
  Intervention Observation.
- `agentctl project harness` also reads existing `tool_call`, `edited`, and
  `produced` graph evidence so observed tooling and main-branch write-risk
  signals are grounded in the current database.
- Default `agentctl ingest` persists the Harness Doctor report into the staged
  Harness Doctor tables via the `harness/doctor` ingest stage.

The harness ingest stage is idempotent and:

1. Upserts `guidance_source` rows keyed by path.
2. Upserts `guidance_revision` rows keyed by source path plus content hash.
3. Upserts declared and observed `stack` records.
4. Upserts `agent_tooling` records from package scripts, global tools, and
   observed tool calls.
5. Upserts local `harness_learning` candidates.
6. Upserts approval-gated `intervention` suggestions.
7. Upserts `intervention_observation` rows with before/after metric fields.

Use `agentctl project harness --json` as the canonical report surface and
`agentctl insights schema` to verify durable table population after ingest.

SurrealKit workflow takeaway: local development can keep importing the schema
directly for now. Tests should prefer isolated databases or namespaces so
query/integration runs do not mutate the user's main `agentctl/main` graph.
A future schema sync and rollout workflow can be added once the evidence graph
stabilizes.

Implementation-pattern reference: `docs/effect-reference-t3code.md` captures
Effect practices from the local `.references/t3code` clone that are worth
adapting as the prototype grows, especially typed config, process services,
schema decoders, and layer-based tests.

## Prototype Verification Notes

The prototype writes the new evidence graph beside the legacy taste graph.
Existing taste/search commands continue to read legacy edges while the new
insight commands read through `src/queries/insights.ts`.

Verification commands run:

- `bun run db:schema`
- `bun src/cli/index.ts ingest --since=1`
- `bun src/cli/index.ts ingest-insights`
- `bun src/cli/index.ts insights schema --limit=5`
- `bun src/cli/index.ts insights repositories --limit=5`
- `bun src/cli/index.ts insights checkouts --limit=5`
- `bun src/cli/index.ts insights git --limit=5`
- `bun src/cli/index.ts insights friction --limit=5`
- `bun src/cli/index.ts insights tools --limit=5`
- `bun src/cli/index.ts insights sessions --limit=5`
- `bun src/cli/index.ts dashboard --limit=5`
- `bun test`
- `bun run typecheck`
- `bun src/cli/index.ts project verify --json`

Live dogfood counts after the smoke:

- `tool_call`: 9,055
- `plan_snapshot`: 103
- `insight`: 131
- `friction_event`: 626
- `diagnostic_event`: 456

Schema coverage after the smoke: 25 of 40 tables populated. Empty staged
tables are `workspace`, `changeset`, `file_memory`, `artifact`,
`feedback_event`, `guidance`, `guidance_version`, and the future
changeset/artifact/provenance relation tables. `recommendation` is active but
conditional; it stays empty until repeated friction crosses the current
threshold.

Harness Doctor schema additions are populated by default ingest. If they are
empty, run `agentctl ingest --since=1` and inspect the `harness/doctor` ingest
stage.

Dashboard generated at:

`file:///Users/necmttn/.local/share/agentctl/dashboard.html`

## Empty DB Benchmarks

Use `scripts/bench-empty-db.sh` for cold ingest timing without mutating
`agentctl/main`:

```bash
scripts/bench-empty-db.sh --since=90
```

The script selects a unique `AGENTCTL_DB_DB=bench_<timestamp>`, applies the
schema, runs ingest, imports Claude insights, writes `schema.json`,
`checkouts.json`, and `git.json`, and generates a static dashboard under
`~/.local/share/agentctl/benchmarks/<db>/`.

Repo initialization is not per-project. Ingest discovers repositories from
existing transcript `cwd` values and optionally from
`~/.local/share/agentctl/agentctl-repos.txt`. The Git pass backfills
`session.repository` and `session.checkout`; `produced` edges are then tied to
the checkout plus commit timestamp, while `touched` edges connect commits to
canonical repository-relative files.

The final ingest smoke also found and fixed a plan-item identity bug: plan item
records now use plan+sequence identity, and the writer deletes legacy
content-hashed item rows that conflict on the `plan_item_plan_seq` unique index
before upserting the canonical row.
