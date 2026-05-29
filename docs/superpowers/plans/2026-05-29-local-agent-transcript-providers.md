# Local Agent Transcript Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local provider event graph for Claude, Codex, Pi, OpenCode, and Cursor, while preserving existing AX projections into `session`, `turn`, `tool_call`, plans, token usage, and current dashboard/query surfaces.

**Architecture:** Add a provider-native event substrate (`agent_provider`, `agent_session`, `agent_event`, `agent_event_child`) beneath the current AX projection tables. Each provider adapter discovers local artifacts, writes lossless provider events, then projects compatible records through shared helpers into existing tables. Claude and Codex dual-write first, then Pi/OpenCode/Cursor adapters can land in parallel against the same contract.

**Tech Stack:** Bun test runner, TypeScript strict mode, Effect stage registry, SurrealDB schema and statement writers, SQLite read-only extraction for OpenCode/Cursor, JSONL streaming for Claude/Codex/Pi.

---

## File Structure

- Create `src/ingest/provider-events.ts`: provider event types, record keys, statement builders, and adapter contract.
- Create `src/ingest/provider-events.test.ts`: unit tests for keys and event graph statements.
- Modify `schema/schema.surql`: add provider event graph tables and optional projection links.
- Modify `src/lib/config.ts` and `src/lib/config.test.ts`: add Pi/OpenCode/Cursor paths.
- Modify `src/ingest/stage/tags.ts`: add provider-stage tag if the current union needs it.
- Modify `src/ingest/stage/registry.ts` and `src/ingest/stage/registry.test.ts`: register `pi`, `opencode`, and `cursor`.
- Modify `src/cli/index.ts` and CLI tests: stage progress, removed-flag replacement, ingest description.
- Modify `src/ingest/transcripts.ts` and `src/ingest/transcripts.test.ts`: Claude dual-write provider events.
- Modify `src/ingest/codex.ts` and `src/ingest/codex.test.ts`: Codex dual-write provider events.
- Create `src/ingest/pi.ts` and `src/ingest/pi.test.ts`: Pi JSONL tree adapter.
- Create `src/ingest/opencode.ts` and `src/ingest/opencode.test.ts`: OpenCode SQLite/files adapter.
- Create `src/ingest/cursor.ts` and `src/ingest/cursor.test.ts`: Cursor SQLite adapter with key allowlist.
- Modify query/dashboard source filters:
  - `src/dashboard/web/src/routes/sessions.tsx`
  - `src/dashboard/sessions-list.ts`
  - `src/queries/insights.ts`
  - any tests that hard-code `claude | codex`.

---

### Task 1: Provider Event Schema And Writers

**Files:**
- Modify: `schema/schema.surql`
- Create: `src/ingest/provider-events.ts`
- Create: `src/ingest/provider-events.test.ts`

- [ ] **Step 1: Write failing provider event writer tests**

Create `src/ingest/provider-events.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
    agentEventRecordKey,
    agentProviderRecordKey,
    agentSessionRecordKey,
    buildAgentEventStatements,
    buildAgentProviderStatements,
} from "./provider-events.ts";

describe("provider event graph writers", () => {
    test("builds stable provider/session/event keys", () => {
        expect(agentProviderRecordKey("pi")).toBe("pi");
        expect(agentSessionRecordKey("pi", "019ddc60-e3cb")).toBe("pi__019ddc60_e3cb");
        expect(agentEventRecordKey({
            provider: "pi",
            providerSessionId: "019ddc60-e3cb",
            providerEventId: "f3609756",
            seq: 6,
        })).toBe("pi__019ddc60_e3cb__f3609756");
        expect(agentEventRecordKey({
            provider: "cursor",
            providerSessionId: "workspace/chat",
            providerEventId: null,
            seq: 2,
        })).toContain("cursor__workspace_chat__seq_000002");
    });

    test("writes provider, session, events, and parent edges", () => {
        const providerStatements = buildAgentProviderStatements([{
            name: "pi",
            displayName: "Pi",
            capabilities: { tree: true, toolCalls: true },
        }]);
        expect(providerStatements.join("\n")).toContain("UPSERT agent_provider:`pi`");

        const statements = buildAgentEventStatements({
            provider: "pi",
            providerSessionId: "session-1",
            axSessionId: "session-1",
            session: {
                cwd: "/tmp/project",
                project: "project",
                title: null,
                model: "gpt-5.5",
                sourcePath: "/tmp/pi/session.jsonl",
                startedAt: "2026-04-30T03:13:50.539Z",
                endedAt: "2026-04-30T03:14:59.855Z",
                rawJson: { type: "session", id: "session-1" },
                labels: { imported: true },
                metrics: { lines: 2 },
            },
            events: [
                {
                    providerEventId: "root",
                    parentProviderEventId: null,
                    seq: 1,
                    ts: "2026-04-30T03:13:51.000Z",
                    type: "model_change",
                    role: null,
                    text: null,
                    textExcerpt: null,
                    rawJson: { type: "model_change" },
                    labels: {},
                    metrics: {},
                },
                {
                    providerEventId: "child",
                    parentProviderEventId: "root",
                    seq: 2,
                    ts: "2026-04-30T03:14:00.000Z",
                    type: "message",
                    role: "user",
                    text: "hello",
                    textExcerpt: "hello",
                    rawJson: { type: "message" },
                    labels: {},
                    metrics: {},
                },
            ],
        });

        expect(statements.join("\n")).toContain("UPSERT agent_session:`pi__session_1`");
        expect(statements.join("\n")).toContain("UPSERT agent_event:`pi__session_1__root`");
        expect(statements.join("\n")).toContain("RELATE agent_event:`pi__session_1__root`->agent_event_child");
    });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
bun test src/ingest/provider-events.test.ts
```

Expected: fail because `src/ingest/provider-events.ts` does not exist.

- [ ] **Step 3: Add schema tables and projection links**

Patch `schema/schema.surql` after the `session` table and before `turn`:

```surql
DEFINE TABLE agent_provider SCHEMAFULL;
DEFINE FIELD name           ON agent_provider TYPE string;
DEFINE FIELD display_name   ON agent_provider TYPE string;
DEFINE FIELD version        ON agent_provider TYPE option<string>;
DEFINE FIELD capabilities   ON agent_provider TYPE option<string>;
DEFINE FIELD created_at     ON agent_provider TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at     ON agent_provider TYPE option<datetime>;
DEFINE INDEX agent_provider_name_uq ON agent_provider FIELDS name UNIQUE;

DEFINE TABLE agent_session SCHEMAFULL;
DEFINE FIELD provider       ON agent_session TYPE record<agent_provider>;
DEFINE FIELD provider_session_id ON agent_session TYPE string;
DEFINE FIELD ax_session     ON agent_session TYPE option<record<session>>;
DEFINE FIELD cwd            ON agent_session TYPE option<string>;
DEFINE FIELD project        ON agent_session TYPE option<string>;
DEFINE FIELD title          ON agent_session TYPE option<string>;
DEFINE FIELD model          ON agent_session TYPE option<string>;
DEFINE FIELD source_path    ON agent_session TYPE option<string>;
DEFINE FIELD raw            ON agent_session TYPE option<string>;
DEFINE FIELD labels         ON agent_session TYPE option<string>;
DEFINE FIELD metrics        ON agent_session TYPE option<string>;
DEFINE FIELD started_at     ON agent_session TYPE option<datetime>;
DEFINE FIELD ended_at       ON agent_session TYPE option<datetime>;
DEFINE FIELD created_at     ON agent_session TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at     ON agent_session TYPE option<datetime>;
DEFINE INDEX agent_session_provider_id ON agent_session FIELDS provider, provider_session_id UNIQUE;
DEFINE INDEX agent_session_ax_session ON agent_session FIELDS ax_session;

DEFINE TABLE agent_event SCHEMAFULL;
DEFINE FIELD agent_session  ON agent_event TYPE record<agent_session>;
DEFINE FIELD ax_session     ON agent_event TYPE option<record<session>>;
DEFINE FIELD provider       ON agent_event TYPE record<agent_provider>;
DEFINE FIELD provider_event_id ON agent_event TYPE option<string>;
DEFINE FIELD parent_provider_event_id ON agent_event TYPE option<string>;
DEFINE FIELD seq            ON agent_event TYPE int;
DEFINE FIELD ts             ON agent_event TYPE datetime;
DEFINE FIELD type           ON agent_event TYPE string;
DEFINE FIELD role           ON agent_event TYPE option<string>;
DEFINE FIELD text           ON agent_event TYPE option<string>;
DEFINE FIELD text_excerpt   ON agent_event TYPE option<string>;
DEFINE FIELD raw            ON agent_event TYPE option<string>;
DEFINE FIELD labels         ON agent_event TYPE option<string>;
DEFINE FIELD metrics        ON agent_event TYPE option<string>;
DEFINE INDEX agent_event_session_seq ON agent_event FIELDS agent_session, seq UNIQUE;
DEFINE INDEX agent_event_provider_id ON agent_event FIELDS provider, provider_event_id;
DEFINE INDEX agent_event_session_ts ON agent_event FIELDS agent_session, ts;
```

Patch existing tables:

```surql
DEFINE FIELD agent_event    ON turn TYPE option<record<agent_event>>;
DEFINE INDEX turn_agent_event ON turn FIELDS agent_event;

DEFINE FIELD agent_event    ON tool_call TYPE option<record<agent_event>>;
DEFINE INDEX tool_call_agent_event ON tool_call FIELDS agent_event;

DEFINE FIELD agent_event    ON plan_snapshot TYPE option<record<agent_event>>;
DEFINE INDEX plan_snapshot_agent_event ON plan_snapshot FIELDS agent_event;

DEFINE TABLE agent_event_child TYPE RELATION FROM agent_event TO agent_event;
DEFINE FIELD agent_session ON agent_event_child TYPE record<agent_session>;
DEFINE FIELD provider      ON agent_event_child TYPE record<agent_provider>;
DEFINE FIELD kind          ON agent_event_child TYPE string DEFAULT "parent";
DEFINE FIELD ts            ON agent_event_child TYPE datetime DEFAULT time::now();
DEFINE INDEX agent_event_child_in ON agent_event_child FIELDS in;
DEFINE INDEX agent_event_child_out ON agent_event_child FIELDS out;
```

- [ ] **Step 4: Implement provider event writers**

Create `src/ingest/provider-events.ts`:

```ts
import {
    recordRef,
    surrealDate,
    surrealJsonTextOption,
    surrealObject,
    surrealOptionDate,
    surrealOptionRecord,
    surrealOptionString,
    surrealString,
} from "../lib/shared/surql.ts";

export type AgentProviderName = "claude" | "codex" | "pi" | "opencode" | "cursor";

export interface AgentProviderWrite {
    readonly name: AgentProviderName;
    readonly displayName: string;
    readonly version?: string | null;
    readonly capabilities?: unknown;
}

export interface AgentSessionWrite {
    readonly cwd?: string | null;
    readonly project?: string | null;
    readonly title?: string | null;
    readonly model?: string | null;
    readonly sourcePath?: string | null;
    readonly startedAt?: string | Date | null;
    readonly endedAt?: string | Date | null;
    readonly rawJson?: unknown;
    readonly labels?: unknown;
    readonly metrics?: unknown;
}

export interface AgentEventWrite {
    readonly providerEventId?: string | null;
    readonly parentProviderEventId?: string | null;
    readonly seq: number;
    readonly ts: string | Date;
    readonly type: string;
    readonly role?: string | null;
    readonly text?: string | null;
    readonly textExcerpt?: string | null;
    readonly rawJson?: unknown;
    readonly labels?: unknown;
    readonly metrics?: unknown;
}

export interface AgentEventBatchWrite {
    readonly provider: AgentProviderName;
    readonly providerSessionId: string;
    readonly axSessionId?: string | null;
    readonly session: AgentSessionWrite;
    readonly events: readonly AgentEventWrite[];
}

function keyPart(input: string, fallback = "_"): string {
    const value = input.replace(/[^a-zA-Z0-9]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
    return value.length > 0 ? value : fallback;
}

export function agentProviderRecordKey(provider: AgentProviderName): string {
    return keyPart(provider, "provider");
}

export function agentSessionRecordKey(provider: AgentProviderName, providerSessionId: string): string {
    return `${agentProviderRecordKey(provider)}__${keyPart(providerSessionId, "session").slice(0, 120)}`;
}

export function agentEventRecordKey(input: {
    readonly provider: AgentProviderName;
    readonly providerSessionId: string;
    readonly providerEventId?: string | null;
    readonly seq: number;
}): string {
    const eventPart = input.providerEventId
        ? keyPart(input.providerEventId, "event")
        : `seq_${input.seq.toString(10).padStart(6, "0")}`;
    return `${agentSessionRecordKey(input.provider, input.providerSessionId)}__${eventPart.slice(0, 120)}`;
}

export function buildAgentProviderStatements(providers: readonly AgentProviderWrite[]): string[] {
    return providers.map((provider) =>
        `UPSERT ${recordRef("agent_provider", agentProviderRecordKey(provider.name))} MERGE ${surrealObject([
            ["name", surrealString(provider.name)],
            ["display_name", surrealString(provider.displayName)],
            ["version", surrealOptionString(provider.version)],
            ["capabilities", surrealJsonTextOption(provider.capabilities)],
            ["updated_at", "time::now()"],
        ])};`
    );
}

export function buildAgentEventStatements(batch: AgentEventBatchWrite): string[] {
    const providerKey = agentProviderRecordKey(batch.provider);
    const agentSessionKey = agentSessionRecordKey(batch.provider, batch.providerSessionId);
    const sessionRef = recordRef("agent_session", agentSessionKey);
    const providerRef = recordRef("agent_provider", providerKey);
    const axSessionRef = batch.axSessionId ? recordRef("session", batch.axSessionId) : "NONE";
    const statements: string[] = [
        `UPSERT ${sessionRef} MERGE ${surrealObject([
            ["provider", providerRef],
            ["provider_session_id", surrealString(batch.providerSessionId)],
            ["ax_session", axSessionRef],
            ["cwd", surrealOptionString(batch.session.cwd)],
            ["project", surrealOptionString(batch.session.project)],
            ["title", surrealOptionString(batch.session.title)],
            ["model", surrealOptionString(batch.session.model)],
            ["source_path", surrealOptionString(batch.session.sourcePath)],
            ["started_at", surrealOptionDate(batch.session.startedAt)],
            ["ended_at", surrealOptionDate(batch.session.endedAt)],
            ["raw", surrealJsonTextOption(batch.session.rawJson)],
            ["labels", surrealJsonTextOption(batch.session.labels)],
            ["metrics", surrealJsonTextOption(batch.session.metrics)],
            ["updated_at", "time::now()"],
        ])};`,
    ];

    const keyByProviderEventId = new Map<string, string>();
    for (const event of batch.events) {
        if (event.providerEventId) {
            keyByProviderEventId.set(event.providerEventId, agentEventRecordKey({
                provider: batch.provider,
                providerSessionId: batch.providerSessionId,
                providerEventId: event.providerEventId,
                seq: event.seq,
            }));
        }
    }

    for (const event of batch.events) {
        const eventKey = agentEventRecordKey({
            provider: batch.provider,
            providerSessionId: batch.providerSessionId,
            providerEventId: event.providerEventId,
            seq: event.seq,
        });
        statements.push(`UPSERT ${recordRef("agent_event", eventKey)} CONTENT ${surrealObject([
            ["agent_session", sessionRef],
            ["ax_session", axSessionRef],
            ["provider", providerRef],
            ["provider_event_id", surrealOptionString(event.providerEventId)],
            ["parent_provider_event_id", surrealOptionString(event.parentProviderEventId)],
            ["seq", String(event.seq)],
            ["ts", surrealDate(event.ts)],
            ["type", surrealString(event.type)],
            ["role", surrealOptionString(event.role)],
            ["text", surrealOptionString(event.text)],
            ["text_excerpt", surrealOptionString(event.textExcerpt)],
            ["raw", surrealJsonTextOption(event.rawJson)],
            ["labels", surrealJsonTextOption(event.labels)],
            ["metrics", surrealJsonTextOption(event.metrics)],
        ])};`);
    }

    for (const event of batch.events) {
        if (!event.parentProviderEventId) continue;
        const parentKey = keyByProviderEventId.get(event.parentProviderEventId);
        if (!parentKey) continue;
        const childKey = agentEventRecordKey({
            provider: batch.provider,
            providerSessionId: batch.providerSessionId,
            providerEventId: event.providerEventId,
            seq: event.seq,
        });
        const edgeKey = Bun.hash(`${parentKey}|${childKey}|agent_event_child`).toString(16).padStart(16, "0");
        statements.push(`RELATE ${recordRef("agent_event", parentKey)}->agent_event_child:\`${edgeKey}\`->${recordRef("agent_event", childKey)} SET agent_session = ${sessionRef}, provider = ${providerRef}, kind = "parent", ts = ${surrealDate(event.ts)};`);
    }

    return statements;
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
bun test src/ingest/provider-events.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add schema/schema.surql src/ingest/provider-events.ts src/ingest/provider-events.test.ts
git commit -m "feat: add provider event graph writers"
```

---

### Task 2: Config, Stage Registry, And CLI Surface

**Files:**
- Modify: `src/lib/config.ts`
- Modify: `src/lib/config.test.ts`
- Create: `src/ingest/pi.ts`
- Create: `src/ingest/opencode.ts`
- Create: `src/ingest/cursor.ts`
- Modify: `src/ingest/stage/registry.ts`
- Modify: `src/ingest/stage/registry.test.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Write failing config tests**

Append to `src/lib/config.test.ts`:

```ts
test("envSnapshot exposes local provider directories", () => {
    const snap = envSnapshot({
        HOME: "/tmp/home",
        AX_PI_DIR: "/tmp/pi-sessions",
        AX_OPENCODE_DIR: "/tmp/opencode",
        AX_CURSOR_USER_DIR: "/tmp/cursor-user",
    });
    expect(snap.paths.piDir).toBe("/tmp/pi-sessions");
    expect(snap.paths.opencodeDir).toBe("/tmp/opencode");
    expect(snap.paths.cursorUserDir).toBe("/tmp/cursor-user");
});

test("envSnapshot defaults local provider directories", () => {
    const snap = envSnapshot({ HOME: "/tmp/home" });
    expect(snap.paths.piDir).toBe("/tmp/home/.pi/agent/sessions");
    expect(snap.paths.opencodeDir).toBe("/tmp/home/.local/share/opencode");
    expect(snap.paths.cursorUserDir).toBe("/tmp/home/Library/Application Support/Cursor/User");
});
```

- [ ] **Step 2: Run the failing config tests**

```bash
bun test src/lib/config.test.ts
```

Expected: fail because `piDir`, `opencodeDir`, and `cursorUserDir` do not exist.

- [ ] **Step 3: Add config paths**

Modify `AxConfigShape.paths` in `src/lib/config.ts`:

```ts
readonly piDir: string;
readonly opencodeDir: string;
readonly cursorUserDir: string;
```

Add to `envSnapshot().paths`:

```ts
piDir: env.AX_PI_DIR ?? join(home, ".pi", "agent", "sessions"),
opencodeDir: env.AX_OPENCODE_DIR ?? join(home, ".local", "share", "opencode"),
cursorUserDir:
    env.AX_CURSOR_USER_DIR ?? join(home, "Library", "Application Support", "Cursor", "User"),
```

- [ ] **Step 4: Add provider stage shells**

Create `src/ingest/pi.ts`:

```ts
import { Effect, Schema } from "effect";
import { AxConfig } from "../lib/config.ts";
import type { DbError } from "../lib/errors.ts";
import { BaseStageStats, IngestContext, sinceDaysFromCtx, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

export const PiKey = Schema.Literal("pi");

export interface PiStats {
    files: number;
    sessions: number;
    events: number;
    turns: number;
    toolCalls: number;
    skipped: number;
    warnings: number;
}

export const ingestPi = (): Effect.Effect<PiStats, DbError, AxConfig> =>
    Effect.gen(function* () {
        yield* AxConfig;
        return { files: 0, sessions: 0, events: 0, turns: 0, toolCalls: 0, skipped: 0, warnings: 0 };
    });

export class PiStageStats extends BaseStageStats.extend<PiStageStats>("PiStageStats")({
    files: Schema.Number,
    sessions: Schema.Number,
    events: Schema.Number,
    turns: Schema.Number,
    toolCalls: Schema.Number,
    skipped: Schema.Number,
    warnings: Schema.Number,
}) {}

export const piStage: StageDef<PiStageStats, AxConfig> = {
    meta: StageMeta.make({ key: "pi", deps: [], tags: ["ingest"] }),
    run: (ctx: IngestContext) =>
        ingestPi().pipe(
            Effect.map((stats) =>
                PiStageStats.make({
                    durationMs: 0,
                    summary: `pi: ${stats.sessions} sessions, ${stats.events} events`,
                    ...stats,
                }),
            ),
        ),
};
```

Create `src/ingest/opencode.ts` and `src/ingest/cursor.ts` with the same shell, replacing names and summaries with `OpenCode` / `Cursor` and stage keys `opencode` / `cursor`.

- [ ] **Step 5: Register new stages**

Modify `src/ingest/stage/registry.ts`:

```ts
import { PiKey, piStage } from "../pi.ts";
import { OpenCodeKey, opencodeStage } from "../opencode.ts";
import { CursorKey, cursorStage } from "../cursor.ts";
```

Add the keys to `IngestStageKey`:

```ts
export const IngestStageKey = Schema.Union([SkillsKey, CommandsKey, ClaudeKey, CodexKey, PiKey, OpenCodeKey, CursorKey, SubagentsKey, SpawnedKey, GitKey, SignalsKey, OutcomesKey, SessionHealthKey, ClosureKey, ProposalsKey, OpportunitiesKey, RetroProposalsKey, HarnessKey]);
```

Add stages after `codexStage`:

```ts
export const ALL_STAGES = [skillsStage, commandsStage, claudeStage, codexStage, piStage, opencodeStage, cursorStage, subagentsStage, spawnedStage, gitStage, signalsStage, outcomesStage, sessionHealthStage, closureStage, proposalsStage, opportunitiesStage, retroProposalsStage, harnessStage] as const;
```

- [ ] **Step 6: Update CLI stage progress and removed flag replacement**

Modify `IngestStageKeyLegacy` in `src/cli/index.ts` to include:

```ts
| "pi" | "opencode" | "cursor"
```

Add to `STAGE_PROGRESS`:

```ts
pi: { source: "pi", stage: "sessions" },
opencode: { source: "opencode", stage: "sessions" },
cursor: { source: "cursor", stage: "sessions" },
```

Change removed flag replacements:

```ts
["--transcripts-only", "--stages=claude,codex,pi,opencode,cursor"],
```

Update ingest command description to say:

```ts
"Ingest skills, local agent transcripts, git history, and insight artifacts. "
```

- [ ] **Step 7: Run focused tests**

```bash
bun test src/lib/config.test.ts src/ingest/stage/registry.test.ts src/cli/effect-cli.test.ts
```

Expected: pass or reveal one CLI snapshot that needs string adjustment only.

- [ ] **Step 8: Commit**

```bash
git add src/lib/config.ts src/lib/config.test.ts src/ingest/pi.ts src/ingest/opencode.ts src/ingest/cursor.ts src/ingest/stage/registry.ts src/ingest/stage/registry.test.ts src/cli/index.ts src/cli/effect-cli.test.ts
git commit -m "feat: register local agent provider stages"
```

---

### Task 3: Claude And Codex Dual-Write Provider Events

**Files:**
- Modify: `src/ingest/transcripts.ts`
- Modify: `src/ingest/transcripts.test.ts`
- Modify: `src/ingest/codex.ts`
- Modify: `src/ingest/codex.test.ts`
- Modify: `src/ingest/evidence-writers.ts`

- [ ] **Step 1: Extend writer types with optional event links**

In `src/ingest/evidence-writers.ts`, add optional `agentEventKey`:

```ts
export interface ToolCallWrite {
    readonly agentEventKey?: string | null;
    ...
}
```

In `buildToolCallStatements`, add field:

```ts
["agent_event", surrealOptionRecord("agent_event", call.agentEventKey)],
```

- [ ] **Step 2: Add extractor tests for provider events**

In `src/ingest/codex.test.ts`, extend the existing extraction expectations with:

```ts
expect(extracted.providerEvents.map((event) => ({
    providerEventId: event.providerEventId,
    parentProviderEventId: event.parentProviderEventId,
    type: event.type,
    role: event.role,
}))).toContainEqual({
    providerEventId: "call_exec",
    parentProviderEventId: null,
    type: "function_call",
    role: "tool_call",
});
```

In `src/ingest/transcripts.test.ts`, add:

```ts
expect(extracted.providerEvents[0]).toMatchObject({
    type: "user",
    role: "user",
    seq: 1,
});
```

- [ ] **Step 3: Run failing tests**

```bash
bun test src/ingest/codex.test.ts src/ingest/transcripts.test.ts
```

Expected: fail because `providerEvents` is not on the extract types.

- [ ] **Step 4: Add provider events to extract types**

In both `src/ingest/codex.ts` and `src/ingest/transcripts.ts`, import:

```ts
import {
    agentEventRecordKey,
    buildAgentEventStatements,
    buildAgentProviderStatements,
    type AgentEventWrite,
} from "./provider-events.ts";
```

Add `providerEvents: AgentEventWrite[]` to each extract interface and mutable extract shape.

When processing each source line/item, push an event:

```ts
providerEvents.push({
    providerEventId: nativeIdOrCallId,
    parentProviderEventId: null,
    seq,
    ts,
    type: type ?? itemType ?? role,
    role,
    text,
    textExcerpt,
    rawJson: entry,
    labels: { source: "transcript" },
    metrics: { seq },
});
```

For Claude, use the transcript line `uuid`, `requestId`, or `tool_use_id` if present; otherwise use `null` and rely on sequence keys.

- [ ] **Step 5: Write provider graph statements during ingest**

In each batch statement builder, prepend provider statements and event graph statements:

```ts
...buildAgentProviderStatements([{ name: "codex", displayName: "Codex", capabilities: { jsonl: true, toolCalls: true } }]),
...buildAgentEventStatements({
    provider: "codex",
    providerSessionId: batch.session.id,
    axSessionId: batch.session.id,
    session: {
        cwd: batch.session.cwd,
        project: batch.session.cwd,
        title: null,
        model: batch.session.model_provider,
        sourcePath: filePath,
        startedAt: batch.session.started_at,
        endedAt: batch.session.ended_at,
        rawJson: batch.session,
        labels: { dualWrite: true },
        metrics: { turns: batch.turns.length },
    },
    events: batch.providerEvents,
}),
```

Use `claude` / `Claude Code` in `transcripts.ts`.

- [ ] **Step 6: Link tool calls to agent events**

When creating a tool call, compute:

```ts
agentEventKey: agentEventRecordKey({
    provider: "codex",
    providerSessionId: currentSession.id,
    providerEventId: callId,
    seq,
}),
```

Use provider `"claude"` in Claude tool call creation.

- [ ] **Step 7: Run focused tests**

```bash
bun test src/ingest/codex.test.ts src/ingest/transcripts.test.ts src/ingest/provider-events.test.ts
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add src/ingest/transcripts.ts src/ingest/transcripts.test.ts src/ingest/codex.ts src/ingest/codex.test.ts src/ingest/evidence-writers.ts
git commit -m "feat: dual-write claude and codex provider events"
```

---

### Task 4: Pi JSONL Tree Adapter

**Files:**
- Modify: `src/ingest/pi.ts`
- Create/modify: `src/ingest/pi.test.ts`

- [ ] **Step 1: Write Pi extraction fixture tests**

Create `src/ingest/pi.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { __testExtractPiJsonlLines, textFromPiContent } from "./pi.ts";

describe("Pi transcript extraction", () => {
    test("extracts session header, tree events, turns, and token usage", () => {
        const extracted = __testExtractPiJsonlLines([
            JSON.stringify({ type: "session", version: 3, id: "pi-session", timestamp: "2026-04-30T03:13:50.539Z", cwd: "/tmp/project" }),
            JSON.stringify({ type: "model_change", id: "m1", parentId: null, timestamp: "2026-04-30T03:13:51.000Z", provider: "openai-codex", modelId: "gpt-5.5" }),
            JSON.stringify({ type: "message", id: "u1", parentId: "m1", timestamp: "2026-04-30T03:14:00.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
            JSON.stringify({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-04-30T03:14:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "Hello." }], model: "gpt-5.5", usage: { input: 10, output: 2, totalTokens: 12 } } }),
        ]);
        expect(extracted?.session.id).toBe("pi-session");
        expect(extracted?.providerEvents.map((event) => event.providerEventId)).toEqual(["m1", "u1", "a1"]);
        expect(extracted?.providerEvents[1]?.parentProviderEventId).toBe("m1");
        expect(extracted?.turns.map((turn) => [turn.role, turn.text])).toEqual([
            ["user", "hello"],
            ["assistant", "Hello."],
        ]);
        expect(extracted?.tokenUsage?.estimatedTokens).toBe(12);
    });

    test("joins text content blocks and ignores unknown blocks", () => {
        expect(textFromPiContent([{ type: "text", text: "a" }, { type: "image", url: "x" }, { type: "text", text: "b" }])).toBe("a\nb");
    });
});
```

- [ ] **Step 2: Run failing Pi tests**

```bash
bun test src/ingest/pi.test.ts
```

Expected: fail because parser helpers do not exist.

- [ ] **Step 3: Implement Pi parser helpers**

In `src/ingest/pi.ts`, add:

```ts
export interface PiSession {
    id: string;
    cwd: string | null;
    model: string | null;
    started_at: string;
    ended_at: string;
}

export interface PiTurn {
    session: string;
    seq: number;
    ts: string;
    role: string;
    message_kind: string;
    intent_kind: string;
    text: string | null;
    text_excerpt: string | null;
    has_tool_use: boolean;
}

export interface PiExtract {
    session: PiSession;
    providerEvents: AgentEventWrite[];
    turns: PiTurn[];
    toolCalls: ToolCallWrite[];
    skillRelations: ToolCallSkillRelationWrite[];
    tokenUsage: { estimatedTokens: number; inputTokens: number | null; outputTokens: number | null } | null;
}
```

Add `textFromPiContent`:

```ts
export function textFromPiContent(content: unknown): string | null {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return null;
    const text = content
        .filter((block): block is Record<string, unknown> => typeof block === "object" && block !== null && !Array.isArray(block))
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => String(block.text))
        .join("\n");
    return text.length > 0 ? text : null;
}
```

Implement `__testExtractPiJsonlLines(lines)` by mirroring the Codex extractor style:

- Parse each JSONL line.
- First `type === "session"` creates `PiSession`.
- Non-session entries push `AgentEventWrite`.
- `type === "message"` with `message.role` creates `PiTurn`.
- Assistant `message.usage.totalTokens` contributes token usage.

- [ ] **Step 4: Implement Pi ingest stage**

In `ingestPi`, walk `cfg.paths.piDir` recursively for `.jsonl`, filter by `sinceDaysFromCtx` through the stage `ctx`, parse each file, upsert session, write provider graph statements, turn statements, tool call statements, and skill relation statements.

Use these defaults:

```ts
source: "pi"
skill scope: "pi-tool"
raw snapshot: source path only for v0; provider events preserve raw JSON per line
```

- [ ] **Step 5: Run Pi tests**

```bash
bun test src/ingest/pi.test.ts src/ingest/provider-events.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/ingest/pi.ts src/ingest/pi.test.ts
git commit -m "feat: ingest local pi sessions"
```

---

### Task 5: OpenCode Local Adapter

**Files:**
- Modify: `src/ingest/opencode.ts`
- Create/modify: `src/ingest/opencode.test.ts`
- Modify: `package.json` only if a SQLite dependency is needed; prefer `bun:sqlite`.

- [ ] **Step 1: Write OpenCode DB fixture test**

Create `src/ingest/opencode.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { extractOpenCodeDatabase } from "./opencode.ts";

describe("OpenCode extraction", () => {
    test("extracts sessions and messages from recognized SQLite tables", () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-opencode-"));
        const dbPath = join(dir, "opencode.db");
        const db = new Database(dbPath);
        db.run("create table session (id text primary key, cwd text, title text, created_at text, updated_at text)");
        db.run("create table message (id text primary key, session_id text, role text, content text, created_at text)");
        db.run("insert into session values (?, ?, ?, ?, ?)", ["ses_1", "/tmp/project", "Fix auth", "2026-05-01T00:00:00.000Z", "2026-05-01T00:01:00.000Z"]);
        db.run("insert into message values (?, ?, ?, ?, ?)", ["msg_1", "ses_1", "user", "hello opencode", "2026-05-01T00:00:01.000Z"]);
        db.close();

        const extracted = extractOpenCodeDatabase(dbPath);
        expect(extracted.sessions).toHaveLength(1);
        expect(extracted.sessions[0]?.providerSessionId).toBe("ses_1");
        expect(extracted.events[0]?.text).toBe("hello opencode");
    });
});
```

- [ ] **Step 2: Run failing OpenCode test**

```bash
bun test src/ingest/opencode.test.ts
```

Expected: fail because `extractOpenCodeDatabase` does not exist.

- [ ] **Step 3: Implement OpenCode extraction**

In `src/ingest/opencode.ts`, use `bun:sqlite` read-only mode:

```ts
import { Database } from "bun:sqlite";

export interface OpenCodeExtractedSession {
    readonly providerSessionId: string;
    readonly cwd: string | null;
    readonly title: string | null;
    readonly startedAt: string | null;
    readonly endedAt: string | null;
}

export interface OpenCodeExtractResult {
    readonly sessions: OpenCodeExtractedSession[];
    readonly events: AgentEventWrite[];
}

export function extractOpenCodeDatabase(dbPath: string): OpenCodeExtractResult {
    const db = new Database(dbPath, { readonly: true });
    try {
        const tables = new Set(db.query<{ name: string }, []>("select name from sqlite_master where type = 'table'").all().map((row) => row.name));
        if (!tables.has("session") || !tables.has("message")) return { sessions: [], events: [] };
        const sessions = db.query<OpenCodeExtractedSession, []>(`
            select id as providerSessionId, cwd as cwd, title as title, created_at as startedAt, updated_at as endedAt
            from session
        `).all();
        const messages = db.query<{ id: string; session_id: string; role: string; content: string; created_at: string }, []>(`
            select id, session_id, role, content, created_at
            from message
            order by created_at asc
        `).all();
        const events = messages.map((message, index): AgentEventWrite => ({
            providerEventId: message.id,
            parentProviderEventId: null,
            seq: index + 1,
            ts: message.created_at,
            type: "message",
            role: message.role,
            text: message.content,
            textExcerpt: message.content.slice(0, 500),
            rawJson: message,
            labels: { session_id: message.session_id },
            metrics: {},
        }));
        return { sessions, events };
    } finally {
        db.close();
    }
}
```

- [ ] **Step 4: Wire OpenCode ingest**

In `ingestOpenCode`, discover `cfg.paths.opencodeDir/opencode.db`, call `extractOpenCodeDatabase`, write `agent_provider:opencode`, `agent_session`, `agent_event`, projected sessions and turns.

Use defensive behavior:

```ts
if (!(await Bun.file(dbPath).exists())) {
    return { files: 0, sessions: 0, events: 0, turns: 0, toolCalls: 0, skipped: 0, warnings: 0 };
}
```

- [ ] **Step 5: Run OpenCode tests**

```bash
bun test src/ingest/opencode.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/ingest/opencode.ts src/ingest/opencode.test.ts
git commit -m "feat: ingest local opencode sessions"
```

---

### Task 6: Cursor Local SQLite Adapter

**Files:**
- Modify: `src/ingest/cursor.ts`
- Create/modify: `src/ingest/cursor.test.ts`

- [ ] **Step 1: Write Cursor allowlist tests**

Create `src/ingest/cursor.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { extractCursorStateDb, isAllowedCursorHistoryKey } from "./cursor.ts";

describe("Cursor extraction", () => {
    test("allowlists chat/composer keys and rejects auth keys", () => {
        expect(isAllowedCursorHistoryKey("composer.composerData")).toBe(true);
        expect(isAllowedCursorHistoryKey("cursorAuth/accessToken")).toBe(false);
        expect(isAllowedCursorHistoryKey("cursorai/donotchange/privacyMode")).toBe(false);
    });

    test("extracts recognized JSON message arrays from state.vscdb", () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-cursor-"));
        const dbPath = join(dir, "state.vscdb");
        const db = new Database(dbPath);
        db.run("create table ItemTable (key text primary key, value blob)");
        db.run("insert into ItemTable values (?, ?)", [
            "composer.composerData",
            JSON.stringify({
                conversations: [{
                    id: "cursor-convo-1",
                    title: "Fix login",
                    messages: [
                        { id: "m1", role: "user", text: "hello cursor", timestamp: "2026-05-01T00:00:00.000Z" },
                    ],
                }],
            }),
        ]);
        db.run("insert into ItemTable values (?, ?)", ["cursorAuth/accessToken", "secret"]);
        db.close();

        const extracted = extractCursorStateDb(dbPath);
        expect(extracted.sessions[0]?.providerSessionId).toBe("cursor-convo-1");
        expect(extracted.events[0]?.text).toBe("hello cursor");
        expect(extracted.events.map((event) => JSON.stringify(event.rawJson)).join("\n")).not.toContain("secret");
    });
});
```

- [ ] **Step 2: Run failing Cursor tests**

```bash
bun test src/ingest/cursor.test.ts
```

Expected: fail because extraction helpers do not exist.

- [ ] **Step 3: Implement Cursor allowlist and extractor**

In `src/ingest/cursor.ts`, add:

```ts
import { Database } from "bun:sqlite";

export function isAllowedCursorHistoryKey(key: string): boolean {
    return (
        key.startsWith("composer.") ||
        key.startsWith("cursor.composer") ||
        key.startsWith("cursor/glass.tabs") ||
        key.startsWith("glass/")
    ) && !key.startsWith("cursorAuth/") && !key.includes("accessToken") && !key.includes("refreshToken");
}
```

Implement `extractCursorStateDb(dbPath)`:

- Open SQLite read-only.
- Read `ItemTable.key,value`.
- Skip keys not passing `isAllowedCursorHistoryKey`.
- JSON parse values.
- Support a conservative shape:
  `conversations: [{ id, title, messages: [{ id, role, text, timestamp }] }]`.
- Return extracted sessions/events.

- [ ] **Step 4: Wire Cursor ingest**

In `ingestCursor`, search:

```ts
[
  join(cfg.paths.cursorUserDir, "globalStorage", "state.vscdb"),
  ...workspaceStorage state.vscdb files
]
```

For each DB, call `extractCursorStateDb`, write provider/event graph rows, and project messages into `session`/`turn`.

- [ ] **Step 5: Run Cursor tests**

```bash
bun test src/ingest/cursor.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/ingest/cursor.ts src/ingest/cursor.test.ts
git commit -m "feat: ingest local cursor chat history"
```

---

### Task 7: Query And Dashboard Source Coverage

**Files:**
- Modify: `src/dashboard/web/src/routes/sessions.tsx`
- Modify: `src/dashboard/sessions-list.ts`
- Modify: `src/queries/insights.ts`
- Modify related tests that assert fixed provider lists.

- [ ] **Step 1: Write/update source filter tests**

Find source-list tests:

```bash
rg "claude|codex|SOURCE_FILTERS|sourceFilter" src/dashboard src/queries -n
```

Update expectations to include:

```ts
["all", "claude", "codex", "pi", "opencode", "cursor"]
```

- [ ] **Step 2: Update dashboard source filters**

In `src/dashboard/web/src/routes/sessions.tsx`, change:

```ts
const SOURCE_FILTERS = ["all", "claude", "codex", "pi", "opencode", "cursor"] as const;
```

Extend badge colors with restrained distinct colors:

```ts
pi: { bg: "#ede9fe", fg: "#5b21b6" },
opencode: { bg: "#dcfce7", fg: "#166534" },
cursor: { bg: "#fce7f3", fg: "#9d174d" },
```

- [ ] **Step 3: Update insights source-specific labels**

In `src/queries/insights.ts`, keep `codex-health` as Codex-specific, but ensure general token and workflow views do not filter to `claude|codex` only.

- [ ] **Step 4: Run dashboard/query tests**

```bash
bun test src/dashboard/sessions-list.test.ts src/queries/insights.test.ts
```

Expected: pass. If `sessions-list.test.ts` does not exist, run:

```bash
bun test src/dashboard src/queries
```

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/web/src/routes/sessions.tsx src/dashboard/sessions-list.ts src/queries/insights.ts src/dashboard src/queries
git commit -m "feat: surface local agent provider sources"
```

---

### Task 8: End-To-End Verification

**Files:**
- Modify only files needed to fix verification failures.

- [ ] **Step 1: Apply schema locally**

```bash
bun run scripts/apply-schema.sh
```

Expected: schema applies without SurrealQL errors.

- [ ] **Step 2: Run focused provider tests**

```bash
bun test src/ingest/provider-events.test.ts src/ingest/pi.test.ts src/ingest/opencode.test.ts src/ingest/cursor.test.ts src/ingest/codex.test.ts src/ingest/transcripts.test.ts
```

Expected: all pass.

- [ ] **Step 3: Run stage and config tests**

```bash
bun test src/lib/config.test.ts src/ingest/stage/registry.test.ts src/cli/effect-cli.test.ts
```

Expected: all pass.

- [ ] **Step 4: Run a local ingest smoke test**

```bash
bun src/cli/index.ts ingest --stages=pi,opencode,cursor --since=30 --progress=plain
```

Expected: command exits 0. Missing providers report zero counts; existing providers ingest sessions.

- [ ] **Step 5: Run recall smoke test**

```bash
bun src/cli/index.ts recall hello
```

Expected: command exits 0 and can include provider sessions when matching projected turn text exists.

- [ ] **Step 6: Run full test suite**

```bash
bun test
```

Expected: pass.

- [ ] **Step 7: Commit verification fixes**

If verification required fixes:

```bash
git add <changed-files>
git commit -m "fix: stabilize local provider ingest"
```

If no fixes were needed, skip this commit.

---

## Self-Review

Spec coverage:

- Claude and Codex are covered by Task 3.
- Pi full local tree support is covered by Task 4.
- OpenCode local storage support is covered by Task 5.
- Cursor local SQLite support and allowlisting are covered by Task 6.
- Shared provider schema and projection links are covered by Task 1.
- CLI/config/stage registration are covered by Task 2.
- Dashboard and query source coverage are covered by Task 7.
- End-to-end verification is covered by Task 8.

The plan intentionally keeps provider adapters small and forces all shared behavior through `provider-events.ts`. After Task 1 and Task 2 land, Tasks 4, 5, and 6 can run in parallel without editing each other's files.
