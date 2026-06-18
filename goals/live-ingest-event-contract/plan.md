# Live Ingest Event Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote live ingest Durable Stream events from TypeScript-only shapes to a runtime-validated shared Effect Schema contract.

**Architecture:** Keep the existing HTTP trigger and Durable Streams transport. Add a schema-backed event contract in `@ax/lib/shared`, validate on the daemon append path, and decode in the studio before reducing events. This borrows the useful idea from the Effect/Electron example, namely a single schema-defined wire payload, without adopting its Electron or `@effect/rpc` transport.

**Tech Stack:** Bun, TypeScript strict mode, Effect 4 beta `Schema`, Durable Streams, React reducer state in `apps/studio`, existing `bun:test` test style.

---

## Current Context

The current shared event file is only structural TypeScript:

- `packages/lib/src/shared/ingest-stream-events.ts`
- Imported by producer code through `apps/axctl/src/ingest/stream-events.ts`
- Published by `apps/axctl/src/dashboard/ingest-stream-durable.ts`
- Consumed by `apps/studio/src/use-ingest-stream.ts`

The repo already has a nearby schema-union pattern:

- `packages/lib/src/live-traces/Schema.ts`

Do not copy that file blindly. It uses `_tag` via `Schema.TaggedStruct`; live ingest events currently use `kind`, and the UI reducer switches on `event.kind`. The live ingest contract must keep `kind`.

The main doc mismatch to clean up is in:

- `packages/lib/src/shared/api-contract.ts`

The module comment says SSE and binary stay outside the contract because streaming/binary shapes do not fit `HttpApi`. After this work, the accurate statement is: streaming and binary routes stay outside `HttpApi`, but live-ingest stream payloads are schema-typed in `@ax/lib/shared/ingest-stream-events`.

## Non-Goals

- Do not add `@effect/rpc`.
- Do not add Electron, MessagePort, or any desktop transport.
- Do not migrate studio state to effect-atom.
- Do not alter the Durable Streams sidecar protocol.
- Do not touch generated build artifacts under `apps/studio/dist*`.
- Do not touch copied app sources under `apps/studio-desktop/resources/ax-src`.
- Do not broaden this into unrelated query input contracts, pagination, OTLP, MCP, or table rendering work.

## Worktree Protocol

- If the overnight runner starts in a dedicated non-main worktree, use the current worktree and branch. Do not create a nested worktree.
- If the runner starts on `main` and an issue number exists, use the repo's normal claim flow:

```bash
bun run wip list
bun run wip claim <issue#> arch
cd <printed-worktree-path>
```

- If the runner starts on `main` and there is no issue number, create a dedicated branch/worktree before editing:

```bash
git worktree add .claude/worktrees/live-ingest-event-contract -b arch/live-ingest-event-contract
cd .claude/worktrees/live-ingest-event-contract
```

- Do not edit code on `main`.
- Before editing, run:

```bash
git status --short
git branch --show-current
```

If unrelated dirty files are present, leave them alone.

## File Map

Modify:

- `packages/lib/src/shared/ingest-stream-events.ts`
  - Owns schema definitions, derived public types, decoder/encoder helpers, and the failure-snapshot schema.

- `apps/axctl/src/ingest/stream-events.ts`
  - Keeps translating trace events into ingest stream events.
  - Replaces manual `stage_file_failures` shape checks with the shared schema where possible.

- `apps/axctl/src/dashboard/ingest-stream-durable.ts`
  - Encodes or validates each event before `handle.append(JSON.stringify(...))`.

- `apps/studio/src/use-ingest-stream.ts`
  - Treats Durable Stream items as `unknown`.
  - Decodes each item using the shared contract before calling `applyEvent`.
  - Dispatches an error for malformed items without breaking valid-item folding.

- `packages/lib/src/shared/api-contract.ts`
  - Updates comments only. The `HttpApi` route itself should stay unchanged.

Test:

- Create `packages/lib/src/shared/ingest-stream-events.test.ts`
- Update `apps/axctl/src/ingest/stream-events.test.ts`
- Update `apps/axctl/src/dashboard/ingest-stream-durable.test.ts`
- Update `apps/studio/src/use-ingest-stream.test.ts`

Do not modify:

- `apps/studio/dist*`
- `apps/studio-desktop/resources/ax-src`
- `package.json` dependency lists
- `packages/lib/package.json` exports, unless TypeScript resolution fails. It should not fail because `@ax/lib` has a wildcard export.

---

## Task 1: Shared Schema Contract

**Files:**

- Modify: `packages/lib/src/shared/ingest-stream-events.ts`
- Create: `packages/lib/src/shared/ingest-stream-events.test.ts`

### Task 1 Goal

Replace the interface-only event shapes with Effect Schema definitions and derive the public types from the schemas.

### Step 1: Write the failing schema tests

- [ ] Add `packages/lib/src/shared/ingest-stream-events.test.ts` with tests covering every valid variant and representative invalid shapes.

Use this test file content as the starting point:

```ts
import { describe, expect, test } from "bun:test";
import { Option, Schema } from "effect";
import {
    decodeIngestStreamEventOption,
    encodeIngestStreamEvent,
    IngestStreamEventSchema,
    isIngestStreamEvent,
    type IngestStreamEvent,
} from "./ingest-stream-events.ts";

const validEvents: ReadonlyArray<IngestStreamEvent> = [
    { kind: "run_started", runId: "r1", label: "ingest" },
    { kind: "stage_started", runId: "r1", stage: "claude" },
    {
        kind: "stage_progress",
        runId: "r1",
        stage: "claude",
        current: 10,
        total: 25,
        ratePerSec: 5,
        etaLeftMs: 3000,
        stageIndex: 1,
    },
    {
        kind: "stage_progress",
        runId: "r1",
        stage: "claude",
        current: 25,
        total: 25,
        ratePerSec: 10,
        etaLeftMs: null,
        stageIndex: 1,
    },
    {
        kind: "stage_file_failures",
        runId: "r1",
        stage: "claude",
        total: 2,
        failures: [
            { filePath: "/tmp/a.jsonl", tag: "DbError", message: "boom" },
            { filePath: "/tmp/b.jsonl", tag: "ParseError", message: "bad json" },
        ],
    },
    { kind: "stage_finished", runId: "r1", stage: "claude", status: "ok", durationMs: 42 },
    { kind: "stage_finished", runId: "r1", stage: "codex", status: "error", durationMs: 99 },
    { kind: "run_finished", runId: "r1", status: "completed", durationMs: 120 },
    { kind: "run_finished", runId: "r2", status: "failed", durationMs: 121 },
];

describe("IngestStreamEventSchema", () => {
    test("decodes every valid live-ingest event variant", () => {
        for (const event of validEvents) {
            expect(Schema.decodeUnknownSync(IngestStreamEventSchema)(event)).toEqual(event);
            expect(Option.isSome(decodeIngestStreamEventOption(event))).toBe(true);
            expect(isIngestStreamEvent(event)).toBe(true);
        }
    });

    test("encodes valid events without changing their JSON shape", () => {
        for (const event of validEvents) {
            expect(encodeIngestStreamEvent(event)).toEqual(event);
        }
    });

    test("rejects unknown event kinds and invalid status literals", () => {
        const invalid: ReadonlyArray<unknown> = [
            { kind: "wat", runId: "r1" },
            { kind: "stage_finished", runId: "r1", stage: "s", status: "completed", durationMs: 1 },
            { kind: "run_finished", runId: "r1", status: "ok", durationMs: 1 },
        ];

        for (const value of invalid) {
            expect(Option.isNone(decodeIngestStreamEventOption(value))).toBe(true);
            expect(isIngestStreamEvent(value)).toBe(false);
        }
    });

    test("rejects malformed stage_file_failures details", () => {
        const invalid: ReadonlyArray<unknown> = [
            { kind: "stage_file_failures", runId: "r", stage: "s", total: 1, failures: [{ filePath: 1, tag: "x", message: "y" }] },
            { kind: "stage_file_failures", runId: "r", stage: "s", total: 1, failures: [{ filePath: "/x", tag: 2, message: "y" }] },
            { kind: "stage_file_failures", runId: "r", stage: "s", total: 1, failures: [{ filePath: "/x", tag: "x", message: null }] },
        ];

        for (const value of invalid) {
            expect(Option.isNone(decodeIngestStreamEventOption(value))).toBe(true);
        }
    });
});
```

Run:

```bash
bun test packages/lib/src/shared/ingest-stream-events.test.ts
```

Expected before implementation: fail because the schema/helper exports do not exist.

### Step 2: Implement the schemas and helpers

- [ ] Edit `packages/lib/src/shared/ingest-stream-events.ts`.

Use `Schema.Struct` with explicit `kind` literals. Do not use `Schema.TaggedStruct`, because that would introduce `_tag`.

Implementation shape:

```ts
import { Option, Schema } from "effect";

export const IngestFileFailureSchema = Schema.Struct({
    filePath: Schema.String,
    tag: Schema.String,
    message: Schema.String,
});
export type IngestFileFailure = typeof IngestFileFailureSchema.Type;

export const IngestFileFailureSnapshotSchema = Schema.Struct({
    total: Schema.Number,
    failures: Schema.Array(IngestFileFailureSchema),
});
export type IngestFileFailureSnapshot = typeof IngestFileFailureSnapshotSchema.Type;

export const RunStartedEventSchema = Schema.Struct({
    kind: Schema.Literal("run_started"),
    runId: Schema.String,
    label: Schema.String,
});

export const StageStartedEventSchema = Schema.Struct({
    kind: Schema.Literal("stage_started"),
    runId: Schema.String,
    stage: Schema.String,
});

export const StageProgressEventSchema = Schema.Struct({
    kind: Schema.Literal("stage_progress"),
    runId: Schema.String,
    stage: Schema.String,
    current: Schema.Number,
    total: Schema.Number,
    ratePerSec: Schema.Number,
    etaLeftMs: Schema.NullOr(Schema.Number),
    stageIndex: Schema.Number,
});

export const StageFileFailuresEventSchema = Schema.Struct({
    kind: Schema.Literal("stage_file_failures"),
    runId: Schema.String,
    stage: Schema.String,
    total: Schema.Number,
    failures: Schema.Array(IngestFileFailureSchema),
});

export const StageFinishedEventSchema = Schema.Struct({
    kind: Schema.Literal("stage_finished"),
    runId: Schema.String,
    stage: Schema.String,
    status: Schema.Literals(["ok", "error"]),
    durationMs: Schema.Number,
});

export const RunFinishedEventSchema = Schema.Struct({
    kind: Schema.Literal("run_finished"),
    runId: Schema.String,
    status: Schema.Literals(["completed", "failed"]),
    durationMs: Schema.Number,
});

export const IngestStreamEventSchema = Schema.Union([
    RunStartedEventSchema,
    StageStartedEventSchema,
    StageProgressEventSchema,
    StageFileFailuresEventSchema,
    StageFinishedEventSchema,
    RunFinishedEventSchema,
]);
export type IngestStreamEvent = typeof IngestStreamEventSchema.Type;

const decodeEventOption = Schema.decodeUnknownOption(IngestStreamEventSchema);
const decodeFailureSnapshotOption = Schema.decodeUnknownOption(IngestFileFailureSnapshotSchema);
const encodeEventSync = Schema.encodeSync(IngestStreamEventSchema);

export const decodeIngestStreamEventOption = (value: unknown) =>
    decodeEventOption(value);

export const decodeIngestFileFailureSnapshotOption = (value: unknown) =>
    decodeFailureSnapshotOption(value);

export const isIngestStreamEvent = (value: unknown): value is IngestStreamEvent =>
    Option.isSome(decodeEventOption(value));

export const encodeIngestStreamEvent = (event: IngestStreamEvent): unknown =>
    encodeEventSync(event);
```

If `Option.isSome` is not exported in this Effect beta, inspect existing Option usage with:

```bash
rg "Option\\.isSome|Option\\." apps packages -n
```

Then use the local idiom. Do not add a dependency for this.

### Step 3: Run the shared schema tests

- [ ] Run:

```bash
bun test packages/lib/src/shared/ingest-stream-events.test.ts
```

Expected after implementation: pass.

### Step 4: Typecheck the shared package

- [ ] Run:

```bash
bun --cwd packages/lib run typecheck
```

Expected: pass.

Commit:

```bash
git add packages/lib/src/shared/ingest-stream-events.ts packages/lib/src/shared/ingest-stream-events.test.ts
git commit -m "feat: schema live ingest stream events"
```

---

## Task 2: Producer-Side Validation Before Durable Stream Append

**Files:**

- Modify: `apps/axctl/src/dashboard/ingest-stream-durable.ts`
- Modify: `apps/axctl/src/dashboard/ingest-stream-durable.test.ts`

### Task 2 Goal

The daemon must not append an event that fails the shared stream contract. This catches producer drift close to the source.

### Step 1: Add a failing test for invalid producer events

- [ ] In `apps/axctl/src/dashboard/ingest-stream-durable.test.ts`, add a non-E2E test outside the `AX_STREAM_E2E` gated describe block if the file structure makes that practical.

Because the current implementation opens a real sidecar before it can append, do not overfit the test to internals. Export a pure helper from the producer module in the next step:

```ts
import { describe, expect, test } from "bun:test";
import { encodeIngestStreamEventJson } from "./ingest-stream-durable.ts";
import type { IngestStreamEvent } from "../ingest/stream-events.ts";

describe("encodeIngestStreamEventJson", () => {
    test("serializes valid events with the existing JSON shape", () => {
        expect(encodeIngestStreamEventJson({ kind: "stage_started", runId: "r", stage: "discover" })).toBe(
            JSON.stringify({ kind: "stage_started", runId: "r", stage: "discover" }),
        );
    });

    test("rejects invalid events before Durable Stream append", () => {
        // Simulates a malformed runtime value crossing the TypeScript boundary.
        const malformed = { kind: "stage_finished", runId: "r", stage: "s", status: "completed", durationMs: 1 } as unknown as IngestStreamEvent;
        expect(() =>
            encodeIngestStreamEventJson(malformed),
        ).toThrow();
    });
});
```

Run:

```bash
bun test apps/axctl/src/dashboard/ingest-stream-durable.test.ts
```

Expected before implementation: fail because `encodeIngestStreamEventJson` does not exist.

### Step 2: Add the producer encoder helper

- [ ] Edit `apps/axctl/src/dashboard/ingest-stream-durable.ts`.

Import the shared JSON-string encoder:

```ts
import { encodeIngestStreamEventJson } from "@ax/lib/shared/ingest-stream-events";
```

Re-export the pure helper near the top-level exports for the producer tests:

```ts
export { encodeIngestStreamEventJson };
```

Then change:

```ts
await handle.append(JSON.stringify(event));
```

to:

```ts
await handle.append(encodeIngestStreamEventJson(event));
```

Do not catch schema failures here. An invalid producer event is a programmer error in ax, not a malformed remote client. Let the append path fail so tests and live ingest reveal the bug.

### Step 3: Run producer tests

- [ ] Run:

```bash
bun test apps/axctl/src/dashboard/ingest-stream-durable.test.ts
```

Expected: pure helper tests pass. The E2E sidecar test remains skipped unless `AX_STREAM_E2E=1`.

### Step 4: Optional E2E if time and local native sidecar works

- [ ] Run:

```bash
AX_STREAM_E2E=1 bun test apps/axctl/src/dashboard/ingest-stream-durable.test.ts
```

Expected: sidecar publish/read still passes. If native `lmdb` or Durable Streams setup blocks this, document the blocker in the final report and continue with typecheck plus focused unit tests.

Commit:

```bash
git add apps/axctl/src/dashboard/ingest-stream-durable.ts apps/axctl/src/dashboard/ingest-stream-durable.test.ts
git commit -m "test: validate live ingest stream appends"
```

---

## Task 3: Trace Translator Uses the Shared Failure Snapshot Schema

**Files:**

- Modify: `apps/axctl/src/ingest/stream-events.ts`
- Modify: `apps/axctl/src/ingest/stream-events.test.ts`

### Task 3 Goal

Keep the existing trace-to-stream behavior, but stop hand-validating the `ingest.fileFailures` snapshot shape when the shared schema can do it.

### Step 1: Strengthen existing translator tests

- [ ] Add a test that proves malformed failure snapshots are dropped because of schema validation:

```ts
test("drops fileFailures payloads whose failure entries do not match the shared schema", () => {
    const malformedEvent: SpanEvent = {
        _tag: "SpanEvent",
        traceId: "ingest:run123",
        spanId: "s1",
        name: "attribute:ingest.fileFailures",
        attributes: {
            value: JSON.stringify({
                total: 2,
                failures: [{ filePath: "/p/a.jsonl", tag: "DbError", message: 42 }],
            }),
        },
    };

    const ev = ingestStreamEventFromTrace(
        malformedEvent,
        { spanNames: new Map([["s1", "claude"]]) },
    );
    expect(ev).toBeNull();
});
```

Run:

```bash
bun test apps/axctl/src/ingest/stream-events.test.ts
```

Expected before implementation: this may already pass because manual checks exist. That is acceptable for a characterization test.

### Step 2: Replace manual shape checks for the snapshot

- [ ] Edit `apps/axctl/src/ingest/stream-events.ts`.

Change the import from shared event types:

```ts
import type { IngestFileFailure, IngestStreamEvent } from "@ax/lib/shared/ingest-stream-events";
```

to:

```ts
import {
    decodeIngestFileFailureSnapshotOption,
    type IngestFileFailure,
    type IngestStreamEvent,
} from "@ax/lib/shared/ingest-stream-events";
```

Then replace the object-entry loop inside `readFileFailures` with:

```ts
const decoded = decodeIngestFileFailureSnapshotOption(parsed);
if (Option.isNone(decoded)) return null;
const snapshot = decoded.value;
if (snapshot.total <= 0) return null;
return { total: snapshot.total, failures: [...snapshot.failures] };
```

Use public `Option` APIs instead of inspecting the `Option` discriminator directly.

Keep the JSON parse try/catch. The shared schema validates the parsed object; it does not replace JSON parsing.

### Step 3: Run translator tests

- [ ] Run:

```bash
bun test apps/axctl/src/ingest/stream-events.test.ts
```

Expected: pass.

Commit:

```bash
git add packages/lib/src/shared/ingest-stream-events.ts apps/axctl/src/ingest/stream-events.ts apps/axctl/src/ingest/stream-events.test.ts
git commit -m "refactor: validate ingest failure snapshots with schema"
```

---

## Task 4: Studio Decodes Unknown Stream Items Before Reducing

**Files:**

- Modify: `apps/studio/src/use-ingest-stream.ts`
- Modify: `apps/studio/src/use-ingest-stream.test.ts`

### Task 4 Goal

The studio should not trust generic type parameters from `@durable-streams/client`. Stream items are external JSON at runtime. Decode them before `applyEvent`.

### Step 1: Add pure decode/fold tests

- [ ] Extend `apps/studio/src/use-ingest-stream.test.ts`.

Add an exported pure helper in the implementation during Step 2, then test it here:

```ts
import { decodeStreamItems } from "./use-ingest-stream.ts";
```

Add tests:

```ts
describe("decodeStreamItems", () => {
    test("returns valid ingest events and counts malformed items", () => {
        const batch = decodeStreamItems([
            { kind: "stage_started", runId: "r", stage: "claude" },
            { kind: "stage_finished", runId: "r", stage: "claude", status: "completed", durationMs: 1 },
            { kind: "run_finished", runId: "r", status: "completed", durationMs: 2 },
        ]);

        expect(batch.events).toEqual([
            { kind: "stage_started", runId: "r", stage: "claude" },
            { kind: "run_finished", runId: "r", status: "completed", durationMs: 2 },
        ]);
        expect(batch.invalidCount).toBe(1);
    });
});
```

Run:

```bash
bun test apps/studio/src/use-ingest-stream.test.ts
```

Expected before implementation: fail because `decodeStreamItems` does not exist.

### Step 2: Implement `decodeStreamItems`

- [ ] Edit `apps/studio/src/use-ingest-stream.ts`.

Change:

```ts
import type { IngestFileFailure, IngestStreamEvent } from "@ax/lib/shared/ingest-stream-events";
```

to:

```ts
import {
    decodeIngestStreamEventOption,
    type IngestFileFailure,
    type IngestStreamEvent,
} from "@ax/lib/shared/ingest-stream-events";
```

Add a pure helper near the reducer helpers:

```ts
export interface DecodedStreamItems {
    readonly events: ReadonlyArray<IngestStreamEvent>;
    readonly invalidCount: number;
}

export function decodeStreamItems(items: ReadonlyArray<unknown>): DecodedStreamItems {
    const events: IngestStreamEvent[] = [];
    let invalidCount = 0;
    for (const item of items) {
        Option.match(decodeIngestStreamEventOption(item), {
            onSome: (event) => {
                events.push(event);
            },
            onNone: () => {
                invalidCount += 1;
            },
        });
    }
    return { events, invalidCount };
}
```

Use public `Option` helpers such as `Option.match`, `Option.isSome`, or `Option.isNone`; do not inspect `Option` internals.

### Step 3: Decode in the hook

- [ ] In `useIngestStream`, make the Durable Stream session unknown-typed:

```ts
let session: StreamResponse<unknown> | null = null;
```

Change:

```ts
const res = await stream<IngestStreamEvent>({
```

to:

```ts
const res = await stream<unknown>({
```

Then change the subscribe block from:

```ts
unsubscribe = res.subscribeJson((batch) => {
    if (cancelled) return;
    if (batch.items.length > 0) receivedAny = true;
    for (const event of batch.items) {
        dispatch({ type: "event", event, offset: batch.offset });
    }
});
```

to:

```ts
unsubscribe = res.subscribeJson((batch) => {
    if (cancelled) return;
    if (batch.items.length > 0) receivedAny = true;
    const decoded = decodeStreamItems(batch.items);
    if (decoded.invalidCount > 0) {
        dispatch({
            type: "error",
            message: `received ${decoded.invalidCount} invalid ingest stream event${decoded.invalidCount === 1 ? "" : "s"}`,
        });
    }
    for (const event of decoded.events) {
        dispatch({ type: "event", event, offset: batch.offset });
    }
});
```

Rationale:

- A malformed item should not crash rendering.
- Valid items in the same batch should still fold.
- The error is visible in state, so the UI can surface it.

### Step 4: Run studio stream tests

- [ ] Run:

```bash
bun test apps/studio/src/use-ingest-stream.test.ts
```

Expected: pass.

Commit:

```bash
git add apps/studio/src/use-ingest-stream.ts apps/studio/src/use-ingest-stream.test.ts
git commit -m "fix: decode live ingest stream items in studio"
```

---

## Task 5: Update Contract Comments

**Files:**

- Modify: `packages/lib/src/shared/api-contract.ts`

### Task 5 Goal

Keep the architecture comments accurate. The stream route is outside `HttpApi`, but its JSON event payload is now schema-typed.

### Step 1: Update the module comment

- [ ] In the top comment, replace:

```ts
SSE /api/events and binary /api/image stay OUTSIDE the contract permanently
(streaming/binary shapes that don't fit HttpApi).
```

with:

```ts
SSE /api/events, Durable Stream tails returned by /api/ingest, and binary
/api/image stay outside HttpApi routing. Live-ingest stream event payloads
are still schema-typed separately in @ax/lib/shared/ingest-stream-events.
```

Keep line lengths consistent with the file.

### Step 2: Update the live group comment

- [ ] Near `LiveGroup`, replace:

```ts
The live family's JSON endpoint. SSE /api/events and binary /api/image
stay OUTSIDE the contract permanently (module doc above).
```

with:

```ts
The live family's JSON trigger endpoint. The returned Durable Stream URL is
not an HttpApi route, but its event payload is schema-typed in
@ax/lib/shared/ingest-stream-events.
```

### Step 3: Run a narrow typecheck

- [ ] Run:

```bash
bun --cwd packages/lib run typecheck
```

Expected: pass.

Commit:

```bash
git add packages/lib/src/shared/api-contract.ts
git commit -m "docs: clarify live ingest stream contract"
```

---

## Task 6: Verification Pass

### Step 1: Run focused tests

- [ ] Run:

```bash
bun test \
  packages/lib/src/shared/ingest-stream-events.test.ts \
  apps/axctl/src/ingest/stream-events.test.ts \
  apps/axctl/src/dashboard/ingest-stream-durable.test.ts \
  apps/studio/src/use-ingest-stream.test.ts
```

Expected: pass. The Durable Streams E2E section may remain skipped unless `AX_STREAM_E2E=1`.

### Step 2: Run package typechecks

- [ ] Run:

```bash
bun --cwd packages/lib run typecheck
bun --cwd apps/axctl run typecheck
bun --cwd apps/studio run typecheck
```

Expected: pass.

Note: the site/studio typecheck sometimes depends on generated route/content output. If it fails for missing generated artifacts, run the repo's established build step first:

```bash
bun run build
```

Then rerun the failing typecheck.

### Step 3: Run full gates if time remains

- [ ] Run:

```bash
bun test
bun run typecheck
```

Expected: pass.

If `bun test` is blocked by a local hook that requires the project test wrapper, follow the repo's current test-wrapper convention and record the exact command used in the final report.

### Step 4: Inspect changed files

- [ ] Run:

```bash
git status --short
git diff --stat
git diff -- packages/lib/src/shared/ingest-stream-events.ts
git diff -- apps/axctl/src/dashboard/ingest-stream-durable.ts
git diff -- apps/studio/src/use-ingest-stream.ts
```

Confirm:

- No generated `dist` files changed.
- No `apps/studio-desktop/resources/ax-src` files changed.
- No dependencies changed.
- The public type names still exist.
- The UI reducer still switches on `event.kind`.

### Step 5: Final commit if previous tasks were not committed

- [ ] If the task commits were skipped, make one commit:

```bash
git add \
  packages/lib/src/shared/ingest-stream-events.ts \
  packages/lib/src/shared/ingest-stream-events.test.ts \
  packages/lib/src/shared/api-contract.ts \
  apps/axctl/src/ingest/stream-events.ts \
  apps/axctl/src/ingest/stream-events.test.ts \
  apps/axctl/src/dashboard/ingest-stream-durable.ts \
  apps/axctl/src/dashboard/ingest-stream-durable.test.ts \
  apps/studio/src/use-ingest-stream.ts \
  apps/studio/src/use-ingest-stream.test.ts

git commit -m "feat: validate live ingest stream contract"
```

---

## Edge Cases and Traps

### Keep `kind`, not `_tag`

The Effect/Electron example uses `Schema.TaggedStruct`, and ax's live traces schema also uses `_tag`. Live ingest events do not. The studio reducer is keyed on `kind`. Preserve that.

### Do not use `Schema.Unknown` for the event union

The whole point is to catch drift. A union of exact structs is needed.

### Do not silently drop malformed producer events

Producer-side invalid events indicate an ax code bug. The daemon append helper should throw/reject. Consumer-side malformed events are external stream data and should be handled gracefully.

### Avoid over-validating counts in the first pass

The current TypeScript type allows any number for `current`, `total`, `ratePerSec`, `durationMs`, and `stageIndex`. It is fine to restrict obvious literals like statuses and kind. Do not add positivity or integer constraints unless tests prove all producers already satisfy them. This goal is a contract promotion, not a semantic behavior change.

### `Schema.Array` may return readonly arrays

If TypeScript complains when returning `snapshot.failures`, use `[...snapshot.failures]` at the boundary. Do not loosen the schema.

### Use public `Option` APIs

Use `Option.match`, `Option.isSome`, or `Option.isNone` for Effect `Option` values. Reserve direct discriminator checks for this project's own public wire unions.

### `apps/studio/src/use-ingest-stream.ts` still owns UI state

Do not move `applyEvent` into shared lib in this goal. The shared contract should know event shapes; the studio hook should own render state.

### Comments matter here

The old comment in `api-contract.ts` says streaming payloads do not fit the contract. After this change, leaving that comment untouched will mislead the next agent into thinking the stream is intentionally untyped.

## Suggested Final Report

The final response should include:

- Files changed.
- Focused tests run and pass/fail status.
- Typecheck commands run and pass/fail status.
- Whether `AX_STREAM_E2E=1` was run or skipped.
- Any deviations from this plan, especially around Effect `Option` APIs or schema helper naming.
