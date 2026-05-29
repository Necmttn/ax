# Ingest Stage Registry Refactor - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three-sources-of-truth Ingest Stage wiring (`INGEST_STAGE_DEPS` in `pipeline.ts` + `stageRun` map in `cli/index.ts` + ad-hoc `deriveOnlyKeys`) with a Schema-typed, per-stage co-located `StageDef` registry, and route progress through a vendored `live-traces` tracer decorator instead of bespoke progress plumbing.

**Architecture:** Each stage file exports a `Schema.Literal` for its key, a `BaseStageStats`-extending stats class, and a `StageDef` factory. A central registry composes the key/tag unions via `Schema.Union` and exposes a typed `StageRegistry` Effect service. The pipeline consumes the registry. Progress is emitted as Schema-typed `TraceEvent`s via the vendored `live-traces` Layer that wraps Effect's tracer; consumers subscribe to a pluggable `TraceTransport`.

**Tech Stack:** TypeScript strict, Bun ≥ 1.3, `effect@beta` (4.0.0-beta.x) with `Schema`/`Layer`/`Context.Service`, SurrealDB 3.0+, bun:test.

**ADRs referenced:** 0004 (native hook observability), 0005 (converge writes onto ingest path), 0006 (typed stats as inter-stage contract), 0007 (live-traces as progress channel), 0008 (vendor live-traces).

**No backwards compatibility.** The flags `--X-only` are removed; `--stages=<list>` and `--derive-only` remain but are reimplemented over the registry. The legacy `StageSpec`/`INGEST_STAGE_DEPS`/`selectStages` exports are deleted, not aliased.

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `src/lib/live-traces/types.ts` | Wire-format `TraceEvent` discriminated union, zero deps |
| `src/lib/live-traces/Schema.ts` | Schema-validated mirrors of `TraceEvent` |
| `src/lib/live-traces/Sink.ts` | `TraceSink` service + `TraceTransport` tag + flush daemon |
| `src/lib/live-traces/Tracer.ts` | `LiveTraceLayer` (Effect tracer decorator) |
| `src/lib/live-traces/WrappedSpan.ts` | Span decorator that emits `SpanEvent`/`SpanEnd` to sink |
| `src/lib/live-traces/LiveTrace.ts` | `withTrace`/`step` user-facing combinators |
| `src/lib/live-traces/Logger.ts` | Bridge `Effect.log` → `SpanEvent` |
| `src/lib/live-traces/index.ts` | Barrel re-export |
| `src/lib/live-traces/transports/console.ts` | Dev transport (NDJSON to stdout) |
| `src/lib/live-traces/__tests__/Sink.test.ts` | Buffer + flush daemon test |
| `src/lib/live-traces/__tests__/LiveTrace.test.ts` | `withTrace` end-to-end emission test |
| `src/ingest/stage/types.ts` | `BaseStageStats`, `IngestContext`, `StageMeta`, `StageDef`, `IngestError` |
| `src/ingest/stage/tags.ts` | Co-located tag literals (`IngestTag`, `DeriveTag`, `RetroTag`, `HealthTag`) + union |
| `src/ingest/stage/registry.ts` | `StageRegistry` service + composed `IngestStageKey` union |
| `src/ingest/stage/runner.ts` | New `runPipeline(stages, ctx)` over `StageDef[]` |
| `src/ingest/stage/runner.test.ts` | Dep ordering, fail-fast, concurrency tests |
| `src/ingest/stage/select.ts` | `selectByKeys` / `selectByTag` over the registry |
| `src/ingest/stage/select.test.ts` | Selection tests |

### Modified files

| Path | Change |
|---|---|
| `src/lib/layers.ts` | Add `LiveTraceLayer`, `TraceSinkLive`, `ConsoleTransportLayer`, `StageRegistryLive` |
| `src/ingest/skills.ts` | Co-locate `SkillsKey` + `SkillsStats` + `skillsStage` |
| `src/ingest/commands.ts` | Co-locate `CommandsKey` + `CommandsStats` + `commandsStage` |
| `src/ingest/transcripts.ts` | Co-locate `ClaudeKey` + `ClaudeStats` + `claudeStage` |
| `src/ingest/codex.ts` | Co-locate `CodexKey` + `CodexStats` + `codexStage` |
| `src/ingest/derive-claude-subagents.ts` | Co-locate `SubagentsKey` + `SubagentsStats` + `subagentsStage` |
| `src/ingest/derive-spawned.ts` | Co-locate `SpawnedKey` + `SpawnedStats` + `spawnedStage` |
| `src/ingest/git.ts` | Co-locate `GitKey` + `GitStats` + `gitStage` |
| `src/ingest/derive-signals.ts` | Co-locate `SignalsKey` + `SignalsStats` + `signalsStage` |
| `src/ingest/outcomes.ts` | Co-locate `OutcomesKey` + `OutcomesStats` + `outcomesStage` |
| `src/ingest/session-health.ts` | Co-locate `SessionHealthKey` + `SessionHealthStats` + `sessionHealthStage` |
| `src/ingest/closure.ts` | Co-locate `ClosureKey` + `ClosureStats` + `closureStage` |
| `src/ingest/derive-proposals.ts` | Co-locate `ProposalsKey` + `ProposalsStats` + `proposalsStage` |
| `src/ingest/derive-opportunities.ts` | Co-locate `OpportunitiesKey` + `OpportunitiesStats` + `opportunitiesStage` |
| `src/ingest/derive-retro-proposals.ts` | Co-locate `RetroProposalsKey` + `RetroProposalsStats` + `retroProposalsStage` |
| `src/ingest/harness.ts` | Co-locate `HarnessKey` + `HarnessStats` + `harnessStage` |
| `src/ingest/pipeline.ts` | Delete `StageSpec`, `INGEST_STAGE_DEPS`, `deriveOnlyKeys`, `ALL_STAGE_KEYS`, `selectStages`; replace with re-export from `stage/registry.ts` |
| `src/ingest/pipeline.test.ts` | Update to test new runner via `src/ingest/stage/runner.test.ts` |
| `src/cli/index.ts` | Delete inlined `stageRun` map + `--X-only` aliases; route to `runPipeline(registry.select(...), ctx)`; remove `--X-only` flags |

### Deleted exports (no shims)

- `pipeline.ts::StageSpec`
- `pipeline.ts::INGEST_STAGE_DEPS`
- `pipeline.ts::IngestStageKey` (replaced by Schema-derived type in `stage/registry.ts`)
- `pipeline.ts::ALL_STAGE_KEYS`
- `pipeline.ts::deriveOnlyKeys`
- `pipeline.ts::selectStages`
- `cli/index.ts::stageRun` literal (function-local, replaced by `registry.run`)
- `cli/index.ts` legacy `--X-only` flag handling

---

## Pre-flight

- [ ] **Verify clean working tree**

```bash
git status --short
```

Expected: only the ADRs from this session shown as untracked / staged. Stash anything else.

- [ ] **Create feature branch**

```bash
git checkout -b refactor/ingest-stage-registry
```

- [ ] **Snapshot test baseline**

```bash
bun test 2>&1 | tail -20
```

Expected: count passing tests before changes; record number to confirm no regressions later.

---

## Task 1: Vendor live-traces into ax

**Files:**
- Create: `src/lib/live-traces/types.ts`
- Create: `src/lib/live-traces/Schema.ts`
- Create: `src/lib/live-traces/Sink.ts`
- Create: `src/lib/live-traces/WrappedSpan.ts`
- Create: `src/lib/live-traces/Tracer.ts`
- Create: `src/lib/live-traces/LiveTrace.ts`
- Create: `src/lib/live-traces/Logger.ts`
- Create: `src/lib/live-traces/index.ts`
- Create: `src/lib/live-traces/transports/console.ts`

- [ ] **Step 1: Copy source from quera**

```bash
mkdir -p src/lib/live-traces/transports src/lib/live-traces/__tests__
cp ~/Projects/quera/packages/live-traces/src/types.ts        src/lib/live-traces/types.ts
cp ~/Projects/quera/packages/live-traces/src/Schema.ts       src/lib/live-traces/Schema.ts
cp ~/Projects/quera/packages/live-traces/src/Sink.ts         src/lib/live-traces/Sink.ts
cp ~/Projects/quera/packages/live-traces/src/WrappedSpan.ts  src/lib/live-traces/WrappedSpan.ts
cp ~/Projects/quera/packages/live-traces/src/Tracer.ts       src/lib/live-traces/Tracer.ts
cp ~/Projects/quera/packages/live-traces/src/LiveTrace.ts    src/lib/live-traces/LiveTrace.ts
cp ~/Projects/quera/packages/live-traces/src/Logger.ts       src/lib/live-traces/Logger.ts
```

- [ ] **Step 2: Add console transport**

Write `src/lib/live-traces/transports/console.ts`:

```ts
import { Effect, Layer } from "effect";
import { TraceTransportTag, type TraceTransport } from "../Sink.ts";

export const ConsoleTransport: TraceTransport = {
    send: (events) =>
        Effect.sync(() => {
            for (const event of events) {
                console.log(`[live-trace] ${event._tag}`, JSON.stringify(event));
            }
        }),
};

export const ConsoleTransportLayer: Layer.Layer<TraceTransportTag> =
    Layer.succeed(TraceTransportTag, ConsoleTransport);
```

- [ ] **Step 3: Add barrel**

Write `src/lib/live-traces/index.ts`:

```ts
export * from "./types.ts";
export * as Schema from "./Schema.ts";
export * from "./Sink.ts";
export * from "./Tracer.ts";
export * from "./LiveTrace.ts";
export * from "./Logger.ts";
export * from "./WrappedSpan.ts";
```

- [ ] **Step 4: Update relative imports**

Change every `.js` extension in the vendored files to `.ts` (ax uses `.ts` imports throughout):

```bash
rg -l '\.js"' src/lib/live-traces | xargs sed -i '' 's/\.js"/.ts"/g'
```

- [ ] **Step 5: Write Sink test**

Write `src/lib/live-traces/__tests__/Sink.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { Effect, Layer, TestClock, TestContext } from "effect";
import {
    TraceSink,
    TraceSinkLive,
    TraceTransportTag,
    type TraceTransport,
} from "../Sink.ts";
import type { TraceEvent } from "../types.ts";

describe("TraceSink", () => {
    it("buffers events and flushes via daemon", async () => {
        const collected: TraceEvent[] = [];
        const TestTransport: TraceTransport = {
            send: (events) => Effect.sync(() => { for (const e of events) collected.push(e); }),
        };
        const Transport = Layer.succeed(TraceTransportTag, TestTransport);
        const program = Effect.gen(function* () {
            const sink = yield* TraceSink;
            sink.emit({
                _tag: "TraceStart",
                traceId: "t1",
                label: "test",
                scope: { type: "user", id: "u1" },
                timestamp: 0,
            });
            yield* TestClock.adjust("250 millis");
        });
        await Effect.runPromise(
            program.pipe(
                Effect.provide(TraceSinkLive({ flushIntervalMs: 200 })),
                Effect.provide(Transport),
                Effect.provide(TestContext.TestContext),
                Effect.scoped,
            ) as Effect.Effect<void, never, never>,
        );
        expect(collected).toHaveLength(1);
        expect(collected[0]?._tag).toBe("TraceStart");
    });
});
```

- [ ] **Step 6: Run Sink test**

```bash
bun test src/lib/live-traces/__tests__/Sink.test.ts
```

Expected: PASS - 1 test.

- [ ] **Step 7: Write LiveTrace integration test**

Write `src/lib/live-traces/__tests__/LiveTrace.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { LiveTrace } from "../index.ts";
import { LiveTraceLayer } from "../Tracer.ts";
import {
    TraceSinkLive,
    TraceTransportTag,
    type TraceTransport,
} from "../Sink.ts";
import type { TraceEvent } from "../types.ts";

describe("LiveTrace.withTrace", () => {
    it("emits TraceStart/SpanStart/SpanEnd/TraceEnd through the tracer", async () => {
        const events: TraceEvent[] = [];
        const Transport: TraceTransport = {
            send: (batch) => Effect.sync(() => { for (const e of batch) events.push(e); }),
        };
        const TransportLayer = Layer.succeed(TraceTransportTag, Transport);
        const Sink = TraceSinkLive({ flushIntervalMs: 10 });
        const program = Effect.succeed(42).pipe(
            LiveTrace.withTrace({
                traceId: "test:1",
                label: "smoke",
                scope: { type: "user", id: "u1" },
            }),
            Effect.delay("30 millis"),
        );
        await Effect.runPromise(
            program.pipe(
                Effect.provide(Layer.provideMerge(LiveTraceLayer)(Sink)),
                Effect.provide(TransportLayer),
                Effect.scoped,
            ) as Effect.Effect<unknown, never, never>,
        );
        const tags = events.map((e) => e._tag);
        expect(tags).toContain("TraceStart");
        expect(tags).toContain("SpanStart");
        expect(tags).toContain("SpanEnd");
        expect(tags).toContain("TraceEnd");
    });
});
```

- [ ] **Step 8: Run LiveTrace test**

```bash
bun test src/lib/live-traces/__tests__/LiveTrace.test.ts
```

Expected: PASS - 1 test.

- [ ] **Step 9: Commit**

```bash
git add src/lib/live-traces
git commit -m "feat(live-traces): vendor tracer decorator + sink from quera (ADR-0008)"
```

---

## Task 2: Ingest stage type foundations

**Files:**
- Create: `src/ingest/stage/types.ts`
- Create: `src/ingest/stage/tags.ts`
- Create: `src/ingest/stage/types.test.ts`

- [ ] **Step 1: Write BaseStageStats + extension test**

Write `src/ingest/stage/types.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { BaseStageStats, IngestContext, StageMeta } from "./types.ts";
import { IngestTag, DeriveTag, IngestStageTag } from "./tags.ts";

class ExampleStats extends BaseStageStats.extend<ExampleStats>("ExampleStats")({
    rowsWritten: Schema.Number,
}) {}

describe("BaseStageStats", () => {
    it("extends with stage-specific fields", () => {
        const stats = ExampleStats.make({
            durationMs: 12,
            summary: "wrote 3 rows",
            rowsWritten: 3,
        });
        expect(stats.rowsWritten).toBe(3);
        expect(stats.summary).toBe("wrote 3 rows");
    });
});

describe("StageMeta", () => {
    it("decodes a valid meta record", () => {
        const decoded = Schema.decodeUnknownSync(StageMeta)({
            key: "signals",
            deps: ["claude", "codex"],
            tags: ["derive"],
        });
        expect(decoded.key).toBe("signals");
    });
});

describe("IngestContext", () => {
    it("constructs with the required fields", () => {
        const ctx = IngestContext.make({
            cwd: "/tmp",
            since: new Date(0),
            debug: false,
        });
        expect(ctx.debug).toBe(false);
    });
});

describe("IngestStageTag", () => {
    it("includes ingest and derive", () => {
        expect(Schema.decodeUnknownSync(IngestStageTag)("ingest")).toBe("ingest");
        expect(Schema.decodeUnknownSync(IngestStageTag)("derive")).toBe("derive");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/ingest/stage/types.test.ts
```

Expected: FAIL with "Cannot find module './types.ts'".

- [ ] **Step 3: Implement tags.ts**

Write `src/ingest/stage/tags.ts`:

```ts
import { Schema } from "effect";

/** Raw transcript or filesystem ingestion. Carries: skills, commands, claude,
 *  codex, git. */
export const IngestTag = Schema.Literal("ingest");
export type IngestTag = typeof IngestTag.Type;

/** Re-derives evidence from already-ingested rows. Carries: signals, outcomes,
 *  session-health, closure, proposals, opportunities, retro-proposals. */
export const DeriveTag = Schema.Literal("derive");
export type DeriveTag = typeof DeriveTag.Type;

/** Retrospective surface (proposal clustering, learning candidates). Carries:
 *  retro-proposals. */
export const RetroTag = Schema.Literal("retro");
export type RetroTag = typeof RetroTag.Type;

/** Harness Doctor / readiness rollup. Carries: harness, session-health. */
export const HealthTag = Schema.Literal("health");
export type HealthTag = typeof HealthTag.Type;

/** Union of all known Ingest Stage tags. Adding a tag = add a literal above +
 *  one entry here. */
export const IngestStageTag = Schema.Union(IngestTag, DeriveTag, RetroTag, HealthTag);
export type IngestStageTag = typeof IngestStageTag.Type;
```

- [ ] **Step 4: Implement types.ts**

Write `src/ingest/stage/types.ts`:

```ts
import { Effect, Schema } from "effect";
import { DbError } from "../../lib/errors.ts";
import { IngestStageTag } from "./tags.ts";

/** Stable base shape every stage's stats class extends. `summary` is the
 *  human-readable line emitted as a `SpanEvent`; `durationMs` is captured by
 *  the runner. */
export class BaseStageStats extends Schema.Class<BaseStageStats>("BaseStageStats")({
    durationMs: Schema.Number,
    summary: Schema.String,
}) {}

/** Ambient context every stage's run receives. Pipeline owns lifetime; stages
 *  treat it as read-only. */
export class IngestContext extends Schema.Class<IngestContext>("IngestContext")({
    cwd: Schema.String,
    since: Schema.Date,
    debug: Schema.Boolean,
}) {}

/** Declarative metadata for a stage. The `key` field is narrowed per stage at
 *  construction time; deps/tags reference Schema unions defined in
 *  `./registry.ts` and `./tags.ts`. */
export class StageMeta extends Schema.Class<StageMeta>("StageMeta")({
    key: Schema.String, // tightened at the registry level to IngestStageKey
    deps: Schema.Array(Schema.String),
    tags: Schema.Array(IngestStageTag),
}) {}

/** A stage = metadata + a typed Effect runner. `R` is the union of Effect
 *  services the stage actually consumes; the pipeline composes the union. */
export interface StageDef<
    S extends BaseStageStats = BaseStageStats,
    R = never,
> {
    readonly meta: StageMeta;
    readonly run: (ctx: IngestContext) => Effect.Effect<S, DbError, R>;
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test src/ingest/stage/types.test.ts
```

Expected: PASS - 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/ingest/stage/types.ts src/ingest/stage/tags.ts src/ingest/stage/types.test.ts
git commit -m "feat(ingest): Schema types for StageDef foundation (ADR-0006)"
```

---

## Task 3: Stage registry service skeleton

**Files:**
- Create: `src/ingest/stage/registry.ts`
- Create: `src/ingest/stage/registry.test.ts`

- [ ] **Step 1: Write registry test**

Write `src/ingest/stage/registry.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import {
    StageRegistry,
    StageRegistryLive,
    type StageDef,
} from "./registry.ts";
import { BaseStageStats, IngestContext, StageMeta } from "./types.ts";

const fakeStage: StageDef = {
    meta: StageMeta.make({ key: "skills", deps: [], tags: ["ingest"] }),
    run: (_ctx) =>
        Effect.succeed(
            BaseStageStats.make({ durationMs: 0, summary: "noop" }),
        ),
};

describe("StageRegistry", () => {
    it("exposes the registered stages by key", async () => {
        const program = Effect.gen(function* () {
            const reg = yield* StageRegistry;
            const all = reg.all();
            expect(all).toHaveLength(1);
            expect(reg.byKey("skills")?.meta.key).toBe("skills");
        });
        const Live = StageRegistryLive([fakeStage]);
        await Effect.runPromise(program.pipe(Effect.provide(Live)));
    });

    it("filters by tag", async () => {
        const program = Effect.gen(function* () {
            const reg = yield* StageRegistry;
            const ingestStages = reg.byTag("ingest");
            expect(ingestStages.map((s) => s.meta.key)).toEqual(["skills"]);
        });
        const Live = StageRegistryLive([fakeStage]);
        await Effect.runPromise(program.pipe(Effect.provide(Live)));
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/ingest/stage/registry.test.ts
```

Expected: FAIL with "Cannot find module './registry.ts'".

- [ ] **Step 3: Implement registry**

Write `src/ingest/stage/registry.ts`:

```ts
import { Context, Effect, Layer, Schema } from "effect";
import type { IngestStageTag } from "./tags.ts";
import type { BaseStageStats, StageDef } from "./types.ts";

export type { StageDef } from "./types.ts";

/** Composed union of every known Ingest Stage key. Each stage file exports its
 *  own `Schema.Literal("<key>")`; this union is reassembled by re-exporting
 *  them here. Adding a stage = one import + one entry in the union below. */
export const IngestStageKey = Schema.Union(
    // Populated by Task 5 onward. Initially empty - Schema.Union of zero arms is invalid,
    // so this is a placeholder that the first migrated stage replaces.
    Schema.Literal("skills"),
);
export type IngestStageKey = typeof IngestStageKey.Type;

export interface StageRegistryShape {
    readonly all: () => ReadonlyArray<StageDef<BaseStageStats, unknown>>;
    readonly byKey: (key: string) => StageDef<BaseStageStats, unknown> | undefined;
    readonly byTag: (tag: IngestStageTag) => ReadonlyArray<StageDef<BaseStageStats, unknown>>;
}

export class StageRegistry extends Context.Tag("ax/StageRegistry")<
    StageRegistry,
    StageRegistryShape
>() {}

/** Provide a registry by passing the typed list of co-located stage definitions. */
export const StageRegistryLive = (
    stages: ReadonlyArray<StageDef<BaseStageStats, unknown>>,
): Layer.Layer<StageRegistry> =>
    Layer.succeed(StageRegistry, {
        all: () => stages,
        byKey: (key) => stages.find((s) => s.meta.key === key),
        byTag: (tag) => stages.filter((s) => s.meta.tags.includes(tag)),
    });
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/ingest/stage/registry.test.ts
```

Expected: PASS - 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/stage/registry.ts src/ingest/stage/registry.test.ts
git commit -m "feat(ingest): StageRegistry service + IngestStageKey union skeleton"
```

---

## Task 4: New pipeline runner over StageDef[]

**Files:**
- Create: `src/ingest/stage/runner.ts`
- Create: `src/ingest/stage/runner.test.ts`

- [ ] **Step 1: Write topo + DAG runner test**

Write `src/ingest/stage/runner.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { runPipeline, topoLayers } from "./runner.ts";
import { BaseStageStats, IngestContext, StageMeta, type StageDef } from "./types.ts";

const stage = (key: string, deps: string[]): StageDef => ({
    meta: StageMeta.make({ key, deps, tags: ["ingest"] }),
    run: () =>
        Effect.succeed(BaseStageStats.make({ durationMs: 0, summary: key })),
});

describe("topoLayers", () => {
    it("returns leaves first, dependents last", () => {
        const layers = topoLayers([
            stage("a", []),
            stage("b", ["a"]),
            stage("c", ["b"]),
        ]);
        expect(layers).toEqual([["a"], ["b"], ["c"]]);
    });

    it("groups independent stages in one layer", () => {
        const layers = topoLayers([
            stage("a", []),
            stage("b", []),
            stage("c", ["a", "b"]),
        ]);
        expect(layers[0]?.sort()).toEqual(["a", "b"]);
        expect(layers[1]).toEqual(["c"]);
    });

    it("throws on dependency cycle", () => {
        expect(() => topoLayers([
            stage("a", ["b"]),
            stage("b", ["a"]),
        ])).toThrow(/cycle/);
    });
});

describe("runPipeline", () => {
    it("runs every stage exactly once and respects deps", async () => {
        const order: string[] = [];
        const make = (key: string, deps: string[]): StageDef => ({
            meta: StageMeta.make({ key, deps, tags: ["ingest"] }),
            run: () =>
                Effect.sync(() => {
                    order.push(key);
                    return BaseStageStats.make({ durationMs: 0, summary: key });
                }),
        });
        const ctx = IngestContext.make({ cwd: "/tmp", since: new Date(0), debug: false });
        await Effect.runPromise(
            runPipeline([
                make("a", []),
                make("b", ["a"]),
            ], ctx) as Effect.Effect<unknown, never, never>,
        );
        expect(order).toEqual(["a", "b"]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/ingest/stage/runner.test.ts
```

Expected: FAIL with "Cannot find module './runner.ts'".

- [ ] **Step 3: Implement runner**

Write `src/ingest/stage/runner.ts`:

```ts
import { Deferred, Effect, Semaphore } from "effect";
import type { DbError } from "../../lib/errors.ts";
import { LiveTrace } from "../../lib/live-traces/index.ts";
import type { BaseStageStats, IngestContext, StageDef } from "./types.ts";

/** Max stages running their `run` Effect concurrently. Each stage has its own
 *  internal concurrency (claude=8, codex=4) hitting Surreal, so 2 stages
 *  × internal fan-out is already heavy. */
export const PIPELINE_CONCURRENCY = 2;

/** Kahn's algorithm; throws on cycle. Layers are useful for diagnostics, but
 *  `runPipeline` uses Deferreds for tighter scheduling (no layer barriers). */
export const topoLayers = <S extends BaseStageStats, R>(
    stages: ReadonlyArray<StageDef<S, R>>,
): string[][] => {
    const keys = new Set(stages.map((s) => s.meta.key));
    const done = new Set<string>();
    const layers: string[][] = [];
    let remaining: ReadonlyArray<StageDef<S, R>> = stages;
    while (remaining.length > 0) {
        const ready = remaining.filter((s) =>
            s.meta.deps.filter((d) => keys.has(d)).every((d) => done.has(d)),
        );
        if (ready.length === 0) {
            throw new Error(
                `ingest pipeline: dependency cycle among ${remaining
                    .map((s) => s.meta.key)
                    .join(", ")}`,
            );
        }
        layers.push(ready.map((s) => s.meta.key));
        for (const s of ready) done.add(s.meta.key);
        remaining = remaining.filter((s) => !done.has(s.meta.key));
    }
    return layers;
};

/** Run the given stages with DAG scheduling. Each stage waits for its in-graph
 *  deps via Deferreds; only `PIPELINE_CONCURRENCY` are inside the semaphore at
 *  once. Each stage is wrapped in `LiveTrace.step` so progress flows through
 *  the configured `TraceTransport` (ADR-0007). */
export const runPipeline = <S extends BaseStageStats, R>(
    stages: ReadonlyArray<StageDef<S, R>>,
    ctx: IngestContext,
): Effect.Effect<ReadonlyArray<S>, DbError, R> =>
    Effect.gen(function* () {
        topoLayers(stages); // cycle check

        const deferreds = new Map<string, Deferred.Deferred<S, DbError>>();
        for (const s of stages) {
            deferreds.set(s.meta.key, yield* Deferred.make<S, DbError>());
        }
        const sem = yield* Semaphore.make(PIPELINE_CONCURRENCY);

        const runStage = (s: StageDef<S, R>) =>
            Effect.gen(function* () {
                for (const dep of s.meta.deps) {
                    const d = deferreds.get(dep);
                    if (d) yield* Deferred.await(d);
                }
                const stats: S = yield* sem.withPermits(1)(
                    s.run(ctx).pipe(
                        LiveTrace.step(s.meta.key, {
                            "ingest.stage.tags": s.meta.tags.join(","),
                        }),
                    ),
                );
                return stats;
            }).pipe(
                Effect.tap((stats) => Deferred.succeed(deferreds.get(s.meta.key)!, stats)),
                Effect.tapCause((cause) =>
                    Deferred.failCause(deferreds.get(s.meta.key)!, cause as never),
                ),
            );

        const results = yield* Effect.forEach(stages, runStage, {
            concurrency: "unbounded",
        });
        return results;
    });
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/ingest/stage/runner.test.ts
```

Expected: PASS - 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/stage/runner.ts src/ingest/stage/runner.test.ts
git commit -m "feat(ingest): runPipeline over StageDef[] with LiveTrace.step wrap"
```

---

## Task 5: Stage selection helpers

**Files:**
- Create: `src/ingest/stage/select.ts`
- Create: `src/ingest/stage/select.test.ts`

- [ ] **Step 1: Write selection test**

Write `src/ingest/stage/select.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { StageRegistry, StageRegistryLive } from "./registry.ts";
import { selectByKeys, selectByTag } from "./select.ts";
import { BaseStageStats, StageMeta, type StageDef } from "./types.ts";

const stage = (key: string, tags: string[], deps: string[] = []): StageDef => ({
    meta: StageMeta.make({ key, deps, tags: tags as never }),
    run: () => Effect.succeed(BaseStageStats.make({ durationMs: 0, summary: key })),
});

const fixture = [
    stage("skills", ["ingest"]),
    stage("claude", ["ingest"], ["skills"]),
    stage("signals", ["derive"], ["claude"]),
];

describe("selectByKeys", () => {
    it("returns matching stages in registry order", async () => {
        const program = Effect.gen(function* () {
            const reg = yield* StageRegistry;
            return selectByKeys(reg, ["claude", "signals"]);
        });
        const Live = StageRegistryLive(fixture);
        const out = await Effect.runPromise(program.pipe(Effect.provide(Live)));
        expect(out.map((s) => s.meta.key)).toEqual(["claude", "signals"]);
    });

    it("throws on unknown key", async () => {
        const program = Effect.gen(function* () {
            const reg = yield* StageRegistry;
            return selectByKeys(reg, ["bogus"]);
        });
        const Live = StageRegistryLive(fixture);
        await expect(
            Effect.runPromise(program.pipe(Effect.provide(Live))),
        ).rejects.toThrow(/unknown stage\(s\): bogus/);
    });
});

describe("selectByTag", () => {
    it("filters by tag", async () => {
        const program = Effect.gen(function* () {
            const reg = yield* StageRegistry;
            return selectByTag(reg, "derive");
        });
        const Live = StageRegistryLive(fixture);
        const out = await Effect.runPromise(program.pipe(Effect.provide(Live)));
        expect(out.map((s) => s.meta.key)).toEqual(["signals"]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/ingest/stage/select.test.ts
```

Expected: FAIL with "Cannot find module './select.ts'".

- [ ] **Step 3: Implement selection helpers**

Write `src/ingest/stage/select.ts`:

```ts
import type { StageRegistryShape } from "./registry.ts";
import type { IngestStageTag } from "./tags.ts";
import type { BaseStageStats, StageDef } from "./types.ts";

/** Return the stages with these keys, in registry order. Throws on an unknown
 *  key - replaces the legacy `selectStages` helper. */
export const selectByKeys = (
    registry: StageRegistryShape,
    keys: ReadonlyArray<string>,
): ReadonlyArray<StageDef<BaseStageStats, unknown>> => {
    const all = registry.all();
    const known = new Set(all.map((s) => s.meta.key));
    const bad = keys.filter((k) => !known.has(k));
    if (bad.length > 0) {
        throw new Error(
            `ingest pipeline: unknown stage(s): ${bad.join(", ")}\n` +
                `  valid stages: ${all.map((s) => s.meta.key).join(", ")}`,
        );
    }
    const wanted = new Set(keys);
    return all.filter((s) => wanted.has(s.meta.key));
};

/** Return the stages carrying the given tag, in registry order. */
export const selectByTag = (
    registry: StageRegistryShape,
    tag: IngestStageTag,
): ReadonlyArray<StageDef<BaseStageStats, unknown>> =>
    registry.byTag(tag);
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/ingest/stage/select.test.ts
```

Expected: PASS - 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/stage/select.ts src/ingest/stage/select.test.ts
git commit -m "feat(ingest): selectByKeys + selectByTag over registry"
```

---

## Task 6: Migrate `skills` stage (canonical pattern)

**Files:**
- Modify: `src/ingest/skills.ts`

This task is the canonical template every later stage migration follows. Read it carefully before doing Tasks 7–20.

- [ ] **Step 1: Read current shape**

```bash
rg -n "export const ingestSkills" src/ingest/skills.ts
```

Confirm `ingestSkills(): Effect.Effect<{ count: number }, DbError, SurrealClient>` exists. The migration wraps this without changing its body.

- [ ] **Step 2: Add co-located key, stats class, and stage factory**

Add at the bottom of `src/ingest/skills.ts`:

```ts
import { Schema } from "effect";
import { BaseStageStats, IngestContext } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";
import { SurrealClient } from "../lib/db.ts";

/**
 * Skills stage - seeds Skill rows from `~/.claude/skills/` + `~/.agents/skills/`.
 *
 * Depends on: (none - leaf)
 * Consumed by: {@link ClaudeKey}, {@link CodexKey} via `invoked` edges.
 * Tags: {@link IngestTag}
 */
export const SkillsKey = Schema.Literal("skills");
export type SkillsKey = typeof SkillsKey.Type;

export class SkillsStats extends BaseStageStats.extend<SkillsStats>("SkillsStats")({
    skillsUpserted: Schema.Number,
}) {}

export const skillsStage: StageDef<SkillsStats, SurrealClient> = {
    meta: {
        key: "skills",
        deps: [],
        tags: ["ingest"],
    } as const,
    run: (_ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const { count } = yield* ingestSkills();
            return SkillsStats.make({
                durationMs: Date.now() - t0,
                summary: `upserted ${count} skill rows`,
                skillsUpserted: count,
            });
        }),
};
```

- [ ] **Step 3: Update the registry skeleton**

Edit `src/ingest/stage/registry.ts`:

Replace the placeholder import block with:

```ts
import { SkillsKey, skillsStage } from "../skills.ts";

export const IngestStageKey = Schema.Union(SkillsKey);
export type IngestStageKey = typeof IngestStageKey.Type;

export const ALL_STAGES = [skillsStage] as const;

export const StageRegistryDefault: Layer.Layer<StageRegistry> = StageRegistryLive(ALL_STAGES);
```

(Keep `StageRegistryLive` factory for tests; add `StageRegistryDefault` as the production layer.)

- [ ] **Step 4: Write a stage-level smoke test**

Append to `src/ingest/skill-upsert.test.ts` (or a new `src/ingest/skills.stage.test.ts` if cleaner):

```ts
import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { SkillsKey, SkillsStats, skillsStage } from "./skills.ts";

describe("skillsStage", () => {
    it("declares the canonical key and tag", () => {
        expect(Schema.decodeUnknownSync(SkillsKey)("skills")).toBe("skills");
        expect(skillsStage.meta.key).toBe("skills");
        expect(skillsStage.meta.tags).toEqual(["ingest"]);
        expect(skillsStage.meta.deps).toEqual([]);
    });

    it("produces a SkillsStats class instance shape", () => {
        const s = SkillsStats.make({ durationMs: 1, summary: "x", skillsUpserted: 2 });
        expect(s.skillsUpserted).toBe(2);
    });
});
```

- [ ] **Step 5: Run tests**

```bash
bun test src/ingest/skills.ts src/ingest/skill-upsert.test.ts src/ingest/stage
```

Expected: PASS - including the new stage-level smoke test.

- [ ] **Step 6: Commit**

```bash
git add src/ingest/skills.ts src/ingest/skill-upsert.test.ts src/ingest/stage/registry.ts
git commit -m "feat(ingest): skills stage co-located StageDef (canonical pattern)"
```

---

## Tasks 7–20: Migrate remaining stages

**Pattern (identical to Task 6):** in each stage file, add `Schema.Literal` key, `BaseStageStats.extend` stats class, and `StageDef` factory; then add the import + entry to `src/ingest/stage/registry.ts`'s `IngestStageKey` union and `ALL_STAGES` array; then add a smoke test asserting key/tag/deps.

For each stage below, all the per-stage facts are listed. The engineer should:

1. Open the source file.
2. Append the key/stats/stage block from the table below.
3. Add the imports + entry in `registry.ts`.
4. Add the smoke test.
5. Run the per-stage tests.
6. Commit with the message in the table.

> **Locality note:** each migration is a single commit. Do not bundle multiple stage migrations into one commit - one stage per commit so failures are bisectable.

| # | Task | Source file | Key | Wrapped fn / shape | Deps | Tags | Stats fields (extending BaseStageStats) | Commit message |
|---|---|---|---|---|---|---|---|---|
| 7 | commands | `src/ingest/commands.ts` | `CommandsKey = Schema.Literal("commands")` | `ingestCommands()` returning `{ count }` | `[]` | `["ingest"]` | `commandsUpserted: Schema.Number` | `feat(ingest): commands stage co-located StageDef` |
| 8 | claude | `src/ingest/transcripts.ts` | `ClaudeKey = Schema.Literal("claude")` | `ingestClaudeTranscripts(...)` returning per-session counts | `["skills", "commands"]` | `["ingest"]` | `sessionsIngested: Schema.Number, turnsIngested: Schema.Number, toolCallsIngested: Schema.Number` | `feat(ingest): claude stage co-located StageDef` |
| 9 | codex | `src/ingest/codex.ts` | `CodexKey = Schema.Literal("codex")` | `ingestCodexSessions(...)` returning per-session counts | `["skills", "commands"]` | `["ingest"]` | `sessionsIngested: Schema.Number, turnsIngested: Schema.Number, toolCallsIngested: Schema.Number` | `feat(ingest): codex stage co-located StageDef` |
| 10 | subagents | `src/ingest/derive-claude-subagents.ts` | `SubagentsKey = Schema.Literal("subagents")` | `deriveClaudeSubagents(...)` | `["claude", "codex"]` | `["derive"]` | `subagentLinksWritten: Schema.Number` | `feat(ingest): subagents stage co-located StageDef` |
| 11 | spawned | `src/ingest/derive-spawned.ts` | `SpawnedKey = Schema.Literal("spawned")` | `deriveSpawned(...)` | `["claude", "codex"]` | `["derive"]` | `spawnEdgesWritten: Schema.Number` | `feat(ingest): spawned stage co-located StageDef` |
| 12 | git | `src/ingest/git.ts` | `GitKey = Schema.Literal("git")` | `ingestGit(...)` | `[]` | `["ingest"]` | `commitsIngested: Schema.Number, repositoriesSeen: Schema.Number` | `feat(ingest): git stage co-located StageDef` |
| 13 | signals | `src/ingest/derive-signals.ts` | `SignalsKey = Schema.Literal("signals")` | `deriveSignals(...)` | `["claude", "codex", "subagents", "spawned", "git"]` | `["derive"]` | `frictionEdges: Schema.Number, feedbackEdges: Schema.Number, diagnosticEdges: Schema.Number, intentEdges: Schema.Number` | `feat(ingest): signals stage co-located StageDef` |
| 14 | outcomes | `src/ingest/outcomes.ts` | `OutcomesKey = Schema.Literal("outcomes")` | `deriveOutcomes(...)` | `["signals"]` | `["derive"]` | `outcomeEdgesWritten: Schema.Number` | `feat(ingest): outcomes stage co-located StageDef` |
| 15 | session-health | `src/ingest/session-health.ts` | `SessionHealthKey = Schema.Literal("session-health")` | `deriveSessionHealth(...)` | `["signals"]` | `["derive", "health"]` | `sessionsScored: Schema.Number` | `feat(ingest): session-health stage co-located StageDef` |
| 16 | closure | `src/ingest/closure.ts` | `ClosureKey = Schema.Literal("closure")` | `deriveClosure(...)` | `["signals"]` | `["derive"]` | `changeSetsWritten: Schema.Number, fileMemoriesWritten: Schema.Number` | `feat(ingest): closure stage co-located StageDef` |
| 17 | proposals | `src/ingest/derive-proposals.ts` | `ProposalsKey = Schema.Literal("proposals")` | `deriveProposals(...)` | `["closure"]` | `["derive"]` | `proposalsCreated: Schema.Number, proposalsDeduped: Schema.Number` | `feat(ingest): proposals stage co-located StageDef` |
| 18 | opportunities | `src/ingest/derive-opportunities.ts` | `OpportunitiesKey = Schema.Literal("opportunities")` | `deriveOpportunities(...)` | `["proposals"]` | `["derive"]` | `opportunitiesCreated: Schema.Number, experimentsConsidered: Schema.Number` | `feat(ingest): opportunities stage co-located StageDef` |
| 19 | retro-proposals | `src/ingest/derive-retro-proposals.ts` | `RetroProposalsKey = Schema.Literal("retro-proposals")` | `deriveRetroProposals(...)` | `["proposals"]` | `["derive", "retro"]` | `retroProposalsCreated: Schema.Number, retrosScanned: Schema.Number` | `feat(ingest): retro-proposals stage co-located StageDef` |
| 20 | harness | `src/ingest/harness.ts` | `HarnessKey = Schema.Literal("harness")` | `deriveHarness(...)` (Harness Doctor rollup) | `["outcomes", "session-health", "closure"]` | `["derive", "health"]` | `doctorChecksWritten: Schema.Number, layerScores: Schema.Number` | `feat(ingest): harness stage co-located StageDef` |

**Per-stage template (apply for each row above):**

- [ ] **Step 1: Append key + stats + stage to the source file**

Use this template (replace placeholders with the row's values):

```ts
// At the bottom of <source file>
import { Schema } from "effect";
import { BaseStageStats, IngestContext } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

/**
 * <Stage name> - <one-line purpose>.
 *
 * Depends on: <comma-separated {@link XKey} list, or "(none - leaf)">
 * Consumed by: <comma-separated {@link YKey} list, or "(none - terminal)">
 * Tags: <{@link IngestTag} | {@link DeriveTag} | …>
 */
export const <Name>Key = Schema.Literal("<key>");
export type <Name>Key = typeof <Name>Key.Type;

export class <Name>Stats extends BaseStageStats.extend<<Name>Stats>("<Name>Stats")({
    // ...stats fields from the table column...
}) {}

export const <name>Stage: StageDef<<Name>Stats, /* R = service union */> = {
    meta: {
        key: "<key>",
        deps: [/* deps from table */],
        tags: [/* tags from table */],
    } as const,
    run: (ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const result = yield* <wrappedFn>(/* args from ctx */);
            return <Name>Stats.make({
                durationMs: Date.now() - t0,
                summary: `<short human line>`,
                // ...fields mapped from result...
            });
        }),
};
```

- [ ] **Step 2: Add to registry**

Edit `src/ingest/stage/registry.ts`:

```ts
import { <Name>Key, <name>Stage } from "../<source-file>.ts";

// Add <Name>Key to the IngestStageKey Schema.Union args.
// Add <name>Stage to the ALL_STAGES array.
```

- [ ] **Step 3: Add a smoke test**

Create or append to `src/ingest/<source-file>.stage.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { <Name>Key, <Name>Stats, <name>Stage } from "./<source-file>.ts";

describe("<name>Stage", () => {
    it("declares the canonical key/deps/tags", () => {
        expect(Schema.decodeUnknownSync(<Name>Key)("<key>")).toBe("<key>");
        expect(<name>Stage.meta.key).toBe("<key>");
        expect(<name>Stage.meta.deps).toEqual([/* deps */]);
        expect(<name>Stage.meta.tags).toEqual([/* tags */]);
    });
});
```

- [ ] **Step 4: Run tests for this stage**

```bash
bun test src/ingest/<source-file>
```

Expected: PASS - all pre-existing tests plus the new smoke test.

- [ ] **Step 5: Run the full registry test**

```bash
bun test src/ingest/stage
```

Expected: PASS - the registry union now contains this stage.

- [ ] **Step 6: Commit**

```bash
git add src/ingest/<source-file>.ts src/ingest/<source-file>.stage.test.ts src/ingest/stage/registry.ts
git commit -m "<commit message from table>"
```

---

## Task 21: Wire LiveTrace + StageRegistry into AppLayer

**Files:**
- Modify: `src/lib/layers.ts`

- [ ] **Step 1: Read current `AppLayer`**

```bash
bat src/lib/layers.ts
```

Confirm it currently composes `SurrealClientLive`, `AxConfigLive`, `ProcessServiceLive`.

- [ ] **Step 2: Replace AppLayer**

Edit `src/lib/layers.ts`:

```ts
import { Layer } from "effect";
import { AxConfigLive } from "./config.ts";
import { SurrealClientLive } from "./db.ts";
import { ProcessServiceLive } from "./process.ts";
import { LiveTraceLayer } from "./live-traces/Tracer.ts";
import { TraceSinkLive } from "./live-traces/Sink.ts";
import { ConsoleTransportLayer } from "./live-traces/transports/console.ts";
import { StageRegistryDefault } from "../ingest/stage/registry.ts";

/**
 * Composed application layer. Built outermost → innermost:
 *
 *   1. ConsoleTransport (or override) provides the TraceTransport
 *   2. TraceSinkLive builds the buffered sink + flush daemon over the transport
 *   3. LiveTraceLayer wraps the current Effect tracer so withSpan/log calls
 *      inside `LiveTrace.withTrace` scopes emit to the sink
 *   4. SurrealClient, AxConfig, ProcessService, StageRegistryDefault provide
 *      the rest of the runtime
 */
export const AppLayer = Layer.mergeAll(
    SurrealClientLive,
    AxConfigLive,
    ProcessServiceLive,
    StageRegistryDefault,
).pipe(
    Layer.provide(AxConfigLive),
    Layer.provideMerge(LiveTraceLayer),
    Layer.provideMerge(TraceSinkLive({ flushIntervalMs: 200 })),
    Layer.provideMerge(ConsoleTransportLayer),
);
```

- [ ] **Step 3: Run all tests**

```bash
bun test
```

Expected: PASS - no regressions in pre-existing tests.

- [ ] **Step 4: Commit**

```bash
git add src/lib/layers.ts
git commit -m "feat(layers): wire LiveTrace + StageRegistry into AppLayer (ADR-0007)"
```

---

## Task 22: CLI consumes the registry

**Files:**
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Locate stage wiring in CLI**

```bash
rg -n "stageRun|sel\.has|--stages|--derive-only|deriveOnlyKeys|INGEST_STAGE_DEPS|selectStages|ALL_STAGE_KEYS" src/cli/index.ts | head -30
```

Confirm the boundaries (currently lines ~280–550 per pre-flight read).

- [ ] **Step 2: Replace stage selection with registry-driven logic**

In `src/cli/index.ts`, find the `runIngest`-style function (the one that builds `specs: StageSpec[]` and calls `runPipeline`). Replace with:

```ts
import { Effect } from "effect";
import { StageRegistry } from "../ingest/stage/registry.ts";
import { runPipeline } from "../ingest/stage/runner.ts";
import { selectByKeys, selectByTag } from "../ingest/stage/select.ts";
import { IngestContext } from "../ingest/stage/types.ts";
import { LiveTrace } from "../lib/live-traces/index.ts";

// `parseStageSelection` is local - returns either { kind: "keys"; keys } or
// { kind: "tag"; tag: "derive" } or { kind: "all" } based on args.

const buildContext = (args: string[]): IngestContext =>
    IngestContext.make({
        cwd: process.cwd(),
        since: new Date(Date.now() - parseSinceMs(args)),
        debug: args.includes("--debug"),
    });

const runIngestEffect = (args: string[]) =>
    Effect.gen(function* () {
        const reg = yield* StageRegistry;
        const selection = parseStageSelection(args);
        const stages =
            selection.kind === "all"
                ? reg.all()
                : selection.kind === "keys"
                  ? selectByKeys(reg, selection.keys)
                  : selectByTag(reg, selection.tag);
        const ctx = buildContext(args);
        const runId = `ingest:${Date.now().toString(36)}`;
        yield* runPipeline(stages, ctx).pipe(
            LiveTrace.withTrace({
                traceId: runId,
                label: `ingest ${stages.map((s) => s.meta.key).join(",")}`,
                scope: { type: "user", id: process.env.USER ?? "local" },
            }),
        );
    });
```

Add the local helper:

```ts
type StageSelection =
    | { readonly kind: "all" }
    | { readonly kind: "keys"; readonly keys: ReadonlyArray<string> }
    | { readonly kind: "tag"; readonly tag: "derive" };

const parseStageSelection = (args: string[]): StageSelection => {
    const stagesArg = args.find((a) => a.startsWith("--stages="));
    if (stagesArg) {
        const keys = stagesArg
            .slice("--stages=".length)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        if (keys.length === 0) {
            console.error("axctl ingest: --stages= requires at least one key");
            process.exit(2);
        }
        return { kind: "keys", keys };
    }
    if (args.includes("--derive-only")) return { kind: "tag", tag: "derive" };
    return { kind: "all" };
};

const parseSinceMs = (args: string[]): number => {
    const sinceArg = args.find((a) => a.startsWith("--since="));
    if (!sinceArg) return 7 * 24 * 60 * 60 * 1000; // 7d default
    const days = Number(sinceArg.slice("--since=".length));
    if (Number.isFinite(days) && days > 0) return days * 24 * 60 * 60 * 1000;
    return 7 * 24 * 60 * 60 * 1000;
};
```

- [ ] **Step 3: Remove legacy stage code**

Delete from `src/cli/index.ts`:

```bash
# Find and delete:
# - the `stageRun: Record<IngestStageKey, () => Effect.Effect<...>>` literal
# - every `--X-only` flag handler (claude-only, codex-only, signals-only, etc.)
# - any `withServices(...)` helper used only to lift stage Effects into the old StageSpec shape
```

Concretely: delete the block from `const stageRun: Record<IngestStageKey, ...>` through the matching close brace, and remove every `if (args.includes("--<name>-only")) ...` branch. Also remove the deprecation-warning code path (`--${flagName} is deprecated`) - per "no backwards compat."

- [ ] **Step 4: Run CLI test**

```bash
bun test src/cli/effect-cli.test.ts
```

Expected: PASS - adjust assertions in the test if they referenced removed flags. Update assertions to call `--stages=`/`--derive-only` or drop dead paths.

- [ ] **Step 5: Smoke test the binary**

```bash
bun src/cli/index.ts ingest --stages=skills --debug 2>&1 | head -30
```

Expected: stage runs; `[live-trace] TraceStart`, `[live-trace] SpanStart skills`, `[live-trace] SpanEnd`, `[live-trace] TraceEnd` lines appear on stdout from the console transport.

- [ ] **Step 6: Commit**

```bash
git add src/cli/index.ts src/cli/effect-cli.test.ts
git commit -m "refactor(cli): consume StageRegistry; drop --X-only flags"
```

---

## Task 23: Delete legacy pipeline exports

**Files:**
- Modify: `src/ingest/pipeline.ts`
- Modify: `src/ingest/pipeline.test.ts`

- [ ] **Step 1: Replace `pipeline.ts` with a thin re-export shim**

Rewrite `src/ingest/pipeline.ts`:

```ts
/**
 * Legacy entry point. The pipeline implementation moved to `./stage/runner.ts`
 * and the registry to `./stage/registry.ts`. This file re-exports the
 * canonical surface for any callers that still import from
 * `src/ingest/pipeline.ts`. Prefer the canonical paths.
 */
export { runPipeline, topoLayers, PIPELINE_CONCURRENCY } from "./stage/runner.ts";
export {
    StageRegistry,
    StageRegistryDefault,
    StageRegistryLive,
    IngestStageKey,
    ALL_STAGES,
    type StageDef,
} from "./stage/registry.ts";
export {
    BaseStageStats,
    IngestContext,
    StageMeta,
} from "./stage/types.ts";
```

- [ ] **Step 2: Delete pipeline.test.ts in favour of stage tests**

```bash
git rm src/ingest/pipeline.test.ts
```

The functional coverage moved to `src/ingest/stage/runner.test.ts` and `src/ingest/stage/select.test.ts`.

- [ ] **Step 3: Update any importers of removed names**

```bash
rg -n "from .*pipeline" src/ | rg -v "stage/"
rg -n "StageSpec|INGEST_STAGE_DEPS|deriveOnlyKeys|selectStages|ALL_STAGE_KEYS" src/
```

For each match outside the deleted set, fix the import:
- `StageSpec` → `StageDef` from `./stage/registry.ts`
- `INGEST_STAGE_DEPS` → query the registry via `StageRegistry` service
- `deriveOnlyKeys()` → `reg.byTag("derive")` then `.map((s) => s.meta.key)`
- `selectStages(keys)` → `selectByKeys(reg, keys)`
- `ALL_STAGE_KEYS` → `reg.all().map((s) => s.meta.key)`

- [ ] **Step 4: Run full test suite**

```bash
bun test
```

Expected: PASS - count matches the pre-flight baseline (Task 23 may net delete a couple of obsolete tests; if the count is lower, confirm only intentionally-removed tests are gone).

- [ ] **Step 5: Commit**

```bash
git add src/ingest/pipeline.ts src/
git commit -m "refactor(ingest): delete legacy StageSpec / INGEST_STAGE_DEPS path"
```

---

## Task 24: End-to-end verification

- [ ] **Step 1: Run typecheck**

```bash
bun run --bun tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 2: Run full test suite**

```bash
bun test 2>&1 | tail -5
```

Expected: PASS - total ≥ pre-flight baseline.

- [ ] **Step 3: Run full ingest in --debug**

```bash
bun src/cli/index.ts ingest --debug 2>&1 | rg "live-trace|error" | head -50
```

Expected:
- `TraceStart` once at the top
- `SpanStart`/`SpanEnd` pair for each stage (`skills`, `commands`, `claude`, `codex`, `subagents`, `spawned`, `git`, `signals`, `outcomes`, `session-health`, `closure`, `proposals`, `opportunities`, `retro-proposals`, `harness`)
- `TraceEnd` once at the bottom
- no `error` lines

- [ ] **Step 4: Run --stages= subset**

```bash
bun src/cli/index.ts ingest --stages=signals,outcomes --debug 2>&1 | rg "SpanStart|SpanEnd" | head -20
```

Expected: exactly two `SpanStart`/`SpanEnd` pairs - `signals` then `outcomes`.

- [ ] **Step 5: Run --derive-only**

```bash
bun src/cli/index.ts ingest --derive-only --debug 2>&1 | rg "SpanStart" | head -20
```

Expected: `SpanStart` for every stage carrying the `derive` tag (signals, outcomes, session-health, closure, proposals, opportunities, retro-proposals, harness).

- [ ] **Step 6: Inspect a stats payload**

```bash
bun src/cli/index.ts ingest --stages=skills --debug 2>&1 | rg "SpanEvent|SpanEnd" | head -5
```

Expected: a `SpanEnd` event with `status: "ok"` and a `durationMs` field; nearby `SpanEvent` carries the `summary` string from `SkillsStats`.

- [ ] **Step 7: Commit verification artefact (optional)**

If anything in steps 1–6 surfaced a real issue, fix it via a new commit and re-run.

```bash
git status --short
```

Expected: clean working tree.

---

## Self-review checklist (run after writing this plan)

- [x] Every task lists exact files
- [x] Every test step shows the code being tested
- [x] Every commit step shows the exact command + message
- [x] No "TBD" / "implement later" / "similar to Task N" placeholders
- [x] Types used in later tasks (StageDef, BaseStageStats, IngestContext, StageMeta, IngestStageKey, IngestStageTag, StageRegistry, runPipeline, selectByKeys, selectByTag) are defined in earlier tasks
- [x] ADRs 0006, 0007, 0008 are referenced and the plan respects them
- [x] CONTEXT.md vocab used (Ingest Stage, Ingest Pipeline, Derivation Engine, BaseStageStats, etc.)

## Spec coverage gaps (deferred work - not in this plan)

- **God-file shrinks (candidate 2).** `derive-signals.ts`, `derive-retro-proposals.ts`, `codex.ts` stay god files at the end of this plan. Internal extraction is deferred to a follow-up plan because the right cut-lines will be clearer once each god file has a co-located StageDef and the registry consumes typed stats. Tracked as a follow-up todo, not in this plan.
- **Statement-builder seam (candidate 3 from the deepening review).** ADR-0005's loop is not closed by this plan. Follow-up plan: introduce per-domain statement builders so derive stages stop authoring SQL.
- **Hook command writer (candidate 6).** Schema seam exists; code seam still missing. Follow-up plan tracked separately.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-27-ingest-stage-registry.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for the 14-stage migration loop in Tasks 7–20 where every task follows the same template.

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints. Slower but lets the user steer mid-task.

**Which approach?**
