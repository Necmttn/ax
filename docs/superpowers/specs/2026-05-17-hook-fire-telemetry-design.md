# Hook-Fire Telemetry - Design

**Date:** 2026-05-17
**Status:** Approved (Sections 1–4); Sections 5–6 deferred to follow-up.

## Goal

Capture every `axctl hook file-context` decision (inject and skip) into a queryable Surreal table so we can tune suppression, measure usefulness, and detect regressions from real data instead of vibes. Cover Claude Code in real time and Codex via transcript replay.

## Scope (week 1)

- Slice 1: real-time Claude Code fires written to `hook_fire`; `axctl hook log` reads them.
- Slice 2: Codex transcript replay synthesizes `hook_fire` rows.
- Out of scope this week: `/graph` panel, daily digest cron, generic `axctl events log`, `exec`-based path extraction, snapshot-time historical decisions.

## Architecture

```
                       ┌─────────────────────────────┐
 Claude Code PreToolUse│  axctl hook file-context    │
 (stdin: hook payload) │  (existing)                 │──┐
─────────────────────► └──────────────┬──────────────┘  │
                                      │ recordFire()    │ stdout: <ax_file_memory> or nothing
                                      ▼
                       ┌─────────────────────────────┐
                       │  HookTelemetry service       │
                       │  src/hooks/telemetry.ts     │
                       └──────────────┬──────────────┘
                                      │ writes via
                                      ▼
                       ┌─────────────────────────────┐
                       │  TelemetryBase helper       │
                       │  src/lib/telemetry-base.ts  │  ← reused by future telemetry kinds
                       └──────────────┬──────────────┘
                                      │ upsert
                                      ▼
                       ┌─────────────────────────────┐
                       │  SurrealDB: hook_fire       │
                       │  (per-kind schemafull table)│
                       └──────────────┬──────────────┘
                                      ▲
                                      │ synthesizes rows
                       ┌──────────────┴──────────────┐
                       │  src/ingest/codex.ts (+pass)│
                       └─────────────────────────────┘
```

**Boundaries.**
- `buildFileContextHookResponse` stays pure decision logic; knows nothing about telemetry.
- `HookTelemetry` Effect service owns writes; layer-overridable for tests.
- CLI handler orchestrates: time the call, build response, write telemetry via `Effect.forkDaemon` so stdout is never blocked.
- Codex ingest imports `HookTelemetry.recordFire` directly - no CLI round-trip.
- `axctl hook log` is a read-only query over `hook_fire`.

**Failure mode.** Telemetry write failure must never affect hook output. All writes wrapped in `Effect.catchAll` → log to stderr, swallow.

## Schema

### Common telemetry base

Exported as a SurrealQL snippet generator from `src/lib/telemetry-base.ts`. Every future telemetry table starts with these fields, top-level, SCHEMAFULL:

```surql
DEFINE FIELD ts          ON <T> TYPE datetime;
DEFINE FIELD kind        ON <T> TYPE string;
DEFINE FIELD session     ON <T> TYPE option<record<session>>;
DEFINE FIELD file        ON <T> TYPE option<record<file>>;
DEFINE FIELD file_path   ON <T> TYPE string;
DEFINE FIELD harness     ON <T> TYPE string;   -- claude | codex | unknown
DEFINE FIELD ok          ON <T> TYPE bool;
DEFINE FIELD latency_ms  ON <T> TYPE int;
```

### `hook_fire`

```surql
DEFINE TABLE hook_fire SCHEMAFULL;
-- + common base fields
DEFINE FIELD event                     ON hook_fire TYPE string;   -- pre-edit | read | write | search | unknown
DEFINE FIELD inject                    ON hook_fire TYPE bool;
DEFINE FIELD reason                    ON hook_fire TYPE string;
DEFINE FIELD prior_sessions_considered ON hook_fire TYPE int;
DEFINE FIELD task_excerpt              ON hook_fire TYPE string;
DEFINE FIELD top_prior_sessions        ON hook_fire TYPE array<record<session>>;

DEFINE INDEX hook_fire_by_ts      ON hook_fire FIELDS ts;
DEFINE INDEX hook_fire_by_session ON hook_fire FIELDS session;
DEFINE INDEX hook_fire_by_file    ON hook_fire FIELDS file;
DEFINE INDEX hook_fire_by_reason  ON hook_fire FIELDS reason;
```

**Record ID (deterministic for Codex replay dedup):**
```
hook_fire:`{sha1(harness | session_id | file_path | ts_ms | event).slice(0,16)}`
```

### Intentionally NOT in schema

- `stdin_payload` - re-derivable: re-run hook against same file, or read transcript on inject.
- `rendered_context` - same.
- `evidence: object` JSON blob - defer; current shape covers the analytics questions.

## Slice 1 - real-time Claude Code

**Deliverables:**

1. `src/lib/telemetry-base.ts` - `TelemetryBaseRow` interface, `deterministicId(parts)`, `writeRow(table, row)`, schema snippet generator.
2. `schema/hook_fire.surql` - table + fields + indexes; hooked into existing schema bootstrap.
3. `src/hooks/telemetry.ts` - `HookTelemetry` Effect service exposing `recordFire(input, decision, ctx)`; resolves harness, file record id, session id, clips `task_excerpt` to 240 chars, picks top 3 prior session ids; `Effect.catchAll` to stderr.
4. CLI wiring in `hookFileContextCommand` - measure `performance.now()`, call `recordFire` via `Effect.forkDaemon` after stdout flush.
5. `axctl hook log` subcommand - flags: `--tail`, `--since`, `--reason`, `--file`, `--inject`, `--harness`, `--json`; default output is TSV.
6. Claude Code wiring docs - PreToolUse hook entry in `~/.claude/settings.json` matching `Edit|Write|MultiEdit|Read`; settings recipe lives in `docs/HOOKS.md` (new) or extends `skills/axctl/SKILL.md`.
7. Claude payload adapter - extend `parseFileContextHookStdin` to map `{ hook_event_name, tool_name, tool_input.file_path, session_id }` to our `FileContextHookInput`. Event mapping: `PreToolUse + (Edit|Write|MultiEdit) → pre-edit`; `PreToolUse + Read → read`; `PreToolUse + (Grep|Glob) → search`; else `unknown`. `task` left empty when not provided.

**Exit criteria:**
- Edit a file in Claude Code → row appears in `hook_fire` within 1 s.
- `axctl hook log --tail 5` shows the fire.
- Suppressed paths (lockfiles) produce rows with `inject:false reason:suppressed_path`.
- DB down → hook still emits stdout; failure logged to stderr.

## Slice 2 - Codex replay synthesis

**Where it runs.** New pass inside `src/ingest/codex.ts`, after transcript ingestion. Respects existing `--since` semantics; full sweep on `axctl ingest --codex-only` without `--since`.

**What synthesizes.** For each Codex `tool_call` where `tool_name === "apply_patch"` and a file path can be extracted from patch headers, emit one `hook_fire` row per file touched. `exec`-based path extraction (`sed -i`, `tee`, `> file`) deferred.

**Row construction.**
- `harness: "codex"`, `event: "pre-edit"`, `ts: tool_call.ts`.
- `session`: existing Codex session record id.
- `file`: resolved by path; may be undefined.
- `file_path`: from patch header.
- `task_excerpt`: last user turn before `ts`, clipped 240 chars.
- Decision = `shouldInjectFileMemory({ files: [file_path], priorFileSessions })`, where `priorFileSessions` are scoped to sessions with `ts < tool_call.ts` to avoid leaking the current session's own edits into its own "prior".
- `latency_ms: 0` (synthesized, not measured).
- `ok: true`.

**Sub-agents.** Codex sessions running as sub-agents are included as the *subject* of a fire; the prior_file_sessions decision query continues to exclude `claude-subagent` sources (consistent with real-time logic).

**Historical limitation.** Decision is computed against today's graph, not the graph as of `tool_call.ts`. Documented inline in `src/ingest/codex.ts`.

**Backfill on first deploy.** First run after Slice 2 ships sweeps existing Codex sessions, capped at last 90 days, one-shot via `axctl hook backfill --since 90d`. Subsequent ingest runs only synthesize for new sessions.

**Exit criteria:**
- `axctl ingest --codex-only` produces `hook_fire` rows for each apply_patch in new sessions.
- Re-running ingest does not duplicate rows (deterministic ID upsert).
- `axctl hook log --harness codex --tail 10` shows synthesized rows.

## Out of scope (follow-up slice)

- `/graph` "Hook fires" panel.
- Daily digest cron summarising inject rate, top suppress reasons, top files.
- Generic `axctl events log` cross-table union.
- `exec`-based file path extraction for Codex.
- Snapshot-time historical decision computation.

## Open risks

- **Task text missing on real-time fires.** Claude Code PreToolUse payload doesn't carry the original user prompt directly. Slice 1 leaves `task` empty; a follow-up may pull from the last user turn of the live transcript at `transcript_path`. Decision logic does not require task text - only `prior_file_sessions` evidence matters.
- **Hot-path latency.** Every Edit fires the hook. Budget: < 200 ms p95 measured by `latency_ms`. If we exceed, add a foreground cache of file→prior_sessions for N minutes.
- **Storage growth.** Bounded by edit frequency; ~9 fields × ~100 fires/day = trivial in Slice 1. Re-evaluate at week 2.
