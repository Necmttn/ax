# Compaction Signal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make context compaction a first-class, queryable event across the Pi, Codex, Claude, and Cursor harness parsers in the ax ingest pipeline.

**Architecture:** A new SCHEMAFULL `compaction` projection table (mirroring `plan_snapshot`) plus a shared `compaction.ts` module holding the typed `CompactionWrite` shape, its SurrealDB statement builder, and four pure per-harness extractors. Each parser detects its native compaction marker, builds a `CompactionWrite`, threads it through the existing `*Extract` accumulator, and appends `buildCompactionStatements(...)` to its batch write. The Claude parser additionally stops mis-ingesting the `isCompactSummary` continuation message as a normal turn. Two compaction models (summarize-to-text vs history-replacement) are unified via a `strategy` discriminant. OpenCode is out of scope (gets the schema field, stays null).

**Tech Stack:** TypeScript (strict), bun ≥ 1.3, SurrealDB 3.0+, `bun:test`. SurrealDB statement helpers from `@ax/lib/shared/surql`. Provider-event substrate in `apps/axctl/src/ingest/provider-events.ts`.

**Spec:** `docs/superpowers/specs/2026-06-04-compaction-signal-design.md`

**Working tree:** worktree `feat/compaction-signal` (branch `feat/compaction-signal`). All commits land here; integrate via PR.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `packages/schema/src/schema.surql` | DDL - add `compaction` table | Modify (after `plan_snapshot`, ~line 501) |
| `apps/axctl/src/ingest/compaction.ts` | `CompactionWrite` type, `compactionRecordKey`, `buildCompactionStatements`, 4 pure extractors | Create |
| `apps/axctl/src/ingest/compaction.test.ts` | Unit tests for builder + extractors | Create |
| `apps/axctl/src/ingest/codex.ts` | Detect `type:"compacted"`, thread compactions | Modify |
| `apps/axctl/src/ingest/codex.test.ts` | Codex compaction test | Modify |
| `apps/axctl/src/ingest/pi.ts` | Detect `type:"compaction"`, thread compactions | Modify |
| `apps/axctl/src/ingest/pi.test.ts` | Pi compaction test | Modify |
| `apps/axctl/src/ingest/transcripts.ts` | Detect `isCompactSummary`, skip turn, thread compactions | Modify |
| `apps/axctl/src/ingest/transcripts.test.ts` | Claude compaction + turn-skip regression | Modify/Create |
| `apps/axctl/src/ingest/cursor.ts` | Detect non-empty `summarizedComposers`, thread compactions | Modify |
| `apps/axctl/src/ingest/cursor.test.ts` | Cursor compaction test | Modify |
| `apps/axctl/src/dashboard/session-show.ts` | Add `compactions` to `SessionViewPayload` + query | Modify |
| `apps/axctl/src/cli/session-show-format.ts` | Render compaction boundaries | Modify |
| `apps/axctl/src/cli/session-show-format.test.ts` | Renderer test | Modify |

**Control-flow flags (from codebase analysis):**
- **Pi already emits a generic provider event for every entry** (`pi.ts:517` unconditional `pushProviderEvent` with `type` passed through). So a `type:"compaction"` entry *already* produces an `agent_event` with `type:"compaction"`. Do **NOT** add a second `pushProviderEvent` in the Pi arm - only extract the projection row. Capture the emitted event's key via `agentEventRecordKey(...)` for the `agent_event` link.
- **Codex drops unknown top-level types** - `type:"compacted"` falls through the whole switch and emits nothing today. The Codex arm MUST both `pushProviderEvent` and extract the projection row.
- **`agent_event.type` is an unconstrained string** - `"compaction"` needs no DDL change for the event. Only the new `compaction` projection table is new DDL.
- **No codegen** - `packages/schema/src/types.ts` is a hand-written stub; no derived-type update is required.

---

## Task 1: Schema - `compaction` table

**Files:**
- Modify: `packages/schema/src/schema.surql` (insert after `plan_snapshot` block, which ends at line 501)
- Test: `packages/schema/src/schema.test.ts` (already applies the full schema; no new test needed - it validates the DDL parses/applies)

- [ ] **Step 1: Add the table DDL**

Insert immediately after the `plan_snapshot` index lines (after `schema.surql:501`):

```surql

DEFINE TABLE compaction SCHEMAFULL;
DEFINE FIELD session           ON compaction TYPE record<session>;
DEFINE FIELD agent_event       ON compaction TYPE option<record<agent_event>>;
DEFINE FIELD harness           ON compaction TYPE string;          -- provider name: claude|codex|pi|cursor|opencode
DEFINE FIELD ts                ON compaction TYPE datetime;
DEFINE FIELD trigger           ON compaction TYPE option<string>;  -- auto|manual|hook
DEFINE FIELD strategy          ON compaction TYPE string;          -- summarize|history_replacement|encrypted
DEFINE FIELD source_confidence ON compaction TYPE string;          -- explicit|derived
DEFINE FIELD summary           ON compaction TYPE option<string>;  -- Pi/Claude; null for Codex/Cursor
DEFINE FIELD tokens_before     ON compaction TYPE option<int>;
DEFINE FIELD boundary_ref      ON compaction TYPE option<string>;  -- where post-compaction history resumes
DEFINE FIELD kept_count        ON compaction TYPE option<int>;     -- Codex replacement_history length
DEFINE FIELD read_files        ON compaction TYPE option<string>;  -- JSON-encoded array; Pi details
DEFINE FIELD modified_files    ON compaction TYPE option<string>;  -- JSON-encoded array; Pi details
DEFINE FIELD raw               ON compaction TYPE option<string>;  -- JSON-encoded
DEFINE INDEX compaction_session_ts  ON compaction FIELDS session, ts;
DEFINE INDEX compaction_agent_event ON compaction FIELDS agent_event;
```

- [ ] **Step 2: Run the schema test to verify the DDL applies**

Run: `bun test packages/schema/src/schema.test.ts`
Expected: PASS (schema applies cleanly; a malformed DDL would fail to parse).

- [ ] **Step 3: Commit**

```bash
git -C .claude/worktrees/compaction-signal add packages/schema/src/schema.surql
git -C .claude/worktrees/compaction-signal commit -m "feat(schema): add compaction projection table"
```

---

## Task 2: Shared `compaction.ts` module

**Files:**
- Create: `apps/axctl/src/ingest/compaction.ts`
- Test: `apps/axctl/src/ingest/compaction.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/axctl/src/ingest/compaction.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
    buildCompactionStatements,
    compactionRecordKey,
    extractCodexCompaction,
    extractCursorCompaction,
    extractPiCompaction,
    type CompactionWrite,
} from "./compaction.ts";

describe("compactionRecordKey", () => {
    test("is deterministic and sanitized", () => {
        expect(compactionRecordKey("codex", "sess-1:abc", 3)).toBe("codex_sess_1_abc_cmp_3");
    });
});

describe("buildCompactionStatements", () => {
    test("emits one UPSERT with typed fields", () => {
        const write: CompactionWrite = {
            compactionKey: "codex_s_cmp_1",
            sessionId: "s",
            agentEventKey: "codex_s_seq_000001",
            harness: "codex",
            ts: new Date("2026-05-14T15:34:42.663Z"),
            trigger: "auto",
            strategy: "history_replacement",
            sourceConfidence: "explicit",
            summary: null,
            tokensBefore: 120000,
            boundaryRef: "seq_42",
            keptCount: 83,
            readFiles: null,
            modifiedFiles: null,
            raw: { replacement_count: 83 },
        };
        const [stmt] = buildCompactionStatements([write]);
        expect(stmt).toContain("UPSERT compaction:");
        expect(stmt).toContain("harness: 'codex'");
        expect(stmt).toContain("strategy: 'history_replacement'");
        expect(stmt).toContain("kept_count: 83");
        expect(stmt).toContain("tokens_before: 120000");
        expect(stmt).toContain("summary: NONE");
        expect(stmt).toContain("session: session:");
        expect(stmt).toContain("agent_event: agent_event:");
    });

    test("null kept_count and tokens become NONE", () => {
        const write: CompactionWrite = {
            compactionKey: "pi_s_cmp_1",
            sessionId: "s",
            agentEventKey: null,
            harness: "pi",
            ts: new Date("2026-05-29T06:05:38.132Z"),
            trigger: "auto",
            strategy: "summarize",
            sourceConfidence: "explicit",
            summary: "Goal: ship X",
            tokensBefore: 90000,
            boundaryRef: "entry-7",
            keptCount: null,
            readFiles: ["a.ts", "b.ts"],
            modifiedFiles: null,
            raw: null,
        };
        const [stmt] = buildCompactionStatements([write]);
        expect(stmt).toContain("kept_count: NONE");
        expect(stmt).toContain("agent_event: NONE");
        expect(stmt).toContain("strategy: 'summarize'");
        expect(stmt).toContain("read_files: '[\"a.ts\",\"b.ts\"]'");
        expect(stmt).toContain("raw: NONE");
    });
});

describe("extractPiCompaction", () => {
    test("maps a Pi CompactionEntry", () => {
        const entry = {
            type: "compaction",
            id: "c1",
            summary: "Goal: ship X",
            firstKeptEntryId: "entry-7",
            tokensBefore: 90000,
            fromHook: false,
            details: { readFiles: ["a.ts"], modifiedFiles: ["b.ts"] },
        };
        const w = extractPiCompaction(entry, {
            sessionId: "s",
            providerSessionId: "ps",
            seq: 4,
            ts: new Date("2026-05-29T06:05:38.132Z"),
            agentEventKey: "pi_ps_seq_000004",
        });
        expect(w).not.toBeNull();
        expect(w!.strategy).toBe("summarize");
        expect(w!.summary).toBe("Goal: ship X");
        expect(w!.tokensBefore).toBe(90000);
        expect(w!.boundaryRef).toBe("entry-7");
        expect(w!.trigger).toBe("auto");
        expect(w!.readFiles).toEqual(["a.ts"]);
        expect(w!.modifiedFiles).toEqual(["b.ts"]);
    });

    test("fromHook=true => trigger hook", () => {
        const w = extractPiCompaction(
            { type: "compaction", summary: "s", fromHook: true },
            { sessionId: "s", providerSessionId: "ps", seq: 1, ts: new Date(0), agentEventKey: null },
        );
        expect(w!.trigger).toBe("hook");
    });
});

describe("extractCodexCompaction", () => {
    test("history-replacement with kept_count", () => {
        const payload = {
            message: "",
            replacement_history: [{ type: "message" }, { type: "message" }, { type: "message" }],
        };
        const w = extractCodexCompaction(payload, {
            sessionId: "s",
            providerSessionId: "ps",
            seq: 10,
            ts: new Date("2026-05-14T15:34:42.663Z"),
            agentEventKey: "codex_ps_seq_000010",
            tokensBefore: 120000,
            boundaryRef: "seq_10",
        });
        expect(w!.strategy).toBe("history_replacement");
        expect(w!.summary).toBeNull();
        expect(w!.keptCount).toBe(3);
        expect(w!.tokensBefore).toBe(120000);
        expect(w!.trigger).toBe("auto");
    });

    test("non-empty message => manual trigger + summary", () => {
        const w = extractCodexCompaction(
            { message: "focus on auth", replacement_history: [] },
            { sessionId: "s", providerSessionId: "ps", seq: 1, ts: new Date(0), agentEventKey: null, tokensBefore: null, boundaryRef: "seq_1" },
        );
        expect(w!.trigger).toBe("manual");
        expect(w!.summary).toBe("focus on auth");
    });
});

describe("extractCursorCompaction", () => {
    test("encrypted strategy, null summary", () => {
        const w = extractCursorCompaction({
            sessionId: "s",
            providerSessionId: "ps",
            seq: 2,
            ts: new Date("2026-05-29T00:00:00.000Z"),
            agentEventKey: "cursor_ps_seq_000002",
            boundaryRef: "bubble-9",
            summarizedComposers: ["comp-1"],
        });
        expect(w.strategy).toBe("encrypted");
        expect(w.summary).toBeNull();
        expect(w.boundaryRef).toBe("bubble-9");
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/axctl/src/ingest/compaction.test.ts`
Expected: FAIL - `Cannot find module './compaction.ts'`.

- [ ] **Step 3: Write the module**

Create `apps/axctl/src/ingest/compaction.ts`:

```ts
import {
    recordRef,
    surrealDate,
    surrealJsonTextOption,
    surrealObject,
    surrealOptionInt,
    surrealOptionRecord,
    surrealOptionString,
    surrealString,
} from "@ax/lib/shared/surql";

export type CompactionStrategy = "summarize" | "history_replacement" | "encrypted";
export type CompactionTrigger = "auto" | "manual" | "hook";
export type CompactionConfidence = "explicit" | "derived";

export interface CompactionWrite {
    readonly compactionKey: string;
    readonly sessionId: string;
    readonly agentEventKey?: string | null;
    readonly harness: string;
    readonly ts: Date;
    readonly trigger?: CompactionTrigger | null;
    readonly strategy: CompactionStrategy;
    readonly sourceConfidence: CompactionConfidence;
    readonly summary?: string | null;
    readonly tokensBefore?: number | null;
    readonly boundaryRef?: string | null;
    readonly keptCount?: number | null;
    readonly readFiles?: readonly string[] | null;
    readonly modifiedFiles?: readonly string[] | null;
    readonly raw?: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

const stringArray = (v: unknown): readonly string[] | null =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;

export const compactionRecordKey = (
    harness: string,
    providerSessionId: string,
    seq: number,
): string => `${harness}_${providerSessionId}_cmp_${seq}`.replace(/[^A-Za-z0-9_]/g, "_");

export const buildCompactionStatements = (
    writes: readonly CompactionWrite[],
): string[] =>
    writes.map(
        (c) =>
            `UPSERT ${recordRef("compaction", c.compactionKey)} CONTENT ${surrealObject([
                ["session", recordRef("session", c.sessionId)],
                ["agent_event", surrealOptionRecord("agent_event", c.agentEventKey ?? null)],
                ["harness", surrealString(c.harness)],
                ["ts", surrealDate(c.ts)],
                ["trigger", surrealOptionString(c.trigger ?? null)],
                ["strategy", surrealString(c.strategy)],
                ["source_confidence", surrealString(c.sourceConfidence)],
                ["summary", surrealOptionString(c.summary ?? null)],
                ["tokens_before", surrealOptionInt(c.tokensBefore ?? null)],
                ["boundary_ref", surrealOptionString(c.boundaryRef ?? null)],
                ["kept_count", surrealOptionInt(c.keptCount ?? null)],
                ["read_files", surrealJsonTextOption(c.readFiles ?? null)],
                ["modified_files", surrealJsonTextOption(c.modifiedFiles ?? null)],
                ["raw", surrealJsonTextOption(c.raw ?? null)],
            ])};`,
    );

export interface PiCompactionCtx {
    readonly sessionId: string;
    readonly providerSessionId: string;
    readonly seq: number;
    readonly ts: Date;
    readonly agentEventKey?: string | null;
}

export const extractPiCompaction = (
    entry: Record<string, unknown>,
    ctx: PiCompactionCtx,
): CompactionWrite | null => {
    if (entry.type !== "compaction") return null;
    const details = isRecord(entry.details) ? entry.details : null;
    return {
        compactionKey: compactionRecordKey("pi", ctx.providerSessionId, ctx.seq),
        sessionId: ctx.sessionId,
        agentEventKey: ctx.agentEventKey ?? null,
        harness: "pi",
        ts: ctx.ts,
        trigger: entry.fromHook === true ? "hook" : "auto",
        strategy: "summarize",
        sourceConfidence: "explicit",
        summary: typeof entry.summary === "string" ? entry.summary : null,
        tokensBefore: typeof entry.tokensBefore === "number" ? entry.tokensBefore : null,
        boundaryRef:
            typeof entry.firstKeptEntryId === "string" ? entry.firstKeptEntryId : null,
        keptCount: null,
        readFiles: details ? stringArray(details.readFiles) : null,
        modifiedFiles: details ? stringArray(details.modifiedFiles) : null,
        raw: { fromHook: entry.fromHook === true },
    };
};

export interface CodexCompactionCtx {
    readonly sessionId: string;
    readonly providerSessionId: string;
    readonly seq: number;
    readonly ts: Date;
    readonly agentEventKey?: string | null;
    readonly tokensBefore?: number | null;
    readonly boundaryRef?: string | null;
}

export const extractCodexCompaction = (
    payload: Record<string, unknown>,
    ctx: CodexCompactionCtx,
): CompactionWrite | null => {
    const replacement = Array.isArray(payload.replacement_history)
        ? payload.replacement_history
        : [];
    const message = typeof payload.message === "string" ? payload.message : "";
    return {
        compactionKey: compactionRecordKey("codex", ctx.providerSessionId, ctx.seq),
        sessionId: ctx.sessionId,
        agentEventKey: ctx.agentEventKey ?? null,
        harness: "codex",
        ts: ctx.ts,
        trigger: message.length > 0 ? "manual" : "auto",
        strategy: "history_replacement",
        sourceConfidence: "explicit",
        summary: message.length > 0 ? message : null,
        tokensBefore: ctx.tokensBefore ?? null,
        boundaryRef: ctx.boundaryRef ?? null,
        keptCount: replacement.length,
        readFiles: null,
        modifiedFiles: null,
        raw: { replacement_count: replacement.length },
    };
};

export interface ClaudeCompactionCtx {
    readonly sessionId: string;
    readonly providerSessionId: string;
    readonly seq: number;
    readonly ts: Date;
    readonly agentEventKey?: string | null;
    readonly summary: string | null;
    readonly boundaryRef?: string | null;
}

export const extractClaudeCompaction = (
    ctx: ClaudeCompactionCtx,
): CompactionWrite => ({
    compactionKey: compactionRecordKey("claude", ctx.providerSessionId, ctx.seq),
    sessionId: ctx.sessionId,
    agentEventKey: ctx.agentEventKey ?? null,
    harness: "claude",
    ts: ctx.ts,
    trigger: "auto",
    strategy: "summarize",
    sourceConfidence: "explicit",
    summary: ctx.summary,
    tokensBefore: null,
    boundaryRef: ctx.boundaryRef ?? null,
    keptCount: null,
    readFiles: null,
    modifiedFiles: null,
    raw: null,
});

export interface CursorCompactionCtx {
    readonly sessionId: string;
    readonly providerSessionId: string;
    readonly seq: number;
    readonly ts: Date;
    readonly agentEventKey?: string | null;
    readonly boundaryRef?: string | null;
    readonly summarizedComposers: readonly string[];
}

export const extractCursorCompaction = (
    ctx: CursorCompactionCtx,
): CompactionWrite => ({
    compactionKey: compactionRecordKey("cursor", ctx.providerSessionId, ctx.seq),
    sessionId: ctx.sessionId,
    agentEventKey: ctx.agentEventKey ?? null,
    harness: "cursor",
    ts: ctx.ts,
    trigger: "auto",
    strategy: "encrypted",
    sourceConfidence: "explicit",
    summary: null,
    tokensBefore: null,
    boundaryRef: ctx.boundaryRef ?? null,
    keptCount: null,
    readFiles: null,
    modifiedFiles: null,
    raw: { summarized_composers: ctx.summarizedComposers },
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test apps/axctl/src/ingest/compaction.test.ts`
Expected: PASS (all assertions). If `read_files` assertion fails, confirm `surrealJsonTextOption` emits compact JSON (no spaces) - `JSON.stringify(["a.ts","b.ts"])` => `["a.ts","b.ts"]`.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git -C .claude/worktrees/compaction-signal add apps/axctl/src/ingest/compaction.ts apps/axctl/src/ingest/compaction.test.ts
git -C .claude/worktrees/compaction-signal commit -m "feat(ingest): shared compaction write type, statement builder, extractors"
```

---

## Task 3: Codex parser - detect `type:"compacted"`

**Files:**
- Modify: `apps/axctl/src/ingest/codex.ts`
- Test: `apps/axctl/src/ingest/codex.test.ts`

Context (from analysis): `processLine` switch is at `codex.ts:867-967`; the `token_count` block is at `:901-911`; the `response_item` block starts at `:913`. The `*Extract` accumulators are closure arrays drained via `.splice(...)` at `:833` and returned in the drain object at `:852`; `planSnapshots` is an existing projection accumulator threaded the same way you'll thread `compactions`. The provider statement builder `buildCodexProviderStatements` is at `:1230-1280`. `pushProviderEvent` is at `:566` and `agentEventRecordKey` is imported from `./provider-events.ts`.

- [ ] **Step 1: Write the failing test**

Add to `apps/axctl/src/ingest/codex.test.ts`:

```ts
import { extractCodexCompaction } from "./compaction.ts"; // (add if not already imported)

describe("codex compaction", () => {
    test("type:compacted produces a compaction row + provider event", () => {
        const extracted = __testExtractCodexJsonlLines([
            JSON.stringify({ type: "session_meta", payload: { id: "cdx-1", timestamp: "2026-05-14T15:00:00.000Z", cwd: "/tmp", originator: "test" } }),
            JSON.stringify({ type: "event_msg", timestamp: "2026-05-14T15:30:00.000Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120000 }, model_context_window: 200000 } } }),
            JSON.stringify({ type: "compacted", timestamp: "2026-05-14T15:34:42.663Z", payload: { message: "", replacement_history: [{ type: "message" }, { type: "message" }] } }),
        ]);
        expect(extracted.compactions.length).toBe(1);
        const c = extracted.compactions[0];
        expect(c.harness).toBe("codex");
        expect(c.strategy).toBe("history_replacement");
        expect(c.keptCount).toBe(2);
        expect(c.tokensBefore).toBe(120000);
        // provider event emitted with type "compaction"
        expect(extracted.providerEvents.some((e) => e.type === "compaction")).toBe(true);
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/axctl/src/ingest/codex.test.ts`
Expected: FAIL - `extracted.compactions` is undefined.

- [ ] **Step 3: Add the `compactions` accumulator + import**

In `codex.ts`, add to the imports near the existing `./compaction.ts`-adjacent imports:

```ts
import { buildCompactionStatements, extractCodexCompaction, type CompactionWrite } from "./compaction.ts";
```

Near the other closure accumulators (where `providerEvents`/`planSnapshots` are declared, around `codex.ts:551`), add:

```ts
const compactions: CompactionWrite[] = [];
let lastContextTokens: number | null = null;
```

In the `token_count` block (`codex.ts:901-911`), after the existing usage advance, capture the running context size. Add this line inside that block:

```ts
lastContextTokens = tokenUsage?.totalTokens ?? lastContextTokens;
```

(If the local field is named differently, use the `total_tokens` value just parsed by `codexTokenUsageFromPayload`. Confirm the property name on `CodexTokenUsage` by reading `codex.ts:90-98`.)

- [ ] **Step 4: Add the `compacted` arm**

Insert between the `token_count` block (ends `:911`) and the `response_item` block (starts `:913`):

```ts
if (type === "compacted" && payload && session) {
    seq += 1;
    const eventKey = agentEventRecordKey({
        provider: "codex",
        providerSessionId: session.id,
        seq,
        ts,
        type: "compaction",
    });
    pushProviderEvent(
        {
            seq,
            ts,
            type: "compaction",
            role: null,
            text: null,
            metrics: { strategy: "history_replacement" },
            raw: { replacement_count: Array.isArray(payload.replacement_history) ? payload.replacement_history.length : 0 },
        },
        session,
    );
    const write = extractCodexCompaction(payload, {
        sessionId: session.id,
        providerSessionId: session.id,
        seq,
        ts: new Date(ts),
        agentEventKey: eventKey,
        tokensBefore: lastContextTokens,
        boundaryRef: `seq_${seq}`,
    });
    if (write) compactions.push(write);
    return;
}
```

Notes:
- `pushProviderEvent`'s exact argument shape must match its definition at `codex.ts:566` - read it and align field names (`seq`, `ts`, `type`, `role`, `text`, `metrics`, `raw`). The example above assumes the same shape used by the `response_item` pushes.
- `session.id` is the provider session id used elsewhere in this file as the session key - confirm against the `session_meta` block at `:876-887`.
- `agentEventRecordKey` is already imported in this file (used in tests); if not imported in the module, add it from `./provider-events.ts`.

- [ ] **Step 5: Thread `compactions` through drain + finish + remaining**

At the drain site (`codex.ts:833`), add alongside the other `.splice(...)` drains:

```ts
const drainedCompactions = compactions.splice(0, compactions.length);
```

In the drain return object (`codex.ts:852`), add:

```ts
compactions: drainedCompactions,
```

In the `finish()` remaining-return (`codex.ts:864`), add `compactions: remaining.compactions,` to the returned object, and add `compactions: CompactionWrite[]` to the `*Extract` interface for codex (find it near the top of the file - search `interface` with a `providerEvents` field; add the field there).

- [ ] **Step 6: Emit compaction statements in the builder**

In `buildCodexProviderStatements` (`codex.ts:1230-1280`), where it returns the array of statements (it calls `buildAgentEventStatements(...)`), append the compaction statements. Change the returned array to include:

```ts
...buildCompactionStatements(batch.compactions ?? []),
```

`batch` here is the drained/extracted object - confirm it carries `compactions` (it does after Step 5). If the builder's parameter type doesn't include `compactions`, add it to that type.

- [ ] **Step 7: Run tests + typecheck**

Run: `bun test apps/axctl/src/ingest/codex.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git -C .claude/worktrees/compaction-signal add apps/axctl/src/ingest/codex.ts apps/axctl/src/ingest/codex.test.ts
git -C .claude/worktrees/compaction-signal commit -m "feat(ingest): emit compaction events from codex transcripts"
```

---

## Task 4: Pi parser - detect `type:"compaction"`

**Files:**
- Modify: `apps/axctl/src/ingest/pi.ts`
- Test: `apps/axctl/src/ingest/pi.test.ts`

Context: `PiExtract` interface at `pi.ts:81` (has `providerEvents`). The `type` chain is at `pi.ts:440-556`; the **universal** `pushProviderEvent` is at `:517-544` (so a `compaction` entry already emits an `agent_event` with `type:"compaction"` - do NOT add a second push). `finish()` returns the extract at `:558-570`. Statements assembled around `:717` via `buildAgentEventStatements`.

- [ ] **Step 1: Write the failing test**

Add to `apps/axctl/src/ingest/pi.test.ts`:

```ts
describe("pi compaction", () => {
    test("type:compaction produces a compaction row (no duplicate provider event)", () => {
        const extracted = __testExtractPiJsonlLines([
            JSON.stringify({ type: "session", id: "pi-1", timestamp: 1748498738132, cwd: "/tmp" }),
            JSON.stringify({ type: "compaction", id: "c1", parentId: "p0", timestamp: 1748498800000, summary: "Goal: ship X", firstKeptEntryId: "entry-7", tokensBefore: 90000, fromHook: false, details: { readFiles: ["a.ts"], modifiedFiles: [] } }),
        ]);
        expect(extracted.compactions.length).toBe(1);
        const c = extracted.compactions[0];
        expect(c.strategy).toBe("summarize");
        expect(c.summary).toBe("Goal: ship X");
        expect(c.boundaryRef).toBe("entry-7");
        expect(c.tokensBefore).toBe(90000);
        // exactly one provider event for the compaction entry (no double-push)
        expect(extracted.providerEvents.filter((e) => e.type === "compaction").length).toBe(1);
    });
});
```

(If Pi timestamps are epoch-ms, the test uses numbers; confirm the session header field names against `pi.ts:441-459` and adjust the `session` line if needed.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/axctl/src/ingest/pi.test.ts`
Expected: FAIL - `extracted.compactions` is undefined.

- [ ] **Step 3: Add accumulator + interface field + import**

Import in `pi.ts`:

```ts
import { buildCompactionStatements, extractPiCompaction, type CompactionWrite } from "./compaction.ts";
```

Add `compactions: CompactionWrite[];` to the `PiExtract` interface (`pi.ts:81`). Declare the accumulator near `const providerEvents: AgentEventWrite[] = [];` (`pi.ts:294`):

```ts
const compactions: CompactionWrite[] = [];
```

- [ ] **Step 4: Add the compaction extraction (after the universal provider-event push)**

The universal `pushProviderEvent` at `pi.ts:517-544` already emits the `agent_event`. Immediately AFTER that push (so the event key matches), add:

```ts
if (type === "compaction") {
    const eventKey = agentEventRecordKey({
        provider: "pi",
        providerSessionId: session.id,
        seq,
        ts: iso,
        type: "compaction",
    });
    const write = extractPiCompaction(entry, {
        sessionId: session.id,
        providerSessionId: session.id,
        seq,
        ts: new Date(iso),
        agentEventKey: eventKey,
    });
    if (write) compactions.push(write);
}
```

Notes:
- `entry`, `session.id`, `seq`, and the resolved timestamp (`iso`) are the locals already in scope in this loop - confirm their exact names by reading `pi.ts:466-544` (the timestamp local may be named `iso`, `ts`, or come from the `{ ts }` returned by Pi's timestamp resolver at `:466`). Use whatever the universal push at `:517` passes as `ts` so the `agentEventRecordKey` matches the emitted event.
- `agentEventRecordKey` is already imported (`pi.ts:29`).

- [ ] **Step 5: Return compactions from finish()**

In `finish()` (`pi.ts:558-570`), add to the returned object:

```ts
compactions,
```

- [ ] **Step 6: Emit compaction statements**

Where Pi assembles write statements (around `pi.ts:717`, the block that spreads `buildAgentEventStatements({...})`), append:

```ts
...buildCompactionStatements(extract.compactions),
```

(Use the same `extract`/batch variable name in scope at that site - read `:710-750`.)

- [ ] **Step 7: Run tests + typecheck**

Run: `bun test apps/axctl/src/ingest/pi.test.ts && bun run typecheck`
Expected: PASS - and the "no double-push" assertion confirms exactly one `compaction` provider event.

- [ ] **Step 8: Commit**

```bash
git -C .claude/worktrees/compaction-signal add apps/axctl/src/ingest/pi.ts apps/axctl/src/ingest/pi.test.ts
git -C .claude/worktrees/compaction-signal commit -m "feat(ingest): emit compaction events from pi transcripts"
```

---

## Task 5: Claude parser - `isCompactSummary` detect + turn skip

**Files:**
- Modify: `apps/axctl/src/ingest/transcripts.ts`
- Test: `apps/axctl/src/ingest/transcripts.test.ts` (create if absent; the `__testExtractClaudeJsonlLines` re-export is at `transcripts.ts:955`)

Context: `processLine` at `transcripts.ts:814`; `if (type === "summary") return;` at `:818-819` (this is a DIFFERENT marker - leaf title summaries - leave it); `role` derived at `:851`; unconditional `pushProviderEvent` at `:875-893`; normal turn constructed at `:915-926`; `FileExtract` interface at `:290` (has `turns`, `providerEvents`); `finish()` returns at `:938-945`.

The compaction marker is a `type:"user"` entry with `isCompactSummary: true` (and `isVisibleInTranscriptOnly: true`). Goal: emit a `compaction` row, emit the provider event as `type:"compaction"` (not a user turn), and **do not** push a normal user `turn`.

- [ ] **Step 1: Write the failing test**

Create/extend `apps/axctl/src/ingest/transcripts.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { __testExtractClaudeJsonlLines } from "./transcripts.ts";

describe("claude compaction", () => {
    test("isCompactSummary message becomes a compaction row, not a user turn", () => {
        const extracted = __testExtractClaudeJsonlLines([
            JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-06-01T10:00:00.000Z", sessionId: "cl-1", cwd: "/tmp", message: { role: "user", content: "real question" } }),
            JSON.stringify({ type: "user", uuid: "u2", timestamp: "2026-06-01T10:05:00.000Z", sessionId: "cl-1", cwd: "/tmp", isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: "user", content: "## Summary\nGoal: ship X" } }),
        ]);
        // compaction row captured
        expect(extracted.compactions.length).toBe(1);
        expect(extracted.compactions[0].strategy).toBe("summarize");
        expect(extracted.compactions[0].summary).toContain("Goal: ship X");
        expect(extracted.compactions[0].boundaryRef).toBe("u2");
        // the isCompactSummary entry did NOT create a normal user turn
        const userTurnTexts = extracted.turns.filter((t) => t.role === "user").map((t) => t.text);
        expect(userTurnTexts).toContain("real question");
        expect(userTurnTexts.some((t) => t?.includes("Goal: ship X"))).toBe(false);
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/axctl/src/ingest/transcripts.test.ts`
Expected: FAIL - `extracted.compactions` undefined and/or the summary text leaks into a user turn.

- [ ] **Step 3: Add accumulator + interface field + import**

Import in `transcripts.ts`:

```ts
import { buildCompactionStatements, extractClaudeCompaction, type CompactionWrite } from "./compaction.ts";
```

Add `compactions: CompactionWrite[];` to `FileExtract` (`transcripts.ts:290`). Declare near `const turns: Turn[] = [];` (`:306`):

```ts
const compactions: CompactionWrite[] = [];
```

- [ ] **Step 4: Detect `isCompactSummary` and branch**

After `ts`/`role` are resolved (around `:851`) and BEFORE the normal turn push at `:915`, add a guard. Determine the flag and summary text using the same text-extraction the parser already uses for a user turn (the local that holds the turn `text` - read `:895-915` to find its name; call it `text` below):

```ts
const isCompactSummary =
    entry.isCompactSummary === true ||
    (isRecord(entry.message) && (entry.message as Record<string, unknown>).isCompactSummary === true);
if (isCompactSummary) {
    const eventKey = agentEventRecordKey({
        provider: "claude",
        providerSessionId: sessionId,
        seq,
        ts,
        type: "compaction",
    });
    providerEvents.push({
        provider: "claude",
        providerSessionId: sessionId,
        seq,
        ts,
        type: "compaction",
        role: null,
        text,
        metrics: { strategy: "summarize" },
    });
    compactions.push(
        extractClaudeCompaction({
            sessionId,
            providerSessionId: sessionId,
            seq,
            ts: new Date(ts),
            agentEventKey: eventKey,
            summary: text ?? null,
            boundaryRef: typeof entry.uuid === "string" ? entry.uuid : null,
        }),
    );
    return; // skip the normal user turn + the unconditional provider push below
}
```

Notes:
- This `return` must come BEFORE both the unconditional `pushProviderEvent` (`:875`) and the `turns.push` (`:915`) so the entry does not also become a normal turn or a `type:"user"` event. If the unconditional provider push happens earlier than the turn push, place this guard above the provider push (just after `role`/`ts`/`text` are available).
- `sessionId`, `seq`, `ts`, and `text` are locals already in scope - confirm exact names against `:843-915`. `isRecord` and `agentEventRecordKey` are already used in this file (imports at top).
- The `AgentEventWrite` push shape must match how `providerEvents.push({...})` is called at `:875-893` - copy that call's field set, swapping `type` to `"compaction"`, `role` to `null`, and keeping `text`.

- [ ] **Step 5: Return compactions from finish() + emit statements**

In `finish()` (`:938-945`) add `compactions,` to the returned object. Then find where Claude assembles write statements (the upsert pipeline; `upsertTurns` is at `:1069`, and provider events are written via `buildAgentEventStatements` - search the file for `buildAgentEventStatements(`). At that assembly site, append:

```ts
...buildCompactionStatements(extracted.compactions),
```

(Match the variable name in scope - likely `extracted` per `:1002`.)

- [ ] **Step 6: Run tests + typecheck**

Run: `bun test apps/axctl/src/ingest/transcripts.test.ts && bun run typecheck`
Expected: PASS - compaction captured, no summary leak into user turns.

- [ ] **Step 7: Commit**

```bash
git -C .claude/worktrees/compaction-signal add apps/axctl/src/ingest/transcripts.ts apps/axctl/src/ingest/transcripts.test.ts
git -C .claude/worktrees/compaction-signal commit -m "feat(ingest): capture claude compaction summary, stop mis-ingesting it as a turn"
```

---

## Task 6: Cursor parser - `summarizedComposers`

**Files:**
- Modify: `apps/axctl/src/ingest/cursor.ts`
- Test: `apps/axctl/src/ingest/cursor.test.ts`

Context: `CursorExtract` interface at `cursor.ts:70` (has `providerEvents`). The disk-KV path `extractComposerDiskKvData` is at `:661-752`; the composer record `data` is read at `:677-685` (where `fullConversationHeadersOnly`, `name`, `createdAt` are read - read `summarizedComposers` here); per-bubble loop at `:702-748`. Cursor tests use a real temporary SQLite `Database` (see existing `cursor.test.ts`).

For v1: detect a **session-level** compaction when `data.summarizedComposers` is a non-empty array. Emit one `compaction` row per composer that has it (boundary = composerId or first bubble id). This is coarse but matches the encrypted-content constraint (we can flag that compaction happened, not its content).

- [ ] **Step 1: Write the failing test**

Add to `apps/axctl/src/ingest/cursor.test.ts`, following the existing temp-SQLite setup pattern in that file (reuse its helper that seeds `cursorDiskKV` rows - read the file's existing tests for the exact seeding helper name and DB-open boilerplate). Seed a composer whose `data` has a non-empty `summarizedComposers`:

```ts
test("non-empty summarizedComposers yields a compaction row", async () => {
    // ... open temp Database + seed using the SAME helper the other cursor tests use ...
    // composerData row:
    //   key: "composerData:comp-1"
    //   value: JSON.stringify({ composerId: "comp-1", fullConversationHeadersOnly: [{ bubbleId: "b1" }], summarizedComposers: ["prev-comp"], name: "t", createdAt: 1748000000000 })
    // bubbleId:comp-1:b1 row: { type: 2, text: "hi", ... }
    const extract = await /* the same extract entrypoint the existing tests call */;
    expect(extract.compactions.length).toBe(1);
    expect(extract.compactions[0].harness).toBe("cursor");
    expect(extract.compactions[0].strategy).toBe("encrypted");
    expect(extract.compactions[0].summary).toBeNull();
});
```

(Author the seeding/DB boilerplate by copying an existing passing test in `cursor.test.ts` - do not invent a new harness.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/axctl/src/ingest/cursor.test.ts`
Expected: FAIL - `extract.compactions` undefined.

- [ ] **Step 3: Add accumulator + interface field + import**

Import:

```ts
import { buildCompactionStatements, extractCursorCompaction, type CompactionWrite } from "./compaction.ts";
```

Add `compactions: CompactionWrite[];` to `CursorExtract` (`cursor.ts:70`). Initialize it in BOTH return paths that build a `CursorExtract` (the empty/early return at `:153-159` and the main return at `:583`/`:650`) - set `compactions: []` in the empty path and `compactions` (the accumulator) in the main path. Declare the accumulator near `const providerEvents: AgentEventWrite[] = [];` (`:602`):

```ts
const compactions: CompactionWrite[] = [];
```

- [ ] **Step 4: Detect summarizedComposers in the disk-KV composer read**

In `extractComposerDiskKvData` where `data` is read (`:677-685`), after resolving `composerId` and the bubble list, add:

```ts
const summarizedComposers = Array.isArray((data as Record<string, unknown>).summarizedComposers)
    ? ((data as Record<string, unknown>).summarizedComposers as unknown[]).filter(
          (x): x is string => typeof x === "string",
      )
    : [];
if (summarizedComposers.length > 0) {
    const seq = /* next seq for this composer - reuse the loop's seq counter or bubble index */ 0;
    const firstBubbleId = /* first bubble id from fullConversationHeadersOnly, else composerId */ composerId;
    const eventKey = agentEventRecordKey({
        provider: "cursor",
        providerSessionId: composerId,
        seq,
        ts: createdIso,
        type: "compaction",
    });
    input.providerEvents.push({
        provider: "cursor",
        providerSessionId: composerId,
        seq,
        ts: createdIso,
        type: "compaction",
        role: null,
        text: null,
        metrics: { strategy: "encrypted" },
    });
    compactions.push(
        extractCursorCompaction({
            sessionId: composerId,
            providerSessionId: composerId,
            seq,
            ts: new Date(createdIso),
            agentEventKey: eventKey,
            boundaryRef: firstBubbleId,
            summarizedComposers,
        }),
    );
}
```

Notes:
- `composerId`, the `providerEvents` array reference, and the resolved composer timestamp (`createdIso` - derive from `data.createdAt`) are locals/fields already in scope - confirm exact names against `:661-700`. `agentEventRecordKey` is imported (`:20`).
- `seq`: pick a stable per-composer seq that won't collide with bubble events. Simplest: use a dedicated value like `the bubble count` or `0` prefixed into the record key via `compactionRecordKey` (which already namespaces by composer). Since `compactionRecordKey("cursor", composerId, seq)` is unique per composer, `seq = 0` is fine for one compaction row per composer in v1. Use the same `seq` for the matching `agent_event` key.

- [ ] **Step 5: Emit compaction statements**

Find where Cursor assembles statements (search `buildAgentEventStatements(` in `cursor.ts`). Append:

```ts
...buildCompactionStatements(extract.compactions),
```

- [ ] **Step 6: Run tests + typecheck**

Run: `bun test apps/axctl/src/ingest/cursor.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git -C .claude/worktrees/compaction-signal add apps/axctl/src/ingest/cursor.ts apps/axctl/src/ingest/cursor.test.ts
git -C .claude/worktrees/compaction-signal commit -m "feat(ingest): flag cursor compaction from summarizedComposers"
```

---

## Task 7: `ax sessions show` - annotate compaction boundaries

**Files:**
- Modify: `apps/axctl/src/dashboard/session-show.ts` (extend `SessionViewPayload` + query)
- Modify: `apps/axctl/src/cli/session-show-format.ts` (render)
- Test: `apps/axctl/src/cli/session-show-format.test.ts`

Context: `fetchSessionView`/`SessionViewPayload` in `session-show.ts`; pure renderer `renderSessionMarkdown` at `session-show-format.ts:116-232`; `renderTimeline` at `:86-109`. Because `renderTimeline` truncates tool_calls to 8 (`:96`), render compaction in a dedicated section, not inside the truncated timeline.

- [ ] **Step 1: Write the failing renderer test**

Add to `apps/axctl/src/cli/session-show-format.test.ts` (mirror the existing payload-construction pattern in that file):

```ts
test("renders a compaction section when compactions present", () => {
    const payload = {
        // ...spread a minimal valid SessionViewPayload as the other tests build it...
        compactions: [
            { harness: "codex", ts: "2026-05-14T15:34:42.663Z", strategy: "history_replacement", tokens_before: 120000, kept_count: 83, summary: null },
            { harness: "pi", ts: "2026-05-29T06:05:38.132Z", strategy: "summarize", tokens_before: 90000, kept_count: null, summary: "Goal: ship X" },
        ],
    } as unknown as Parameters<typeof renderSessionMarkdown>[0];
    const md = renderSessionMarkdown(payload);
    expect(md).toContain("## Compaction");
    expect(md).toContain("history_replacement");
    expect(md).toContain("83 kept");
    expect(md).toContain("Goal: ship X");
});
```

(Read `session-show-format.test.ts` first and reuse however it constructs the base payload so the non-compaction fields are valid.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/axctl/src/cli/session-show-format.test.ts`
Expected: FAIL - no `## Compaction` section.

- [ ] **Step 3: Extend the payload type + query**

In `session-show.ts`, add to `SessionViewPayload` (the interface/type returned by `fetchSessionView`):

```ts
readonly compactions: ReadonlyArray<{
    readonly harness: string;
    readonly ts: string;
    readonly strategy: string;
    readonly trigger: string | null;
    readonly tokens_before: number | null;
    readonly kept_count: number | null;
    readonly summary: string | null;
}>;
```

In the query that assembles the payload, add a SELECT against the `compaction` table for the session, ordered by `ts`:

```ts
const compactions = await db.query(
    `SELECT harness, type::string(ts) AS ts, strategy, trigger, tokens_before, kept_count, summary
     FROM compaction WHERE session = $session ORDER BY ts ASC`,
    { session: sessionRecordRef },
);
```

(Match the existing query style/`db` accessor in this file - read how `tool_calls`/`agent_delegations` are fetched and follow it exactly, including how the session record reference is passed. Include `compactions` in the returned payload object, defaulting to `[]` when none.)

- [ ] **Step 4: Render the section**

In `session-show-format.ts`, add a `renderCompaction(payload)` helper near `renderTimeline` (`:86`):

```ts
const renderCompaction = (payload: SessionViewPayload): string => {
    if (!payload.compactions || payload.compactions.length === 0) return "";
    const lines = payload.compactions.map((c) => {
        const kept = c.kept_count !== null ? ` · ${c.kept_count} kept` : "";
        const toks = c.tokens_before !== null ? ` · ${c.tokens_before} tok before` : "";
        const sum = c.summary ? ` - ${c.summary.split("\n")[0].slice(0, 80)}` : "";
        return `- ${c.ts} · ${c.harness} · ${c.strategy}${toks}${kept}${sum}`;
    });
    return `\n## Compaction (${payload.compactions.length})\n\n${lines.join("\n")}\n`;
};
```

Then call it inside `renderSessionMarkdown` (`:116-232`), appending its output near the Timeline section (`:185-191`):

```ts
out += renderCompaction(payload);
```

(Use the actual string-accumulation idiom in `renderSessionMarkdown` - read `:116-232`; it may push to an array rather than `+=`. Match it.)

- [ ] **Step 5: Run tests + typecheck**

Run: `bun test apps/axctl/src/cli/session-show-format.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git -C .claude/worktrees/compaction-signal add apps/axctl/src/dashboard/session-show.ts apps/axctl/src/cli/session-show-format.ts apps/axctl/src/cli/session-show-format.test.ts
git -C .claude/worktrees/compaction-signal commit -m "feat(cli): show compaction boundaries in ax sessions show"
```

---

## Task 8: Full-suite verification + integration check

**Files:** none (verification only)

- [ ] **Step 1: Run the full ingest test suite**

Run: `bun test apps/axctl/src/ingest`
Expected: PASS (all parser tests including the 4 new compaction tests).

- [ ] **Step 2: Repo-wide test + typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Real-data smoke test (manual, optional but recommended)**

Run a scoped ingest over real Codex sessions known to contain compaction, then query:

```bash
.claude/worktrees/compaction-signal/apps/axctl/bin/axctl ingest --since=30 --stages=codex
# then in the DB:
#   SELECT harness, count() FROM compaction GROUP BY harness;
# Expect codex rows > 0 (55 sessions / 351 events exist in ~/.codex/sessions).
```

Expected: non-zero `compaction` rows for codex; spot-check `kept_count` is populated and `strategy = "history_replacement"`.

- [ ] **Step 4: Push branch + open PR**

```bash
git -C .claude/worktrees/compaction-signal push -u origin feat/compaction-signal
gh pr create --repo Necmttn/ax --base main --head feat/compaction-signal \
  --title "feat: first-class compaction signal across harnesses" \
  --body "Implements docs/superpowers/specs/2026-06-04-compaction-signal-design.md - see plan docs/superpowers/plans/2026-06-04-compaction-signal.md"
```

---

## Notes for the implementer

- **Read before editing each parser.** Every parser task gives exact line numbers from analysis, but the load-bearing locals (`seq`, `ts`/`iso`, `text`, `session.id`, the `*Extract` variable name at the statement-assembly site) must be confirmed by reading the surrounding 30–40 lines first. The plan flags every such spot.
- **The `agent_event` key must match the emitted event.** Always derive `agentEventKey` with the SAME `agentEventRecordKey({provider, providerSessionId, seq, ts, type})` args used by the corresponding `pushProviderEvent`/`providerEvents.push`, or the `compaction.agent_event` link will dangle.
- **Pi is the one harness that must NOT push a second provider event** (its universal push at `pi.ts:517` already emits the `type:"compaction"` event). Codex, Claude, and Cursor DO push (Codex/Cursor because the entry is otherwise unhandled; Claude because it replaces the user-turn push it's suppressing).
- **OpenCode is intentionally untouched** - it has no explicit marker; deriving boundaries from `step-finish.tokens` saturation is a separate follow-up with `source_confidence: "derived"`.
- **Worktree-write hook:** all edits happen inside `.claude/worktrees/compaction-signal`, so the enforce-worktree-on-main hook stays satisfied. Run `bun` commands from the repo root but `git` via `git -C .claude/worktrees/compaction-signal`.
