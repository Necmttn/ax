# OTLP logs ingestion - design

Status: approved (brainstorm 2026-06-15). Branch: `feat/otel-logs-ingestion`.
Builds on the OTLP receiver (PR #423) + Codex config fix (PR #426).
Extends memory [[otel-receiver-shipped]].

## Goal

Implement the currently-no-op `POST /v1/logs` to ingest OTLP **log events** into a
new `otel_log_event` table, and correlate them to sessions. This unblocks
**Codex** dogfood data: Codex emits OTLP *logs* (events), not spans, so nothing
Codex produces lands today. Also forward-covers Claude Code events
(tool_decision accept/reject, skill_activated) on the same path.

## Why logs (the dogfood finding)

Live capture (2026-06-15) against real `codex exec`: Codex's otlp-http exporter
POSTs OTLP `resourceLogs` (JSON) to the endpoint **as-is** (no `/v1/<signal>`
appending; config targets `/v1/logs`). Service name `codex_exec`. Events carry
`event.name` and rich attributes. The spec's original "Codex = traces"
assumption was wrong.

Captured event vocabulary (one `codex exec` turn):
`codex.websocket_event` (×16, transport noise), `codex.startup_phase` (×8),
`codex.sse_event` (×2 - **carries token usage**), `codex.websocket_request`,
`codex.api_request` (http status + duration), `codex.websocket_connect`,
`codex.user_prompt`, `codex.turn_ttft` (latency), `codex.conversation_starts`
(model + reasoning_effort).

**Token usage rides on `codex.sse_event`**: `input_token_count`,
`output_token_count`, `reasoning_token_count`, `cached_token_count`,
`tool_token_count`, plus `model`, `conversation.id`. (NOT on api_request -
api_request carries `duration_ms`, `http.response.status_code`.)

Session key = **`conversation.id`** attr (not `session.id`). Log-record
`timeUnixNano` is `0`; real time is the `event.timestamp` string attr.

Real captured fixture committed at
`apps/axctl/src/otel/__fixtures__/codex-logs.json` (compact: one sse_event with
tokens, one user_prompt, one conversation_starts, one websocket_event for the
filter test).

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Storage | new `otel_log_event` table | mirrors `otel_metric_point`/`otel_span`; additive |
| Event scope | **curated allowlist** | drops the ~80% transport noise (websocket/sse-non-usage); clean rows |
| Token data | **typed columns** on the row | Codex usage queryable/summable like CC metrics |
| Session key | `conversation.id` ?? `session.id` | codex vs claude attr naming |
| Timestamp | `event.timestamp` attr ?? observedTimeUnixNano | logRecord timeUnixNano is 0 |
| Decode | Effect `Schema` (reuse AnyValue/KeyValue/attrMap) | consistency |
| Correlation | add `otel_log_event` to existing `correlateOrphanOtel` | `telemetry_of` is unconstrained |

## Curated allowlist

A `const` (easy to extend), keyed by harness:

- **codex**: `codex.sse_event` (tokens), `codex.api_request` (latency/status),
  `codex.user_prompt`, `codex.turn_ttft`, `codex.conversation_starts`
- **claude**: `claude_code.tool_decision`, `claude_code.skill_activated`,
  `claude_code.user_prompt`, `claude_code.api_error`

Events whose `event.name` is not in the harness's allowlist are skipped (not
written). `codex.websocket_event`/`websocket_request`/`websocket_connect`/
`startup_phase`/`sse_event`-without-usage noise is dropped. (An sse_event with
no token attrs still matches the allowlist but lands with null token columns -
acceptable; the allowlist is by name, token columns are best-effort.)

## Architecture

Extends `apps/axctl/src/otel/` (mirror the metrics/spans pipeline exactly).

```
POST /v1/logs (JSON) ──► decodeLogsPayload ─► normalizeLogs (allowlist + harness)
                                                  │
                                                  ▼
                                            OtelWriter.writeLogs ─► otel_log_event
ingest finish ──► correlateOrphanOtel (now includes otel_log_event) ─► telemetry_of
```

### Components

1. **`otlp-schema.ts`** - add `LogsPayload` Schema:
   `resourceLogs[].{resource?, scopeLogs[].logRecords[]}` where a `LogRecord`
   has `timeUnixNano?`, `observedTimeUnixNano?`, `attributes?`, `body?`. Reuse
   `AnyValue`/`KeyValue`/`attrMap`. Export `LogsPayload` (+type).
2. **`rows.ts`** - add `OtelLogEventRow`:
   `harness, event_name, session_id, model, observed_at` (Date),
   token columns `input_tokens, output_tokens, reasoning_tokens, cached_tokens,
   tool_tokens` (NullOr number), `duration_ms` (NullOr number),
   `status_code` (NullOr number), `attrs` (NullOr string JSON).
   Plus `logEventKey(r)` deterministic id =
   `harness|event_name|session_id|observed_at.iso|<short hash of attrs>` (events
   repeat per name+session+ts; include a stable discriminator so distinct
   same-name events at the same second don't collide - use the record index or
   an attr-derived suffix; the writer passes an index).
3. **`decode.ts`** - `decodeLogsPayload(json)` (Effect, maps to OtelDecodeError signal "logs").
4. **`normalize.ts`** - `normalizeLogs(payload): OtelLogEventRow[]`:
   - `harnessOf(service.name)` extended: `codex_exec`/`codex_tui`/startsWith `codex` → "codex".
   - per record: read `event.name`; if not in `ALLOWLIST[harness]` → skip.
   - `session_id` = attr `conversation.id` ?? `session.id`.
   - `observed_at` = parse `event.timestamp` attr ?? `observedTimeUnixNano`/`timeUnixNano` via nanoToDate.
   - lift `input_token_count`→input_tokens, etc; `duration_ms`; `http.response.status_code`→status_code; `model`.
   - `attrs` = JSON of full bag.
5. **`writer.ts`** - add `writeLogs(rows)` to `OtelWriterShape` + Live (UPSERT into
   `otel_log_event` via `recordRef` + `executeStatements`, numeric/option helpers).
6. **`contract/otel.ts`** - replace the `signal === "logs"` early-return no-op with
   decode→normalize→writeLogs (same fail-open shape as metrics/traces).
7. **schema** - `otel_log_event` DDL (SCHEMAFULL, fields above, INDEX on session_id)
   in `schema.surql` + `SCHEMA_TABLES`. `telemetry_of` unchanged (unconstrained).
8. **`correlate.ts`** - add `"otel_log_event"` to `RELATABLE`.
9. **docs** - correct the CLAUDE.md OTLP section ("logs now ingested → otel_log_event").

## Correlation note (verify during build)

`correlateOrphanOtel` links rows whose `session_id` matches an existing `session`
id. For Codex, `session_id` = `conversation.id`. Whether ax's codex transcript
ingest keys its `session` rows by that same uuid is unverified - check against a
real ingested codex session. If they match → `telemetry_of` edges draw; if not →
log rows stay queryable standalone (still useful for usage analytics). Either
way correlation is best-effort under `Effect.ignore`, so no risk.

## Testing (TDD)

- **normalize**: the committed `__fixtures__/codex-logs.json` → assert 3 rows
  (websocket_event dropped), sse_event row has token columns populated
  (input_tokens=9994, model gpt-5.5, session_id=conversation.id), user_prompt +
  conversation_starts rows present.
- **allowlist**: a payload with only `websocket_event`/`startup_phase` → 0 rows.
- **schema mirror**: new table registered (guard test).
- **writer**: `writeLogs([row])` issues `UPSERT otel_log_event:` with token cols; empty → no query.
- **handler**: post the fixture body to `handleOtlp("logs", …)` → writer called, ack `{partialSuccess:{}}`; malformed → ack, no write.
- **correlate**: orphan otel_log_event with a matching session → RELATE issued.

## Out of scope / deferred

- CC events live-capture (the claude allowlist entries are wired but only Codex
  is dogfood-verified here; CC events need `OTEL_LOGS_EXPORTER=otlp` which ax
  install does not yet set - follow-up).
- Cost USD derivation from codex token counts (ax cost analytics integration) -
  separate follow-up; this PR lands the raw token columns.
- Span ingestion for codex (if a future codex version emits a trace exporter).
