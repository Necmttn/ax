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
