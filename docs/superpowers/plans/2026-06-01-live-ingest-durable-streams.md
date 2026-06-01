# Live Ingest over Durable Streams - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Land everything in a single PR.** Every commit must leave `bun run typecheck` clean and the existing test suite green.

**Goal:** Let `ax serve` *host* ingest - trigger the existing ingest pipeline as an in-process workflow from the server/UI, publish per-stage progress to a per-run Durable Stream, and add a live dashboard view that subscribes (catch-up history + live deltas, resumable across refresh/reconnect) so a new user can literally watch their graph fill up. The CLI `ax ingest` and its terminal animation keep working unchanged.

**Architecture:** The ingest pipeline (`runIngest`, an Effect program) becomes a reusable core that BOTH the CLI and the server call. `ax serve` (a `Bun.serve` process) gains: (1) an in-process **ingest workflow runner** that runs `runIngest` with a server-provided layer, (2) an **`IngestStreamBus`** seam - a tiny interface for publishing per-run progress events - backed by **Durable Streams** (ElectricSQL; offset-resumable HTTP streaming), and (3) a **live ingest view** in the dashboard SPA that uses `@durable-streams/client` to subscribe to `ingest:<runId>`. The `IngestStreamBus` seam means the local backing (Durable Streams embedded in the Bun process) can later be swapped for a hosted/Durable-Objects backend without touching the producer or the UI.

**Tech Stack:** Bun ≥ 1.3, TypeScript (strict), Effect 4.0.0-beta.x, SurrealDB 3.x, `@durable-streams/server` + `@durable-streams/client` + `@durable-streams/cli`, React 19 + TanStack Router/Query (dashboard SPA under `apps/axctl/src/dashboard/web`).

**Reference docs (read before coding the binding):** ElectricSQL Durable Streams announcement (https://electric-sql.com/blog/2025/12/09/announcing-durable-streams), the protocol/State-Protocol post (https://electric-sql.com/blog/2025/12/23/durable-streams-0.1.0), and the package repos at https://github.com/durable-streams/durable-streams (`packages/server`, `packages/client`). The protocol is HTTP long-poll/SSE with client-tracked **offsets**; do not guess the API - Task 0 pins it.

---

## Existing infrastructure (do NOT rebuild)

- `apps/axctl/src/ingest/run.ts` - `runIngest(opts: RunIngestOptions): Effect<RunIngestResult, DbError, SurrealClient | AxConfig | ProcessService | StageRegistry | TraceSink>`. Already the callable pipeline; the CLI runs it via `withIngest` in `apps/axctl/src/cli/index.ts`. Stages run inside `LiveTrace.step(stageKey)` (see `apps/axctl/src/ingest/stage/runner.ts`).
- `apps/axctl/src/dashboard/telemetry.ts` - `publishIngestEvent` UPSERTs the durable `ingest_event` table (schema: `packages/schema/src/schema.surql:977`) **and** fans out to in-process subscribers (`addIngestEventSubscriber`/`removeIngestEventSubscriber`). `makeIngestEvent`, `buildIngestRunStartStatement`, `buildIngestStageStartStatement`, etc. already exist.
- `apps/axctl/src/dashboard/server.ts` - `Bun.serve({ port, fetch })`; `formatSseEvent(event, data)`; the `/api/events` SSE route (≈ line 409) already sends a `ready` frame, replays existing `ingest_event` rows (catch-up), then streams live `ingest_event` frames via the in-process subscriber.
- `apps/axctl/src/dashboard/web/src/use-ingest-events.ts` - the SPA already opens `new EventSource("/api/events")`, listens for `ingest_event`, and invalidates React Query keys.
- `apps/axctl/src/cli/ingest-trace-progress.ts` - the CLI terminal animation transport (keep working; this plan must not regress it).

**The gap this plan fills:** today the live half of `/api/events` only fires for events produced *inside the serve process*; CLI ingest (a separate process) is only seen via table catch-up on (re)connect. And raw SSE has no resume/replay guarantee. This plan makes ingest runnable *inside* serve and routes its progress through a resumable Durable Stream.

---

## File Structure (after)

```
apps/axctl/src/
├── ingest/
│   ├── run.ts                         # unchanged core (runIngest)
│   └── stream-events.ts               # NEW: IngestStreamEvent type + mapper from live-trace spans / ingest_event
├── dashboard/
│   ├── server.ts                      # MODIFY: mount stream routes + POST /api/ingest
│   ├── telemetry.ts                   # unchanged (still writes ingest_event)
│   ├── ingest-stream.ts               # NEW: IngestStreamBus interface + helpers
│   ├── ingest-stream-durable.ts       # NEW: Durable Streams binding of IngestStreamBus (server side)
│   ├── ingest-workflow.ts             # NEW: server-side runner - runIngest in-process + publish to the bus
│   └── web/src/
│       ├── use-ingest-stream.ts       # NEW: @durable-streams/client hook (catch-up + live + resume)
│       └── routes/ingest-live.tsx     # NEW: "watch it fill" live view
└── cli/
    ├── index.ts                       # unchanged ingest path; CLI animation intact
    └── ingest-trace-progress.ts       # unchanged
```

---

## Task 0: Pin the Durable Streams API (research spike, no product code)

**Goal:** Produce concrete, verified API notes so later tasks aren't guessing. Decide embed-vs-sidecar.

**Files:**
- Create: `docs/superpowers/research/durable-streams-api.md`

- [ ] **Step 1: Install the packages as a spike**

Run:
```bash
cd /Users/necmttn/Projects/ax/apps/axctl
bun add @durable-streams/client @durable-streams/server
```
Expected: both resolve; `bun.lock` updates. (If the package names differ from the README, find the real names via `bun pm view @durable-streams/client` and the repo `packages/*/package.json`; record the exact names.)

- [ ] **Step 2: Read the real source/types**

Read `node_modules/@durable-streams/server/**` and `node_modules/@durable-streams/client/**` `.d.ts` files. Capture, verbatim, in `docs/superpowers/research/durable-streams-api.md`:
- The **server** API: how to create a server / request handler, how to **append/publish** an event to a named stream, and whether it can be mounted into an existing HTTP server (e.g. given a `Request`, return a `Response`) - this determines embed-in-`Bun.serve` vs run-a-sidecar.
- The **client** API: construct a client, **subscribe** to a stream name, the shape of catch-up vs live messages, and how **offset/resume** is exposed.
- The on-the-wire endpoints (paths, methods) if the server is a plain HTTP handler.

- [ ] **Step 3: Decide and record the integration mode**

In the same doc, pick ONE and justify in 2-3 sentences:
- **(A) Embed** - mount the Durable Streams server as a request handler inside `Bun.serve` (preferred: keeps ax single-process, "just bun + surreal"). Only viable if the server exposes a `(Request) => Response`/Node-handler we can adapt.
- **(B) Sidecar** - spawn `@durable-streams/server` on a second localhost port from within `cmdServe`. Fallback if (A) isn't supported.

- [ ] **Step 4: Commit the research**

```bash
git add docs/superpowers/research/durable-streams-api.md apps/axctl/package.json bun.lock
git commit -m "research(stream): pin Durable Streams server/client API + integration mode"
```

**Everything below references `docs/superpowers/research/durable-streams-api.md` for exact calls. Where this plan writes `bus.publish(...)` / `client.subscribe(...)`, use the verified signatures from Task 0.**

---

## Task 1: `IngestStreamEvent` - the progress payload

**Goal:** One typed event shape for "a stage started / finished / the run finished", derived from the data ingest already produces.

**Files:**
- Create: `apps/axctl/src/ingest/stream-events.ts`
- Test: `apps/axctl/src/ingest/stream-events.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/axctl/src/ingest/stream-events.test.ts
import { describe, expect, test } from "bun:test";
import { ingestStreamEventFromTrace, type IngestStreamEvent } from "./stream-events.ts";

describe("ingest stream events", () => {
    test("maps a SpanStart to a stage-started event", () => {
        const ev = ingestStreamEventFromTrace(
            { _tag: "SpanStart", traceId: "ingest:run123", spanId: "s1", name: "skills" } as never,
            { spanNames: new Map() },
        );
        expect(ev).toEqual({ kind: "stage_started", runId: "run123", stage: "skills" } as IngestStreamEvent);
    });

    test("maps a SpanEnd (ok) to a stage-finished event with status", () => {
        const names = new Map([["s1", "skills"]]);
        const ev = ingestStreamEventFromTrace(
            { _tag: "SpanEnd", traceId: "ingest:run123", spanId: "s1", status: "ok", durationMs: 12 } as never,
            { spanNames: names },
        );
        expect(ev).toEqual({ kind: "stage_finished", runId: "run123", stage: "skills", status: "ok", durationMs: 12 });
    });

    test("maps TraceEnd to run_finished", () => {
        const ev = ingestStreamEventFromTrace(
            { _tag: "TraceEnd", traceId: "ingest:run123", status: "completed", durationMs: 99 } as never,
            { spanNames: new Map() },
        );
        expect(ev).toEqual({ kind: "run_finished", runId: "run123", status: "completed", durationMs: 99 });
    });

    test("returns null for unrelated events", () => {
        expect(ingestStreamEventFromTrace({ _tag: "SpanEvent", traceId: "ingest:x", spanId: "s", name: "n" } as never, { spanNames: new Map() })).toBeNull();
    });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `bun test apps/axctl/src/ingest/stream-events.test.ts` (if a hook blocks `bun test`, use the project's bun:test wrapper - see CLAUDE.md / memory). Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// apps/axctl/src/ingest/stream-events.ts
import type { TraceEvent } from "@ax/lib/live-traces/types";

export type IngestStreamEvent =
    | { readonly kind: "run_started"; readonly runId: string; readonly label: string }
    | { readonly kind: "stage_started"; readonly runId: string; readonly stage: string }
    | { readonly kind: "stage_finished"; readonly runId: string; readonly stage: string; readonly status: "ok" | "error"; readonly durationMs: number }
    | { readonly kind: "run_finished"; readonly runId: string; readonly status: "completed" | "failed"; readonly durationMs: number };

const runIdOf = (traceId: string): string => traceId.replace(/^ingest:/, "");

/** Translate a live-trace event into a coarse ingest progress event, or null. */
export function ingestStreamEventFromTrace(
    event: TraceEvent,
    ctx: { readonly spanNames: Map<string, string> },
): IngestStreamEvent | null {
    switch (event._tag) {
        case "TraceStart":
            return { kind: "run_started", runId: runIdOf(event.traceId), label: event.label };
        case "SpanStart":
            ctx.spanNames.set(event.spanId, event.name);
            return { kind: "stage_started", runId: runIdOf(event.traceId), stage: event.name };
        case "SpanEnd": {
            const stage = ctx.spanNames.get(event.spanId) ?? event.spanId;
            ctx.spanNames.delete(event.spanId);
            return { kind: "stage_finished", runId: runIdOf(event.traceId), stage, status: event.status, durationMs: event.durationMs };
        }
        case "TraceEnd":
            return { kind: "run_finished", runId: runIdOf(event.traceId), status: event.status, durationMs: event.durationMs };
        default:
            return null;
    }
}
```

(If `TraceEvent` isn't an exported union, export it from `packages/lib/src/live-traces/types.ts` and re-run typecheck.)

- [ ] **Step 4: Run tests, verify pass**

Run: `bun test apps/axctl/src/ingest/stream-events.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/ingest/stream-events.ts apps/axctl/src/ingest/stream-events.test.ts packages/lib/src/live-traces/types.ts
git commit -m "feat(ingest): IngestStreamEvent payload mapped from live-trace spans"
```

---

## Task 2: `IngestStreamBus` seam

**Goal:** A tiny producer-side interface so the workflow publishes progress without knowing about Durable Streams. Ships with an in-memory impl used by tests.

**Files:**
- Create: `apps/axctl/src/dashboard/ingest-stream.ts`
- Test: `apps/axctl/src/dashboard/ingest-stream.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/axctl/src/dashboard/ingest-stream.test.ts
import { describe, expect, test } from "bun:test";
import { InMemoryIngestStreamBus } from "./ingest-stream.ts";

describe("IngestStreamBus", () => {
    test("publishes events to the per-run stream and replays history", async () => {
        const bus = new InMemoryIngestStreamBus();
        await bus.publish("run1", { kind: "stage_started", runId: "run1", stage: "skills" });
        await bus.publish("run1", { kind: "stage_finished", runId: "run1", stage: "skills", status: "ok", durationMs: 5 });
        expect(bus.history("run1")).toHaveLength(2);
        expect(bus.history("run1")[0]).toMatchObject({ kind: "stage_started", stage: "skills" });
    });
});
```

- [ ] **Step 2: Run, verify fail** - `bun test apps/axctl/src/dashboard/ingest-stream.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// apps/axctl/src/dashboard/ingest-stream.ts
import type { IngestStreamEvent } from "../ingest/stream-events.ts";

/** The stream name for a run. Keep this the single source of truth. */
export const ingestStreamName = (runId: string): string => `ingest:${runId}`;

/**
 * Producer-side seam. The server-side ingest workflow publishes progress here;
 * the concrete backing (Durable Streams) is provided by `ingest-stream-durable.ts`.
 * Keeping this an interface lets the local Durable-Streams-in-Bun backing be
 * swapped for a hosted/Durable-Objects backend later without touching producers.
 */
export interface IngestStreamBus {
    publish(runId: string, event: IngestStreamEvent): Promise<void>;
}

/** Test/dev impl: keeps events in memory, no transport. */
export class InMemoryIngestStreamBus implements IngestStreamBus {
    private readonly streams = new Map<string, IngestStreamEvent[]>();
    async publish(runId: string, event: IngestStreamEvent): Promise<void> {
        const list = this.streams.get(runId) ?? [];
        list.push(event);
        this.streams.set(runId, list);
    }
    history(runId: string): readonly IngestStreamEvent[] {
        return this.streams.get(runId) ?? [];
    }
}
```

- [ ] **Step 4: Run, verify pass.** **Step 5: Commit**

```bash
git add apps/axctl/src/dashboard/ingest-stream.ts apps/axctl/src/dashboard/ingest-stream.test.ts
git commit -m "feat(serve): IngestStreamBus seam + in-memory impl"
```

---

## Task 3: Durable Streams backing for the bus

**Goal:** Implement `IngestStreamBus` over Durable Streams (server side), and expose the stream's HTTP endpoint(s) so the browser client can read it. Uses the exact API pinned in Task 0.

**Files:**
- Create: `apps/axctl/src/dashboard/ingest-stream-durable.ts`
- Test: `apps/axctl/src/dashboard/ingest-stream-durable.test.ts` (integration - gated behind an env flag like the existing `AX_E2E_DB` pattern, since it needs the embedded server)

- [ ] **Step 1: Implement the binding against Task 0's API**

```ts
// apps/axctl/src/dashboard/ingest-stream-durable.ts
// NOTE: the imports + publish call below use the API recorded in
// docs/superpowers/research/durable-streams-api.md. Replace the placeholder
// calls (createServer/append) with the verified names if they differ.
import type { IngestStreamEvent } from "../ingest/stream-events.ts";
import { ingestStreamName, type IngestStreamBus } from "./ingest-stream.ts";
// import { ... } from "@durable-streams/server";

export interface DurableIngestStream extends IngestStreamBus {
    /** Returns a Response for a stream read request, to mount inside Bun.serve.
     *  Return null if `request` is not a stream-protocol request (let other routes handle it). */
    handle(request: Request): Promise<Response | null>;
}

export function createDurableIngestStream(/* config from Task 0 */): DurableIngestStream {
    // 1. Construct the embedded Durable Streams server (mode A) per Task 0.
    // 2. publish(): append `event` (JSON) to stream `ingestStreamName(runId)`.
    // 3. handle(): if request.url matches the streams base path, delegate to the
    //    server's request handler and return its Response; else return null.
    return {
        async publish(runId: string, event: IngestStreamEvent): Promise<void> {
            // await server.append(ingestStreamName(runId), JSON.stringify(event));
            throw new Error("bind to @durable-streams/server append() - see Task 0 notes");
        },
        async handle(_request: Request): Promise<Response | null> {
            // return matchesStreamPath(_request) ? server.handle(_request) : null;
            throw new Error("bind to @durable-streams/server request handler - see Task 0 notes");
        },
    };
}
```

- [ ] **Step 2: Integration test (env-gated)** - write a test that, when `AX_STREAM_E2E=1`, publishes 2 events then reads them back through `handle()` using `@durable-streams/client` against an in-process fetch, asserting catch-up returns both and an offset is exposed. Skip otherwise (mirror the `AX_E2E_DB` skip pattern already in the suite).

- [ ] **Step 3: Run gated test locally**

Run: `AX_STREAM_E2E=1 bun test apps/axctl/src/dashboard/ingest-stream-durable.test.ts` → PASS. Without the flag it skips.

- [ ] **Step 4: Commit**

```bash
git add apps/axctl/src/dashboard/ingest-stream-durable.ts apps/axctl/src/dashboard/ingest-stream-durable.test.ts
git commit -m "feat(serve): Durable Streams backing for IngestStreamBus + mountable handler"
```

---

## Task 4: Server-side ingest workflow runner

**Goal:** A function the server calls to run `runIngest` IN-PROCESS, wiring a TraceSink transport that forwards every live-trace event to `bus.publish(...)`. Returns the runId immediately and runs the pipeline in the background (forked), so the HTTP request that triggered it can return at once.

**Files:**
- Create: `apps/axctl/src/dashboard/ingest-workflow.ts`
- Test: `apps/axctl/src/dashboard/ingest-workflow.test.ts`

- [ ] **Step 1: Write the failing test** (drive it with `InMemoryIngestStreamBus` + a fake/minimal layer; assert that running a no-op stage set publishes `run_started` … `run_finished` to the bus for the returned runId). Use the existing stage-pipeline test scaffolding in `apps/axctl/src/ingest/run.test.ts` as the model for providing layers.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement**

```ts
// apps/axctl/src/dashboard/ingest-workflow.ts
import { Effect, Layer } from "effect";
import { TraceTransportTag, type TraceTransport } from "@ax/lib/live-traces/Sink";
import { runIngest, type RunIngestOptions } from "../ingest/run.ts";
import { ingestStreamEventFromTrace } from "../ingest/stream-events.ts";
import type { IngestStreamBus } from "./ingest-stream.ts";

/** A live-trace transport that forwards ingest spans to the stream bus. */
function busTransportLayer(bus: IngestStreamBus): Layer.Layer<TraceTransportTag> {
    const spanNames = new Map<string, string>();
    const transport: TraceTransport = {
        send: (events) =>
            Effect.promise(async () => {
                for (const event of events) {
                    const mapped = ingestStreamEventFromTrace(event, { spanNames });
                    if (mapped) await bus.publish(mapped.runId, mapped);
                }
            }),
    };
    return Layer.succeed(TraceTransportTag, transport);
}

export interface StartIngestResult {
    readonly runId: string;
}

/**
 * Start an ingest run inside the serve process. Forks the pipeline so the
 * caller (an HTTP handler) returns immediately with the runId; progress lands
 * on the stream bus as stages run. `baseLayer` must supply runIngest's other
 * services (SurrealClient, AxConfig, ProcessService, StageRegistry, TraceSink).
 */
export const startIngestWorkflow = (
    opts: RunIngestOptions,
    bus: IngestStreamBus,
    baseLayer: Layer.Layer<never, never, never>, // the serve runtime layer (see Task 5 wiring)
): Effect.Effect<StartIngestResult> =>
    Effect.gen(function* () {
        const runId = crypto.randomUUID();
        const program = runIngest({ ...opts, runId }).pipe(
            Effect.provide(busTransportLayer(bus)),
            Effect.provide(baseLayer),
            Effect.scoped,
            Effect.catchAll((e) => Effect.logError("ingest workflow failed", e)),
        );
        yield* Effect.forkDaemon(program);
        return { runId };
    });
```

(Confirm `RunIngestOptions` accepts an explicit `runId`; if not, add an optional `runId` field to `RunIngestOptions` in `run.ts` and use it instead of the internally generated one, so the stream name is known before the run starts. This is the only change to `run.ts` and must keep the CLI path identical.)

**Concurrency note for the implementing agent:** `forkDaemon` + DB writes here run concurrently with the watcher; the v0.6.2 jittered conflict retry + reaction_event self-heal cover that, but verify with `fork-daemon-observability` discipline - confirm the forked work actually publishes events and finishes (don't declare done on fork alone).

- [ ] **Step 4: Run, verify pass.** **Step 5: Commit.**

```bash
git add apps/axctl/src/dashboard/ingest-workflow.ts apps/axctl/src/dashboard/ingest-workflow.test.ts apps/axctl/src/ingest/run.ts
git commit -m "feat(serve): in-process ingest workflow runner publishing to the stream bus"
```

---

## Task 5: Wire serve - `POST /api/ingest` + mount the stream

**Goal:** `ax serve` constructs the Durable stream + the runtime layer once, exposes `POST /api/ingest` (triggers a run, returns `{ runId }`), and mounts the stream handler so the browser can read `ingest:<runId>`.

**Files:**
- Modify: `apps/axctl/src/dashboard/server.ts` (the `fetch` handler ≈ around the existing `/api/events` route at line 409 and `Bun.serve` at line 926)

- [ ] **Step 1: Construct the bus + runtime once** at server start (near where the dashboard layer/DB is set up). Hold a module-level `DurableIngestStream`.

- [ ] **Step 2: Add the route - before the catch-all**, mirroring the existing `/api/events` handler style:

```ts
// in the fetch handler, alongside the other /api/* checks
if (url.pathname === "/api/ingest" && request.method === "POST") {
    const body = await request.json().catch(() => ({} as Record<string, unknown>));
    const sinceDays = typeof body.since === "number" ? body.since : undefined;
    const { runId } = await Effect.runPromise(
        startIngestWorkflow({ command: "ingest", args: sinceDays ? [`--since`, String(sinceDays)] : [], cwd: process.cwd(), debug: false, verbose: false }, durableStream, serveRuntimeLayer),
    );
    return Response.json({ runId, stream: ingestStreamName(runId) });
}
// delegate stream-protocol reads to Durable Streams:
const streamResponse = await durableStream.handle(request);
if (streamResponse) return streamResponse;
```

(Match the exact `RunIngestOptions` fields required by `run.ts`. `serveRuntimeLayer` is the same layer the dashboard already uses to talk to SurrealDB, plus `TraceSinkLive` - reuse the existing serve layer composition.)

- [ ] **Step 3: Typecheck + smoke**

Run: `bun run typecheck` → 0 errors. Then start the server and trigger a run:
```bash
bun apps/axctl/src/cli/index.ts serve &      # or ./dist/axctl serve
curl -s -XPOST localhost:8520/api/ingest -d '{"since":1}' | jq .   # → { runId, stream }
```
Expected: returns a runId; server logs show stages running; no crash.

- [ ] **Step 4: Commit**

```bash
git add apps/axctl/src/dashboard/server.ts
git commit -m "feat(serve): POST /api/ingest triggers in-process ingest + mounts the run stream"
```

---

## Task 6: Frontend - subscribe + animate

**Goal:** A `@durable-streams/client` hook + a live view that triggers a run, subscribes to `ingest:<runId>`, replays history on mount/refresh, and animates stages completing + headline counts rising.

**Files:**
- Create: `apps/axctl/src/dashboard/web/src/use-ingest-stream.ts`
- Create: `apps/axctl/src/dashboard/web/src/routes/ingest-live.tsx`
- Modify: `apps/axctl/src/dashboard/web/src/router.tsx` (register the route) and the nav/site-header to link it

- [ ] **Step 1: The hook** - `useIngestStream(runId: string)`: construct a `@durable-streams/client` (per Task 0), subscribe to `ingestStreamName(runId)`, fold messages into `{ stages: Record<stage, "running"|"ok"|"error">, finished: boolean }`. Persist the client offset (the client handles resume; just don't reset state on reconnect). Parse each message as `IngestStreamEvent` (import the type from `../../../ingest/stream-events.ts` via the existing `@shared`-style alias or a relative path - match how the SPA imports shared types today).

- [ ] **Step 2: The view** - `ingest-live.tsx`: a "Run ingest" button → `POST /api/ingest` → take `runId` → `useIngestStream(runId)` → render a stage checklist that ticks ✓ as `stage_finished` arrives, plus the existing dashboard count tiles (reuse the React Query queries that `use-ingest-events.ts` already invalidates) so numbers visibly climb. Keep it simple and legible; the *moment* is "stages tick green + counts rise live."

- [ ] **Step 3: Build the SPA**

Run: `bun run dashboard:build` → builds with no errors. (Dashboard typecheck has pre-existing strictness; do not block on unrelated errors, but your new files must be clean.)

- [ ] **Step 4: Commit**

```bash
git add apps/axctl/src/dashboard/web/src/use-ingest-stream.ts apps/axctl/src/dashboard/web/src/routes/ingest-live.tsx apps/axctl/src/dashboard/web/src/router.tsx
git commit -m "feat(dashboard): live ingest view over Durable Streams (catch-up + resume + animate)"
```

---

## Task 7: End-to-end dogfood + docs

**Goal:** Prove the onboarding moment works, including the resumability payoff, and document it.

- [ ] **Step 1: Manual E2E** - build the binary (`bun run build`), `./dist/axctl serve`, open the dashboard, click **Run ingest**, watch stages tick + counts rise. Then **refresh the page mid-run** - confirm the view rehydrates the run's history (stages already done stay done) and keeps receiving live deltas (this is the Durable Streams payoff vs raw SSE). Capture a screenshot/gif into `docs/dogfood/<date>-live-ingest/`.
- [ ] **Step 2: CLI regression** - `./dist/axctl ingest --since 1` in a terminal still shows the terminal step animation and exits clean (no regression from the server path). `bun test` full suite green; `bun run typecheck` clean.
- [ ] **Step 3: Docs** - add a short "Live ingest in the dashboard" section to `CLAUDE.md` (under Reactivity) and `README`/site docs: trigger from `ax serve`, the stream name convention `ingest:<runId>`, and the `IngestStreamBus` seam (local = Durable-Streams-in-Bun; hosted-later = swap the backing). Note `AX_PROGRESS=off` still silences the CLI animation.
- [ ] **Step 4: Commit**

```bash
git add docs/ CLAUDE.md README.md
git commit -m "docs: live ingest over Durable Streams + dogfood evidence"
```

---

## Risk register

1. **Durable Streams not embeddable in `Bun.serve` (Task 0 mode A fails).** Mitigation: fall back to sidecar (mode B) - spawn `@durable-streams/server` on a second localhost port from `cmdServe`, proxy `/stream/*` to it. Still single command, one extra child process. Document the choice.
2. **`@durable-streams/server` is Node-targeted and misbehaves under Bun.** Mitigation: it's a small HTTP protocol; if the package won't run under Bun, implement the read endpoints directly in `Bun.serve` against the documented offset protocol and keep only `@durable-streams/client` on the frontend.
3. **Forked ingest inside serve contends with the watcher.** Already mitigated by the v0.6.2 jittered conflict retry + reaction_event self-heal; verify via `fork-daemon-observability` (confirm events actually published + run finished, not just forked).
4. **Heavy ingest blocks the serve event loop.** `runIngest` is IO-bound Effect; keep it forked (`forkDaemon`) and never `await` the full run inside a request. For very large runs, surface progress only via the stream (already the design).
5. **Browser reconnect storms / offset bugs.** That's exactly what Durable Streams' offset resume is for - rely on the client, don't hand-roll reconnect. Test the refresh-mid-run case explicitly (Task 7 Step 1).
6. **Scope creep into "hosted ax".** This plan stays local-first single-process. The `IngestStreamBus` seam is the only forward-looking abstraction; do NOT build a hosted backend in this PR.

## Done When

- `POST /api/ingest` triggers an in-process run and returns `{ runId, stream }`.
- The dashboard live view shows stages ticking green and counts rising in real time; refreshing mid-run rehydrates history and continues live (Durable Streams resume verified).
- CLI `ax ingest` + its terminal animation are unchanged; full `bun test` green; `bun run typecheck` clean.
- `docs/superpowers/research/durable-streams-api.md` records the real API + the embed-vs-sidecar decision; `IngestStreamBus` seam is in place for a future hosted swap.
- Dogfood evidence (refresh-mid-run gif/screenshot) committed under `docs/dogfood/`.

## Reference

- ElectricSQL Durable Streams: https://electric-sql.com/blog/2025/12/09/announcing-durable-streams · protocol/state: https://electric-sql.com/blog/2025/12/23/durable-streams-0.1.0 · packages: https://github.com/durable-streams/durable-streams
- ax touchpoints: `apps/axctl/src/ingest/run.ts`, `apps/axctl/src/dashboard/{server,telemetry}.ts`, `apps/axctl/src/dashboard/web/src/use-ingest-events.ts`, `packages/lib/src/live-traces/`.
