# Multi-hop telemetry → insight enrichment - design

Status: approved (brainstorm 2026-06-15). Branch: `feat/telemetry-insight-enrichment`.
Builds on the OTLP receiver/logs work (v0.31.0: #423/#426/#432).
Context: investigation found ax's insight/improve system already IS adaline's
"behaviors → improve" loop (and ahead on graph richness), but **no insight query
traverses the new `telemetry_of` edge** - OTLP cost/latency is disconnected from
the behavior graph. This wires it in.

## Goal

Attach OTLP-sourced cost/latency to existing behavior insights via the
`session -> telemetry_of -> otel_*` multi-hop edge. No new command - enrich four
existing surfaces in place. Realizes "behaviors with a $ dimension" through ax's
existing system rather than a parallel feature.

## Core component - `apps/axctl/src/queries/telemetry-rollup.ts`

One shared, batched rollup the four lenses reuse:

```
sessionTelemetryCost(sessionIds: readonly string[])
  : Effect<Map<string, TelemetryCost>, DbError, SurrealClient>
sessionTelemetryLatency(sessionIds: readonly string[])
  : Effect<Map<string, TelemetryLatency>, DbError, SurrealClient>
```

- `TelemetryCost = { cost_usd: number | null, tokens: number, source: "otlp" }`
  - `cost_usd`: SUM of `otel_metric_point.value WHERE metric = 'claude_code.cost.usage'` for the session (Claude). **null** when no USD metric exists (Codex - token-only until a token→USD step lands).
  - `tokens`: Claude `otel_metric_point WHERE metric='claude_code.token.usage'` value, PLUS Codex `otel_log_event` token columns (input+output+reasoning+tool) summed. (Reasoning/cached counting policy: sum input+output+reasoning+tool; exclude cached to avoid double-count - document inline.)
- `TelemetryLatency = { duration_ms: number | null, span_count: number }`
  - max/sum of `otel_span.duration_ms` for the session (fallback `otel_log_event.duration_ms`).

### Hard constraints (from prior incidents)
- **Batch by session id - never per-edge deref.** Query shape: one statement that
  takes the session-id list, joins `telemetry_of`/`otel_*`, GROUP BY session.
  Do NOT walk `<-telemetry_of` per row with stacked derefs ([[weighted-query-per-edge-deref-hang]]).
- **SurrealDB v3 dialect**: use `type::record("session:" + id)` not `type::thing`
  ([[otel-receiver-shipped]]); materialize record lists with `.map()` if the
  `FROM [recordid]` bug bites ([[surreal-30x-record-list-select-bug]]).
- **No double-count**: this is the OTLP-sourced lens, kept SEPARATE from
  transcript-derived `session_token_usage`/`session_metrics.estimatedCostUsd`.
  Columns are labeled `otlp_*` so the two sources are never summed.
- **Graceful nulls**: sessions with no telemetry → absent from the map → callers
  render `-`/null. Critical while telemetry is still thin.

## Four enrichment points (existing surfaces)

| Lens | File | Change |
| --- | --- | --- |
| A friction→cost | `queries/insights.ts` friction view + a rollup fn | per-`kind` OTLP cost: total + avg cost_usd / tokens for sessions where each friction kind occurs |
| B episode→cost | `metrics/session-churn.ts` `SessionChurnRow` + CLI render (`cli/commands/sessions.ts`) | add `otlp_cost_usd`/`otlp_tokens` per session row + `cost_per_episode` (cost / max(episodes,1)) |
| C cascade→cost | `metrics/fragility-cascade.ts` `CascadeEdge` + `readFragilityCascade` | add `downstream_cost_usd`/`downstream_tokens` (sum over the cascade's downstream sessions) |
| E recovery→latency | `ax skills weighted` query (locate handler) | add median recovery `duration_ms` per skill, over the sessions of its `recovered_by` edges |

Each lens: collect the relevant session-id set from the EXISTING query result,
call the shared rollup ONCE for that set, merge the cost/latency back onto rows
in JS (deref-free). `--json` outputs gain the new fields; table renderers gain a
column (only when any row has telemetry, else omit to avoid an all-`-` column).

## Data flow

```
existing behavior query → collect sessionIds
        → sessionTelemetryCost(ids) / sessionTelemetryLatency(ids)  (1 batched query)
        → merge map onto rows in JS → render (column shown only if populated)
```

## Testing (TDD)

- **telemetry-rollup**: stub `SurrealClient.query` returning telemetry_of + otel
  rows; assert `sessionTelemetryCost` sums claude cost.usage to `cost_usd`,
  codex log token cols to `tokens`, `cost_usd: null` for codex-only sessions,
  absent session → not in map. `sessionTelemetryLatency` from spans.
- **each lens**: stub the existing query's rows + the rollup; assert the new
  column populates when telemetry present and is null/omitted when absent.
- No regression: existing churn/fragility/friction/weighted tests stay green.

## Out of scope / deferred
- Codex token→USD cost derivation (needs per-model pricing) - `cost_usd` stays
  null for codex here; follow-up.
- Dashboard/studio rendering of these columns - CLI/MCP/`--json` only this PR.
- Backfilling telemetry - these light up as OTLP data accumulates.

## Open
- Exact `ax skills weighted` handler location for lens E - implementer locates
  during build; if the weighted query is structurally hostile to a clean join,
  E degrades to a separate `--json` field rather than a table column (note it).
