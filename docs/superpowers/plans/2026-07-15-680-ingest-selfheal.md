# #680 ingest self-heal + codex `ingest here` filter - Implementation Plan

> **For agentic workers:** strict TDD per task, failing test FIRST. Seam rule: fake only DB client / fs leaf, never the code path under test.

**Goal:** Stop codex files being permanently skipped on `agent_event_session_seq` ghost-index collisions (self-heal + retry + doctor surface), silence the `isoTimestamp undefined` warning on half-ingested sessions, and scope codex ingest to `$PWD` repo under `ingest here`.

**Architecture:** New pure heal module (`agent-event-index-heal.ts`) exposes duplicate-index detection + REBUILD planner + a `withAgentEventSeqHeal` wrapper (retry-once, rebuild-once-per-stage) + an unhealthy-marker (doctor surface). Wired into codex `processFile`. Session-health caller made NONE-safe. Codex stage gains a repo-scope filter via head-peek cwd.

**Tech Stack:** bun:test, Effect v4, SurrealDB.

## Global Constraints
- SurrealDB 3.x: `REBUILD INDEX [IF EXISTS] <name> ON <table>` is valid; it rebuilds the index from live rows, discarding ghost entries whose backing row is gone (a clear-by-primary-id can't remove those).
- Tests must NOT require a live SurrealDB; fake the client, use temp dirs for fs.
- Consult effect-solutions before new Effect.
- One conventional commit. Never stage BRIEF.md/REPORT.md.

---

### Task A: agent_event ghost-index self-heal
**Files:**
- Create `apps/axctl/src/ingest/agent-event-index-heal.ts`
- Test `apps/axctl/src/ingest/agent-event-index-heal.test.ts`
- Modify `apps/axctl/src/ingest/codex.ts` (wrap `processFile`, wire marker fs)
- Modify `apps/axctl/src/cli/install.ts` (doctor check reads marker)

**Exports:** `isAgentEventSeqDuplicateError`, `extractAgentSessionId`, `buildAgentEventSeqRepairStatements`, `AGENT_EVENT_SEQ_REPAIR_HINT`, `withAgentEventSeqHeal(effect, {db,state,onRepairAttempt?,onExhausted?,onHealed?})`, marker helpers `agentEventIndexMarkerPath` / `writeIndexUnhealthyMarker` / `clearIndexUnhealthyMarker` / `readIndexUnhealthyMarker`, `agentEventIndexDoctorCheck`.

- Detect: `DbError` whose message contains `agent_event_session_seq` (liberal - SurrealDB strings shift).
- Repair: `REBUILD INDEX IF EXISTS agent_event_session_seq ON agent_event;` - once per stage (guard via `state.repaired`).
- Retry the file effect once; second matching failure → `onExhausted` (write marker) then rethrow (per-file isolation skips w/ hint). Non-matching errors pass through untouched.
- Success after repair → `onHealed` (clear marker).
- Doctor: cheap `fs.exists(marker)` → warn with REBUILD remediation.

### Task B: isoTimestamp NONE-safe in session-health
**Files:** Modify `apps/axctl/src/ingest/session-health.ts` (`buildRows`); test in `apps/axctl/src/ingest/session-health.test.ts`.
- Skip a session with no `started_at` (half-ingested) → no usage/health row, no epoch warn. Recomputed next ingest.

### Task C: codex cwd filter for `ingest here`
**Files:**
- Create `apps/axctl/src/ingest/codex-scope.ts` (`cwdInRepoScope`, `codexCwdFromMetaLine`) + test.
- Modify `apps/axctl/src/ingest/codex.ts`: `CodexIngestOpts.repoRoots`; head-peek filter of discovered files; `codexStage` reads `ctx.repoPaths`.
- Modify `apps/axctl/src/cli/commands/ingest.ts`: default-skip set drops `codex` (keep pi/opencode/cursor); update skip message + `here` help copy.
- C2: verify `sessions.ts` stale copy is honest - no change (recommends `ingest here --since=7`, now genuinely ingests codex).

**Gates:** `bun run typecheck` == 0; `bun test apps/axctl/src/ingest apps/axctl/src/cli` green.
