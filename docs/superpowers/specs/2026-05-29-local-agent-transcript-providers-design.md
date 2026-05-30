# Local Agent Transcript Providers - Design

**Status:** draft
**Date:** 2026-05-29
**Author:** brainstorm w/ Necmttn

## Motivation

AX already ingests Claude Code transcripts, Codex sessions, installed skills,
and git evidence into a local graph. The next step is broader local agent
coverage: Pi, OpenCode, and Cursor should appear in the same recall,
workflow, wrapped, health, and dashboard surfaces without losing provider
specific structure.

The key issue is that the existing AX model is mostly linear:
`session -> turn(seq) -> tool_call`. That works for Claude and Codex. It is
not enough for Pi, whose session files are explicit trees through `id` and
`parentId`; it is also too narrow for Cursor and OpenCode, where useful local
state may be split between SQLite rows, JSON blobs, sidecar files, and project
metadata.

This design introduces a provider event graph beneath the existing AX
projection tables. Provider adapters write a lossless local evidence graph
first, then project compatible data into `session`, `turn`, `tool_call`,
`plan`, `session_token_usage`, and existing derived-signal stages.

## Provider Evidence

- Claude Code: existing local JSONL transcripts under `~/.claude/projects/`.
- Codex: existing local JSONL sessions under `~/.codex/sessions/`.
- Pi: documented JSONL sessions under
  `~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl`; entries form a
  tree through `id` / `parentId`.
  Source: <https://pi.dev/docs/latest/session>
- OpenCode: local app/session data under `~/.local/share/opencode/`, including
  SQLite-backed session data on this machine.
  Source: <https://dev.opencode.ai/docs/troubleshooting/>
- Cursor: chat history is local SQLite according to Cursor's history docs.
  This machine has VS Code-style `state.vscdb` files under
  `~/Library/Application Support/Cursor/User/`.
  Source: <https://docs.cursor.com/agent/chat/history>

## Goals

- Preserve provider-native session evidence without flattening it too early.
- Make Claude, Codex, Pi, OpenCode, and Cursor first-class local providers in
  the same graph model.
- Keep existing AX user surfaces working while the provider graph grows:
  recall, sessions, wrapped, tool failures, skill taste, session health, and
  dashboard source filters.
- Support branched/tree conversations, starting with Pi, without forcing every
  existing query to understand branches immediately.
- Keep provider adapters isolated so Pi, OpenCode, and Cursor can be built in
  parallel after the shared substrate lands.
- Stay local-first. No cloud APIs, remote history scraping, or shared-session
  URL import in this spec.

## Non-Goals

- Importing `pi.dev/session/#...` shared links. URL import can be a later
  adapter once local Pi support is solid.
- Importing Cursor Background Agent remote chats. Cursor documents those as
  remote rather than normal local history.
- Replacing `session`, `turn`, or `tool_call` in one migration. Existing AX
  tables remain the compatibility projection layer.
- Building a full provider-specific dashboard for every source in the first
  implementation slice.

## Architecture

```
local provider artifacts
  Claude JSONL      Codex JSONL      Pi JSONL tree      OpenCode DB/files      Cursor SQLite
       │                │                │                    │                    │
       ▼                ▼                ▼                    ▼                    ▼
 provider adapters: claude | codex | pi | opencode | cursor
       │
       ▼
 provider event graph
   agent_provider
   agent_session
   agent_event
   agent_event_child
       │
       ▼
 AX projection
   session
   turn
   tool_call
   plan / plan_item / plan_snapshot
   session_token_usage
       │
       ▼
 existing derive stages + product surfaces
   recall, wrapped, session health, skills, graph explorer, dashboard
```

The event graph is the source-preserving layer. AX projection tables are the
query-stable layer. A provider can ingest rich native evidence even if only a
subset is immediately useful to recall or session health.

## Data Model

### `agent_provider`

One row per supported provider.

Fields:

- `name`: stable provider id: `claude`, `codex`, `pi`, `opencode`, `cursor`.
- `display_name`: user-facing name.
- `version`: optional provider/app version observed during ingest.
- `capabilities`: JSON string, e.g. `{"tree":true,"tool_calls":true}`.
- `created_at`, `updated_at`.

### `agent_session`

Provider-native session identity.

Fields:

- `provider`: `record<agent_provider>`.
- `provider_session_id`: provider's native session id.
- `ax_session`: optional `record<session>` projection row.
- `cwd`, `project`, `title`, `model`, `source_path`.
- `started_at`, `ended_at`.
- `raw`: JSON string for header/session metadata.
- `labels`, `metrics`: JSON strings.

Unique index: `provider, provider_session_id`.

### `agent_event`

Every provider-native event or message.

Fields:

- `agent_session`: `record<agent_session>`.
- `ax_session`: optional `record<session>`.
- `provider`: `record<agent_provider>`.
- `provider_event_id`: native event id when available.
- `parent_provider_event_id`: native parent id when available.
- `seq`: provider file/order sequence.
- `ts`: event timestamp.
- `type`: provider-native event type, e.g. `message`, `model_change`,
  `tool_call`, `compaction`, `branch_summary`, `custom`.
- `role`: optional normalized role: `user`, `assistant`, `tool`, `system`,
  `custom`.
- `text`, `text_excerpt`.
- `raw`: JSON string of the original event.
- `labels`, `metrics`: JSON strings.

Indexes:

- `agent_event_session_seq` on `agent_session, seq`.
- `agent_event_provider_id` on `provider, provider_event_id`.
- `agent_event_session_ts` on `agent_session, ts`.
- full-text index on `text_excerpt` if query tests show value beyond existing
  `turn` recall.

### `agent_event_child`

Relation from parent `agent_event` to child `agent_event`.

Fields:

- `agent_session`
- `provider`
- `kind`: `parent`, `branch`, `fork`, `projection`.
- `ts`

Pi writes this relation directly from `id` / `parentId`. Claude and Codex can
write linear parent edges between adjacent events. Cursor and OpenCode write
native parent/thread edges when extractable and linear edges otherwise.

### Projection Links

Add optional links back to native evidence:

- `turn.agent_event`: `option<record<agent_event>>`
- `tool_call.agent_event`: `option<record<agent_event>>`
- `plan_snapshot.agent_event`: `option<record<agent_event>>`

These fields let session inspect and debugging jump from normalized AX rows
back to raw provider evidence.

## Provider Adapter Contract

Each adapter implements the same three phases:

1. `discover(config, since)`: return candidate local artifacts.
2. `extract(artifact)`: stream provider events and session metadata.
3. `project(events)`: produce AX-compatible writes for session, turn,
   tool_call, plan, and token usage.

Provider adapters should be deterministic and idempotent. Stable record keys
derive from `provider + provider_session_id + provider_event_id` when possible,
falling back to file path plus sequence hash.

Adapters must emit:

- provider session row
- raw event rows
- parent/child edges where known
- projected `session` row
- projected `turn` rows for user/assistant/tool-result messages

Adapters may emit:

- `tool_call`
- synthetic skill invocations, e.g. `pi:bash`, `opencode:edit`,
  `cursor:agent_edit`
- plans and plan snapshots
- token usage
- file read/edit relations

## Provider Details

### Claude Code

Current state:

- `src/ingest/transcripts.ts` reads Claude JSONL transcripts.
- It already emits `session`, `turn`, `tool_call`, `invoked`, `edited`, plans,
  hook telemetry, and related evidence.

New behavior:

- Claude ingest also writes `agent_provider:claude`, `agent_session`, and one
  `agent_event` per transcript line.
- Adjacent transcript lines get `agent_event_child` linear edges.
- Existing projection remains authoritative during migration; it gains
  `agent_event` back-links where practical.

Reasoning:

Claude is already a mature adapter. It should be brought under the provider
graph to avoid making Pi/OpenCode/Cursor special cases.

### Codex

Current state:

- `src/ingest/codex.ts` streams JSONL files under `~/.codex/sessions`.
- It handles function calls, function outputs, synthetic `codex:<tool>` skills,
  plan snapshots, raw snapshotting, and payload compaction.

New behavior:

- Codex ingest writes `agent_provider:codex`, `agent_session`, and one
  `agent_event` per parsed line or response item.
- Function calls and outputs link to their native event rows.
- Existing `session.source = "codex"` projection remains stable.

Reasoning:

Codex is the closest template for streaming provider adapters and should guide
the Pi implementation style.

### Pi

Discovery:

- Read `AX_PI_DIR` when set.
- Then read Pi settings only if they expose an explicit session directory key.
- Default to `~/.pi/agent/sessions`.
- Walk `**/*.jsonl`, filtered by `--since` using file mtime.

Extraction:

- First line is a `session` header with `id`, `version`, `timestamp`, `cwd`,
  and optional `parentSession`.
- All non-header entries become `agent_event` rows.
- `id` and `parentId` create `agent_event_child` edges.
- Preserve all known entry types:
  `message`, `model_change`, `thinking_level_change`, `compaction`,
  `branch_summary`, `custom`, `custom_message`, `label`, `session_info`.
- Preserve unknown entry types as raw events with `type` unchanged.

Projection:

- `message.message.role = "user"` becomes a user `turn`.
- `message.message.role = "assistant"` becomes an assistant `turn`.
- Content blocks of type `text` become turn text.
- Assistant content blocks of type `toolCall` become `tool_call` rows and
  synthetic `pi:<tool>` skill invocations.
- Tool result messages become tool-result turns and update matching tool calls
  when an id is available.
- Usage data from assistant messages rolls up into `session_token_usage`.
- Model changes update `agent_session.model`; projected `session.model` uses
  the latest model or the model with the most assistant usage.

Branch semantics:

- Store the full tree in `agent_event_child`.
- Project all message events into `turn` rows in file/sequence order for v0
  compatibility.
- Mark branch metadata in `turn` labels/metrics so future queries can restrict
  to a selected branch.
- A later dashboard view can render the event tree directly from
  `agent_event_child`.

### OpenCode

Discovery:

- Read `AX_OPENCODE_DIR` when set.
- Default to `~/.local/share/opencode`.
- Inspect `opencode.db` and sidecar storage under `storage/`.
- Include versioned or alternate DB names if discovered in the same directory.

Extraction:

- Treat SQLite rows as source-of-truth when available.
- Treat sidecar JSON such as `storage/session_diff/*.json` as supplemental
  artifact evidence.
- Adapter starts read-only and defensive: unknown tables/columns are skipped
  with an ingest warning, not a hard failure.

Projection:

- Session rows become `agent_session` and projected `session` rows.
- Message rows become `agent_event` and `turn` rows.
- Tool/action rows become `tool_call` rows when table semantics are known.
- Snapshot/session diff files can become `artifact` rows or event raw payloads
  when linked to a session id.

Risk:

OpenCode local storage is discoverable and local, but less stable than Pi's
documented JSONL. The adapter should ship with schema introspection tests and
fixture-based parser tests.

### Cursor

Discovery:

- Read `AX_CURSOR_USER_DIR` when set.
- macOS default:
  `~/Library/Application Support/Cursor/User`.
- Search `globalStorage/state.vscdb` and `workspaceStorage/*/state.vscdb`.
- Do not read Cursor auth tokens or unrelated secrets.
- Cursor is included in normal local ingest. Privacy protection comes from
  strict key allowlisting and read-only DB access, not from disabling the
  provider by default.

Extraction:

- Open SQLite read-only.
- Inspect known chat/composer keys and blobs from `ItemTable` and
  `cursorDiskKV`.
- Decode JSON blobs only when their key matches a recognized Cursor chat,
  composer, or agent-history prefix.
- Record source DB path and key in `agent_event.raw`/labels for debugging.

Projection:

- Conversations become `agent_session` and projected `session` rows.
- Chat messages become `agent_event` and `turn` rows.
- `bubbleId:*` rows with `toolFormerData` become shared `tool_call` rows,
  stable `cursor:<tool>` synthetic skill invocations, and tool-call provenance
  edges.
- Generic `tool_calls`/`function_call` message fields are parsed best-effort
  when the tool name is explicit. Cursor tool activity is skipped when the raw
  blob does not expose a clear tool identity.

Risk:

Cursor documents local SQLite chat history but not a stable public schema.
This adapter is best-effort and version-guarded. It should never fail a full
AX ingest because one Cursor key changed shape.

## Migration Strategy

1. Add schema for provider/event graph and projection links.
2. Add adapter interface and shared record-key helpers.
3. Retrofit Claude and Codex to dual-write provider events and existing
   projections.
4. Add Pi adapter as the reference new provider.
5. Add OpenCode and Cursor adapters against the same contract.
6. Update derive stage dependencies from `claude,codex` to include all local
   transcript providers where applicable.
7. Update UI/source filters and CLI help.

This is additive. Existing rows remain valid. Existing queries can continue
to read `session`, `turn`, and `tool_call`.

## CLI and Config

Config additions:

- `AX_PI_DIR`
- `AX_OPENCODE_DIR`
- `AX_CURSOR_USER_DIR`
- Optional `AX_AGENT_PROVIDER_DIRS` later if a generic provider registry is
  added.

Stage registry:

- Keep existing stage keys `claude` and `codex`.
- Add `pi`, `opencode`, `cursor`.
- Add a `providers` tag for all five provider stages.
- Keep `derive` stages separate.

CLI:

- `axctl ingest --stages=pi`
- `axctl ingest --stages=opencode,cursor`
- Removed `--transcripts-only` replacement becomes
  `--stages=claude,codex,pi,opencode,cursor`.
- Dashboard filters include all sources:
  `all`, `claude`, `codex`, `pi`, `opencode`, `cursor`.

## Error Handling

- Missing provider directories are not errors; they produce zero counts.
- Unreadable files or SQLite DBs produce ingest warnings with path and provider.
- Malformed records are skipped with counters and debug logs.
- Provider adapters must not throw on unknown event types. Unknown events are
  preserved as raw `agent_event` rows when possible.
- Cursor/OpenCode schema drift should degrade only those adapters, not the
  entire ingest run.

## Testing

Unit tests:

- Record-key generation for provider sessions/events.
- Adapter discovery path resolution for each provider.
- Pi JSONL parser with tree, branch, label, model, and tool-call fixtures.
- Claude/Codex dual-write fixtures proving existing projections are unchanged.
- OpenCode SQLite fixture with known rows.
- Cursor `state.vscdb` fixture with recognized keys and unrelated secret-like
  keys that must be ignored.

Stage tests:

- Each provider stage reports counts:
  `files`, `sessions`, `events`, `turns`, `toolCalls`, `skipped`, `warnings`.
- `--since` filters by artifact mtime without losing active sessions.
- Full pipeline runs derive stages after provider stages.

Regression tests:

- Recall sees Pi/OpenCode/Cursor projected user/assistant text.
- Session list source filters include all five providers.
- Wrapped and session health include provider sessions through normal
  projection tables.
- Graph integrity check catches orphaned `agent_event_child` edges.

## Parallel Work Plan

Milestone A must land first:

- schema
- adapter interface
- shared event writers
- stage registration shape
- Claude/Codex dual-write proof

After Milestone A, provider adapters can run in parallel:

- Pi: JSONL tree adapter.
- OpenCode: SQLite/files adapter.
- Cursor: SQLite best-effort adapter.

The parallel adapters should not edit shared projection code directly. They
should emit provider-normalized events and use shared projection helpers.

## Open Questions

No unresolved design questions remain for the implementation plan. The plan
may still discover provider-specific field names while building fixtures, but
those are adapter details rather than product or schema decisions.

## Acceptance Criteria

- Running `axctl ingest --stages=claude,codex,pi,opencode,cursor` succeeds when
  any subset of provider directories exists.
- Claude and Codex still produce the same existing `session`, `turn`, and
  `tool_call` projections.
- Pi sessions preserve every local entry and parent edge.
- OpenCode and Cursor sessions import best-effort local history without
  crashing the pipeline on unknown schema.
- Recall and session list can show projected sessions from all five providers.
- Existing `axctl ingest` remains backward-compatible and local-first.
