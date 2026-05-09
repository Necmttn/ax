# Repository Evidence Graph Queries

`src/queries/insights.ts` is the shared adapter for dashboard-grade evidence
graph queries. CLI, TUI, and integration tests should reuse these builders
instead of embedding ad hoc SurrealQL that can drift from the schema.

Example commands:

```bash
agentctl insights
agentctl insights repositories --limit=25
agentctl insights friction --limit=50
agentctl insights tools --limit=20
agentctl insights sessions --limit=20
```

The builders target the current schema fields directly:

- `repositoryOverviewSql` reads `repository` and counts
  `->has_checkout->checkout`.
- `recentFrictionSql` reads `friction_event` and returns the JSON-encoded
  `labels`, `metrics`, and `raw` fields rather than flattened draft fields.
- `toolFailuresSql` groups `tool_call` rows with `WHERE has_error = true`.
- `sessionEvidenceSql` summarizes session-linked tool calls, failures,
  friction events, and plan snapshots.

SurrealKit workflow takeaway: local development can keep importing the schema
directly for now. Tests should prefer isolated databases or namespaces so
query/integration runs do not mutate the user's main `agentctl/main` graph.
A future schema sync and rollout workflow can be added once the evidence graph
stabilizes.

## Prototype Verification Notes

The prototype writes the new evidence graph beside the legacy taste graph.
Existing taste/search commands continue to read legacy edges while the new
insight commands read through `src/queries/insights.ts`.

Verification commands run:

- `bun run db:schema`
- `bun src/cli/index.ts ingest --since=1`
- `bun src/cli/index.ts ingest-insights`
- `bun src/cli/index.ts insights repositories --limit=5`
- `bun src/cli/index.ts insights friction --limit=5`
- `bun src/cli/index.ts insights tools --limit=5`
- `bun src/cli/index.ts insights sessions --limit=5`
- `bun test`
- `bun run typecheck`
- `bun src/cli/index.ts project verify --json`

Live dogfood counts after the smoke:

- `tool_call`: 8,870
- `plan_snapshot`: 100
- `insight`: 131
- `friction_event`: 621
- `diagnostic_event`: 451

The final ingest smoke also found and fixed a plan-item identity bug: plan item
records now use plan+sequence identity, and the writer deletes legacy
content-hashed item rows that conflict on the `plan_item_plan_seq` unique index
before upserting the canonical row.
