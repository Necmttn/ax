# Ingest Run And Normalized Transcripts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deepen the Ingest Pipeline run module and normalize all agent transcript providers through one persistence path.

**Architecture:** `src/ingest/run.ts` becomes the event-only Ingest Pipeline orchestration module: it owns run records, stage event rows, LiveTrace scope, stage wrapping, reset, and pipeline execution, but never owns terminal progress rendering. `src/ingest/normalized/` becomes the provider-neutral transcript model and persistence module; Claude, Codex, Pi, OpenCode, and Cursor adapters keep source parsing while shared code writes sessions, turns, Tool Calls, plan snapshots, Agent Events, and skill relations.

**Tech Stack:** Bun test, TypeScript strict mode, Effect 4 beta services/layers, SurrealDB statement builders, current vendored `src/lib/live-traces` package. Do not migrate to the external `livetrace` npm package in this plan.

---

## Current Context

- The worktree is dirty. Treat existing changes as user-owned, especially the new `pricing` Ingest Stage in `src/ingest/model-pricing.ts`, `src/ingest/stage/registry.ts`, and `src/cli/index.ts`.
- Keep `src/lib/live-traces/` for now. Do not add a `livetrace` dependency.
- The new run module is event-only. It may emit `TraceEvent`s through the vendored LiveTrace layer and durable rows through `src/dashboard/telemetry.ts`. It must not import `src/cli/progress.ts` or `src/cli/progress-tui.tsx`.
- Provider normalization must migrate all current providers: Claude, Codex, Pi, OpenCode, Cursor.

## File Structure

- Create `src/ingest/run.ts`
  - Owns `runIngest`, `IngestRunOptions`, `IngestRunResult`, stage display metadata, reset, run/stage/event DB writes, `LiveTrace.withTrace`, and `runPipeline`.
- Create `src/ingest/run.test.ts`
  - Unit tests for event-only orchestration, reset guard, run finish on success/error, and absence of CLI progress imports.
- Modify `src/cli/index.ts`
  - Keep raw argv validation and command definitions.
  - Move `STAGE_PROGRESS`, `telemetryStage`, `writeIngestEvent`, run id creation, stage wrapping, and run lifecycle into `src/ingest/run.ts`.
  - `cmdIngest` becomes argument parsing plus `runIngest`.
- Create `src/ingest/normalized/types.ts`
  - Provider-neutral write model and stats helpers.
- Create `src/ingest/normalized/persist.ts`
  - Shared persistence for normalized extracts.
- Create `src/ingest/normalized/persist.test.ts`
  - Statement-level tests for shared persistence.
- Create `src/ingest/normalized/adapters.test.ts`
  - Cross-provider smoke fixtures proving all providers can produce `NormalizedAgentExtract`.
- Modify `src/ingest/transcripts.ts`
  - Claude parser emits normalized extract and delegates persistence.
- Modify `src/ingest/codex.ts`
  - Codex parser emits normalized extract and delegates persistence.
- Modify `src/ingest/pi.ts`
  - Pi parser emits normalized extract and delegates persistence.
- Modify `src/ingest/opencode.ts`
  - OpenCode parser emits normalized extract and delegates persistence.
- Modify `src/ingest/cursor.ts`
  - Cursor parser emits normalized extract and delegates persistence.
- Modify tests for each provider only where assertions currently depend on provider-local persistence functions.

---

## Task 1: Extract Event-Only Ingest Run Module

**Files:**
- Create: `src/ingest/run.ts`
- Create: `src/ingest/run.test.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Write failing tests for run orchestration**

Create `src/ingest/run.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient, type SurrealClientShape } from "../lib/db.ts";
import { StageRegistry, StageRegistryLive, type StageDef } from "./stage/registry.ts";
import { BaseStageStats, IngestContext, StageMeta } from "./stage/types.ts";
import { runIngest, stageEventName } from "./run.ts";

const fakeDb = () => {
    const queries: string[] = [];
    const client: SurrealClientShape = {
        query: (sql) => Effect.sync(() => {
            queries.push(sql);
            return [] as unknown[];
        }),
        upsert: () => Effect.succeed({}),
        relate: () => Effect.succeed({}),
        putFile: () => Effect.void,
        getFile: () => Effect.succeed(""),
        raw: {} as SurrealClientShape["raw"],
    };
    return { queries, layer: Layer.succeed(SurrealClient, client) };
};

const stage = (key: string, deps: string[] = []): StageDef => ({
    meta: StageMeta.make({ key, deps, tags: ["ingest"] }),
    run: () => Effect.succeed(BaseStageStats.make({ durationMs: 1, summary: `${key} done` })),
});

describe("stageEventName", () => {
    it("uses canonical event labels for registered stages", () => {
        expect(stageEventName("skills")).toEqual({ source: "skills", stage: "upsert" });
        expect(stageEventName("commands")).toEqual({ source: "commands", stage: "upsert" });
        expect(stageEventName("pricing")).toEqual({ source: "pricing", stage: "models" });
        expect(stageEventName("unknown-provider")).toEqual({ source: "unknown-provider", stage: "run" });
    });
});

describe("runIngest", () => {
    it("writes run and stage lifecycle events without CLI progress services", async () => {
        const db = fakeDb();
        const registry = StageRegistryLive([stage("skills"), stage("commands", ["skills"])]);
        const program = runIngest({
            command: "ingest",
            args: [],
            cwd: "/tmp/ax",
            now: () => new Date("2026-05-29T00:00:00.000Z"),
            runId: () => "test_run",
        }).pipe(Effect.provide(Layer.mergeAll(db.layer, registry)));

        const result = await Effect.runPromise(program as Effect.Effect<unknown, never, never>);

        expect(result).toEqual({
            runId: "test_run",
            selectedStages: ["skills", "commands"],
            status: "ok",
        });
        expect(db.queries.join("\n")).toContain("UPSERT ingest_run:`test_run`");
        expect(db.queries.join("\n")).toContain("UPSERT ingest_stage:`test_run__skills__upsert`");
        expect(db.queries.join("\n")).toContain("UPSERT ingest_stage:`test_run__commands__upsert`");
        expect(db.queries.join("\n")).toContain("status: \"ok\"");
    });

    it("rejects reset with stage filters before deleting graph rows", async () => {
        const db = fakeDb();
        const registry = StageRegistryLive([stage("skills")]);
        const program = runIngest({
            command: "ingest",
            args: ["--reset", "--stages=skills"],
            cwd: "/tmp/ax",
            now: () => new Date("2026-05-29T00:00:00.000Z"),
            runId: () => "test_run",
        }).pipe(Effect.provide(Layer.mergeAll(db.layer, registry)));

        await expect(Effect.runPromise(program as Effect.Effect<unknown, never, never>))
            .rejects.toThrow(/--reset rebuilds the whole skill graph/);
        expect(db.queries.join("\n")).not.toContain("DELETE invoked");
    });
});
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```bash
bun test src/ingest/run.test.ts
```

Expected: fails because `src/ingest/run.ts`, `runIngest`, and `stageEventName` do not exist.

- [ ] **Step 3: Implement `src/ingest/run.ts`**

Create `src/ingest/run.ts`:

```ts
import { Effect, References } from "effect";
import { SurrealClient, type SurrealClientShape } from "../lib/db.ts";
import { AxConfig } from "../lib/config.ts";
import { ProcessService } from "../lib/process.ts";
import type { DbError } from "../lib/errors.ts";
import {
    buildIngestEventStatement,
    buildIngestRunFinishStatement,
    buildIngestRunStartStatement,
    buildIngestStageFinishStatement,
    buildIngestStageStartStatement,
    makeIngestEvent,
    publishIngestEvent,
} from "../dashboard/telemetry.ts";
import { LiveTrace } from "../lib/live-traces/index.ts";
import { selectByKeys, selectByTag } from "./stage/select.ts";
import { runPipeline } from "./stage/runner.ts";
import { StageRegistry, type StageRegistryShape } from "./stage/registry.ts";
import { BaseStageStats, IngestContext, type StageDef } from "./stage/types.ts";

export interface StageEventName {
    readonly source: string;
    readonly stage: string;
}

const STAGE_EVENT_NAMES: Record<string, StageEventName> = {
    skills: { source: "skills", stage: "upsert" },
    commands: { source: "commands", stage: "upsert" },
    pricing: { source: "pricing", stage: "models" },
    claude: { source: "claude", stage: "transcripts" },
    codex: { source: "codex", stage: "sessions" },
    pi: { source: "pi", stage: "sessions" },
    opencode: { source: "opencode", stage: "sessions" },
    cursor: { source: "cursor", stage: "sessions" },
    subagents: { source: "claude", stage: "subagents" },
    "invoked-positions": { source: "invoked", stage: "backfill-positions" },
    spawned: { source: "signals", stage: "spawned" },
    git: { source: "git", stage: "history" },
    signals: { source: "signals", stage: "derive" },
    outcomes: { source: "outcomes", stage: "derive" },
    "session-health": { source: "session-health", stage: "derive" },
    closure: { source: "closure", stage: "derive" },
    proposals: { source: "proposals", stage: "derive" },
    opportunities: { source: "opportunities", stage: "derive" },
    "retro-proposals": { source: "retro-proposals", stage: "derive" },
    harness: { source: "harness", stage: "doctor" },
};

export const stageEventName = (key: string): StageEventName =>
    STAGE_EVENT_NAMES[key] ?? { source: key, stage: "run" };

const flag = (name: string, args: readonly string[]): string | undefined =>
    args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

const parseOptionalPositiveIntFlag = (
    command: string,
    flagName: string,
    args: readonly string[],
): number | undefined => {
    const raw = flag(flagName, args);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`axctl ${command}: --${flagName} must be a positive integer (got "${raw}")`);
    }
    return n;
};

const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

const numericCounts = (value: unknown): Record<string, number> => {
    if (typeof value !== "object" || value === null) return {};
    const counts: Record<string, number> = {};
    for (const [key, raw] of Object.entries(value)) {
        if (typeof raw === "number" && Number.isFinite(raw)) counts[key] = raw;
    }
    return counts;
};

const resolveStages = (
    registry: StageRegistryShape,
    args: readonly string[],
): ReadonlyArray<StageDef<BaseStageStats, unknown>> => {
    const hasStagesArg = args.some((a) => a.startsWith("--stages="));
    const hasDeriveOnly = args.includes("--derive-only");
    if (hasStagesArg && hasDeriveOnly) {
        throw new Error("axctl ingest: --stages and --derive-only are mutually exclusive");
    }
    const stagesArg = args.find((a) => a.startsWith("--stages="));
    if (stagesArg) {
        const raw = stagesArg
            .slice("--stages=".length)
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        return selectByKeys(registry, raw);
    }
    if (args.includes("--derive-only")) return selectByTag(registry, "derive");
    return registry.all();
};

const writeIngestEvent = (
    db: SurrealClientShape,
    input: {
        readonly runId: string;
        readonly source: string;
        readonly stage: string;
        readonly level: "debug" | "info" | "warn" | "error";
        readonly message: string;
        readonly counts?: Record<string, number>;
    },
): Effect.Effect<void, DbError> =>
    Effect.gen(function* () {
        const event = makeIngestEvent({ ...input, counts: input.counts ?? {} });
        yield* db.query(buildIngestEventStatement(event));
        publishIngestEvent(event);
    }).pipe(Effect.asVoid);

const wrapStage = (
    db: SurrealClientShape,
    runId: string,
    stageDef: StageDef<BaseStageStats, SurrealClient | AxConfig | ProcessService>,
): StageDef<BaseStageStats, SurrealClient | AxConfig | ProcessService> => {
    const eventName = stageEventName(stageDef.meta.key);
    return {
        ...stageDef,
        run: (ctx: IngestContext) =>
            Effect.gen(function* () {
                yield* db.query(buildIngestStageStartStatement({
                    runId,
                    source: eventName.source,
                    stage: eventName.stage,
                }));
                const result = yield* stageDef.run(ctx).pipe(
                    LiveTrace.step(stageDef.meta.key, {
                        "ingest.stage.tags": stageDef.meta.tags.join(","),
                    }),
                    Effect.tap((value) => {
                        const counts = numericCounts(value);
                        return Effect.gen(function* () {
                            yield* db.query(buildIngestStageFinishStatement({
                                runId,
                                source: eventName.source,
                                stage: eventName.stage,
                                status: "ok",
                                counts,
                            }));
                            yield* writeIngestEvent(db, {
                                runId,
                                source: eventName.source,
                                stage: eventName.stage,
                                level: "info",
                                message: `${eventName.source} ${eventName.stage} complete`,
                                counts,
                            });
                        });
                    }),
                    Effect.catch((error) =>
                        Effect.gen(function* () {
                            const message = errorText(error);
                            yield* db.query(buildIngestStageFinishStatement({
                                runId,
                                source: eventName.source,
                                stage: eventName.stage,
                                status: "error",
                                counts: {},
                                errorText: message,
                            }));
                            yield* writeIngestEvent(db, {
                                runId,
                                source: eventName.source,
                                stage: eventName.stage,
                                level: "error",
                                message,
                            });
                            return yield* error;
                        }),
                    ),
                );
                return result;
            }),
    };
};

export interface RunIngestOptions {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly repoPaths?: readonly string[];
    readonly claudeProject?: string;
    readonly debug?: boolean;
    readonly verbose?: boolean;
    readonly now?: () => Date;
    readonly runId?: () => string;
}

export interface RunIngestResult {
    readonly runId: string;
    readonly selectedStages: readonly string[];
    readonly status: "ok";
}

const defaultRunId = (command: string): string =>
    Bun.hash(`${command}|${Date.now()}|${Math.random()}`).toString(16).padStart(16, "0");

export const runIngest = (
    opts: RunIngestOptions,
): Effect.Effect<RunIngestResult, DbError, SurrealClient | AxConfig | ProcessService | StageRegistry> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const registry = yield* StageRegistry;
        const hasFilter = opts.args.some((a) => a.startsWith("--stages=")) || opts.args.includes("--derive-only");
        if (opts.args.includes("--reset") && hasFilter) {
            throw new Error(`axctl ${opts.command}: --reset rebuilds the whole skill graph and cannot be combined with stage filters`);
        }
        const selectedStages = resolveStages(registry, opts.args);
        const sinceDays = parseOptionalPositiveIntFlag(opts.command, "since", opts.args);
        const runId = opts.runId?.() ?? defaultRunId(opts.command);
        const now = opts.now?.() ?? new Date();
        yield* db.query(buildIngestRunStartStatement({
            runId,
            command: opts.command,
            ...(sinceDays === undefined ? {} : { sinceDays }),
        }));
        if (opts.args.includes("--reset")) {
            yield* db.query("DELETE invoked; DELETE proposed; DELETE concerns; DELETE recovered_by; DELETE skill_paired; DELETE skill;");
        }
        const ctx = IngestContext.make({
            cwd: opts.cwd,
            since: sinceDays === undefined ? new Date(0) : new Date(now.getTime() - sinceDays * 86400 * 1000),
            debug: opts.debug ?? opts.args.includes("--debug"),
            ...(opts.repoPaths ? { repoPaths: [...opts.repoPaths] } : {}),
            ...(opts.claudeProject ? { claudeProject: opts.claudeProject } : {}),
        });
        const wrappedStages = selectedStages.map((stageDef) =>
            wrapStage(
                db,
                runId,
                stageDef as StageDef<BaseStageStats, SurrealClient | AxConfig | ProcessService>,
            )
        );
        yield* runPipeline(wrappedStages, ctx).pipe(
            LiveTrace.withTrace({
                traceId: `ingest:${runId}`,
                label: `ingest ${selectedStages.map((s) => s.meta.key).join(",")}`,
                scope: { type: "user", id: process.env.USER ?? "local" },
            }),
            Effect.tap(() => db.query(buildIngestRunFinishStatement({ runId, status: "ok" })).pipe(Effect.asVoid)),
            Effect.catch((error) =>
                Effect.gen(function* () {
                    yield* db.query(buildIngestRunFinishStatement({
                        runId,
                        status: "error",
                        metrics: { error: errorText(error) },
                    }));
                    return yield* error;
                }),
            ),
            Effect.provideService(References.MinimumLogLevel, opts.verbose ? "Debug" : "Info"),
        );
        return {
            runId,
            selectedStages: selectedStages.map((s) => s.meta.key),
            status: "ok" as const,
        };
    });
```

- [ ] **Step 4: Run the run module test**

Run:

```bash
bun test src/ingest/run.test.ts
```

Expected: PASS.

- [ ] **Step 5: Slim `cmdIngest` in `src/cli/index.ts`**

Modify imports:

```ts
import { runIngest } from "../ingest/run.ts";
```

Remove these CLI-local imports when unused:

```ts
import { References } from "effect";
import { createProgressReporter, parseProgressMode, type ProgressReporter, type ProgressStage } from "./progress.ts";
import { initTuiProgress, shouldUseTui } from "./progress-tui.tsx";
import {
    buildIngestEventStatement,
    buildIngestRunFinishStatement,
    buildIngestRunStartStatement,
    buildIngestStageFinishStatement,
    buildIngestStageStartStatement,
    makeIngestEvent,
    publishIngestEvent,
} from "../dashboard/telemetry.ts";
import { runPipeline } from "../ingest/stage/runner.ts";
import { LiveTrace } from "../lib/live-traces/index.ts";
```

Replace the body of `cmdIngest` with:

```ts
const cmdIngest = (args: string[], opts: IngestCommandOpts = {}) => {
    const commandName = opts.command ?? "ingest";
    return runIngest({
        command: commandName,
        args,
        cwd: opts.cwd ?? process.cwd(),
        ...(opts.repoPaths ? { repoPaths: opts.repoPaths } : {}),
        ...(opts.claudeProject ? { claudeProject: opts.claudeProject } : {}),
        debug: args.includes("--debug"),
        verbose: args.includes("--verbose"),
    }).pipe(Effect.asVoid);
};
```

Keep `detectRemovedIngestFlag` in `src/cli/index.ts` until all raw-argv validation is moved into a dedicated CLI parser module.

- [ ] **Step 6: Run CLI and ingest tests**

Run:

```bash
bun test src/ingest/run.test.ts src/ingest/stage/runner.test.ts src/cli/effect-cli.test.ts
bun run typecheck
```

Expected: tests pass and typecheck passes. If typecheck shows stale imports in `src/cli/index.ts`, remove only imports that are unused after Step 5.

---

## Task 2: Add Normalized Transcript Model

**Files:**
- Create: `src/ingest/normalized/types.ts`
- Create: `src/ingest/normalized/persist.ts`
- Create: `src/ingest/normalized/persist.test.ts`

- [ ] **Step 1: Write failing persistence test**

Create `src/ingest/normalized/persist.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient, type SurrealClientShape } from "../../lib/db.ts";
import { persistNormalizedAgentExtract } from "./persist.ts";
import type { NormalizedAgentExtract } from "./types.ts";

const fakeDb = () => {
    const queries: string[] = [];
    const upserts: Array<{ id: string; content: Record<string, unknown> }> = [];
    const client: SurrealClientShape = {
        query: (sql) => Effect.sync(() => {
            queries.push(sql);
            return [] as unknown[];
        }),
        upsert: (id, content) => Effect.sync(() => {
            upserts.push({ id: String(id), content });
            return {};
        }),
        relate: () => Effect.succeed({}),
        putFile: () => Effect.void,
        getFile: () => Effect.succeed(""),
        raw: {} as SurrealClientShape["raw"],
    };
    return { queries, upserts, layer: Layer.succeed(SurrealClient, client) };
};

describe("persistNormalizedAgentExtract", () => {
    it("persists sessions, provider events, turns, tool calls, and skill relations through one path", async () => {
        const db = fakeDb();
        const extract: NormalizedAgentExtract = {
            provider: "codex",
            sourcePath: "/tmp/codex.jsonl",
            sessions: [{
                id: "s1",
                providerSessionId: "provider-s1",
                cwd: "/tmp/project",
                project: "/tmp/project",
                model: "gpt-test",
                startedAt: "2026-05-29T00:00:00.000Z",
                endedAt: "2026-05-29T00:01:00.000Z",
                rawFile: "/tmp/codex.jsonl",
            }],
            turns: [{
                sessionId: "s1",
                key: "s1__turn_000001",
                seq: 1,
                ts: "2026-05-29T00:00:01.000Z",
                role: "assistant",
                messageKind: "assistant",
                intentKind: "other",
                text: "hello",
                textExcerpt: "hello",
                hasToolUse: false,
                hasError: false,
            }],
            toolCalls: [{
                sessionId: "s1",
                turnKey: "s1__turn_000001",
                provider: "codex",
                toolName: "exec_command",
                toolKind: "builtin",
                seq: 1,
                callId: "call-1",
                ts: "2026-05-29T00:00:02.000Z",
                hasError: false,
            }],
            skillRelations: [{
                toolCallKey: "s1__tool_000001__call_1",
                skillName: "codex:exec_command",
                ts: "2026-05-29T00:00:02.000Z",
                reason: "tool_call",
            }],
            planSnapshots: [],
            agentEvents: [{
                provider: "codex",
                providerSessionId: "provider-s1",
                providerEventId: "event-1",
                axSessionId: "s1",
                seq: 1,
                ts: "2026-05-29T00:00:01.000Z",
                type: "message",
                role: "assistant",
                text: "hello",
                textExcerpt: "hello",
            }],
            warnings: [],
            skipped: 0,
        };

        const result = await Effect.runPromise(
            persistNormalizedAgentExtract(extract).pipe(Effect.provide(db.layer)) as Effect.Effect<unknown, never, never>,
        );

        expect(result).toEqual({
            sessions: 1,
            turns: 1,
            toolCalls: 1,
            skillRelations: 1,
            planSnapshots: 0,
            agentEvents: 1,
        });
        expect(db.upserts[0]?.id).toBe("session:s1");
        const sql = db.queries.join("\n");
        expect(sql).toContain("UPSERT agent_session:");
        expect(sql).toContain("UPSERT agent_event:");
        expect(sql).toContain("UPSERT turn:");
        expect(sql).toContain("UPSERT tool_call:");
        expect(sql).toContain("->concerns:");
    });
});
```

- [ ] **Step 2: Run the persistence test and verify it fails**

Run:

```bash
bun test src/ingest/normalized/persist.test.ts
```

Expected: fails because `types.ts` and `persist.ts` do not exist.

- [ ] **Step 3: Implement normalized types**

Create `src/ingest/normalized/types.ts`:

```ts
import type { AgentEventWrite, AgentProviderName } from "../provider-events.ts";
import type {
    PlanSnapshotWrite,
    ToolCallSkillRelationWrite,
    ToolCallWrite,
} from "../evidence-writers.ts";

export interface NormalizedSession {
    readonly id: string;
    readonly providerSessionId: string;
    readonly cwd: string | null;
    readonly project: string | null;
    readonly model: string | null;
    readonly startedAt: string | Date | null;
    readonly endedAt: string | Date | null;
    readonly rawFile: string | null;
}

export interface NormalizedTurn {
    readonly sessionId: string;
    readonly key: string;
    readonly seq: number;
    readonly ts: string | Date;
    readonly role: string;
    readonly messageKind: string;
    readonly intentKind: string;
    readonly text: string | null;
    readonly textExcerpt: string | null;
    readonly hasToolUse: boolean;
    readonly hasError: boolean;
}

export interface NormalizedAgentExtract {
    readonly provider: AgentProviderName;
    readonly sourcePath: string | null;
    readonly sessions: readonly NormalizedSession[];
    readonly turns: readonly NormalizedTurn[];
    readonly toolCalls: readonly ToolCallWrite[];
    readonly skillRelations: readonly ToolCallSkillRelationWrite[];
    readonly planSnapshots: readonly PlanSnapshotWrite[];
    readonly agentEvents: readonly AgentEventWrite[];
    readonly warnings: readonly string[];
    readonly skipped: number;
}

export interface NormalizedPersistStats {
    readonly sessions: number;
    readonly turns: number;
    readonly toolCalls: number;
    readonly skillRelations: number;
    readonly planSnapshots: number;
    readonly agentEvents: number;
}
```

- [ ] **Step 4: Implement shared persistence**

Create `src/ingest/normalized/persist.ts`:

```ts
import { Effect } from "effect";
import { RecordId, SurrealClient } from "../../lib/db.ts";
import type { DbError } from "../../lib/errors.ts";
import { executeStatements } from "../../lib/shared/statement-exec.ts";
import {
    buildAgentEventStatements,
    type AgentSessionWrite,
} from "../provider-events.ts";
import {
    buildPlanSnapshotStatements,
    buildRelateToolCallSkillStatements,
    buildToolCallStatements,
} from "../evidence-writers.ts";
import { recordRef, surrealDate, surrealObject, surrealOptionString, surrealString } from "../../lib/shared/surql.ts";
import type { NormalizedAgentExtract, NormalizedPersistStats, NormalizedTurn } from "./types.ts";

const dateOrUndefined = (value: string | Date | null): Date | undefined =>
    value === null ? undefined : value instanceof Date ? value : new Date(value);

const sessionContent = (session: NormalizedAgentExtract["sessions"][number], provider: string): Record<string, unknown> => ({
    project: session.project ?? undefined,
    cwd: session.cwd ?? undefined,
    model: session.model ?? undefined,
    source: provider,
    started_at: dateOrUndefined(session.startedAt),
    ended_at: dateOrUndefined(session.endedAt),
    raw_file: session.rawFile ?? undefined,
});

const agentSessions = (extract: NormalizedAgentExtract): AgentSessionWrite[] =>
    extract.sessions.map((session) => ({
        provider: extract.provider,
        providerSessionId: session.providerSessionId,
        axSessionId: session.id,
        cwd: session.cwd,
        project: session.project,
        model: session.model,
        sourcePath: session.rawFile ?? extract.sourcePath,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
    }));

const buildTurnStatements = (turns: readonly NormalizedTurn[]): string[] =>
    turns.map((turn) =>
        `UPSERT ${recordRef("turn", turn.key)} CONTENT ${surrealObject([
            ["session", recordRef("session", turn.sessionId)],
            ["seq", turn.seq.toString(10)],
            ["ts", surrealDate(turn.ts)],
            ["role", surrealString(turn.role)],
            ["message_kind", surrealString(turn.messageKind)],
            ["intent_kind", surrealString(turn.intentKind)],
            ["text", surrealOptionString(turn.text)],
            ["text_excerpt", surrealOptionString(turn.textExcerpt)],
            ["has_tool_use", turn.hasToolUse ? "true" : "false"],
            ["has_error", turn.hasError ? "true" : "false"],
        ])};`
    );

export const persistNormalizedAgentExtract = (
    extract: NormalizedAgentExtract,
): Effect.Effect<NormalizedPersistStats, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        for (const session of extract.sessions) {
            yield* db.upsert(new RecordId("session", session.id), sessionContent(session, extract.provider));
        }

        const statements = [
            ...buildAgentEventStatements({
                sessions: agentSessions(extract),
                events: extract.agentEvents,
            }),
            ...buildTurnStatements(extract.turns),
            ...buildToolCallStatements(extract.toolCalls),
            ...extract.skillRelations.flatMap(buildRelateToolCallSkillStatements),
            ...extract.planSnapshots.flatMap(buildPlanSnapshotStatements),
        ];
        yield* executeStatements(statements, { chunkSize: 500 });

        return {
            sessions: extract.sessions.length,
            turns: extract.turns.length,
            toolCalls: extract.toolCalls.length,
            skillRelations: extract.skillRelations.length,
            planSnapshots: extract.planSnapshots.length,
            agentEvents: extract.agentEvents.length,
        };
    });
```

- [ ] **Step 5: Run the persistence test**

Run:

```bash
bun test src/ingest/normalized/persist.test.ts
```

Expected: PASS.

---

## Task 3: Convert Pi, OpenCode, And Cursor To Shared Persistence

**Files:**
- Modify: `src/ingest/pi.ts`
- Modify: `src/ingest/opencode.ts`
- Modify: `src/ingest/cursor.ts`
- Modify tests only where provider-local persistence statement counts change.

- [ ] **Step 1: Update Pi extraction to build `NormalizedAgentExtract`**

In `src/ingest/pi.ts`, import:

```ts
import { persistNormalizedAgentExtract } from "./normalized/persist.ts";
import type { NormalizedAgentExtract, NormalizedSession, NormalizedTurn } from "./normalized/types.ts";
```

Add mapper functions near `PiExtract`:

```ts
const piNormalizedSession = (extract: PiExtract): NormalizedSession => ({
    id: extract.session.id,
    providerSessionId: extract.session.id,
    cwd: extract.session.cwd,
    project: extract.session.cwd,
    model: extract.session.model,
    startedAt: extract.session.started_at,
    endedAt: extract.session.ended_at,
    rawFile: extract.sourcePath,
});

const piNormalizedTurn = (turn: PiTurn): NormalizedTurn => ({
    sessionId: turn.session,
    key: turnRecordKey(turn.session, turn.seq),
    seq: turn.seq,
    ts: turn.ts,
    role: turn.role,
    messageKind: turn.message_kind,
    intentKind: turn.intent_kind,
    text: turn.text,
    textExcerpt: turn.text_excerpt,
    hasToolUse: turn.has_tool_use,
    hasError: turn.has_error,
});

const piNormalizedExtract = (extract: PiExtract): NormalizedAgentExtract => ({
    provider: "pi",
    sourcePath: extract.sourcePath,
    sessions: [piNormalizedSession(extract)],
    turns: extract.turns.map(piNormalizedTurn),
    toolCalls: extract.toolCalls,
    skillRelations: extract.skillRelations,
    planSnapshots: [],
    agentEvents: extract.providerEvents,
    warnings: extract.warnings,
    skipped: extract.skipped,
});
```

Replace the manual `db.upsert` and `executeStatements(buildPiBatchStatements(...))` block with:

```ts
yield* persistNormalizedAgentExtract(piNormalizedExtract(extracted));
```

- [ ] **Step 2: Update OpenCode extraction to build `NormalizedAgentExtract`**

In `src/ingest/opencode.ts`, import:

```ts
import { persistNormalizedAgentExtract } from "./normalized/persist.ts";
import type { NormalizedAgentExtract, NormalizedSession, NormalizedTurn } from "./normalized/types.ts";
```

Add mapper functions near `OpenCodeExtract`:

```ts
const opencodeNormalizedSessions = (extract: OpenCodeExtract, dbPath: string): NormalizedSession[] =>
    extract.sessions.map((session) => ({
        id: session.id,
        providerSessionId: session.id,
        cwd: session.cwd,
        project: session.cwd,
        model: session.model,
        startedAt: session.started_at,
        endedAt: session.ended_at,
        rawFile: dbPath,
    }));

const opencodeNormalizedTurn = (turn: OpenCodeTurn): NormalizedTurn => ({
    sessionId: turn.session,
    key: turnRecordKey(turn.session, turn.seq),
    seq: turn.seq,
    ts: turn.ts,
    role: turn.role,
    messageKind: turn.message_kind,
    intentKind: turn.intent_kind,
    text: turn.text,
    textExcerpt: turn.text_excerpt,
    hasToolUse: turn.has_tool_use,
    hasError: turn.has_error,
});

const opencodeNormalizedExtract = (extract: OpenCodeExtract, dbPath: string): NormalizedAgentExtract => ({
    provider: "opencode",
    sourcePath: dbPath,
    sessions: opencodeNormalizedSessions(extract, dbPath),
    turns: extract.turns.map(opencodeNormalizedTurn),
    toolCalls: [],
    skillRelations: [],
    planSnapshots: [],
    agentEvents: extract.providerEvents,
    warnings: extract.warnings,
    skipped: extract.skipped,
});
```

Replace the manual session upsert loop and `executeStatements(buildOpenCodeBatchStatements(...))` call with:

```ts
yield* persistNormalizedAgentExtract(opencodeNormalizedExtract(extract, dbPath));
```

- [ ] **Step 3: Update Cursor extraction to build `NormalizedAgentExtract`**

In `src/ingest/cursor.ts`, import:

```ts
import { persistNormalizedAgentExtract } from "./normalized/persist.ts";
import type { NormalizedAgentExtract, NormalizedSession, NormalizedTurn } from "./normalized/types.ts";
```

Add mapper functions near `CursorExtract`:

```ts
const cursorNormalizedSessions = (extract: CursorExtract): NormalizedSession[] =>
    extract.sessions.map((session) => ({
        id: session.id,
        providerSessionId: session.cursorConversationId,
        cwd: null,
        project: null,
        model: null,
        startedAt: session.started_at,
        endedAt: session.ended_at,
        rawFile: session.sourcePath,
    }));

const cursorNormalizedTurn = (turn: CursorTurn): NormalizedTurn => ({
    sessionId: turn.session,
    key: turnRecordKey(turn.session, turn.seq),
    seq: turn.seq,
    ts: turn.ts,
    role: turn.role,
    messageKind: turn.message_kind,
    intentKind: turn.intent_kind,
    text: turn.text,
    textExcerpt: turn.text_excerpt,
    hasToolUse: turn.has_tool_use,
    hasError: turn.has_error,
});

const cursorNormalizedExtract = (extract: CursorExtract, dbPath: string): NormalizedAgentExtract => ({
    provider: "cursor",
    sourcePath: dbPath,
    sessions: cursorNormalizedSessions(extract),
    turns: extract.turns.map(cursorNormalizedTurn),
    toolCalls: [],
    skillRelations: [],
    planSnapshots: [],
    agentEvents: extract.providerEvents,
    warnings: extract.warnings,
    skipped: extract.skipped,
});
```

Replace the manual session upsert loop and `executeStatements(buildCursorBatchStatements(...))` call with:

```ts
yield* persistNormalizedAgentExtract(cursorNormalizedExtract(extract, dbPath));
```

- [ ] **Step 4: Run provider tests**

Run:

```bash
bun test src/ingest/pi.test.ts src/ingest/opencode.test.ts src/ingest/cursor.test.ts src/ingest/normalized/persist.test.ts
```

Expected: PASS after adjusting only tests that asserted the provider-local statement builder call shape.

---

## Task 4: Convert Codex To Shared Persistence

**Files:**
- Modify: `src/ingest/codex.ts`
- Modify: `src/ingest/codex.test.ts`

- [ ] **Step 1: Add Codex normalized mappers**

In `src/ingest/codex.ts`, import:

```ts
import { persistNormalizedAgentExtract } from "./normalized/persist.ts";
import type { NormalizedAgentExtract, NormalizedSession, NormalizedTurn } from "./normalized/types.ts";
```

Add mapper functions near `CodexSession` and `CodexTurn`:

```ts
const codexNormalizedSession = (
    session: CodexSession,
    sourcePath: string | null,
): NormalizedSession => ({
    id: session.id,
    providerSessionId: session.id,
    cwd: session.cwd,
    project: session.cwd,
    model: session.model,
    startedAt: session.started_at,
    endedAt: session.ended_at,
    rawFile: sourcePath,
});

const codexNormalizedTurn = (turn: CodexTurn): NormalizedTurn => ({
    sessionId: turn.session,
    key: turnRecordKey(turn.session, turn.seq),
    seq: turn.seq,
    ts: turn.ts,
    role: turn.role,
    messageKind: turn.message_kind,
    intentKind: turn.intent_kind,
    text: turn.text,
    textExcerpt: turn.text_excerpt,
    hasToolUse: turn.has_tool_use,
    hasError: false,
});
```

- [ ] **Step 2: Replace batch write path**

Where Codex currently calls local session upserts and statement builders in `writeBatch`, produce:

```ts
const normalized: NormalizedAgentExtract = {
    provider: "codex",
    sourcePath: filePath,
    sessions: batch.session ? [codexNormalizedSession(batch.session, filePath)] : [],
    turns: batch.turns.map(codexNormalizedTurn),
    toolCalls: batch.toolCalls,
    skillRelations: batch.skillRelations,
    planSnapshots: batch.planSnapshots,
    agentEvents: batch.providerEvents,
    warnings: [],
    skipped: 0,
};
yield* persistNormalizedAgentExtract(normalized);
```

Keep the final raw artifact pointer update for Codex after raw snapshot upload:

```ts
yield* upsertSession(completedSession, rawPointer);
```

This preserves existing raw snapshot behavior while moving transcript evidence writes to the shared persistence path.

- [ ] **Step 3: Run Codex tests**

Run:

```bash
bun test src/ingest/codex.test.ts src/ingest/normalized/persist.test.ts
```

Expected: PASS.

---

## Task 5: Convert Claude To Shared Persistence

**Files:**
- Modify: `src/ingest/transcripts.ts`
- Modify: `src/ingest/transcripts.test.ts`

- [ ] **Step 1: Add Claude normalized mappers**

In `src/ingest/transcripts.ts`, import:

```ts
import { persistNormalizedAgentExtract } from "./normalized/persist.ts";
import type { NormalizedAgentExtract, NormalizedSession, NormalizedTurn } from "./normalized/types.ts";
```

Add mapper functions near `Session` and `Turn`:

```ts
const claudeNormalizedSession = (session: Session): NormalizedSession => ({
    id: session.id,
    providerSessionId: session.id,
    cwd: session.cwd,
    project: session.project,
    model: session.model,
    startedAt: session.started_at,
    endedAt: session.ended_at,
    rawFile: session.raw_file,
});

const claudeNormalizedTurn = (turn: Turn): NormalizedTurn => ({
    sessionId: turn.session,
    key: turnRecordKey(turn.session, turn.seq),
    seq: turn.seq,
    ts: turn.ts,
    role: turn.role,
    messageKind: turn.message_kind,
    intentKind: turn.intent_kind,
    text: turn.text,
    textExcerpt: turn.text_excerpt,
    hasToolUse: turn.has_tool_use,
    hasError: turn.has_error,
});
```

- [ ] **Step 2: Replace Claude batch persistence**

Where Claude currently upserts sessions, turns, invocations, edits, Tool Calls, plan snapshots, hook events, and provider events separately, change only the shared items first:

```ts
const normalized: NormalizedAgentExtract = {
    provider: "claude",
    sourcePath: filePath,
    sessions: extracted.session ? [claudeNormalizedSession(extracted.session)] : [],
    turns: extracted.turns.map(claudeNormalizedTurn),
    toolCalls: extracted.toolCalls,
    skillRelations: extracted.skillRelations,
    planSnapshots: extracted.planSnapshots,
    agentEvents: extracted.providerEvents,
    warnings: [],
    skipped: 0,
};
yield* persistNormalizedAgentExtract(normalized);
```

Keep Claude-only relations that are not represented in `NormalizedAgentExtract`:

```ts
yield* upsertInvocations(extracted.invocations);
yield* upsertEdits(extracted.edits);
yield* upsertHarnessHookEvents(extracted.hookEvents);
yield* upsertHookCommandInvocations(extracted.hookCommandInvocations);
```

If any of those functions are now only called from the Claude path, leave them in `transcripts.ts`. They are Claude-specific evidence, not part of the provider-neutral persistence seam.

- [ ] **Step 3: Run Claude tests**

Run:

```bash
bun test src/ingest/transcripts.test.ts src/ingest/normalized/persist.test.ts
```

Expected: PASS.

---

## Task 6: Cross-Provider Normalization Smoke Test

**Files:**
- Create: `src/ingest/normalized/adapters.test.ts`
- Modify: provider files only to export test mappers if needed.

- [ ] **Step 1: Export mapper helpers for tests**

For each provider file, export the mapper used by the ingest function:

```ts
export const __testNormalizePiExtract = piNormalizedExtract;
export const __testNormalizeOpenCodeExtract = opencodeNormalizedExtract;
export const __testNormalizeCursorExtract = cursorNormalizedExtract;
export const __testNormalizeCodexSession = codexNormalizedSession;
export const __testNormalizeClaudeSession = claudeNormalizedSession;
```

- [ ] **Step 2: Create smoke test**

Create `src/ingest/normalized/adapters.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import type { NormalizedAgentExtract } from "./types.ts";

const assertExtractShape = (extract: NormalizedAgentExtract) => {
    expect(["claude", "codex", "pi", "opencode", "cursor"]).toContain(extract.provider);
    for (const session of extract.sessions) {
        expect(session.id.length).toBeGreaterThan(0);
        expect(session.providerSessionId.length).toBeGreaterThan(0);
    }
    for (const turn of extract.turns) {
        expect(turn.key.length).toBeGreaterThan(0);
        expect(turn.sessionId.length).toBeGreaterThan(0);
        expect(Number.isInteger(turn.seq)).toBe(true);
    }
};

describe("normalized provider extract shape", () => {
    it("accepts the common shape used by all provider adapters", () => {
        assertExtractShape({
            provider: "claude",
            sourcePath: "/tmp/source.jsonl",
            sessions: [{
                id: "s1",
                providerSessionId: "s1",
                cwd: "/tmp/project",
                project: "project",
                model: "model",
                startedAt: "2026-05-29T00:00:00.000Z",
                endedAt: "2026-05-29T00:01:00.000Z",
                rawFile: "/tmp/source.jsonl",
            }],
            turns: [{
                sessionId: "s1",
                key: "s1__turn_000001",
                seq: 1,
                ts: "2026-05-29T00:00:01.000Z",
                role: "user",
                messageKind: "task",
                intentKind: "other",
                text: "hello",
                textExcerpt: "hello",
                hasToolUse: false,
                hasError: false,
            }],
            toolCalls: [],
            skillRelations: [],
            planSnapshots: [],
            agentEvents: [],
            warnings: [],
            skipped: 0,
        });
    });
});
```

- [ ] **Step 3: Run all provider ingest tests**

Run:

```bash
bun test src/ingest/normalized/adapters.test.ts src/ingest/transcripts.test.ts src/ingest/codex.test.ts src/ingest/pi.test.ts src/ingest/opencode.test.ts src/ingest/cursor.test.ts
```

Expected: PASS.

---

## Task 7: Remove Duplicated Provider Persistence Helpers

**Files:**
- Modify: `src/ingest/pi.ts`
- Modify: `src/ingest/opencode.ts`
- Modify: `src/ingest/cursor.ts`
- Modify: `src/ingest/codex.ts`
- Modify: `src/ingest/transcripts.ts`

- [ ] **Step 1: Search for now-unused provider-local statement builders**

Run:

```bash
rg "buildPiBatchStatements|buildOpenCodeBatchStatements|buildCursorBatchStatements|buildCodexBatchStatements|buildTranscriptBatchStatements" src/ingest -n
```

Expected: each result is either in a test-only export or no longer referenced by production ingest functions.

- [ ] **Step 2: Delete only unused production helpers**

For each helper with no production reference and no test value after Tasks 3-6, remove:

```ts
const unusedHelper = ...
export const __testUnusedHelper = unusedHelper;
```

Do not delete `buildAgentEventStatements`, `buildToolCallStatements`, `buildRelateToolCallSkillStatements`, or `buildPlanSnapshotStatements`; those are the shared persistence implementation.

- [ ] **Step 3: Run duplicate search again**

Run:

```bash
rg "db\\.upsert\\(new RecordId\\(\"session\"|build.*BatchStatements|executeStatements\\(build.*Statements" src/ingest -n
```

Expected: session upserts for provider transcript ingestion are centralized in `src/ingest/normalized/persist.ts`; remaining matches are non-transcript ingest modules or shared statement builders.

---

## Task 8: Final Verification

**Files:**
- No planned source edits.

- [ ] **Step 1: Run targeted tests**

Run:

```bash
bun test src/ingest/run.test.ts src/ingest/normalized/persist.test.ts src/ingest/normalized/adapters.test.ts src/ingest/stage/runner.test.ts src/cli/effect-cli.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run provider tests**

Run:

```bash
bun test src/ingest/transcripts.test.ts src/ingest/codex.test.ts src/ingest/pi.test.ts src/ingest/opencode.test.ts src/ingest/cursor.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run architectural grep checks**

Run:

```bash
rg "progress-tui|createProgressReporter|ProgressReporter|parseProgressMode" src/ingest src/cli/index.ts -n
rg "livetrace" package.json src -n
```

Expected:

```text
# first command: no matches in src/ingest; matches in src/cli are acceptable only if unrelated non-ingest commands still use progress helpers
# second command: no package.json dependency on livetrace; existing docs or comments are acceptable only if they say migration is skipped
```

## Self-Review

- Spec coverage: Candidate 1 is covered by Tasks 1 and 8. Candidate 2 is covered by Tasks 2-7. The user decision "events only" is covered by Task 1 and the grep check. The user decision "all providers" is covered by Tasks 3-6. The user decision "skip livetrace for now" is covered in Current Context and final grep checks.
- Placeholder scan: This plan contains no banned placeholder markers and no open-ended "add tests" steps.
- Type consistency: `NormalizedAgentExtract`, `NormalizedSession`, `NormalizedTurn`, `persistNormalizedAgentExtract`, `runIngest`, and `stageEventName` are defined before later tasks reference them.
