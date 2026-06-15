# OTLP receiver - design

Status: approved (brainstorm 2026-06-15). Branch: `feat/otel-receiver`.
Companion exploration map: `/tmp/ax-otel-ingestion-exploration.md` and memory
[[otel-ingestion-exploration]].

## Goal

`ax serve` accepts harness-emitted OTLP usage telemetry, lands it raw, and
graph-correlates it to sessions when transcripts arrive later. The usage numbers
ax computes by hand today (cost, tokens, dispatch), pushed in real time,
multi-harness, with no file-tail lag.

This is **complementary** to transcript parsing, not a replacement: OTLP carries
operational telemetry (counts, cost, timings), never transcript content. Cost
from OTLP is stored separately from file-parsed cost so the two never
double-count.

## Scope (v1)

- Claude Code **metrics** (`claude_code.*`: cost.usage, token.usage,
  code_edit_tool.decision, lines_of_code.count, commit/pull_request.count, ...)
- Codex **traces/spans** (`codex_cli_rs`: `session_loop` + child API/tool spans)
- Out of v1: CC events/logs (tool_decision accept/reject, skill_activated - a
  separate logs signal); protobuf encoding; gRPC.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Listener | reuse daemon port 1738 | one bind; reuses pidfile/probe/CORS |
| Protocol | OTLP/HTTP **JSON only** | ax owns the harness config → force `http/json` → no protobuf decode, no proto dep |
| Storage | dedicated `otel_*` tables | additive, zero risk, cost isolated → no double-count |
| Correlation | SurrealDB graph edge, drawn at transcript-ingest | OTLP arrives first, transcript later; transcript pass owns linking |
| Enablement | `ax install` auto-configures | zero user steps; idempotent ax-owned markers like the hooks fan-out |
| Decode | Effect `Schema` end-to-end | matches contract layer (ADR-0013) + [[feedback-typed-modular-effect]] |
| Compiled binary | supported | pure HTTP/JSON/Surreal, no native dep (unlike live-ingest's lmdb) |

## Architecture

New module `apps/axctl/src/otel/`. Routes mount via the contract HttpRouter seam
(ADR-0013, `apps/axctl/src/dashboard/contract/`), not the legacy route table.

```
POST /v1/metrics  (JSON, gzip)  ──► decode-metrics ─► normalize(cc)  ─┐
POST /v1/traces   (JSON, gzip)  ──► decode-spans   ─► normalize(codex)─┤─► OtelWriter ─► SurrealDB
POST /v1/logs     (JSON)        ──► 200 OK, drop (v1 no-op)            ─┘                  otel_metric_point
                                                                                          otel_span
transcript ingest (existing)    ──► correlate(session.id) ─► RELATE session->telemetry_of->otel_*
```

### Components (each independently testable)

1. **Routes** (`otel/routes.ts`) - 3 `HttpApiEndpoint`s on the contract router.
   Parse body (gzip-aware), hand JSON to the decoder, return the OTLP success
   envelope (`{ partialSuccess: {} }`). Malformed body → 400; unknown shape →
   logged + 200 (OTLP exporters retry on non-2xx; we do not want retry storms
   for shape drift, so decode failures are swallowed after logging - fail-open).
2. **Decoders** (`otel/decode-metrics.ts`, `otel/decode-spans.ts`) - curated
   `Schema.Struct` of the OTLP/JSON envelope (only fields we read), decoded with
   `Schema.decodeUnknown`. Handles proto3-JSON quirks: int64-as-string
   (`Schema.NumberFromString` for `*UnixNano`), `AnyValue` union
   (`{stringValue|intValue|doubleValue|boolValue}`).
3. **Normalizers** (`otel/normalize.ts`) - per-harness map decoded struct → row
   schema. Extracts `session.id`, model, skill.name, agent.name, value, unit, ts.
4. **Writer** (`otel/writer.ts`) - `OtelWriter` Effect service; batch-insert rows.
   Layer-testable (Live → Surreal, Test → in-memory capture).
5. **Correlation** (`otel/correlate.ts`) - called from the transcript ingest
   pipeline after a session row is written: `SELECT` orphan `otel_*` by
   `session.id`, `RELATE` them to the session via `telemetry_of`. Idempotent.

## Data model

New tables (register in `SCHEMA_TABLES`, `apps/axctl/src/.../insights.ts`):

```
otel_metric_point
  id, harness (string), metric (string), value (number), unit (string),
  session_id (string), model (option string), skill_name (option string),
  agent_name (option string), attrs (string = JSON), observed_at (datetime)

otel_span
  id, harness, name, trace_id, span_id, parent_span_id (option),
  session_id (string), started_at (datetime), ended_at (datetime),
  duration_ms (number), attrs (string = JSON), observed_at (datetime)

telemetry_of  (edge: session -> otel_metric_point | otel_span)
```

Nested objects JSON-encoded as `string` per schema rules. Datetimes are JS
`Date` via the SDK. New tables guarded by the `SCHEMA_TABLES` mirror test
([[schema-tables-mirror]]).

## Correlation flow

1. Harness emits OTLP → row lands in `otel_*` with `session_id`, no edge yet
   (orphan). Immediately queryable for cost/usage on its own.
2. Transcript for that session ingests later (watcher / `ax ingest`). After the
   `session` row is written, `correlate(session.id)` finds orphan `otel_*` rows
   and `RELATE`s them.
3. Queries that want a unified view traverse `session->telemetry_of->otel_*`;
   queries that want raw telemetry read `otel_*` directly.

**No double-count:** file-parsed cost stays on `session`/cost tables; OTLP cost
stays on `otel_metric_point`. A reader chooses a source explicitly; they are
never summed.

## Enablement (`ax install`)

Idempotent, ax-owned markers (mirror the hooks install fan-out pattern):

- **Claude Code** settings env:
  `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`,
  `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`,
  `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:1738`
- **Codex** `config.toml` `[otel]`: trace exporter → otlp-http, same endpoint,
  `http/json`. (Requires codex trust approval like other codex config writes.)
- Daemon down → exports fail silently (fail-open). No retry storm: receiver
  always 2xx once reachable.
- `ax install` prints what it wrote; reversible (markers removable).

## Testing (TDD)

- decoders: golden OTLP/JSON fixtures (real captured CC metrics + Codex traces)
  → assert normalized rows. Cover proto3-JSON quirks (string int64, AnyValue).
- writer: Test layer captures rows, asserts batch shape.
- correlate: seed orphan otel rows + a session, run correlate, assert edge.
- routes: post fixture body, assert 200 + writer called; malformed → 400;
  shape-drift → 200 + logged, no write.
- schema mirror test catches the new tables.

## Risks / open questions

1. **Codex session-id mapping** - confirm Codex spans carry an id that maps to
   ax's session key. If not, Codex rows stay orphan (still useful for cost,
   no correlation). Verify against a real capture during build.
2. **CC metric→session.id presence** - `session.id` is a documented std attr on
   all CC signals; confirm it survives in the JSON exporter output.
3. **Endpoint path convention** - CC/Codex append `/v1/metrics` etc. to
   `OTEL_EXPORTER_OTLP_ENDPOINT` automatically; confirm no double `/v1` and that
   our routes match what the exporters actually POST.
4. **Re-ingest correlation** - correlate must be idempotent across the
   re-ingest watcher race ([[reingest-watcher-daemon-race]]).

## Deferred (v2+)

- CC events/logs ingestion (tool_decision accept/reject, skill_activated) -
  signals ax can't get from transcripts at all.
- protobuf + gRPC transport.
- reconcile/dedup read view that prefers one source per session.
- eval loop (adaline parity) - separate, larger track; needs content + judge.
