# Phase 4: Parser Normalization Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every harness parser an adapter that produces a `NormalizedTranscriptBatch` (+ explicitly-listed parser-specific extras), so dual-write statement composition lives in exactly one place: `apps/axctl/src/ingest/normalized/transcripts.ts` (normalized records + agent_* wiring via `provider-events.ts`). Re-ingesting the same transcripts must produce an **identical statement multiset** (byte-level), with every intentional delta documented in the ledger below. Also extract the duplicated `walkJsonlFiles` directory walkers (codex/pi) into one shared module.

**Architecture:** The Derivation Engine consumes normalized `session`/`turn`/`tool_call` records; provider-specific parsers feed it through adapters and never define its domain model. Each parser keeps its raw-input extraction (`createXExtractor`/`extractXDatabase`) untouched and gains a pure `toXNormalizedBatch(extract) => NormalizedTranscriptBatch` mapping; `buildXBatchStatements` becomes a one-liner delegating to `buildNormalizedTranscriptStatements(batch, opts) ++ parserExtraStatements`. Five adapters over one real seam.

**Scope guard (ADR-0006 stays intact):** This is WITHIN-stage normalization of how one Ingest Stage composes its own write statements. It does NOT introduce inter-stage in-memory row passing - stages still communicate through SurrealDB, deps still express ordering only, and every `StageDef`/`BaseStageStats` contract is unchanged. See `docs/adr/0006-typed-stats-as-ingest-stage-contract.md`.

**Tech Stack:** bun ≥ 1.3, TypeScript strict, Effect v4 beta (`effect@beta`), SurrealDB statements via `@ax/lib/shared/surql` + `@ax/lib/shared/statement-exec`, tests with bun:test (colocated `*.test.ts`). No new Effect APIs are needed - all builders are pure `(...) => string[]` functions; the only effectful code touched (`ingestTranscripts` write block, walk functions) reuses existing patterns (`Effect.gen`, `FileSystem`, `skipNotFound`, `orAbsent`, `classifyNoFollow`).

**Verification commands** (run from repo root):
- `bun test apps/axctl/src/ingest/<file>.test.ts` per task; `bun test apps/axctl` for sweeps.
- `bun run typecheck` after every task.
- NOTE (memory/test_runner.md): a global hook may block bare `bun test`; if blocked, invoke through a tmp wrapper script (e.g. `printf '#!/bin/sh\nexec bun test "$@"\n' > /tmp/bt && chmod +x /tmp/bt && /tmp/bt <path>`).

---

## 0. Current state (verified against source, 2026-06-10)

| Parser | File | Statement builder today | Already on the seam? |
|---|---|---|---|
| OpenCode | `apps/axctl/src/ingest/opencode.ts` (~1,006 LOC) | `buildOpenCodeBatchStatements` (lines 807–878) **already calls `buildNormalizedTranscriptStatements`** | ✅ yes - it is the template/precedent |
| Cursor | `apps/axctl/src/ingest/cursor.ts` (~1,095 LOC) | `buildCursorBatchStatements` (907–957) + private `buildTurnStatements` (878–887), `buildSyntheticSkillAndInvocationStatements` (889–905) | ❌ |
| Pi | `apps/axctl/src/ingest/pi.ts` (~888 LOC) | `buildPiBatchStatements` (728–781) + private turn/synthetic builders (666–693) + `buildPiTokenUsageStatements` (695–726) | ❌ |
| Codex | `apps/axctl/src/ingest/codex.ts` (~1,808 LOC) | `buildCodexBatchStatements` (1412–1436) + `buildCodexProviderStatements` (1274–1324), turn/synthetic builders (1244–1270), token-usage builders (1326–1410) | ❌ |
| Claude | `apps/axctl/src/ingest/transcripts.ts` (~1,884 LOC) | No single batch builder - seven separate write calls in `ingestTranscripts` (1733–1756): `writeClaudeTokenUsage`, `upsertTurns`/`buildTurnStatements` (1228–1242), `writeProviderEvidence`/`buildClaudeProviderStatements` (1371–1416), `writeCompactions`, `writeToolCallStatements`, `writeToolFileEvidence`, `relateToolCallSkills`, `writePlanSnapshots`, plus `relateInvocations` (1277–1333) and `writeHookEvidence` (1362–1369) | ❌ |

Contrary to the original brief, **opencode is already converted** - it proves the seam works and pins the conversion pattern. The pilot below is therefore **cursor** (single-shot extract, smallest extras gap: only `compactions`; no token usage, no plan snapshots, no parent edges, no streaming, and its `__testBuildCursorBatchStatements` fixture tests already exist).

`buildAgentEventStatements` (`provider-events.ts` 320–331) already takes `{ clearExisting }` - the normalized builder just needs to forward it.

---

## 1. Gap analysis - what each parser's statements contain BEYOND `NormalizedTranscriptBatch`

Legend: **(a)** extend `NormalizedTranscriptBatch` · **(b)** keep as parser-specific extra (appended statements or separate write) · **(c)** already covered by the existing batch fields.

### 1.1 Claude (`transcripts.ts`)

| Artifact | Today (file:lines) | Decision | Rationale |
|---|---|---|---|
| `agent_provider` / `agent_session` / `agent_event` (+within-batch parent edges) | `buildClaudeProviderStatements` 1371–1413 | **(c)** `providers`/`sessions`/`events` | Already routed through the shared `provider-events.ts` builders; mapping-only |
| `turn` UPSERTs | `buildTurnStatements` 1234–1242 | **(c)** `turns` (with `agentEvent: null`) | Needs Task 1's "omit `agent_event` when absent" so output is byte-identical |
| `tool_call` / `tool` | `writeToolCallStatements` 1356–1357 | **(c)** `toolCalls` | Same shared builder |
| `read_file`/`edited`/`searched_file` evidence | `writeToolFileEvidence` 1335–1338 | **(c)** `toolFileEvidence` (pass `extractToolFileEvidence(toolCalls)`) | Same shared builder |
| `concerns` tool-call↔skill edges | `relateToolCallSkills` 1340–1346 | **(c)** `toolCallSkillRelations` | Catalog resolution (`resolveSkillName`) stays in `ingestTranscripts`; adapter receives the resolved list |
| `invoked` edges (REAL skills) | `relateInvocations` 1277–1333 | **(b)** stays as-is | Effectful: reads the skill catalog from the DB and pre-upserts `scope:'unknown'` placeholders without clobbering real rows. Routing it through `buildNormalizedSyntheticSkillInvocationStatements` would MERGE synthetic scope/hash onto real skill rows - a data corruption, not a refactor |
| `plan_snapshot` | `writePlanSnapshots` 1348–1354 | **(a)** add `planSnapshots` | Shared `buildPlanSnapshotStatements` already exists; codex needs it too |
| `compaction` rows | `writeCompactions` 1359–1360 | **(a)** add `compactions` | Shared `buildCompactionStatements`; pi/cursor/codex need it too |
| `harness_hook_event` / `hook_command_invocation` | `writeHookEvidence` + builders 1264–1272 | **(b)** parser-specific extra write | Claude-only tables (ADR-0004); no second producer, so widening the batch would be a pretend-seam |
| `session_token_usage` / `turn_token_usage` | `buildClaudeTokenUsageStatements` 1431–1469, `buildClaudeTurnTokenUsageStatements` 1476–1513 | **(b)** | Pricing/labels/usage-quality semantics are provider-specific (claude prices via `normalizeModelName`, codex via delta-vs-total, pi has no costs). Normalizing token usage is a separate future seam |
| `edits[]` | extractor only; **never written** (only `editCount`) | **(c)**/n.a. | Stays on `FileExtract` for stats |
| `session` row upsert, transcript snapshot, watermark, skill-catalog read | 1171–1226, 1657–1677 | **(b)** flow-level, unchanged | SDK calls + control flow, not statement composition |

### 1.2 Codex (`codex.ts`)

| Artifact | Today (file:lines) | Decision | Rationale |
|---|---|---|---|
| provider/session/events with **`clearExisting` first-batch-only** | `buildCodexProviderStatements` 1274–1324, flag threading 1582–1596 | **(c)** + **(a)** add `options.clearExisting` to `buildNormalizedTranscriptStatements` | `buildAgentEventStatements` already supports it; the batch builder must forward it (streaming re-clears would wipe the run's own events) |
| **Cross-batch** `agent_event_child` edges | `batch.parentEdges` (extractor 597–614), emitted 1425–1427 | **(a)** add `agentEventParentEdges` | Within-batch edges come from `buildParentEdgeStatements`; edges to parents flushed in an EARLIER streaming batch must be passed explicitly |
| `turn` UPSERTs (no `agent_event` field, `has_error: false` hardcoded) | `buildTurnStatements` 1244–1248 | **(c)** `turns` with `agentEvent: null`, `hasError: false` | Needs Task 1 omission change for byte parity |
| tool-call **payload compaction** (`compactCodexToolCall`, 286–304, `payloadMaxBytes`) | applied inside batch builder 1421–1423 | **(c)** transform at adapter boundary | `toolCalls: batch.toolCalls.map(c => compactCodexToolCall(c, payloadMaxBytes))` |
| tool-file evidence **from UNcompacted calls** | 1424 | **(c)** explicit `toolFileEvidence: extractToolFileEvidence(batch.toolCalls)` | Must be computed before compaction - passing the field explicitly preserves this exactly |
| synthetic `skill` + `invoked` (`codex:<tool>`) | 1250–1270 | **(c)** `syntheticSkillInvocations` (`skillScope: "codex-tool"`, `skillContentHash: "codex"`) | Needs Task 1 SET-order fix for byte parity |
| `concerns` edges | 1429–1431 | **(c)** `toolCallSkillRelations` | |
| `plan_snapshot` (update_plan) | 1432–1434 | **(a)** `planSnapshots` | |
| `compaction` rows (payload-size compaction events) | 1435 | **(a)** `compactions` | |
| `session_token_usage` / `turn_token_usage` | 1326–1410, emitted 1418/1420 | **(b)** appended extras | Codex-specific delta/total semantics, `context_window`, `token_count_events` metrics |
| streaming flush loop, session upsert before/after, raw artifact snapshot | 1583–1690 | **(b)** flow-level, unchanged | |
| Sessionless drained batch (`!batch.session`) | old builder emits token/turn/tool statements but NO provider/session/event statements | **(c)** preserve: adapter emits `providers: []`, `sessions: []`, `events: []` when `session === null` | Production guards on `batch.session` anyway; preserve the test-seam edge behavior |

### 1.3 Pi (`pi.ts`)

| Artifact | Today (file:lines) | Decision | Rationale |
|---|---|---|---|
| provider/session/events | 729–771 | **(c)** | `version: String(session.version)`, `capabilities.providerGraph` map cleanly |
| `turn` UPSERTs **with `agent_event` ref** | 666–675 | **(c)** `turns` with `agentEvent: { provider:"pi", providerSessionId, providerEventId, seq: providerEventSeq }` | `agentEventRecordKey` handles `providerEventId: null` → `seq_` key, exactly as today |
| tool calls / tool-file evidence | 773–774 | **(c)** | |
| synthetic `skill` + `invoked` (`pi:<tool>`) | 677–693 | **(c)** (`skillScope: "pi-tool"`, hash `"pi"`) | |
| `concerns` edges | 776–778 | **(c)** | |
| `compaction` rows | 779 | **(a)** `compactions` | |
| `session_token_usage` | `buildPiTokenUsageStatements` 695–726, emitted 780 | **(b)** appended extra | pi has no cost estimation; labels via `surrealJsonTextOption` |
| `skipped`/`warnings` | extract fields | n.a. | Stats only, never statements |

### 1.4 Cursor (`cursor.ts`) - PILOT

| Artifact | Today (file:lines) | Decision | Rationale |
|---|---|---|---|
| provider/session/events | 908–949 | **(c)** | Sessions carry `title` (already a `NormalizedSessionWrite` field) and **no** cwd/project/model - leave those `undefined` so `toAgentSession` omits them, byte-identical |
| `turn` UPSERTs with `agent_event` ref | 878–887 | **(c)** | |
| tool calls | 951 | **(c)** | |
| **NO tool-file evidence today** | absent from 907–957 | **(c)** preserve: do NOT pass `toolFileEvidence` | Adding evidence would change DB output - explicitly out of scope |
| synthetic `skill` + `invoked` (`cursor:<tool>`) | 889–905 | **(c)** (`skillScope: "cursor-tool"`, hash `"cursor"`) | |
| `concerns` edges | 953–955 | **(c)** | |
| `compaction` rows (summarizedComposers) | 956 | **(a)** `compactions` | |
| minimal `session` row upsert (no project/cwd/model) | 1047–1054 | **(b)** flow-level, unchanged | |

### 1.5 OpenCode (`opencode.ts`)

Already on the seam (807–878). Only impact: Task 1's invoked-SET reorder changes its emitted edge statement **text** (not record ids, not field values) - see ledger delta D1. No code change needed beyond test expectations if any assert ordering (current tests use `.includes`, so none expected).

---

## 2. Statement-text delta ledger (the ONLY permitted output changes)

The parity harness compares **sorted statement multisets byte-for-byte**, so cross-section ordering differences are absorbed; everything else must be identical. Two deliberate canonicalizations land in Task 1 *before* any parser converts, each chosen so the four unconverted parsers become byte-identical:

| # | Delta | Justification |
|---|---|---|
| **D1** | `buildNormalizedSyntheticSkillInvocationStatements` RELATE `SET` order changes from `ts, session, args, turn_has_error, turn_index` to `session, ts, args, turn_has_error, turn_index`. | Matches the legacy order used by cursor/pi/codex (and claude's `relateInvocations`) so those conversions are byte-identical. Only **opencode's** emitted text changes; SET-field order is semantically irrelevant (same edge key `invokedRelationRecordKey`, same values → same DB row on re-ingest). |
| **D2** | `buildNormalizedTurnStatements` **omits** the `agent_event` key when `turn.agentEvent` is null (previously emitted `agent_event: NONE`). | Matches legacy claude/codex turn statements which have no `agent_event` field. `UPSERT … CONTENT` on a SCHEMAFULL table sets an absent `option<record>` field to `NONE` - identical end state. No current caller passes `agentEvent: null` (opencode always passes a ref), so no existing output changes. |
| **D3** | Cross-section statement ORDER may differ (e.g. codex token-usage statements move from "before turns" to "after the normalized batch"). | All statements are independent idempotent UPSERT/RELATE with record-id links that don't require target existence; `executeStatements` already chunks at 500 so there was never cross-section atomicity. Parity harness compares multisets; each parser task additionally relies on `buildAgentEventStatements` internal ordering (clears before event upserts) which is unchanged. |
| **D4** | Claude/codex interpolations like `ts: d"${t.ts}"`, `role: "${t.role}"`, `session: session:\`${t.session}\`` become `surrealDate`/`surrealString`/`recordRef`. | Byte-identical for all well-formed inputs (ISO timestamps, word roles, sanitized record keys - `recordRef` escaping is identity on `turnRecordKey` output, `surrealLiteral === surrealString` per `packages/lib/src/json.ts:25`). Inputs that would differ (a quote inside a role/timestamp) produced **broken SQL** before; the new path escapes them. Fixture parity tests prove the identical case. |
| **D5** | Claude's seven per-section `executeStatements` calls collapse into one labeled `"normalizedBatch"` call (token usage, hooks, and `invoked` edges stay separate). | DB end-state identical (same statement multiset, proven by the Task 6 parity test). Observability: seven span labels become one - acceptable; per-statement timing was never recorded, and `AX_DB_QUERY_LOG` still pins individual statements. |

Any other diff found by a parity test is a **bug in the conversion** - fix the adapter, never the harness.

---

## 3. Tasks

### Task 1 - Extend the normalized seam (`NormalizedTranscriptBatch` + options + D1/D2)

**Files:**
- `apps/axctl/src/ingest/normalized/transcripts.ts` (batch type 83–92, turn builder 138–146, invocation builder 148–183, main builder 185–200)
- `apps/axctl/src/ingest/normalized/transcripts.test.ts`

**Steps:**

- [ ] Add failing tests to `normalized/transcripts.test.ts`:

```ts
it("omits agent_event entirely when the turn has no provider event ref", () => {
    const sql = buildNormalizedTurnStatements([{
        sessionId: "s1",
        seq: 1,
        ts: "2026-06-10T00:00:00.000Z",
        role: "assistant",
        messageKind: "assistant",
        intentKind: "other",
        text: null,
        textExcerpt: null,
        hasToolUse: false,
        hasError: false,
        agentEvent: null,
    }]).join("\n");
    expect(sql).not.toContain("agent_event");
    expect(sql).toContain("CONTENT { session: session:`s1`, seq: 1,");
});

it("emits invoked SET fields in legacy order: session, ts, args, turn_has_error, turn_index", () => {
    const sql = buildNormalizedSyntheticSkillInvocationStatements([{
        sessionId: "s1",
        seq: 2,
        ts: "2026-06-10T00:00:00.000Z",
        skillName: "codex:exec_command",
        args: { command: "ls" },
        skillScope: "codex-tool",
        skillContentHash: "codex",
    }]).join("\n");
    const setClause = sql.slice(sql.indexOf(" SET "));
    expect(setClause.indexOf("session = ")).toBeLessThan(setClause.indexOf("ts = "));
    expect(setClause.indexOf("ts = ")).toBeLessThan(setClause.indexOf("args = "));
});

it("appends parent edges, plan snapshots, and compactions and forwards clearExisting", () => {
    const batch: NormalizedTranscriptBatch = {
        sessions: [{ id: "s1", provider: "codex" }],
        events: [{
            provider: "codex", providerSessionId: "s1", providerEventId: "e1",
            seq: 1, ts: "2026-06-10T00:00:00.000Z", type: "message", role: "user",
        }],
        turns: [],
        agentEventParentEdges: [{
            provider: "codex", providerSessionId: "s1",
            parentEventKey: "codex__s1__event_e0", childEventKey: "codex__s1__event_e1",
            kind: "parent", ts: "2026-06-10T00:00:00.000Z",
        }],
        compactions: [],
        planSnapshots: [],
    };
    const cleared = buildNormalizedTranscriptStatements(batch).join("\n");
    expect(cleared).toContain("DELETE (SELECT VALUE id FROM agent_event");
    expect(cleared).toContain("->agent_event_child:");
    const notCleared = buildNormalizedTranscriptStatements(batch, { clearExisting: false }).join("\n");
    expect(notCleared).not.toContain("DELETE (SELECT VALUE id FROM agent_event WHERE");
});
```

  (Import `buildNormalizedSyntheticSkillInvocationStatements` is already in the test file; add `NormalizedTranscriptBatch` type import.)
- [ ] Run `bun test apps/axctl/src/ingest/normalized/transcripts.test.ts` → **FAIL** (type errors / missing fields / NONE emitted).
- [ ] Implement in `normalized/transcripts.ts`:
  - New imports:

```ts
import {
    buildPlanSnapshotStatements,
    buildRelateToolCallSkillStatements,
    buildToolCallStatements,
    buildToolFileEvidenceStatements,
    type PlanSnapshotWrite,
    type ToolCallSkillRelationWrite,
    type ToolCallWrite,
    type ToolFileEvidenceWrite,
} from "../evidence-writers.ts";
import { buildCompactionStatements, type CompactionWrite } from "../compaction.ts";
import {
    agentEventRecordKey,
    buildAgentEventParentEdgeStatement,
    buildAgentEventStatements,
    buildAgentProviderStatements,
    type AgentEventParentEdgeWrite,
    type AgentEventWrite,
    type AgentProviderName,
    type AgentProviderWrite,
    type AgentSessionWrite,
} from "../provider-events.ts";
```

  - Extended batch type + options (full replacement of lines 83–92):

```ts
export interface NormalizedTranscriptBatch {
    readonly providers?: readonly AgentProviderWrite[];
    readonly sessions: readonly NormalizedSessionWrite[];
    readonly events?: readonly AgentEventWrite[];
    readonly turns: readonly NormalizedTurnWrite[];
    readonly toolCalls?: readonly ToolCallWrite[];
    readonly toolFileEvidence?: readonly ToolFileEvidenceWrite[];
    /** Cross-batch agent_event parent edges (streaming parsers resolve parents
     *  flushed in an earlier batch themselves; within-batch edges are derived
     *  by buildAgentEventStatements). */
    readonly agentEventParentEdges?: readonly AgentEventParentEdgeWrite[];
    readonly syntheticSkillInvocations?: readonly NormalizedSyntheticSkillInvocationWrite[];
    readonly toolCallSkillRelations?: readonly ToolCallSkillRelationWrite[];
    readonly planSnapshots?: readonly PlanSnapshotWrite[];
    readonly compactions?: readonly CompactionWrite[];
}

export interface BuildNormalizedTranscriptStatementsOptions {
    /** Forwarded to buildAgentEventStatements. Streaming parsers (codex) pass
     *  true on the FIRST batch per session, false afterwards. Default true. */
    readonly clearExisting?: boolean;
}
```

  - Turn builder (D2) - replace lines 138–146:

```ts
export const buildNormalizedTurnStatements = (
    turns: readonly NormalizedTurnWrite[],
): string[] =>
    turns.map((turn) => {
        const agentEventField = turn.agentEvent
            ? `agent_event: ${recordRef("agent_event", agentEventRecordKey(turn.agentEvent))}, `
            : "";
        return `UPSERT ${recordRef("turn", turnRecordKey(turn.sessionId, turn.seq))} CONTENT { session: ${recordRef("session", turn.sessionId)}, ${agentEventField}seq: ${turn.seq}, ts: ${surrealDate(turn.ts)}, role: ${surrealString(turn.role)}, message_kind: ${surrealString(turn.messageKind)}, intent_kind: ${surrealString(turn.intentKind)}, text: ${turn.text === null ? "NONE" : surrealString(turn.text)}, text_excerpt: ${turn.textExcerpt === null ? "NONE" : surrealString(turn.textExcerpt)}, has_tool_use: ${turn.hasToolUse}, has_error: ${turn.hasError} };`;
    });
```

  - Invocation builder (D1) - inside `buildNormalizedSyntheticSkillInvocationStatements`, reorder the `surrealSet` tuple list to:

```ts
        return `RELATE ${recordRef("turn", turnKey)}->invoked:\`${edgeKey}\`->${recordRef("skill", skillKey)} SET ${surrealSet([
            ["session", recordRef("session", invocation.sessionId)],
            ["ts", surrealDate(invocation.ts)],
            ["args", surrealString(args)],
            ["turn_has_error", invocation.turnHasError ? "true" : "false"],
            ["turn_index", (invocation.turnIndex ?? invocation.seq).toString(10)],
        ])};`;
```

  - Main builder - replace lines 185–200:

```ts
export const buildNormalizedTranscriptStatements = (
    batch: NormalizedTranscriptBatch,
    options?: BuildNormalizedTranscriptStatementsOptions,
): string[] => [
    ...buildAgentProviderStatements(batch.providers ?? []),
    ...buildAgentEventStatements(
        { sessions: batch.sessions.map(toAgentSession), events: batch.events ?? [] },
        { clearExisting: options?.clearExisting ?? true },
    ),
    ...buildNormalizedTurnStatements(batch.turns),
    ...buildToolCallStatements(batch.toolCalls ?? []),
    ...buildToolFileEvidenceStatements(batch.toolFileEvidence ?? []),
    ...(batch.agentEventParentEdges ?? []).map(buildAgentEventParentEdgeStatement),
    ...buildNormalizedSyntheticSkillInvocationStatements(batch.syntheticSkillInvocations ?? []),
    ...(batch.toolCallSkillRelations ?? []).flatMap((relation) =>
        buildRelateToolCallSkillStatements(relation)
    ),
    ...(batch.planSnapshots ?? []).flatMap((snapshot) =>
        buildPlanSnapshotStatements(snapshot)
    ),
    ...buildCompactionStatements(batch.compactions ?? []),
];
```

- [ ] Run `bun test apps/axctl/src/ingest/normalized/transcripts.test.ts` → **PASS**.
- [ ] Run `bun test apps/axctl/src/ingest/opencode.test.ts` (consumer of the seam; D1 changes its emitted text - existing `.includes` assertions must still pass) → **PASS**.
- [ ] `bun run typecheck` → clean.
- [ ] Commit:

```
feat(ingest): extend NormalizedTranscriptBatch with parent edges, plans, compactions + clearExisting

Canonicalizes invoked SET order to the legacy parser order (D1) and omits
agent_event on turns without a provider ref (D2) so the four remaining
parsers can convert byte-identically.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

### Task 2 - Statement-parity harness

**Files:**
- `apps/axctl/src/ingest/normalized/statement-parity.ts` (new)
- `apps/axctl/src/ingest/normalized/statement-parity.test.ts` (new)

**Steps:**

- [ ] Write the failing test first (`statement-parity.test.ts`):

```ts
import { describe, expect, it } from "bun:test";
import { diffStatementSets } from "./statement-parity.ts";

describe("diffStatementSets", () => {
    it("reports empty deltas for equal multisets regardless of order", () => {
        expect(diffStatementSets(["a;", "b;", "b;"], ["b;", "a;", "b;"]))
            .toEqual({ missing: [], added: [] });
    });

    it("reports statements only in legacy as missing and only in next as added", () => {
        expect(diffStatementSets(["a;", "b;"], ["a;", "c;"]))
            .toEqual({ missing: ["b;"], added: ["c;"] });
    });

    it("respects multiplicity", () => {
        expect(diffStatementSets(["a;", "a;"], ["a;"]))
            .toEqual({ missing: ["a;"], added: [] });
    });
});
```

- [ ] Run `bun test apps/axctl/src/ingest/normalized/statement-parity.test.ts` → **FAIL** (module missing).
- [ ] Implement `statement-parity.ts` (complete file):

```ts
/**
 * Migration harness for the parser-normalization seam (Phase 4).
 *
 * Compares the statement MULTISET a legacy per-parser builder produced against
 * the normalized-batch path. Order-insensitive on purpose: every statement is
 * an independent idempotent UPSERT/RELATE (see plan ledger delta D3); the only
 * intra-batch ordering that matters (event clears before event upserts) is
 * owned by buildAgentEventStatements and unchanged.
 *
 * Byte-level equality per statement IS required - any non-empty delta means
 * the adapter mapping is wrong, never that the harness should be loosened.
 */
export interface StatementParityDelta {
    /** Statements the legacy builder produced that the normalized path lost. */
    readonly missing: readonly string[];
    /** Statements the normalized path produced that legacy never did. */
    readonly added: readonly string[];
}

export const diffStatementSets = (
    legacy: readonly string[],
    next: readonly string[],
): StatementParityDelta => {
    const remaining = new Map<string, number>();
    for (const statement of legacy) {
        remaining.set(statement, (remaining.get(statement) ?? 0) + 1);
    }
    const added: string[] = [];
    for (const statement of next) {
        const count = remaining.get(statement) ?? 0;
        if (count === 0) {
            added.push(statement);
        } else if (count === 1) {
            remaining.delete(statement);
        } else {
            remaining.set(statement, count - 1);
        }
    }
    const missing = [...remaining.entries()].flatMap(([statement, count]) =>
        Array.from({ length: count }, () => statement)
    );
    return { missing, added };
};
```

- [ ] Run the test → **PASS**. `bun run typecheck` → clean.
- [ ] Commit:

```
test(ingest): add statement-parity multiset diff harness for parser normalization

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

### Task 3 - PILOT: convert cursor to the seam

**Files:**
- `apps/axctl/src/ingest/cursor.ts` (builders 878–959; imports 9–26)
- `apps/axctl/src/ingest/cursor.parity.test.ts` (new)
- `apps/axctl/src/ingest/cursor.test.ts` (must stay green untouched)

**Steps:**

- [ ] Write `cursor.parity.test.ts` (red: `toCursorNormalizedBatch` / `__legacyBuildCursorBatchStatements` don't exist yet). Reuse the two fixture shapes from `cursor.test.ts` - the `cursorDiskKV` composer fixture (~lines 240–330: `composerData:` payload + `bubbleId:` rows including `toolFormerData` with `run_terminal_command_v2`) and a variant with `summarizedComposers` so a compaction row is exercised:

```ts
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    extractCursorStateDb,
    __legacyBuildCursorBatchStatements,
    __testBuildCursorBatchStatements,
} from "./cursor.ts";
import { diffStatementSets } from "./normalized/statement-parity.ts";

const composerDiskKvFixture = (withCompaction: boolean): string => {
    const dir = mkdtempSync(join(tmpdir(), "ax-cursor-parity-"));
    const dbPath = join(dir, "state.vscdb");
    const db = new Database(dbPath);
    db.query("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)").run();
    const insert = db.query("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
    insert.run(
        "composerData:composer-parity-1",
        JSON.stringify({
            composerId: "composer-parity-1",
            name: "Parity session",
            createdAt: "2026-06-10T10:00:00.000Z",
            fullConversationHeadersOnly: [
                { bubbleId: "bubble-user-1" },
                { bubbleId: "bubble-tool-1" },
            ],
            ...(withCompaction ? { summarizedComposers: ["composer-old-1"] } : {}),
        }),
    );
    insert.run(
        "bubbleId:composer-parity-1:bubble-user-1",
        JSON.stringify({
            bubbleId: "bubble-user-1",
            type: 1,
            text: "check git status",
            createdAt: "2026-06-10T10:00:01.000Z",
        }),
    );
    insert.run(
        "bubbleId:composer-parity-1:bubble-tool-1",
        JSON.stringify({
            bubbleId: "bubble-tool-1",
            type: 2,
            text: "Running git status.",
            createdAt: "2026-06-10T10:00:05.000Z",
            toolFormerData: {
                toolCallId: "cursor-tool-call-1",
                status: "completed",
                name: "run_terminal_command_v2",
                rawArgs: "",
                params: JSON.stringify({ command: "git status --short" }),
                result: JSON.stringify({ output: " M src/ingest/cursor.ts\n" }),
            },
        }),
    );
    db.close();
    return dbPath;
};

describe("cursor normalized-batch parity", () => {
    for (const withCompaction of [false, true]) {
        it(`new path emits the exact legacy statement multiset (compaction=${withCompaction})`, () => {
            const dbPath = composerDiskKvFixture(withCompaction);
            const extracted = extractCursorStateDb(dbPath);
            expect(extracted.sessions.length).toBeGreaterThan(0);
            expect(extracted.toolCalls.length).toBeGreaterThan(0);
            if (withCompaction) expect(extracted.compactions.length).toBeGreaterThan(0);

            const legacy = __legacyBuildCursorBatchStatements(extracted, dbPath);
            const next = __testBuildCursorBatchStatements(extracted, dbPath);
            expect(diffStatementSets(legacy, next)).toEqual({ missing: [], added: [] });
        });
    }
});
```

- [ ] Run `bun test apps/axctl/src/ingest/cursor.parity.test.ts` → **FAIL** (missing exports).
- [ ] Implement in `cursor.ts`:
  - Add import: `import { buildNormalizedTranscriptStatements, type NormalizedTranscriptBatch } from "./normalized/transcripts.ts";`
  - Add the adapter ABOVE `buildCursorBatchStatements`:

```ts
export const toCursorNormalizedBatch = (
    extract: CursorExtract,
    sourcePath: string,
): NormalizedTranscriptBatch => ({
    providers: [{
        name: "cursor",
        displayName: "Cursor",
        capabilities: {
            sqlite: true,
            transcripts: true,
            providerGraph: true,
            toolCalls: true,
            planSignals: providerPlanSignalAvailability.cursor,
            delegationSignals: providerDelegationSignalAvailability.cursor,
        },
    }],
    sessions: extract.sessions.map((session) => ({
        id: session.id,
        provider: "cursor",
        providerSessionId: session.id,
        title: session.title,
        sourcePath,
        raw: {
            source: "cursor_state_vscdb",
            sourcePath,
            dbIdentity: session.dbIdentity,
            cursorConversationId: session.cursorConversationId,
        },
        labels: {
            source: "cursor",
            dbIdentity: session.dbIdentity,
            cursorConversationId: session.cursorConversationId,
        },
        metrics: {
            turns: extract.turns.filter((turn) => turn.session === session.id).length,
            toolCalls: extract.toolCalls.filter((call) => call.sessionId === session.id).length,
            providerEvents: extract.providerEvents.filter((event) => event.providerSessionId === session.id).length,
        },
        startedAt: session.started_at,
        endedAt: session.ended_at,
    })),
    events: extract.providerEvents,
    turns: extract.turns.map((turn) => ({
        sessionId: turn.session,
        seq: turn.seq,
        ts: turn.ts,
        role: turn.role,
        messageKind: turn.message_kind,
        intentKind: turn.intent_kind,
        text: turn.text,
        textExcerpt: turn.text_excerpt,
        hasToolUse: turn.has_tool_use,
        hasError: turn.has_error,
        agentEvent: {
            provider: "cursor",
            providerSessionId: turn.session,
            providerEventId: turn.providerEventId,
            seq: turn.seq,
        },
    })),
    toolCalls: extract.toolCalls,
    // Cursor intentionally emits NO tool-file evidence today; do not add it here.
    syntheticSkillInvocations: extract.invocations.map((invocation) => ({
        sessionId: invocation.session,
        seq: invocation.seq,
        ts: invocation.ts,
        skillName: invocation.skill,
        args: invocation.args,
        skillScope: "cursor-tool",
        skillContentHash: "cursor",
    })),
    toolCallSkillRelations: extract.skillRelations,
    compactions: extract.compactions,
});
```

  - Rename the existing `buildCursorBatchStatements` (907–957) to `legacyBuildCursorBatchStatements` and add `export const __legacyBuildCursorBatchStatements = legacyBuildCursorBatchStatements;`. Keep its private helpers (`buildTurnStatements`, `buildSyntheticSkillAndInvocationStatements`) - they die in Task 7.
  - New delegating builder (same signature, same call sites at line 1055 and `__testBuildCursorBatchStatements`):

```ts
const buildCursorBatchStatements = (extract: CursorExtract, sourcePath: string): string[] =>
    buildNormalizedTranscriptStatements(toCursorNormalizedBatch(extract, sourcePath));
```

- [ ] Run `bun test apps/axctl/src/ingest/cursor.parity.test.ts` → **PASS** (any non-empty delta: inspect `missing`/`added`, fix the adapter mapping - common slips: passing `cwd`/`project` (must stay undefined), wrong `metrics` filter, missing `title`).
- [ ] Run `bun test apps/axctl/src/ingest/cursor.test.ts` → **PASS** (existing assertions now exercise the new path through `__testBuildCursorBatchStatements`).
- [ ] `bun run typecheck` → clean.
- [ ] Commit:

```
refactor(ingest): cursor parser emits NormalizedTranscriptBatch (pilot)

Statement multiset proven byte-identical to the legacy builder by
cursor.parity.test.ts on both composer fixture shapes.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

### Task 4 - Convert pi

**Files:**
- `apps/axctl/src/ingest/pi.ts` (builders 666–783; keep `buildPiTokenUsageStatements` 695–726 as the extra)
- `apps/axctl/src/ingest/pi.parity.test.ts` (new)
- `apps/axctl/src/ingest/provider-parity.ts` (pi evidence refs: lines 156, 184–185, 234, 261–263)
- `apps/axctl/src/ingest/pi.test.ts` (must stay green)

**Steps:**

- [ ] Write `pi.parity.test.ts` using the rich jsonl fixture style from `pi.test.ts` (~lines 40–140: `session` header, `model_change`, `custom`, user/assistant `message`s with `usage`, an assistant `toolCall` content block, a `toolResult` message) PLUS one `{"type":"compaction", ...}` entry so `extractPiCompaction` fires:

```ts
import { describe, expect, it } from "bun:test";
import { __legacyBuildPiBatchStatements, __testBuildPiBatchStatements, __testExtractPiJsonlLines } from "./pi.ts";
import { diffStatementSets } from "./normalized/statement-parity.ts";

const fixtureLines = (): string[] => [
    JSON.stringify({ type: "session", version: 3, id: "pi-parity", timestamp: "2026-06-10T06:00:00.000Z", cwd: "/Users/necmttn/Projects/ax" }),
    JSON.stringify({ type: "message", id: "user-1", parentId: null, timestamp: "2026-06-10T06:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "list files" }] } }),
    JSON.stringify({
        type: "message", id: "assistant-1", parentId: "user-1", timestamp: "2026-06-10T06:00:02.000Z",
        message: {
            role: "assistant", model: "gpt-5.5", provider: "openai-codex",
            usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 3, totalTokens: 20 },
            content: [
                { type: "text", text: "Listing." },
                { type: "toolCall", id: "call-1", name: "exec_command", input: { command: "ls -la" } },
            ],
        },
    }),
    JSON.stringify({ type: "message", id: "result-1", parentId: "assistant-1", timestamp: "2026-06-10T06:00:03.000Z", message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "total 8" }] } }),
    JSON.stringify({ type: "compaction", id: "compaction-1", parentId: "result-1", timestamp: "2026-06-10T06:00:04.000Z", summary: "compacted history" }),
];

describe("pi normalized-batch parity", () => {
    it("new path emits the exact legacy statement multiset", () => {
        const extracted = __testExtractPiJsonlLines(fixtureLines());
        expect(extracted).not.toBeNull();
        expect(extracted!.toolCalls.length).toBe(1);
        const legacy = __legacyBuildPiBatchStatements(extracted!);
        const next = __testBuildPiBatchStatements(extracted!);
        expect(diffStatementSets(legacy, next)).toEqual({ missing: [], added: [] });
    });
});
```

  (If the `compaction` fixture entry produces no `CompactionWrite` because `extractPiCompaction` requires fields this fixture lacks, copy the exact compaction fixture entry from `compaction.test.ts` instead - the parity test must assert `extracted!.compactions.length > 0` either way, or drop that assertion with a comment if pi compactions need fields unavailable in synthetic fixtures.)
- [ ] Run → **FAIL** (missing exports).
- [ ] Implement in `pi.ts`: import the seam, add `toPiNormalizedBatch`, rename old builder:

```ts
import { buildNormalizedTranscriptStatements, type NormalizedTranscriptBatch } from "./normalized/transcripts.ts";

const toPiNormalizedBatch = (extract: PiExtract): NormalizedTranscriptBatch => ({
    providers: [{
        name: "pi",
        displayName: "Pi",
        version: extract.session.version === null ? null : String(extract.session.version),
        capabilities: {
            transcripts: true,
            providerGraph: true,
            planSignals: providerPlanSignalAvailability.pi,
            delegationSignals: providerDelegationSignalAvailability.pi,
        },
    }],
    sessions: [{
        id: extract.session.id,
        provider: "pi",
        providerSessionId: extract.session.id,
        cwd: extract.session.cwd,
        project: extract.session.cwd,
        model: extract.session.model,
        sourcePath: extract.sourcePath,
        raw: {
            source: "pi_jsonl",
            sourcePath: extract.sourcePath,
            version: extract.session.version,
        },
        labels: { source: "pi" },
        metrics: {
            turns: extract.turns.length,
            toolCalls: extract.toolCalls.length,
            providerEvents: extract.providerEvents.length,
            usage: extract.usage,
        },
        startedAt: extract.session.started_at,
        endedAt: extract.session.ended_at,
    }],
    events: extract.providerEvents,
    turns: extract.turns.map((turn) => ({
        sessionId: turn.session,
        seq: turn.seq,
        ts: turn.ts,
        role: turn.role,
        messageKind: turn.message_kind,
        intentKind: turn.intent_kind,
        text: turn.text,
        textExcerpt: turn.text_excerpt,
        hasToolUse: turn.has_tool_use,
        hasError: turn.has_error,
        agentEvent: {
            provider: "pi",
            providerSessionId: turn.session,
            providerEventId: turn.providerEventId,
            seq: turn.providerEventSeq,
        },
    })),
    toolCalls: extract.toolCalls,
    toolFileEvidence: extractToolFileEvidence(extract.toolCalls),
    syntheticSkillInvocations: extract.invocations.map((invocation) => ({
        sessionId: invocation.session,
        seq: invocation.seq,
        ts: invocation.ts,
        skillName: invocation.skill,
        args: invocation.args,
        skillScope: "pi-tool",
        skillContentHash: "pi",
    })),
    toolCallSkillRelations: extract.skillRelations,
    compactions: extract.compactions,
});

const buildPiBatchStatements = (extract: PiExtract): string[] => [
    ...buildNormalizedTranscriptStatements(toPiNormalizedBatch(extract)),
    ...buildPiTokenUsageStatements(extract),
];
```

  Rename old `buildPiBatchStatements` (728–781) → `legacyBuildPiBatchStatements`, export `__legacyBuildPiBatchStatements`. `__testBuildPiBatchStatements` keeps pointing at the NEW `buildPiBatchStatements`.
- [ ] Update `provider-parity.ts` pi rows to point at the seam (mirror the opencode precedent at lines 188–191): replace `{ path: ".../pi.ts", contains: "buildToolCallStatements(extract.toolCalls)" }` with `{ path: ".../pi.ts", contains: "toolCalls: extract.toolCalls" }`; replace the two `->invoked:`/`buildRelateToolCallSkillStatements` pi rows with `{ path: ".../pi.ts", contains: "syntheticSkillInvocations" }` and `{ path: ".../pi.ts", contains: "toolCallSkillRelations: extract.skillRelations" }`; replace the `buildToolFileEvidenceStatements(extractToolFileEvidence(extract.toolCalls))` rows (234, 261) with `{ path: ".../pi.ts", contains: "toolFileEvidence: extractToolFileEvidence(extract.toolCalls)" }`. The `buildPiTokenUsageStatements`/`session_token_usage` rows (285–286) are unchanged.
- [ ] Run `bun test apps/axctl/src/ingest/pi.parity.test.ts apps/axctl/src/ingest/pi.test.ts apps/axctl/src/ingest/provider-parity.test.ts` → **PASS**. `bun run typecheck` → clean.
- [ ] Commit:

```
refactor(ingest): pi parser emits NormalizedTranscriptBatch

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

### Task 5 - Convert codex (streaming + clearExisting + payload compaction)

**Files:**
- `apps/axctl/src/ingest/codex.ts` (builders 1244–1438; writeBatch flag threading 1582–1596 unchanged)
- `apps/axctl/src/ingest/codex.parity.test.ts` (new)
- `apps/axctl/src/ingest/provider-parity.ts` (codex rows: 153, 180–181, 209, 230, 256–258)
- `apps/axctl/src/ingest/codex.test.ts`, `codex-reingest.e2e.test.ts`, `codex-stream-batches.test.ts` (must stay green)

**Steps:**

- [ ] Write `codex.parity.test.ts`. Reuse the richest fixture from `codex.test.ts` (the jsonl array containing `session_meta`, `turn_context`, `response_item` messages, `function_call` + `function_call_output`, `update_plan`, `event_msg/token_count`, `compacted`) - lift it into a local `fixtureLines()` helper. Two parity cases:

```ts
import { describe, expect, it } from "bun:test";
import {
    __legacyBuildCodexBatchStatements,
    __testBuildCodexBatchStatements,
    __testExtractCodexJsonlLines,
    __testStreamCodexJsonlLines,
} from "./codex.ts";
import { diffStatementSets } from "./normalized/statement-parity.ts";

describe("codex normalized-batch parity", () => {
    it("single-shot extract emits the exact legacy statement multiset", () => {
        const extracted = __testExtractCodexJsonlLines(fixtureLines());
        expect(extracted).not.toBeNull();
        const legacy = __legacyBuildCodexBatchStatements(extracted!, 1200, true);
        const next = __testBuildCodexBatchStatements(extracted!, 1200, true);
        expect(diffStatementSets(legacy, next)).toEqual({ missing: [], added: [] });
    });

    it("streaming batches stay parity-equal with first-batch-only clearExisting", () => {
        const batches = __testStreamCodexJsonlLines(fixtureLines(), 3);
        expect(batches.length).toBeGreaterThan(1);
        batches.forEach((batch, index) => {
            const clearExisting = index === 0;
            const legacy = __legacyBuildCodexBatchStatements(batch, 1200, clearExisting);
            const next = __testBuildCodexBatchStatements(batch, 1200, clearExisting);
            expect(diffStatementSets(legacy, next)).toEqual({ missing: [], added: [] });
        });
    });
});
```

- [ ] Run → **FAIL** (missing exports).
- [ ] Implement in `codex.ts`:
  - Import the seam: `import { buildNormalizedTranscriptStatements, type NormalizedTranscriptBatch } from "./normalized/transcripts.ts";`
  - Add the adapter (note the sessionless edge case - see gap table 1.2 last row):

```ts
const toCodexNormalizedBatch = (
    batch: MutableCodexExtract,
    payloadMaxBytes: number,
): NormalizedTranscriptBatch => ({
    providers: batch.session
        ? [{
            name: "codex",
            displayName: "Codex",
            version: batch.session.cli_version,
            capabilities: {
                transcripts: true,
                toolCalls: true,
                planSignals: providerPlanSignalAvailability.codex,
                delegationSignals: providerDelegationSignalAvailability.codex,
            },
        }]
        : [],
    sessions: batch.session
        ? [{
            id: batch.session.id,
            provider: "codex",
            providerSessionId: batch.session.id,
            cwd: batch.session.cwd,
            project: batch.session.cwd,
            model: concreteCodexModel(batch.session),
            sourcePath: batch.sourcePath,
            raw: {
                source: "codex_transcript",
                cliVersion: batch.session.cli_version,
                modelProvider: batch.session.model_provider,
                model: batch.session.model,
            },
            labels: { source: "transcript" },
            metrics: {
                turns: batch.turns.length,
                toolCalls: batch.toolCalls.length,
                providerEvents: batch.providerEvents.length,
            },
            startedAt: batch.session.started_at,
            endedAt: batch.session.ended_at,
        }]
        : [],
    // Legacy behavior: without a session header, NO provider/session/event
    // statements were emitted (buildCodexProviderStatements returned []).
    events: batch.session ? batch.providerEvents : [],
    turns: batch.turns.map((turn) => ({
        sessionId: turn.session,
        seq: turn.seq,
        ts: turn.ts,
        role: turn.role,
        messageKind: turn.message_kind,
        intentKind: turn.intent_kind,
        text: turn.text,
        textExcerpt: turn.text_excerpt,
        hasToolUse: turn.has_tool_use,
        hasError: false,
        agentEvent: null,
    })),
    // Payload compaction applies ONLY to the persisted tool_call rows...
    toolCalls: batch.toolCalls.map((call) => compactCodexToolCall(call, payloadMaxBytes)),
    // ...while file evidence is extracted from the UNcompacted calls.
    toolFileEvidence: extractToolFileEvidence(batch.toolCalls),
    agentEventParentEdges: batch.parentEdges,
    syntheticSkillInvocations: batch.invocations.map((invocation) => ({
        sessionId: invocation.session,
        seq: invocation.seq,
        ts: invocation.ts,
        skillName: invocation.skill,
        args: invocation.args,
        skillScope: "codex-tool",
        skillContentHash: "codex",
    })),
    toolCallSkillRelations: batch.skillRelations,
    planSnapshots: batch.planSnapshots,
    compactions: batch.compactions ?? [],
});
```

  - Rename old `buildCodexBatchStatements` (1412–1436) → `legacyBuildCodexBatchStatements`; export `__legacyBuildCodexBatchStatements`. Keep `buildCodexProviderStatements`/turn/synthetic builders for the legacy fn (deleted Task 7). `buildCodexTokenUsageStatements` (1326–1371) and `buildCodexTurnTokenUsageStatements` (1373–1410) are PERMANENT extras - they stay.
  - New builder, same signature (call sites at 1596 and `__testBuildCodexBatchStatements` unchanged):

```ts
const buildCodexBatchStatements = (
    batch: MutableCodexExtract,
    payloadMaxBytes: number,
    clearExisting = true,
): string[] => [
    ...buildNormalizedTranscriptStatements(
        toCodexNormalizedBatch(batch, payloadMaxBytes),
        { clearExisting },
    ),
    ...buildCodexTokenUsageStatements(batch.tokenUsage),
    ...buildCodexTurnTokenUsageStatements(batch.turnTokenUsages),
];
```

  - Note `__testBuildCodexBatchStatements` legacy call sites in `codex.test.ts` pass `(extracted, 1200)` - default `clearExisting = true` matches `legacyBuildCodexBatchStatements(batch, payloadMaxBytes, clearExisting = true)`.
- [ ] Update `provider-parity.ts` codex rows (mirror opencode): line 153 → `{ path: ".../codex.ts", contains: "toolCalls: batch.toolCalls.map((call) => compactCodexToolCall" }`; lines 180–181 → `contains: "syntheticSkillInvocations"` and `contains: "toolCallSkillRelations: batch.skillRelations"`; line 209 → `contains: "planSnapshots: batch.planSnapshots"`; lines 230/256 → `contains: "toolFileEvidence: extractToolFileEvidence(batch.toolCalls)"`. Rows 92–93 (`sourcePath: batch.sourcePath`, `raw_file: rawPointer`) still match - verify with `rg`.
- [ ] Run `bun test apps/axctl/src/ingest/codex.parity.test.ts apps/axctl/src/ingest/codex.test.ts apps/axctl/src/ingest/codex-stream-batches.test.ts apps/axctl/src/ingest/codex-reingest.e2e.test.ts apps/axctl/src/ingest/provider-parity.test.ts` → **PASS** (the reingest e2e needs a live local SurrealDB the way it always has; if it is environment-gated, run what CI runs). `bun run typecheck` → clean.
- [ ] Commit:

```
refactor(ingest): codex parser emits NormalizedTranscriptBatch

clearExisting forwarded through the seam; cross-batch parent edges and
payload compaction move to the adapter boundary. Streaming parity proven
per-batch with first-batch-only clears.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

### Task 6 - Convert claude (`transcripts.ts`)

**Files:**
- `apps/axctl/src/ingest/transcripts.ts` (builders 1234–1242, 1371–1416; write block 1726–1758; subagent exports 1161–1169)
- `apps/axctl/src/ingest/transcripts.parity.test.ts` (new)
- `apps/axctl/src/ingest/provider-parity.ts` (claude rows: 150, 176–177, 206, 226, 251; hook rows 306–307 unchanged)
- `apps/axctl/src/ingest/derive-claude-subagents.ts` (consumer of the `*ForSubagents` exports - signatures must not change)
- `apps/axctl/src/ingest/transcripts.test.ts` (must stay green)

**What stays untouched (per gap table 1.1):** `relateInvocations` (effectful skill-catalog logic), `writeHookEvidence` + hook statement builders, `writeClaudeTokenUsage` + both token-usage builders, `upsertSessions`, `snapshotTranscript`, watermark/skip logic, all extraction code.

**Steps:**

- [ ] Write `transcripts.parity.test.ts`. Fixture: reuse the richest jsonl-lines fixture from `transcripts.test.ts` (user task line, assistant line with `tool_use` Bash + `tool_use` Skill + `TodoWrite`, user line with failing `tool_result`, an `isCompactSummary` line) via `__testExtractClaudeJsonlLines(lines, "-Users-necmttn-Projects-ax", "claude-parity-session")`:

```ts
import { describe, expect, it } from "bun:test";
import {
    __legacyBuildClaudeProviderStatements,
    __legacyBuildClaudeTurnStatements,
    __testExtractClaudeJsonlLines,
    toClaudeNormalizedBatch,
} from "./transcripts.ts";
import { buildNormalizedTranscriptStatements } from "./normalized/transcripts.ts";
import {
    buildPlanSnapshotStatements,
    buildRelateToolCallSkillStatements,
    buildToolCallStatements,
    buildToolFileEvidenceStatements,
} from "./evidence-writers.ts";
import { buildCompactionStatements } from "./compaction.ts";
import { extractToolFileEvidence } from "./tool-file-evidence.ts";
import { diffStatementSets } from "./normalized/statement-parity.ts";

describe("claude normalized-batch parity", () => {
    it("new single-batch path emits the union of the legacy per-section statements", () => {
        const extracted = __testExtractClaudeJsonlLines(
            fixtureLines(),
            "-Users-necmttn-Projects-ax",
            "claude-parity-session",
        );
        expect(extracted).not.toBeNull();
        expect(extracted!.toolCalls.length).toBeGreaterThan(0);
        expect(extracted!.planSnapshots.length).toBeGreaterThan(0);
        expect(extracted!.compactions.length).toBeGreaterThan(0);

        const legacy = [
            ...__legacyBuildClaudeProviderStatements(extracted!),
            ...__legacyBuildClaudeTurnStatements(extracted!.turns),
            ...buildCompactionStatements(extracted!.compactions),
            ...buildToolCallStatements(extracted!.toolCalls),
            ...buildToolFileEvidenceStatements(extractToolFileEvidence(extracted!.toolCalls)),
            ...extracted!.skillRelations.flatMap((relation) => buildRelateToolCallSkillStatements(relation)),
            ...extracted!.planSnapshots.flatMap((snapshot) => buildPlanSnapshotStatements(snapshot)),
        ];
        const next = buildNormalizedTranscriptStatements(
            toClaudeNormalizedBatch(extracted!, extracted!.skillRelations),
        );
        expect(diffStatementSets(legacy, next)).toEqual({ missing: [], added: [] });
    });
});
```

- [ ] Run → **FAIL** (missing exports).
- [ ] Implement in `transcripts.ts`:
  - Import the seam:

```ts
import {
    buildNormalizedTranscriptStatements,
    buildNormalizedTurnStatements,
    type NormalizedTranscriptBatch,
    type NormalizedTurnWrite,
} from "./normalized/transcripts.ts";
```

  - Add the adapter (skill relations passed in because `ingestTranscripts` catalog-resolves them first):

```ts
const toNormalizedClaudeTurn = (turn: Turn): NormalizedTurnWrite => ({
    sessionId: turn.session,
    seq: turn.seq,
    ts: turn.ts,
    role: turn.role,
    messageKind: turn.message_kind,
    intentKind: turn.intent_kind,
    text: turn.text,
    textExcerpt: turn.text_excerpt,
    hasToolUse: turn.has_tool_use,
    hasError: turn.has_error,
    agentEvent: null,
});

export const toClaudeNormalizedBatch = (
    extracted: FileExtract,
    skillRelations: readonly ToolCallSkillRelationWrite[],
): NormalizedTranscriptBatch => ({
    providers: [{
        name: "claude",
        displayName: "Claude Code",
        capabilities: {
            transcripts: true,
            toolCalls: true,
            planSignals: providerPlanSignalAvailability.claude,
            delegationSignals: providerDelegationSignalAvailability.claude,
        },
    }],
    sessions: [{
        id: extracted.session.id,
        provider: "claude",
        providerSessionId: extracted.session.id,
        cwd: extracted.session.cwd,
        project: extracted.session.project,
        model: extracted.session.model,
        sourcePath: extracted.sourcePath,
        raw: {
            source: "claude_transcript",
            rawFile: extracted.session.raw_file,
        },
        labels: {
            source: "transcript",
            project: extracted.session.project,
        },
        metrics: {
            turns: extracted.turns.length,
            toolCalls: extracted.toolCalls.length,
            providerEvents: extracted.providerEvents.length,
        },
        startedAt: extracted.session.started_at,
        endedAt: extracted.session.ended_at,
    }],
    events: extracted.providerEvents,
    turns: extracted.turns.map(toNormalizedClaudeTurn),
    toolCalls: extracted.toolCalls,
    toolFileEvidence: extractToolFileEvidence(extracted.toolCalls),
    toolCallSkillRelations: skillRelations,
    planSnapshots: extracted.planSnapshots,
    compactions: extracted.compactions,
});
```

  - Subtlety the parity test will catch if wrong: legacy `buildClaudeProviderStatements` passes `sourcePath: extracted.sourcePath` directly into `AgentSessionWrite`, while `toAgentSession` emits `sourcePath: session.sourcePath ?? session.rawFile` only when one is defined. `FileExtract.sourcePath` is `string | null` - when null, legacy emitted `source_path: NONE` via `surrealOptionString(null)`, and the new path (sourcePath defined-as-null → spread taken, `null ?? undefined === rawFile` branch) must produce the same `NONE`. Verify in the parity run; if a delta appears, set `sourcePath: extracted.sourcePath` AND omit `rawFile` (as above) and re-check.
  - Rename `buildTurnStatements` (1234–1242) → `legacyBuildClaudeTurnStatements`, `buildClaudeProviderStatements` (1371–1413) → `legacyBuildClaudeProviderStatements`; add `export const __legacyBuildClaudeTurnStatements = legacyBuildClaudeTurnStatements;` and `export const __legacyBuildClaudeProviderStatements = legacyBuildClaudeProviderStatements;`.
  - Reimplement the subagent turn writer over the seam (callers in `derive-claude-subagents.ts:322–336` unchanged):

```ts
const upsertTurns = (turns: Turn[]) =>
    Effect.gen(function* () {
        if (turns.length === 0) return;
        yield* queryTranscriptStatements(
            buildNormalizedTurnStatements(turns.map(toNormalizedClaudeTurn)),
            "upsertTurns",
        );
    });
```

  - Replace the per-file write block in `ingestTranscripts` (current lines 1733–1756) with:

```ts
            yield* writeClaudeTokenUsage(extracted);
            // Resolve invoked names onto the catalog before writing so the
            // `invoked` and `concerns` edges land on the real skill row.
            const resolvedInvocations = extracted.invocations.map((inv) => ({
                ...inv,
                skill: resolveSkillName(inv.skill, skillCatalog) ?? inv.skill,
            }));
            const resolvedSkillRelations = extracted.skillRelations.map((rel) => ({
                ...rel,
                skillName: resolveSkillName(rel.skillName, skillCatalog) ?? rel.skillName,
            }));
            yield* queryTranscriptStatements(
                buildNormalizedTranscriptStatements(
                    toClaudeNormalizedBatch(extracted, resolvedSkillRelations),
                ),
                "normalizedBatch",
            );
            turnCount += extracted.turns.length;
            toolCallCount += extracted.toolCalls.length;
            planSnapshotCount += extracted.planSnapshots.length;
            yield* relateInvocations(resolvedInvocations);
            invCount += resolvedInvocations.length;
            yield* writeHookEvidence(extracted.hookEvents, extracted.hookCommandInvocations);
            hookEventCount += extracted.hookEvents.length;
            hookCommandInvocationCount += extracted.hookCommandInvocations.length;
            editCount += extracted.edits.length;
```

    (`upsertSessions([extracted.session])` and `sessions += 1` stay immediately before this block, exactly as today; the order session-upsert → batch → invoked-edges → hooks preserves every existing referential ordering.)
  - Delete now-unused: `writeProviderEvidence`, `writeCompactions`, `writeToolCallStatements`/`writeToolFileEvidence`/`relateToolCallSkills`/`writePlanSnapshots` **bodies stay** (they are exported `ForSubagents` at 1161–1169 and used by `derive-claude-subagents.ts`) - only `writeProviderEvidence` and `writeCompactions` have no remaining caller; delete those two and their export lines if any (they are not in the ForSubagents list).
- [ ] Run `bun test apps/axctl/src/ingest/transcripts.parity.test.ts apps/axctl/src/ingest/transcripts.test.ts apps/axctl/src/ingest/derive-claude-subagents.test.ts apps/axctl/src/ingest/transcript-stream-parity.test.ts apps/axctl/src/ingest/transcript-vanished-file.test.ts` → **PASS**.
- [ ] Update `provider-parity.ts` claude rows: 150 → `{ path: ".../transcripts.ts", contains: "toolCalls: extracted.toolCalls" }`; 176–177 → `contains: "relateInvocations"` stays valid (invoked edges still written there - keep row 176 as `->invoked:` since `relateInvocations` still contains the RELATE template) and 177 stays (`buildRelateToolCallSkillStatements` still imported/used by `relateToolCallSkillsForSubagents`); 206 → `contains: "planSnapshots: extracted.planSnapshots"`; 226/251 → `contains: "toolFileEvidence: extractToolFileEvidence(extracted.toolCalls)"`. Run `bun test apps/axctl/src/ingest/provider-parity.test.ts` → **PASS**.
- [ ] `bun run typecheck` → clean.
- [ ] Commit:

```
refactor(ingest): claude parser emits NormalizedTranscriptBatch

Seven per-section statement writes collapse into one normalized batch
write (multiset-identical, see transcripts.parity.test.ts). Hooks, real
skill invoked-edges, and token usage stay as documented claude extras;
subagent section writers keep their signatures.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

### Task 7 - Delete legacy builders, convert parity tests to golden assertions

**Files:**
- `apps/axctl/src/ingest/cursor.ts` (delete `legacyBuildCursorBatchStatements`, `buildTurnStatements` 878–887, `buildSyntheticSkillAndInvocationStatements` 889–905, `__legacy` export; prune unused imports: `skillRecordKey`, `invokedRelationRecordKey`, `recordRef`/`surrealDate`/`surrealString` if unused, `buildAgentEventStatements`/`buildAgentProviderStatements`/`buildCompactionStatements`/`buildRelateToolCallSkillStatements`/`buildToolCallStatements` where the legacy fn was the last caller)
- `apps/axctl/src/ingest/pi.ts` (delete `legacyBuildPiBatchStatements`, turn/synthetic builders 666–693, `__legacy` export; prune imports - `buildPiTokenUsageStatements` and its surql imports STAY)
- `apps/axctl/src/ingest/codex.ts` (delete `legacyBuildCodexBatchStatements`, `buildCodexProviderStatements` 1274–1324, `buildTurnStatements` 1244–1248, `buildSyntheticSkillAndInvocationStatements` 1250–1270, `__legacy` export; token-usage builders STAY; `buildAgentEventParentEdgeStatement` import goes if the legacy fn was its last codex caller - it is)
- `apps/axctl/src/ingest/transcripts.ts` (delete `legacyBuildClaudeTurnStatements`, `legacyBuildClaudeProviderStatements`, both `__legacy` exports; prune `surrealLiteral` usage if the legacy turn builder was its last turn-side caller - hook builders still use it, keep)
- `apps/axctl/src/ingest/{cursor,pi,codex,transcripts}.parity.test.ts` (replace legacy-vs-new comparison with golden assertions on the new path)

**Steps:**

- [ ] For each parity test, replace the `diffStatementSets(legacy, next)` assertion with direct golden assertions that pin the load-bearing statement shapes on the NEW path (these survive as regression tests). Pattern (cursor shown; mirror for pi/codex/claude with their scope/hash/provider literals):

```ts
const statements = __testBuildCursorBatchStatements(extracted, dbPath);
const sql = statements.join("\n");
expect(sql).toContain("UPSERT agent_provider:`cursor`");
expect(sql).toContain('scope: "cursor-tool", dir_path: "(synthetic)", content_hash: "cursor"');
expect(sql).toMatch(/RELATE turn:`[^`]+`->invoked:`[^`]+`->skill:`[^`]+` SET session = session:/);
expect(statements.some((s) => s.startsWith("UPSERT compaction:"))).toBe(withCompaction);
```

  (Check the actual compaction record-table prefix emitted by `buildCompactionStatements` before writing the literal - read `compaction.ts:46` first.)
- [ ] Run each parity test → **FAIL only if the golden literals are mistyped**; fix literals against actual output, then **PASS**.
- [ ] Delete the legacy functions + `__legacy*` exports listed above; prune imports flagged by typecheck/oxlint.
- [ ] `bun run typecheck` → clean. `bun test apps/axctl/src/ingest` → **PASS** (full ingest suite - also re-validates `provider-parity.test.ts` since deleted code can break `contains` rows; fix any row that referenced deleted text).
- [ ] Commit:

```
refactor(ingest): delete legacy per-parser statement builders

The normalized seam is now the only dual-write statement composer;
parity tests become golden-shape regression tests on the new path.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

### Task 8 - Extract shared `walkJsonlFiles`

The two walkers are structurally ~95% identical but **deliberately differ in semantics** - the shared module must preserve both behaviors, parameterized, not average them:

| | codex (`codex.ts:476–511`) | pi (`pi.ts:627–664`) |
|---|---|---|
| classification | `fs.stat` (follows symlinks) | `classifyNoFollow` (symlinks skipped) |
| error channel | NotFound skipped, other `PlatformError`s **propagate** | every error absorbed (`orAbsent`), `E = never` |
| result | `{ path, sizeBytes }` | `{ path }` |

**Files:**
- `apps/axctl/src/ingest/walk-jsonl.ts` (new)
- `apps/axctl/src/ingest/walk-jsonl.test.ts` (new - move/adapt the walk test from `pi.test.ts:~600–625`)
- `apps/axctl/src/ingest/codex.ts` (delete 458–511, import `walkJsonlFilesStrict`)
- `apps/axctl/src/ingest/pi.ts` (delete 612–664, import `walkJsonlFilesLenient`, drop `__testWalkJsonlFiles` export)
- `apps/axctl/src/ingest/pi.test.ts` (line 10 import + line 619 call → new module)

**Steps:**

- [ ] Write `walk-jsonl.test.ts` first (red): create a tmp tree `root/2026/06/a.jsonl`, `root/2026/06/b.txt`, a symlinked dir, and an old-mtime file; assert (1) strict + lenient both find only `a.jsonl`, (2) lenient skips the symlinked dir's contents, (3) `cutoffMs` filtering, (4) strict returns `sizeBytes`, (5) both return `[]` for a missing root. Provide `BunFsLayer` the way `pi.test.ts:619` does.
- [ ] Run → **FAIL** (module missing).
- [ ] Implement `walk-jsonl.ts` - a shared recursion core with the two behaviors as presets (complete file):

```ts
import { Effect, FileSystem, Option, Path, PlatformError } from "effect";
import { classifyNoFollow } from "@ax/lib/shared/fs-classify";
import { orAbsent, skipNotFound } from "@ax/lib/shared/fs-error";

export interface JsonlFileCandidate {
    readonly path: string;
    readonly sizeBytes: number;
}

interface WalkEntryFile {
    readonly kind: "file";
    readonly mtimeMs: number;
    readonly sizeBytes: number;
}
interface WalkEntryDir {
    readonly kind: "directory";
}
type WalkEntry = WalkEntryFile | WalkEntryDir;

/**
 * Shared recursion skeleton for the nested (year/month/day) jsonl session
 * trees. The two presets below differ ONLY in their `listDir`/`classifyEntry`
 * strategies, which carry the provider-specific error + symlink semantics:
 *
 *   - strict (codex): `fs.stat` classification (follows symlinks); a vanished
 *     dir/entry (NotFound) is skipped, any other PlatformError PROPAGATES so a
 *     genuine FS fault is loud.
 *   - lenient (pi): `classifyNoFollow` (symlinked dirs are NOT recursed,
 *     symlinked files NOT ingested); EVERY PlatformError recovers to "absent",
 *     matching the old blanket try/catch (`E = never`).
 */
const walkJsonlCore = <E>(input: {
    readonly root: string;
    readonly cutoffMs: number;
    readonly listDir: (dir: string) => Effect.Effect<readonly string[], E, never>;
    readonly classifyEntry: (full: string) => Effect.Effect<Option.Option<WalkEntry>, E, never>;
    readonly joinPath: (dir: string, entry: string) => string;
}): Effect.Effect<JsonlFileCandidate[], E, never> =>
    Effect.gen(function* () {
        const out: JsonlFileCandidate[] = [];
        const visit = (dir: string): Effect.Effect<void, E, never> =>
            Effect.gen(function* () {
                const entries = yield* input.listDir(dir);
                for (const entry of entries) {
                    const full = input.joinPath(dir, entry);
                    const classified = yield* input.classifyEntry(full);
                    if (Option.isNone(classified)) continue;
                    const info = classified.value;
                    if (info.kind === "directory") {
                        yield* visit(full);
                    } else if (full.endsWith(".jsonl")) {
                        if (input.cutoffMs > 0 && info.mtimeMs < input.cutoffMs) continue;
                        out.push({ path: full, sizeBytes: info.sizeBytes });
                    }
                }
            });
        yield* visit(input.root);
        return out;
    });

/** Codex semantics: see {@link walkJsonlCore}. `File.Info.mtime` is
 *  `Option<Date>` (epoch-0 fallback so a missing mtime is never
 *  `--since`-skipped); `.size` is a branded bigint coerced to number. */
export const walkJsonlFilesStrict = (
    root: string,
    cutoffMs: number,
): Effect.Effect<JsonlFileCandidate[], PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        return yield* walkJsonlCore<PlatformError.PlatformError>({
            root,
            cutoffMs,
            joinPath: (dir, entry) => path.join(dir, entry),
            listDir: (dir) => fs.readDirectory(dir).pipe(skipNotFound([] as string[])),
            classifyEntry: (full) =>
                fs.stat(full).pipe(
                    Effect.map((stats) =>
                        stats.type === "Directory"
                            ? Option.some<WalkEntry>({ kind: "directory" })
                            : stats.type === "File"
                                ? Option.some<WalkEntry>({
                                    kind: "file",
                                    mtimeMs: Option.getOrElse(stats.mtime, () => new Date(0)).getTime(),
                                    sizeBytes: Number(stats.size),
                                })
                                : Option.none<WalkEntry>(),
                    ),
                    skipNotFound(Option.none<WalkEntry>()),
                ),
        });
    });

/** Pi semantics: see {@link walkJsonlCore}. `sizeBytes` is reported but the
 *  pi caller ignores it (the old walker never collected size). */
export const walkJsonlFilesLenient = (
    root: string,
    cutoffMs: number,
): Effect.Effect<JsonlFileCandidate[], never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        return yield* walkJsonlCore<never>({
            root,
            cutoffMs,
            joinPath: (dir, entry) => path.join(dir, entry),
            listDir: (dir) => fs.readDirectory(dir).pipe(orAbsent([] as string[])),
            classifyEntry: (full) =>
                classifyNoFollow(full).pipe(
                    Effect.flatMap((kind) => {
                        if (kind === "Directory") {
                            return Effect.succeed(Option.some<WalkEntry>({ kind: "directory" }));
                        }
                        if (kind !== "File") return Effect.succeed(Option.none<WalkEntry>());
                        return fs.stat(full).pipe(
                            Effect.map((stats) =>
                                Option.some<WalkEntry>({
                                    kind: "file",
                                    mtimeMs: Option.getOrElse(stats.mtime, () => new Date(0)).getTime(),
                                    sizeBytes: Number(stats.size),
                                })
                            ),
                            orAbsent(Option.none<WalkEntry>()),
                        );
                    }),
                ),
        });
    });
```

  NOTE before coding: confirm `classifyNoFollow`'s exact return type/requirements in `packages/lib/src/shared/fs-classify.ts` (pi.ts:643 calls it bare inside `Effect.gen`, so it requires `FileSystem` in `R` - if so, capture `fs` via a closure the same way and `Effect.provideService` is NOT needed because the preset closures already run inside the outer `Effect.gen` that has `FileSystem`; adjust the `never` R on the core's callbacks to match what typecheck demands, keeping the PUBLIC signatures exactly as above). One behavioral nuance preserved: the old pi walker skipped a file whose `stat` failed (`mtimeMs < 0 → continue`) - here that becomes `Option.none` → skipped, identical.
- [ ] Wire codex: replace `walkJsonlFiles(cfg.paths.codexDir, cutoff)` (line 1472) with `walkJsonlFilesStrict(...)`; delete `CodexFileCandidate` + local walker (458–511).
- [ ] Wire pi: replace `walkJsonlFiles(cfg.paths.piDir, cutoff)` (line 797) with `walkJsonlFilesLenient(...)`; delete local walker + `PiFileCandidate` + `__testWalkJsonlFiles` (612–664); update `pi.test.ts` line 10/619 to `import { walkJsonlFilesLenient } from "./walk-jsonl.ts"` (or delete the pi walk test if fully superseded by `walk-jsonl.test.ts` - prefer moving it).
- [ ] Run `bun test apps/axctl/src/ingest/walk-jsonl.test.ts apps/axctl/src/ingest/pi.test.ts apps/axctl/src/ingest/codex.test.ts apps/axctl/src/ingest/codex-vanished-file.test.ts` → **PASS**. `bun run typecheck` → clean.
- [ ] Commit:

```
refactor(ingest): extract shared walkJsonlFiles with strict/lenient presets

Codex keeps propagate-on-fault stat semantics; pi keeps absorb-all
no-symlink-follow semantics. One recursion skeleton, two documented
strategies.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

### Task 9 - Full verification sweep

**Files:** none (verification only; fix-forward anything found)

- [ ] `bun run typecheck` (repo root) → clean.
- [ ] `bun test apps/axctl` → all green (covers ingest suite, stage tests, provider-parity matrix, dashboard consumers of turn/tool_call shapes).
- [ ] Grep for leftovers: `rg -n "__legacy|legacyBuild|buildSyntheticSkillAndInvocationStatements|buildCursorBatchStatementsLegacy" apps/axctl/src` → no hits.
- [ ] Grep that no parser composes turn/invoked/agent-statements locally anymore: `rg -n "UPSERT turn:|->invoked:" apps/axctl/src/ingest/{codex,pi,cursor,opencode}.ts` → no hits (transcripts.ts keeps ONE `->invoked:` inside `relateInvocations` - expected, documented in gap table 1.1).
- [ ] OPTIONAL live smoke (only if a local SurrealDB instance is running and the ax-watch daemon is stopped - see memory: re-ingest watcher race): `bun apps/axctl/bin/axctl ingest --since=1 --stages=claude,codex,pi,opencode,cursor` twice; second run must complete without `agent_event_session_seq` errors and report stable counts.
- [ ] Commit (only if fixes were needed) using `fix(ingest): …` + the standard trailer:

```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## 4. Risk register

| Risk | Mitigation |
|---|---|
| Hidden statement drift (escaping, NONE vs omitted, field order) | Byte-level multiset parity tests per parser BEFORE any legacy deletion; ledger D1–D5 enumerates every allowed delta |
| Codex streaming clears wiping same-run events | `clearExisting` forwarded verbatim through the seam; streaming parity test exercises first-true-then-false explicitly |
| Claude `relateInvocations` placeholder logic accidentally routed through synthetic-invocation builder (would MERGE synthetic scope onto real skill rows) | Explicit (b) decision in gap table 1.1; Task 6 leaves `relateInvocations` untouched and the parity test excludes invoked edges on both sides |
| `derive-claude-subagents` breakage | `*ForSubagents` export names + signatures frozen; its test runs in Task 6 |
| `provider-parity.test.ts` contains-rows referencing deleted code | Each parser task updates its rows (opencode rows at lines 188–191 are the precedent) and runs the parity matrix test |
| walk extraction silently unifying error semantics | Two presets with documented divergent strategies; behavior table in Task 8; codex-vanished-file + pi walk tests re-run |

## 5. Unresolved questions for the operator

1. Task 6 collapses claude's seven write spans into one `"normalizedBatch"` call (ledger D5). If per-section write timing matters for your OTLP dashboards (memory: ingest-otlp-instrumentation), say so before Task 6 and the implementer will keep per-section `queryTranscriptStatements` calls fed by normalized sub-builders instead - parity test is unaffected.
2. Should an ADR (e.g. `0012-parsers-as-normalized-batch-adapters.md`) record this seam decision? Not included in the tasks; cheap to add after Task 9.
3. Cursor emits no tool-file evidence today and this plan preserves that gap verbatim. Open a follow-up issue to add it deliberately (it is a one-field change post-refactor: `toolFileEvidence: extractToolFileEvidence(extract.toolCalls)`).
