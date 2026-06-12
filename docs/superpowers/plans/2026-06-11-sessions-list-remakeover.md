# Sessions List Remakeover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich the dashboard `/sessions` list with per-row signal columns (turns, burn sparkline, cost, friction badge, live dot) and an expandable insight panel (story bar, outcome, ΔLOC, skill arc, context seesaw, baseline footer), per the approved design spec `docs/superpowers/specs/2026-06-11-sessions-list-remakeover-design.md`.

**Architecture:** Row enrichment comes from per-session aggregate tables already written at ingest (`session_health`, `session_token_usage`, `session_metrics`) via batched `session IN [page ids]` queries appended to the existing `fetchSessionsList` flow - never per-row turn scans or stacked graph derefs. The panel is fed by a new `/api/sessions/:id/insights` endpoint fetched lazily on expand. A new `burn_buckets` field on `session_token_usage` is precomputed at ingest from per-turn usage.

**Tech Stack:** bun ≥1.3, TypeScript strict, Effect (beta), SurrealDB 3.0 (`makeTestSurrealClient` for tests), React 19 + TanStack Query/Router (studio SPA), hand-rolled SVG/CSS charts (no chart lib).

**Worktree:** all work happens in `.claude/worktrees/sessions-list-remakeover` (branch `feat/sessions-list-remakeover`). All paths below are relative to that worktree root.

**Conventions that bite:**
- `bun test` is the runner (`bun:test`); a global hook may block `bun test` - if so, wrap in a tmp script (see memory note "Test runner").
- SurrealQL: record-id IN-lists are interpolated raw (`formatRecordIdList`), string filters via `safeLiteral`. Datetimes cross the SDK as JS `Date`; over `<string>` casts they arrive as ISO strings.
- Nested objects in SCHEMAFULL tables are JSON-encoded strings.
- Effect: consult `effect-solutions show basics services-and-layers testing` before writing Effect code.

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `packages/lib/src/shared/dashboard-types.ts` | modify | wire types: `SessionListRow` additions, `SessionInsightsPayload`, `burn_p90` |
| `packages/schema/src/schema.surql` | modify | `burn_buckets` field on `session_token_usage` |
| `apps/axctl/src/ingest/burn-buckets.ts` | create | pure downsampler: per-turn tokens → ≤20 buckets |
| `apps/axctl/src/ingest/burn-buckets.test.ts` | create | downsampler tests |
| `apps/axctl/src/ingest/transcripts.ts` | modify | write `burn_buckets` in Claude session_token_usage UPSERT |
| `apps/axctl/src/ingest/codex.ts` | modify | same for Codex |
| `apps/axctl/src/dashboard/sessions-list.ts` | modify | enrichment batch queries + signal/is_live computation |
| `apps/axctl/src/dashboard/sessions-list.test.ts` | create | list enrichment tests |
| `apps/axctl/src/dashboard/session-baselines.ts` | create | 30d medians + p90, in-process cache |
| `apps/axctl/src/dashboard/session-baselines.test.ts` | create | baseline math + cache tests |
| `apps/axctl/src/dashboard/session-insights.ts` | create | panel payload assembly |
| `apps/axctl/src/dashboard/session-insights.test.ts` | create | payload tests |
| `apps/axctl/src/dashboard/router/routes/sessions.ts` | modify | register `/api/sessions/:id+/insights` |
| `apps/studio/src/api.ts` | modify | `sessionInsights()` client fn |
| `apps/studio/src/styles/session-tokens.css` | create | design-system CSS variables (palette/type) |
| `apps/studio/src/components/session-insight/BurnSpark.tsx` | create | row sparkline |
| `apps/studio/src/components/session-insight/SignalBadge.tsx` | create | clean/friction badge |
| `apps/studio/src/components/session-insight/StoryBar.tsx` | create | band-1 hero bar |
| `apps/studio/src/components/session-insight/InsightPanel.tsx` | create | accordion panel: bands + footer + cells |
| `apps/studio/src/routes/sessions.tsx` | modify | new columns, chevron, accordion wiring |

The four `session-insight` components live in one new directory so the panel is testable/replaceable as a unit. `InsightPanel.tsx` holds the four band-2 cells inline (they are small, presentational, and change together); split later only if one grows logic.

---

### Task 1: Wire types

**Files:**
- Modify: `packages/lib/src/shared/dashboard-types.ts:794-830`

- [ ] **Step 1: Extend `SessionListRow` + `SessionListResponse`**

In `packages/lib/src/shared/dashboard-types.ts`, replace the `SessionListRow` interface (line 794) with:

```ts
export interface SessionListRow {
    readonly id: SessionId;
    readonly project: string | null;
    readonly source: string;
    readonly cwd: string | null;
    readonly model: string | null;
    readonly started_at: string | null;
    readonly ended_at: string | null;
    /** True when a raw transcript pointer exists (session is inspectable). */
    readonly has_raw_file: boolean;
    readonly turn_count: number;
    /** Parent session id when this row was spawned by another session (e.g. a
     *  Claude subagent / Codex agent). Null for top-level sessions. Always
     *  null on rows returned from `/api/sessions` (roots-only). Populated on
     *  rows returned from `/api/sessions/:id/children`. */
    readonly parent_session: SessionId | null;
    /** Count of direct children (subagents) this session spawned. Used by the
     *  SPA to render an expand toggle without first fetching children. Only
     *  populated on roots returned from `/api/sessions`. */
    readonly direct_children_count?: number;
    /** Enrichment block - every field nullable: aggregate rows may not exist
     *  for a session (pre-backfill ingests, 8s hook-probes, foreign sources).
     *  Sourced from session_health / session_token_usage / session_metrics
     *  batch lookups - NEVER from turn-table scans. */
    readonly cost_usd: number | null;
    /** Downsampled per-turn estimated tokens (≤20 buckets) for the BURN
     *  sparkline. Null when the ingest predates burn_buckets backfill. */
    readonly burn_buckets: ReadonlyArray<number> | null;
    /** user_corrections + tool_errors. Null when no session_health row. */
    readonly friction: number | null;
    /** 'clean' = health row exists and friction is 0. Null = no health data. */
    readonly signal: "clean" | "friction" | null;
    readonly produced_commits: number | null;
    readonly reverted_commits: number | null;
    readonly lines_added: number | null;
    readonly lines_removed: number | null;
    /** ended_at is null AND the latest health derive write is recent - the
     *  watcher re-ingests live transcripts within ~1 min, so a fresh
     *  session_health.ts is the cheapest liveness proxy. */
    readonly is_live: boolean;
}
```

`turn_count` semantics change: now populated from `session_health.turns` when available (falls back to 0). Update the doc on the field if you wish, but keep the name/type - children rows and existing consumers rely on it.

In `SessionListResponse` (line 816), add `burn_p90` after `total_count`:

```ts
export interface SessionListResponse {
    /** Root sessions only - those with no inbound `spawned` edge. To get a
     *  root's children, call `/api/sessions/:id/children`. */
    readonly sessions: ReadonlyArray<SessionListRow>;
    /** Total root count for the active filter set (independent of window). */
    readonly total_count: number;
    /** The user's 30-day p90 per-turn token burn. The SPA colors sparkline
     *  buckets amber only above this threshold. Null when no usage history. */
    readonly burn_p90: number | null;
    /** The slice that was returned. Stays pinned to the first page on the
     *  SPA side when subsequent pages are appended to the same cache key. */
    readonly window: { readonly offset: number; readonly limit: number };
}
```

- [ ] **Step 2: Add `SessionInsightsPayload`**

Append after `SessionChildrenResponse` (line 830):

```ts
/** Wire format for `/api/sessions/:id/insights` - the expandable insight
 *  panel on the sessions list. All sections optional-by-emptiness: a session
 *  with no data for a section gets an empty array / null, and the SPA hides
 *  that cell. */
export interface SessionInsightsPayload {
    readonly session: SessionId;
    readonly phases: ReadonlyArray<{
        readonly phase: string;
        readonly start_ts: string;
        readonly end_ts: string;
        readonly duration_ms: number;
    }>;
    readonly friction_ticks: ReadonlyArray<{ readonly ts: string; readonly kind: string }>;
    readonly commits: ReadonlyArray<{ readonly ts: string; readonly sha: string; readonly reverted: boolean }>;
    readonly subagent_spans: ReadonlyArray<{
        readonly id: SessionId;
        readonly started_at: string | null;
        readonly ended_at: string | null;
    }>;
    readonly checks: ReadonlyArray<{
        readonly kind: string;
        readonly runs: ReadonlyArray<{ readonly ts: string; readonly ok: boolean }>;
    }>;
    readonly loc: {
        readonly added: number;
        readonly removed: number;
    } | null;
    readonly durability: number | null;
    readonly delegation_ratio: number | null;
    readonly skills: ReadonlyArray<{ readonly name: string; readonly ts: string }>;
    /** Context-fill curve, ≤60 points; t = ms offset from session start,
     *  pct = estimated context fill 0..1 (prompt+cache tokens / window). */
    readonly context_curve: ReadonlyArray<{ readonly t: number; readonly pct: number }>;
    readonly compactions: ReadonlyArray<{ readonly ts: string }>;
    readonly baseline: {
        readonly cost_ratio: number | null;
        readonly friction_ratio: number | null;
        readonly land_ratio: number | null;
        readonly cache_pct: number | null;
    };
}
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck` (from worktree root)
Expected: FAILS in `apps/axctl/src/dashboard/sessions-list.ts` and `apps/studio` - both construct `SessionListRow` without the new fields. That's the next tasks' work; note the exact error sites. If it fails anywhere ELSE, fix that now.

- [ ] **Step 4: Stub the new fields at both construction sites so typecheck passes**

In `apps/axctl/src/dashboard/sessions-list.ts`, add to BOTH row-construction object literals (the mapper inside `fetchSessionsList` ~line 122, and the `children` mapper in `fetchSessionChildren` ~line 224):

```ts
                    cost_usd: null,
                    burn_buckets: null,
                    friction: null,
                    signal: null,
                    produced_commits: null,
                    reverted_commits: null,
                    lines_added: null,
                    lines_removed: null,
                    is_live: false,
```

And in the `fetchSessionsList` return statement add `burn_p90: null`:

```ts
        return { sessions, total_count, burn_p90: null, window: { offset, limit } };
```

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/lib/src/shared/dashboard-types.ts apps/axctl/src/dashboard/sessions-list.ts
git commit -m "feat(dashboard): wire types for sessions list enrichment + insights panel"
```

---

### Task 2: Burn-bucket downsampler (pure)

**Files:**
- Create: `apps/axctl/src/ingest/burn-buckets.ts`
- Test: `apps/axctl/src/ingest/burn-buckets.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/axctl/src/ingest/burn-buckets.test.ts
import { describe, expect, test } from "bun:test";
import { computeBurnBuckets } from "./burn-buckets.ts";

describe("computeBurnBuckets", () => {
    test("empty input -> empty array", () => {
        expect(computeBurnBuckets([])).toEqual([]);
    });

    test("fewer turns than buckets -> one bucket per turn, order preserved", () => {
        expect(computeBurnBuckets([10, 20, 30])).toEqual([10, 20, 30]);
    });

    test("exactly 20 turns -> identity", () => {
        const turns = Array.from({ length: 20 }, (_, i) => i + 1);
        expect(computeBurnBuckets(turns)).toEqual(turns);
    });

    test("more turns than buckets -> sums per bucket, total preserved", () => {
        // 40 turns of 1 token -> 20 buckets of 2
        const turns = Array.from({ length: 40 }, () => 1);
        const buckets = computeBurnBuckets(turns);
        expect(buckets).toHaveLength(20);
        expect(buckets.every((b) => b === 2)).toBe(true);
    });

    test("uneven split keeps total", () => {
        const turns = Array.from({ length: 33 }, (_, i) => i);
        const buckets = computeBurnBuckets(turns);
        expect(buckets).toHaveLength(20);
        expect(buckets.reduce((a, b) => a + b, 0)).toBe(turns.reduce((a, b) => a + b, 0));
    });

    test("non-finite and negative inputs clamp to 0", () => {
        expect(computeBurnBuckets([Number.NaN, -5, 7])).toEqual([0, 0, 7]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/ingest/burn-buckets.test.ts`
Expected: FAIL - `Cannot find module './burn-buckets.ts'`
(If a global hook blocks `bun test`, write a tmp wrapper script `/tmp/run-bun-test.sh` containing `#!/bin/sh\nexec bun test "$@"`, `chmod +x` it, and use it for every test step in this plan.)

- [ ] **Step 3: Implement**

```ts
// apps/axctl/src/ingest/burn-buckets.ts
/**
 * Downsample per-turn token counts into a fixed-size bucket array for the
 * sessions-list BURN sparkline. Bucket k sums the contiguous slice of turns
 * that maps onto it, so the series total is preserved and heavy turns stay
 * visible. Stored JSON-encoded on `session_token_usage.burn_buckets`.
 */
export const BURN_BUCKET_COUNT = 20;

export const computeBurnBuckets = (
    perTurnTokens: ReadonlyArray<number>,
    bucketCount: number = BURN_BUCKET_COUNT,
): number[] => {
    const clean = perTurnTokens.map((t) => (Number.isFinite(t) && t > 0 ? Math.trunc(t) : 0));
    if (clean.length === 0) return [];
    if (clean.length <= bucketCount) return clean;
    const buckets = new Array<number>(bucketCount).fill(0);
    for (let i = 0; i < clean.length; i++) {
        const k = Math.min(bucketCount - 1, Math.floor((i * bucketCount) / clean.length));
        buckets[k] += clean[i] ?? 0;
    }
    return buckets;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/ingest/burn-buckets.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/ingest/burn-buckets.ts apps/axctl/src/ingest/burn-buckets.test.ts
git commit -m "feat(ingest): burn-bucket downsampler for sessions-list sparkline"
```

---

### Task 3: `burn_buckets` schema field + ingest writes

**Files:**
- Modify: `packages/schema/src/schema.surql:849` (session_token_usage block)
- Modify: `apps/axctl/src/ingest/transcripts.ts:1484-1522` (`buildClaudeTokenUsageStatements`)
- Modify: `apps/axctl/src/ingest/codex.ts:~1219` (codex session_token_usage UPSERT)

- [ ] **Step 1: Add the schema field**

In `packages/schema/src/schema.surql`, inside the `session_token_usage` block (after the `metrics` field, line ~850), add:

```surql
DEFINE FIELD burn_buckets ON session_token_usage TYPE option<string>;  -- JSON-encoded number[]; sessions-list BURN sparkline
```

`option<string>` (not `string`): existing rows predate the field - a non-optional field coerces NONE and crashes ingest (see the `commit.reverted` comment at schema.surql:236 for the precedent).

- [ ] **Step 2: Run the schema test**

Run: `bun test packages/schema`
Expected: PASS (the schema render/parse tests accept the new field). This is a field add on an existing table - `SCHEMA_TABLES` registration does NOT apply (that's for new tables).

- [ ] **Step 3: Write burn_buckets in the Claude UPSERT**

In `apps/axctl/src/ingest/transcripts.ts`, import at the top of the file alongside the other ingest imports:

```ts
import { computeBurnBuckets } from "./burn-buckets.ts";
```

In `buildClaudeTokenUsageStatements` (line 1484), the per-turn series is available as `extracted.turnTokenUsages` (same data `buildClaudeTurnTokenUsageStatements` maps over; each entry has `seq` and `estimatedTokens`). Before the `return [` statement add:

```ts
    const burnBuckets = computeBurnBuckets(
        [...extracted.turnTokenUsages]
            .sort((a, b) => a.seq - b.seq)
            .map((t) => t.estimatedTokens),
    );
```

And add one pair to the `surrealObject([...])` list (after `["metrics", ...]` if present, otherwise after `["labels", ...]`):

```ts
            ["burn_buckets", burnBuckets.length > 0 ? surrealString(JSON.stringify(burnBuckets)) : "NONE"],
```

- [ ] **Step 4: Write burn_buckets in the Codex UPSERT**

In `apps/axctl/src/ingest/codex.ts`, the session_token_usage UPSERT is at ~line 1219. Find the builder function containing it and check what per-turn data is in scope: codex batches carry `turnTokenUsages: CodexTurnTokenUsage[]` (declared ~line 461/476). Apply the same pattern - import `computeBurnBuckets` from `./burn-buckets.ts`, compute from the batch's `turnTokenUsages` sorted by `seq` mapping `estimatedTokens`, and add the same `["burn_buckets", ...]` pair to the UPSERT object.

**Caveat the executor must handle:** codex flushes sessions in multiple batches (`drainedTurnTokenUsages` splicing at ~line 785). If the UPSERT site only sees one batch's turns, computing buckets from a partial batch would clobber earlier ones. Inspect the flow: if the usage builder receives cumulative per-session turn usage, wire it directly; if it receives per-batch slices, instead skip codex burn_buckets in this task and leave a `// TODO(burn-buckets): codex batching makes per-session series unavailable here; backfill via derive stage` comment plus `"NONE"` - Claude coverage is the v1 requirement, codex is best-effort.

- [ ] **Step 5: Run ingest test suites**

Run: `bun test apps/axctl/src/ingest/transcripts.test.ts apps/axctl/src/ingest/codex.test.ts`
Expected: PASS. If a transcripts test snapshot-asserts the UPSERT statement strings, update the expected strings to include `burn_buckets`.

- [ ] **Step 6: Apply schema + verify against live DB (manual, optional but recommended)**

Run: `bun run db:schema` (from worktree root; applies DDL to the local SurrealDB)
Then: `echo "SELECT burn_buckets FROM session_token_usage LIMIT 1;" | bun scripts/db-query.ts` - if no such script exists, verify via any existing query path; the assertion is just that the field is accepted.
Expected: no error; existing rows show `burn_buckets: NONE`.

- [ ] **Step 7: Commit**

```bash
git add packages/schema/src/schema.surql apps/axctl/src/ingest/transcripts.ts apps/axctl/src/ingest/codex.ts
git commit -m "feat(ingest): persist burn_buckets on session_token_usage (claude + codex)"
```

---

### Task 4: Enrich `fetchSessionsList`

**Files:**
- Modify: `apps/axctl/src/dashboard/sessions-list.ts`
- Create: `apps/axctl/src/dashboard/sessions-list.test.ts`

- [ ] **Step 1: Write the failing test**

Test pattern follows `apps/axctl/src/dashboard/classifier-explain.test.ts` (`makeTestSurrealClient` + `Effect.provideService`). The stub's `fallback` array answers queries in call order: `fetchSessionsList` issues (1) the page+count multi-statement query → `[rows, [{total}]]`, (2) the spawned-counts query → `[counts]`, (3) the NEW enrichment multi-statement query → `[health[], usage[], metrics[]]`.

```ts
// apps/axctl/src/dashboard/sessions-list.test.ts
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { makeTestSurrealClient } from "@ax/lib/testing/surreal";
import { fetchSessionsList } from "./sessions-list.ts";

const RID = "session:`aaaaaaaa-0000-0000-0000-000000000001`";
const BARE = "aaaaaaaa-0000-0000-0000-000000000001";

const pageRow = {
    id: RID,
    project: "ax",
    source: "claude",
    cwd: "/Users/x/ax",
    model: "claude-fable-5",
    started_at: "2026-06-11T01:00:00.000Z",
    ended_at: null,
    has_raw_file: true,
};

const run = (stub: SurrealClientShape) =>
    Effect.runPromise(
        fetchSessionsList({}).pipe(Effect.provideService(SurrealClient, stub)),
    );

describe("fetchSessionsList enrichment", () => {
    test("joins health/usage/metrics onto rows and computes signal", async () => {
        const stub = makeTestSurrealClient({
            denyWrites: true,
            fallback: [
                // query 1: page select + count (multi-statement -> two result sets)
                [pageRow],
                [{ total: 1 }],
                // query 2: spawned counts
                [],
                // query 3: enrichment (multi-statement -> three result sets)
                [{
                    session: RID, turns: 58, tool_errors: 5, user_corrections: 2,
                    context_pressure: "high", ts: new Date().toISOString(),
                }],
                [{
                    session: RID, estimated_cost_usd: 11.2, estimated_tokens: 3_400_000,
                    cache_read_input_tokens: 2_400_000, burn_buckets: "[100,200,300]",
                }],
                [{
                    session: RID, produced_commits: 5, reverted_commits: 1,
                    lines_added: 2100, lines_removed: 940,
                }],
            ],
        }).client;

        const res = await run(stub);
        const row = res.sessions[0]!;
        expect(row.id).toBe(BARE);
        expect(row.turn_count).toBe(58);
        expect(row.cost_usd).toBe(11.2);
        expect(row.burn_buckets).toEqual([100, 200, 300]);
        expect(row.friction).toBe(7);
        expect(row.signal).toBe("friction");
        expect(row.produced_commits).toBe(5);
        expect(row.reverted_commits).toBe(1);
        expect(row.lines_added).toBe(2100);
        expect(row.lines_removed).toBe(940);
        // ended_at null + fresh health ts -> live
        expect(row.is_live).toBe(true);
    });

    test("rows without enrichment rows render null fields, signal null, not live", async () => {
        const stub = makeTestSurrealClient({
            denyWrites: true,
            fallback: [
                [{ ...pageRow, ended_at: "2026-06-11T02:00:00.000Z" }],
                [{ total: 1 }],
                [], // spawned
                [], [], [], // empty enrichment sets
            ],
        }).client;
        const res = await run(stub);
        const row = res.sessions[0]!;
        expect(row.turn_count).toBe(0);
        expect(row.cost_usd).toBeNull();
        expect(row.burn_buckets).toBeNull();
        expect(row.friction).toBeNull();
        expect(row.signal).toBeNull();
        expect(row.is_live).toBe(false);
    });

    test("zero-friction health row -> signal clean", async () => {
        const stub = makeTestSurrealClient({
            denyWrites: true,
            fallback: [
                [pageRow],
                [{ total: 1 }],
                [],
                [{ session: RID, turns: 4, tool_errors: 0, user_corrections: 0, context_pressure: "low", ts: new Date().toISOString() }],
                [],
                [],
            ],
        }).client;
        const res = await run(stub);
        expect(res.sessions[0]!.signal).toBe("clean");
        expect(res.sessions[0]!.friction).toBe(0);
    });

    test("malformed burn_buckets JSON degrades to null", async () => {
        const stub = makeTestSurrealClient({
            denyWrites: true,
            fallback: [
                [pageRow],
                [{ total: 1 }],
                [],
                [],
                [{ session: RID, estimated_cost_usd: 1, estimated_tokens: 10, cache_read_input_tokens: 0, burn_buckets: "not json" }],
                [],
            ],
        }).client;
        const res = await run(stub);
        expect(res.sessions[0]!.burn_buckets).toBeNull();
        expect(res.sessions[0]!.cost_usd).toBe(1);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/dashboard/sessions-list.test.ts`
Expected: FAIL - enrichment fields are stubbed null/0 from Task 1.

Note: if `makeTestSurrealClient`'s `fallback` answers *per `.query()` call* (arrays-of-result-sets) rather than per result set, restructure the fallback nesting accordingly - open `packages/lib/src/testing/surreal.ts` and match its actual contract before fighting the test.

- [ ] **Step 3: Implement enrichment in `fetchSessionsList`**

In `apps/axctl/src/dashboard/sessions-list.ts`:

Add near the top (after `formatRecordIdList`):

```ts
/** ended_at-null sessions count as live only when the health derive row was
 *  written recently - the watcher re-ingests live transcripts within ~1 min,
 *  so a stale ts means the session is dead, just never closed. */
const LIVE_HEALTH_TS_WINDOW_MS = 10 * 60_000;

interface HealthRow {
    readonly session: string;
    readonly turns: number | null;
    readonly tool_errors: number | null;
    readonly user_corrections: number | null;
    readonly context_pressure: string | null;
    readonly ts: string | null;
}
interface UsageRow {
    readonly session: string;
    readonly estimated_cost_usd: number | null;
    readonly estimated_tokens: number | null;
    readonly cache_read_input_tokens: number | null;
    readonly burn_buckets: string | null;
}
interface MetricsRow {
    readonly session: string;
    readonly produced_commits: number | null;
    readonly reverted_commits: number | null;
    readonly lines_added: number | null;
    readonly lines_removed: number | null;
}

const parseBurnBuckets = (raw: string | null): number[] | null => {
    if (!raw) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return null;
        return parsed.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : 0));
    } catch {
        return null;
    }
};
```

Then in `fetchSessionsList`, after the spawned-counts query block (line ~160) and BEFORE the `sessions` mapping, add the enrichment fetch (single multi-statement round-trip, same websocket-framing rationale as the page query):

```ts
        // Enrichment: one multi-statement round-trip against the three
        // per-session aggregate tables. All keyed `session IN [...]` on
        // UNIQUE session indexes - no turn scans, no graph derefs (the two
        // documented hang classes for this surface).
        const healthBySession = new Map<string, HealthRow>();
        const usageBySession = new Map<string, UsageRow>();
        const metricsBySession = new Map<string, MetricsRow>();
        if (rawIds.length > 0) {
            const inList = formatRecordIdList(rawIds);
            const [health, usage, metrics] = yield* db.query<[
                HealthRow[],
                UsageRow[],
                MetricsRow[],
            ]>(`
                SELECT <string>session AS session, turns, tool_errors,
                       user_corrections, context_pressure, <string>ts AS ts
                FROM session_health WHERE session IN [${inList}];
                SELECT <string>session AS session, estimated_cost_usd,
                       estimated_tokens, cache_read_input_tokens, burn_buckets
                FROM session_token_usage WHERE session IN [${inList}];
                SELECT <string>session AS session, produced_commits,
                       reverted_commits, lines_added, lines_removed
                FROM session_metrics WHERE session IN [${inList}];
            `);
            for (const h of health) healthBySession.set(h.session, h);
            for (const u of usage) usageBySession.set(u.session, u);
            for (const m of metrics) metricsBySession.set(m.session, m);
        }
```

Replace the final `sessions` mapping (currently only fills `direct_children_count`) with:

```ts
        const now = Date.now();
        const sessions: SessionListRow[] = paged.items.map((s) => {
            const rawId = rawIdByBare.get(s.id) ?? "";
            const health = healthBySession.get(rawId);
            const usage = usageBySession.get(rawId);
            const metrics = metricsBySession.get(rawId);
            const friction = health
                ? (Number(health.user_corrections) || 0) + (Number(health.tool_errors) || 0)
                : null;
            const healthTs = health?.ts ? new Date(health.ts).getTime() : Number.NaN;
            return {
                ...s,
                direct_children_count: childCountByRawId.get(rawId) ?? 0,
                turn_count: health?.turns ?? 0,
                cost_usd: usage?.estimated_cost_usd ?? null,
                burn_buckets: parseBurnBuckets(usage?.burn_buckets ?? null),
                friction,
                signal: friction === null ? null : friction === 0 ? "clean" : "friction",
                produced_commits: metrics?.produced_commits ?? null,
                reverted_commits: metrics?.reverted_commits ?? null,
                lines_added: metrics?.lines_added ?? null,
                lines_removed: metrics?.lines_removed ?? null,
                is_live: s.ended_at === null
                    && Number.isFinite(healthTs)
                    && now - healthTs < LIVE_HEALTH_TS_WINDOW_MS,
            };
        });
```

Leave `burn_p90: null` in the return for now - Task 5 wires it.

- [ ] **Step 4: Run tests**

Run: `bun test apps/axctl/src/dashboard/sessions-list.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Typecheck + full dashboard test sweep**

Run: `bun run typecheck && bun test apps/axctl/src/dashboard`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/axctl/src/dashboard/sessions-list.ts apps/axctl/src/dashboard/sessions-list.test.ts
git commit -m "feat(dashboard): enrich sessions list rows from per-session aggregates"
```

---

### Task 5: Baselines module (30d medians + burn p90)

**Files:**
- Create: `apps/axctl/src/dashboard/session-baselines.ts`
- Test: `apps/axctl/src/dashboard/session-baselines.test.ts`
- Modify: `apps/axctl/src/dashboard/sessions-list.ts` (wire `burn_p90`)

- [ ] **Step 1: Write the failing test**

```ts
// apps/axctl/src/dashboard/session-baselines.test.ts
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { makeTestSurrealClient } from "@ax/lib/testing/surreal";
import { fetchSessionBaselines, median, p90, _resetBaselineCacheForTests } from "./session-baselines.ts";

describe("baseline math", () => {
    test("median of odd/even/empty", () => {
        expect(median([3, 1, 2])).toBe(2);
        expect(median([4, 1, 2, 3])).toBe(2.5);
        expect(median([])).toBeNull();
    });
    test("p90 picks the 90th percentile (nearest-rank)", () => {
        const xs = Array.from({ length: 100 }, (_, i) => i + 1);
        expect(p90(xs)).toBe(90);
        expect(p90([])).toBeNull();
    });
});

describe("fetchSessionBaselines", () => {
    test("computes medians from 30d aggregate rows and caches", async () => {
        _resetBaselineCacheForTests();
        let calls = 0;
        const stub = makeTestSurrealClient({
            denyWrites: true,
            handler: (sql) => {
                calls++;
                // one multi-statement query -> three result sets
                return [
                    [{ estimated_cost_usd: 2 }, { estimated_cost_usd: 4 }],
                    [{ friction: 1 }, { friction: 3 }],
                    [{ time_to_land_ms: 100 }, { time_to_land_ms: 300 }],
                ];
            },
        }).client;

        const a = await Effect.runPromise(
            fetchSessionBaselines().pipe(Effect.provideService(SurrealClient, stub)),
        );
        expect(a.median_cost_usd).toBe(3);
        expect(a.median_friction).toBe(2);
        expect(a.median_time_to_land_ms).toBe(200);

        await Effect.runPromise(
            fetchSessionBaselines().pipe(Effect.provideService(SurrealClient, stub)),
        );
        expect(calls).toBe(1); // second call served from cache
    });
});
```

(If `makeTestSurrealClient` has no `handler` option, use `fallback` with the three result sets and assert cache behaviour by checking that a second call with an EMPTY fallback still resolves - read `packages/lib/src/testing/surreal.ts` first and adapt; the assertions stay the same.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/dashboard/session-baselines.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement**

```ts
// apps/axctl/src/dashboard/session-baselines.ts
/**
 * 30-day per-user baselines for the sessions-list insight panel footer
 * ("vs 30d median") and the BURN sparkline amber threshold (p90 per-turn
 * burn). Computed from the per-session aggregate tables only - bounded by
 * the 30d window, no turn scans. Cached in-process: the numbers move on
 * ingest cadence, not request cadence.
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";

export interface SessionBaselines {
    readonly median_cost_usd: number | null;
    readonly median_friction: number | null;
    readonly median_time_to_land_ms: number | null;
    readonly burn_p90: number | null;
}

export const median = (xs: ReadonlyArray<number>): number | null => {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

export const p90 = (xs: ReadonlyArray<number>): number | null => {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)]!;
};

const CACHE_TTL_MS = 5 * 60_000;
let cache: { at: number; value: SessionBaselines } | null = null;
export const _resetBaselineCacheForTests = (): void => { cache = null; };

export const fetchSessionBaselines = (): Effect.Effect<SessionBaselines, DbError, SurrealClient> =>
    Effect.gen(function* () {
        if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
        const db = yield* SurrealClient;
        // burn p90 source: average per-turn burn per session
        // (estimated_tokens / health.turns) is a cheap proxy that avoids
        // touching turn_token_usage at all; good enough for a color
        // threshold.
        const [costs, frictions, lands] = yield* db.query<[
            Array<{ estimated_cost_usd: number | null }>,
            Array<{ friction: number | null }>,
            Array<{ time_to_land_ms: number | null }>,
        ]>(`
            SELECT estimated_cost_usd FROM session_token_usage
                WHERE ts > time::now() - 30d AND estimated_cost_usd IS NOT NONE;
            SELECT (user_corrections + tool_errors) AS friction FROM session_health
                WHERE ts > time::now() - 30d;
            SELECT time_to_land_ms FROM session_metrics
                WHERE ts > time::now() - 30d AND time_to_land_ms IS NOT NONE;
        `);
        const [burns] = yield* db.query<[
            Array<{ avg_burn: number | null }>,
        ]>(`
            SELECT (estimated_tokens / math::max([turns, 1])) AS avg_burn
            FROM (
                SELECT estimated_tokens, turns FROM session_health
                WHERE ts > time::now() - 30d AND turns > 0
            );
        `);
        const value: SessionBaselines = {
            median_cost_usd: median(costs.map((r) => Number(r.estimated_cost_usd)).filter(Number.isFinite)),
            median_friction: median(frictions.map((r) => Number(r.friction)).filter(Number.isFinite)),
            median_time_to_land_ms: median(lands.map((r) => Number(r.time_to_land_ms)).filter(Number.isFinite)),
            burn_p90: p90(burns.map((r) => Number(r.avg_burn)).filter(Number.isFinite)),
        };
        cache = { at: Date.now(), value };
        return value;
    });
```

**SurrealQL caveat for the executor:** the nested-`FROM (SELECT ...)` form and `math::max([..])` must be verified against SurrealDB 3.0.x before trusting - if either misbehaves, fetch `estimated_tokens, turns` rows plainly and do the division in JS (preferred fallback; keep aggregates deref-free per the documented hang class).

- [ ] **Step 4: Run tests**

Run: `bun test apps/axctl/src/dashboard/session-baselines.test.ts`
Expected: PASS

- [ ] **Step 5: Wire `burn_p90` into the list response**

In `apps/axctl/src/dashboard/sessions-list.ts` import and call it (degrade to null on failure - enrichment must never break the base list):

```ts
import { fetchSessionBaselines } from "./session-baselines.ts";
```

Replace `burn_p90: null` in the return with a guarded fetch placed just before the return:

```ts
        const baselines = yield* fetchSessionBaselines().pipe(
            Effect.catchAll(() => Effect.succeed(null)),
        );
        return {
            sessions,
            total_count,
            burn_p90: baselines?.burn_p90 ?? null,
            window: { offset, limit },
        };
```

Update `apps/axctl/src/dashboard/sessions-list.test.ts`: the stub now receives one more query (baselines). Add to each test's `fallback` the extra result sets (`[], [], []` and `[]` for the burns query), or call `_resetBaselineCacheForTests()` in a `beforeEach` and append empty sets - match the client contract you established in Task 4 Step 2.

- [ ] **Step 6: Run tests + typecheck**

Run: `bun test apps/axctl/src/dashboard && bun run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/axctl/src/dashboard/session-baselines.ts apps/axctl/src/dashboard/session-baselines.test.ts apps/axctl/src/dashboard/sessions-list.ts apps/axctl/src/dashboard/sessions-list.test.ts
git commit -m "feat(dashboard): 30d session baselines (medians + burn p90) with in-process cache"
```

---

### Task 6: `/api/sessions/:id/insights` endpoint

**Files:**
- Create: `apps/axctl/src/dashboard/session-insights.ts`
- Test: `apps/axctl/src/dashboard/session-insights.test.ts`
- Modify: `apps/axctl/src/dashboard/router/routes/sessions.ts`

- [ ] **Step 1: Reconnoitre `diagnostic_event.status` values (5 min, informs the ok-mapping)**

Run a one-off query against the live DB (any existing query path, e.g. `ax recall` debug or a scratch bun script):

```surql
SELECT status, count() AS c FROM diagnostic_event GROUP BY status;
SELECT kind, count() AS c FROM diagnostic_event GROUP BY kind;
```

Record the real values in a comment in `session-insights.ts`. The implementation below assumes pass-ish statuses are `pass|passed|success|ok` and everything else is a failure; adjust the `OK_STATUSES` set to the observed values.

- [ ] **Step 2: Write the failing test**

```ts
// apps/axctl/src/dashboard/session-insights.test.ts
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { makeTestSurrealClient } from "@ax/lib/testing/surreal";
import { fetchSessionInsights } from "./session-insights.ts";
import { _resetBaselineCacheForTests } from "./session-baselines.ts";

const BARE = "aaaaaaaa-0000-0000-0000-000000000001";

describe("fetchSessionInsights", () => {
    test("assembles full payload", async () => {
        _resetBaselineCacheForTests();
        const stub = makeTestSurrealClient({
            denyWrites: true,
            fallback: [
                // q1 multi-statement: phases, reactions, produced-commits, spawned, diagnostics, invoked, metrics, usage(+health single)
                [{ phase: "plan", start_ts: "2026-06-11T01:00:00Z", end_ts: "2026-06-11T01:12:00Z", duration_ms: 720000 }],
                [{ ts: "2026-06-11T01:20:00Z", reaction_type: "correction" }],
                [{ ts: "2026-06-11T01:30:00Z", sha: "abc123", reverted: true }],
                [{ id: "session:`bbbbbbbb-0000-0000-0000-000000000002`", started_at: "2026-06-11T01:05:00Z", ended_at: "2026-06-11T01:15:00Z" }],
                [{ kind: "test", status: "fail", ts: "2026-06-11T01:21:00Z" }, { kind: "test", status: "pass", ts: "2026-06-11T01:25:00Z" }],
                [{ skill: "skill:`superpowers__tdd`", ts: "2026-06-11T01:02:00Z" }],
                [{ lines_added: 2100, lines_removed: 940, durability_ratio: 0.8, delegation_ratio: 0.38, time_to_land_ms: 200 }],
                [{ estimated_cost_usd: 11.2, context_window: 200000, cache_read_input_tokens: 100, prompt_tokens: 50, estimated_tokens: 150, user_corrections: 2, tool_errors: 5 }],
                // q2: turn_token_usage curve
                [{ seq: 1, prompt_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ts: "2026-06-11T01:01:00Z" }],
                // q3: compactions
                [{ ts: "2026-06-11T01:40:00Z" }],
                // q4 (baselines, via fetchSessionBaselines): 3 sets + burns
                [{ estimated_cost_usd: 5.6 }], [{ friction: 7 }], [{ time_to_land_ms: 400 }],
                [{ avg_burn: 100 }],
            ],
        }).client;

        const p = await Effect.runPromise(
            fetchSessionInsights(BARE).pipe(Effect.provideService(SurrealClient, stub)),
        );
        expect(p.session).toBe(BARE);
        expect(p.phases[0]?.phase).toBe("plan");
        expect(p.friction_ticks[0]?.kind).toBe("correction");
        expect(p.commits[0]).toEqual({ ts: "2026-06-11T01:30:00Z", sha: "abc123", reverted: true });
        expect(p.subagent_spans[0]?.id).toBe("bbbbbbbb-0000-0000-0000-000000000002");
        expect(p.checks).toEqual([{ kind: "test", runs: [
            { ts: "2026-06-11T01:21:00Z", ok: false },
            { ts: "2026-06-11T01:25:00Z", ok: true },
        ]}]);
        expect(p.skills[0]?.name).toBe("superpowers:tdd");
        expect(p.loc).toEqual({ added: 2100, removed: 940 });
        expect(p.durability).toBe(0.8);
        expect(p.context_curve.length).toBeGreaterThan(0);
        expect(p.compactions).toHaveLength(1);
        expect(p.baseline.cost_ratio).toBe(2); // 11.2 / 5.6
        expect(p.baseline.friction_ratio).toBe(1); // (2+5)/7
        expect(p.baseline.land_ratio).toBe(0.5); // 200/400
    });

    test("empty session -> empty sections, null baseline ratios", async () => {
        _resetBaselineCacheForTests();
        const stub = makeTestSurrealClient({
            denyWrites: true,
            fallback: [
                [], [], [], [], [], [], [], [],
                [],
                [],
                [], [], [], [],
            ],
        }).client;
        const p = await Effect.runPromise(
            fetchSessionInsights(BARE).pipe(Effect.provideService(SurrealClient, stub)),
        );
        expect(p.phases).toEqual([]);
        expect(p.loc).toBeNull();
        expect(p.baseline.cost_ratio).toBeNull();
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test apps/axctl/src/dashboard/session-insights.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 4: Implement**

```ts
// apps/axctl/src/dashboard/session-insights.ts
/**
 * Insight-panel payload for one session - feeds the expandable accordion on
 * the sessions list (`/api/sessions/:id/insights`). Everything here is
 * single-session scoped and index-backed: phase_span / reaction_event /
 * produced / spawned / diagnostic_event / invoked / session_metrics /
 * session_token_usage+session_health by session id, turn_token_usage via the
 * (session, seq) index. Single-session edge derefs (produced.out.sha) are
 * bounded and safe - the documented deref hang was an 87k-edge AGGREGATE,
 * not a one-session lookup.
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import type { SessionInsightsPayload } from "@ax/lib/shared/dashboard-types";
import { toBareSessionId, toSessionRid } from "@ax/lib/shared/session-id";
import { fetchSessionBaselines } from "./session-baselines.ts";

/** Verified against live data in Task 6 Step 1 - adjust if the GROUP BY
 *  showed different status vocabulary. */
const OK_STATUSES = new Set(["pass", "passed", "success", "ok"]);

const CURVE_MAX_POINTS = 60;
const DEFAULT_CONTEXT_WINDOW = 200_000;

/** skill record key -> human name: strip table prefix/backticks, decode the
 *  `__` plugin-namespace encoding (see packages/lib/src/skill-id.ts). */
const skillNameFromKey = (key: string): string =>
    key.replace(/^skill:/, "").replace(/`/g, "").replace(/__/g, ":");

const ratio = (a: number | null | undefined, b: number | null | undefined): number | null =>
    a !== null && a !== undefined && b !== null && b !== undefined && Number.isFinite(a) && Number.isFinite(b) && b > 0
        ? a / b
        : null;

export const fetchSessionInsights = (
    bareId: string,
): Effect.Effect<SessionInsightsPayload, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const session = toBareSessionId(bareId);
        const rid = toSessionRid(session);

        const [phases, reactions, commits, spawnedRows, diagnostics, invokedRows, metricsRows, usageRows] =
            yield* db.query<[
                Array<{ phase: string; start_ts: string; end_ts: string; duration_ms: number }>,
                Array<{ ts: string; reaction_type: string }>,
                Array<{ ts: string; sha: string; reverted: boolean | null }>,
                Array<{ id: string; started_at: string | null; ended_at: string | null }>,
                Array<{ kind: string; status: string | null; ts: string }>,
                Array<{ skill: string; ts: string }>,
                Array<{ lines_added: number; lines_removed: number; durability_ratio: number | null; delegation_ratio: number | null; time_to_land_ms: number | null }>,
                Array<{ estimated_cost_usd: number | null; context_window: number | null; cache_read_input_tokens: number | null; prompt_tokens: number | null; estimated_tokens: number | null; user_corrections: number | null; tool_errors: number | null }>,
            ]>(`
                SELECT phase, <string>start_ts AS start_ts, <string>end_ts AS end_ts, duration_ms
                    FROM phase_span WHERE session = ${rid} ORDER BY start_ts ASC;
                SELECT <string>ts AS ts, reaction_type
                    FROM reaction_event WHERE session = ${rid} AND polarity = 'negative' ORDER BY ts ASC;
                SELECT <string>out.ts AS ts, out.sha AS sha, out.reverted AS reverted
                    FROM produced WHERE in = ${rid};
                SELECT <string>out AS id, <string>out.started_at AS started_at, <string>out.ended_at AS ended_at
                    FROM spawned WHERE in = ${rid};
                SELECT kind, status, <string>ts AS ts
                    FROM diagnostic_event WHERE session = ${rid} ORDER BY ts ASC;
                SELECT <string>out AS skill, <string>ts AS ts
                    FROM invoked WHERE session = ${rid} ORDER BY ts ASC;
                SELECT lines_added, lines_removed, durability_ratio, delegation_ratio, time_to_land_ms
                    FROM session_metrics WHERE session = ${rid};
                SELECT estimated_cost_usd, context_window, cache_read_input_tokens, prompt_tokens, estimated_tokens,
                       (SELECT VALUE user_corrections FROM session_health WHERE session = ${rid})[0] AS user_corrections,
                       (SELECT VALUE tool_errors FROM session_health WHERE session = ${rid})[0] AS tool_errors
                    FROM session_token_usage WHERE session = ${rid};
            `);

        const [turnUsage] = yield* db.query<[
            Array<{ seq: number; prompt_tokens: number | null; cache_read_input_tokens: number | null; cache_creation_input_tokens: number | null; ts: string }>,
        ]>(`
            SELECT seq, prompt_tokens, cache_read_input_tokens, cache_creation_input_tokens, <string>ts AS ts
            FROM turn_token_usage WHERE session = ${rid} ORDER BY seq ASC;
        `);

        const [compactionRows] = yield* db.query<[Array<{ ts: string }>]>(`
            SELECT <string>ts AS ts FROM compaction WHERE session = ${rid} ORDER BY ts ASC;
        `);

        const metrics = metricsRows[0] ?? null;
        const usage = usageRows[0] ?? null;

        // context curve: per-turn input-side tokens vs window, downsampled
        const window = usage?.context_window ?? DEFAULT_CONTEXT_WINDOW;
        const t0 = turnUsage[0]?.ts ? new Date(turnUsage[0].ts).getTime() : 0;
        const allPoints = turnUsage.map((u) => ({
            t: u.ts ? Math.max(0, new Date(u.ts).getTime() - t0) : 0,
            pct: Math.min(1, ((u.prompt_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)) / window),
        }));
        const stride = Math.max(1, Math.ceil(allPoints.length / CURVE_MAX_POINTS));
        const context_curve = allPoints.filter((_, i) => i % stride === 0 || i === allPoints.length - 1);

        // checks: group diagnostics by kind, runs in ts order
        const byKind = new Map<string, Array<{ ts: string; ok: boolean }>>();
        for (const d of diagnostics) {
            const runs = byKind.get(d.kind) ?? [];
            runs.push({ ts: d.ts, ok: d.status !== null && OK_STATUSES.has(d.status.toLowerCase()) });
            byKind.set(d.kind, runs);
        }

        const friction = usage && (usage.user_corrections !== null || usage.tool_errors !== null)
            ? (Number(usage.user_corrections) || 0) + (Number(usage.tool_errors) || 0)
            : null;

        const baselines = yield* fetchSessionBaselines().pipe(
            Effect.catchAll(() => Effect.succeed(null)),
        );
        const cacheTokens = usage?.cache_read_input_tokens ?? null;
        const totalTokens = usage?.estimated_tokens ?? null;

        return {
            session,
            phases,
            friction_ticks: reactions.map((r) => ({ ts: r.ts, kind: r.reaction_type })),
            commits: commits
                .filter((c) => c.sha && c.ts)
                .map((c) => ({ ts: c.ts, sha: c.sha, reverted: c.reverted === true }))
                .sort((a, b) => a.ts.localeCompare(b.ts)),
            subagent_spans: spawnedRows.map((s) => ({
                id: toBareSessionId(s.id),
                started_at: s.started_at,
                ended_at: s.ended_at,
            })),
            checks: Array.from(byKind.entries()).map(([kind, runs]) => ({ kind, runs })),
            loc: metrics ? { added: metrics.lines_added, removed: metrics.lines_removed } : null,
            durability: metrics?.durability_ratio ?? null,
            delegation_ratio: metrics?.delegation_ratio ?? null,
            skills: invokedRows.map((r) => ({ name: skillNameFromKey(r.skill), ts: r.ts })),
            context_curve,
            compactions: compactionRows,
            baseline: {
                cost_ratio: ratio(usage?.estimated_cost_usd, baselines?.median_cost_usd),
                friction_ratio: ratio(friction, baselines?.median_friction),
                land_ratio: ratio(metrics?.time_to_land_ms, baselines?.median_time_to_land_ms),
                cache_pct: cacheTokens !== null && totalTokens !== null && totalTokens > 0
                    ? cacheTokens / totalTokens
                    : null,
            },
        };
    });
```

**SurrealQL caveats for the executor:** (a) the inline `(SELECT VALUE ... )[0]` subquery for health counters inside the usage select must be verified on 3.0.x - if it misbehaves, issue it as a 9th plain statement in the same multi-statement query and merge in JS (preferred if in doubt); (b) `out.sha` derefs on `produced`/`spawned` edges of ONE session are bounded (≤ dozens) and fine; do NOT copy this pattern into cross-session aggregates.

- [ ] **Step 5: Run tests**

Run: `bun test apps/axctl/src/dashboard/session-insights.test.ts`
Expected: PASS

- [ ] **Step 6: Register the route**

In `apps/axctl/src/dashboard/router/routes/sessions.ts`, import:

```ts
import { fetchSessionInsights } from "../../session-insights.ts";
```

Add to `sessionRoutes` BEFORE the catch-all `/api/sessions/:id+` entry (order matters - the catch-all must stay last; mirror how `/children` sits above it):

```ts
    legacyGetRoute({
        path: "/api/sessions/:id+/insights",
        decode: requiredSessionId,
        handler: (id) => fetchSessionInsights(id),
    }),
```

- [ ] **Step 7: Typecheck + dashboard tests + smoke**

Run: `bun run typecheck && bun test apps/axctl/src/dashboard`
Expected: PASS

Smoke (optional, needs running DB): `bin/axctl serve` in one shell, then
`curl -s "http://127.0.0.1:1799/api/sessions?limit=3" | jq '.sessions[0] | {turn_count, cost_usd, signal}'` and
`curl -s "http://127.0.0.1:1799/api/sessions/<some-id>/insights" | jq 'keys'`.

- [ ] **Step 8: Commit**

```bash
git add apps/axctl/src/dashboard/session-insights.ts apps/axctl/src/dashboard/session-insights.test.ts apps/axctl/src/dashboard/router/routes/sessions.ts
git commit -m "feat(dashboard): /api/sessions/:id/insights panel endpoint"
```

---

### Task 7: SPA - design tokens + api client

**Files:**
- Create: `apps/studio/src/styles/session-tokens.css`
- Modify: `apps/studio/src/api.ts` (add `sessionInsights`)

- [ ] **Step 1: Create the token stylesheet**

```css
/* apps/studio/src/styles/session-tokens.css
   Sessions-list design system - one hue per meaning (see
   docs/superpowers/specs/2026-06-11-sessions-list-remakeover-design.md).
   red = failure/friction/revert/delete ONLY; green = pass/landed/add/live
   ONLY; amber = elevated-not-failed ONLY; slate ramp = phases; violet =
   subagents ONLY; source hues = badges ONLY; selection/open state =
   monochrome ink. */
:root {
  --sx-ink-900: #1c2127;
  --sx-ink-600: #555c66;
  --sx-ink-500: #6e7681;
  --sx-ink-300: #b6bcc4;
  --sx-line-200: #e4e7eb;
  --sx-line-100: #f0f2f4;
  --sx-tint-50: #f7f8fa;
  --sx-red-700: #b13434;
  --sx-red-300: #e39891;
  --sx-red-100: #faeceb;
  --sx-green-700: #1f7a3f;
  --sx-green-300: #8fc6a0;
  --sx-green-100: #e8f3ec;
  --sx-amber-700: #8f6514;
  --sx-amber-500: #d99a32;
  --sx-amber-100: #faf1dc;
  --sx-phase-plan: #c9d4e0;
  --sx-phase-exec: #8da2b6;
  --sx-phase-review: #5e7590;
  --sx-phase-idle: #ececec;
  --sx-violet-500: #a193cb;
  --sx-violet-700: #6f5fa3;
  --sx-chart-line: #9aa7b6;
}
```

Import it where the studio app pulls global styles - find the entry with `rg -n "import.*\.css" apps/studio/src/main.tsx apps/studio/src/root.tsx apps/studio/src/app.tsx 2>/dev/null` and add `import "./styles/session-tokens.css";` next to the existing global CSS import.

- [ ] **Step 2: Add the api client fn**

In `apps/studio/src/api.ts`, import `SessionInsightsPayload` from `@ax/lib/shared/dashboard-types` (extend the existing type-import statement), then add next to `sessionChildren` (~line 255):

```ts
    sessionInsights: (sessionId: string): Promise<SessionInsightsPayload> =>
        jsonFetch(`/api/sessions/${encodeURIComponent(sessionId)}/insights`),
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/studio/src/styles/session-tokens.css apps/studio/src/api.ts apps/studio/src/main.tsx
git commit -m "feat(studio): session design tokens + insights api client"
```

(Adjust the third path to whichever file got the CSS import.)

---

### Task 8: SPA - BurnSpark + SignalBadge row components

**Files:**
- Create: `apps/studio/src/components/session-insight/BurnSpark.tsx`
- Create: `apps/studio/src/components/session-insight/SignalBadge.tsx`

No unit-test harness exists for studio components (no jsdom setup in repo); these are presentational and verified by typecheck + the Task 10 visual pass. Keep them logic-free enough that this is honest.

- [ ] **Step 1: BurnSpark**

```tsx
// apps/studio/src/components/session-insight/BurnSpark.tsx
/** Per-turn token-burn sparkline for a sessions-list row. Bars are neutral
 *  gray; only buckets above the user's 30d p90 (server-provided) go amber -
 *  so amber appearing in the table at all marks an outlier row. */
export function BurnSpark({ buckets, p90 }: {
    readonly buckets: ReadonlyArray<number> | null;
    readonly p90: number | null;
}) {
    if (!buckets || buckets.length === 0) {
        return <span style={{ color: "var(--sx-ink-300)" }}>–</span>;
    }
    const max = Math.max(...buckets, 1);
    return (
        <span style={{ display: "inline-flex", alignItems: "flex-end", gap: 1, height: 14 }} aria-hidden>
            {buckets.map((b, i) => (
                <i
                    key={i}
                    style={{
                        display: "block",
                        width: 3,
                        borderRadius: "1px 1px 0 0",
                        height: Math.max(2, Math.round((b / max) * 14)),
                        background: p90 !== null && b > p90 ? "var(--sx-amber-500)" : "var(--sx-ink-300)",
                    }}
                />
            ))}
        </span>
    );
}
```

- [ ] **Step 2: SignalBadge**

```tsx
// apps/studio/src/components/session-insight/SignalBadge.tsx
/** Rightmost triage badge: clean (green) / friction N (red) / – (no data). */
export function SignalBadge({ signal, friction }: {
    readonly signal: "clean" | "friction" | null;
    readonly friction: number | null;
}) {
    if (signal === null) return <span style={{ color: "var(--sx-ink-300)" }}>–</span>;
    const warn = signal === "friction";
    return (
        <span style={{
            fontSize: 10,
            fontWeight: 600,
            padding: "1px 6px",
            borderRadius: 2,
            background: warn ? "var(--sx-red-100)" : "var(--sx-green-100)",
            color: warn ? "var(--sx-red-700)" : "var(--sx-green-700)",
        }}>
            {warn ? `friction ${friction ?? ""}` : "clean"}
        </span>
    );
}
```

- [ ] **Step 3: Typecheck + commit**

Run: `bun run typecheck`
Expected: PASS

```bash
git add apps/studio/src/components/session-insight/BurnSpark.tsx apps/studio/src/components/session-insight/SignalBadge.tsx
git commit -m "feat(studio): BurnSpark + SignalBadge row components"
```

---

### Task 9: SPA - StoryBar + InsightPanel

**Files:**
- Create: `apps/studio/src/components/session-insight/StoryBar.tsx`
- Create: `apps/studio/src/components/session-insight/InsightPanel.tsx`

- [ ] **Step 1: StoryBar**

All positioning is percentage-of-session-duration; the session window comes from the row (`started_at`/`ended_at`) with a fallback to the phase extents.

```tsx
// apps/studio/src/components/session-insight/StoryBar.tsx
import type { SessionInsightsPayload } from "@ax/lib/shared/dashboard-types";

const PHASE_COLOR: Record<string, string> = {
    plan: "var(--sx-phase-plan)",
    execute: "var(--sx-phase-exec)",
    exec: "var(--sx-phase-exec)",
    review: "var(--sx-phase-review)",
};

const fmtMs = (ms: number): string =>
    ms < 60_000 ? `${Math.round(ms / 1000)}s`
    : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m`
    : `${(ms / 3_600_000).toFixed(1)}h`;

/** Band-1 hero: phase segments + friction ticks + commit dots + subagent
 *  lanes on one session-time axis. Idle = uncovered axis (the track's idle
 *  color shows through wherever no phase segment sits). */
export function StoryBar({ insights, startedAt, endedAt }: {
    readonly insights: SessionInsightsPayload;
    readonly startedAt: string | null;
    readonly endedAt: string | null;
}) {
    const phases = insights.phases;
    const tsList = [
        ...(startedAt ? [new Date(startedAt).getTime()] : []),
        ...phases.map((p) => new Date(p.start_ts).getTime()),
    ].filter(Number.isFinite);
    const endList = [
        ...(endedAt ? [new Date(endedAt).getTime()] : []),
        ...phases.map((p) => new Date(p.end_ts).getTime()),
    ].filter(Number.isFinite);
    if (tsList.length === 0 || endList.length === 0) return null;
    const t0 = Math.min(...tsList);
    const t1 = Math.max(...endList);
    const span = Math.max(1, t1 - t0);
    const pct = (ts: string): number =>
        Math.min(100, Math.max(0, ((new Date(ts).getTime() - t0) / span) * 100));

    const hasLanes = insights.subagent_spans.length > 0;
    const phaseTotals = new Map<string, number>();
    for (const p of phases) {
        phaseTotals.set(p.phase, (phaseTotals.get(p.phase) ?? 0) + p.duration_ms);
    }
    const covered = phases.reduce((a, p) => a + p.duration_ms, 0);
    const idleMs = Math.max(0, span - covered);
    const reverted = insights.commits.filter((c) => c.reverted).length;

    return (
        <div style={{ maxWidth: 760 }}>
            <div style={{
                fontSize: 10, color: "var(--sx-ink-500)", letterSpacing: "0.06em",
                textTransform: "uppercase", fontWeight: 600, marginBottom: 8,
            }}>Story</div>
            <div style={{ position: "relative", width: "100%", height: hasLanes ? 36 : 24 }}>
                {/* idle track */}
                <span style={{ position: "absolute", top: 1, left: 0, right: 0, height: 10, background: "var(--sx-phase-idle)" }} />
                {phases.map((p, i) => (
                    <span key={i} style={{
                        position: "absolute", top: 1, height: 10,
                        left: `${pct(p.start_ts)}%`,
                        width: `${Math.max(0.5, pct(p.end_ts) - pct(p.start_ts))}%`,
                        background: PHASE_COLOR[p.phase] ?? "var(--sx-phase-exec)",
                    }} />
                ))}
                {insights.friction_ticks.map((f, i) => (
                    <span key={`f${i}`} title={f.kind} style={{
                        position: "absolute", top: -3, width: 2, height: 18,
                        left: `${pct(f.ts)}%`, background: "var(--sx-red-700)",
                    }} />
                ))}
                {insights.commits.map((c, i) => c.reverted ? (
                    <span key={`c${i}`} title={`${c.sha} (reverted)`} style={{
                        position: "absolute", top: 13, left: `${pct(c.ts)}%`,
                        color: "var(--sx-red-700)", fontSize: 9, fontWeight: 700, lineHeight: 1,
                    }}>✕</span>
                ) : (
                    <span key={`c${i}`} title={c.sha} style={{
                        position: "absolute", top: 15, width: 7, height: 7, borderRadius: "50%",
                        left: `${pct(c.ts)}%`, background: "var(--sx-green-700)",
                    }} />
                ))}
                {insights.subagent_spans.map((s, i) => s.started_at ? (
                    <span key={`a${i}`} title={s.id} style={{
                        position: "absolute", top: 27, height: 5, borderRadius: 2,
                        left: `${pct(s.started_at)}%`,
                        width: `${Math.max(1, (s.ended_at ? pct(s.ended_at) : 100) - pct(s.started_at))}%`,
                        background: "var(--sx-violet-500)",
                    }} />
                ) : null)}
            </div>
            <div style={{ fontSize: 10, color: "var(--sx-ink-500)", marginTop: 6, lineHeight: 1.5 }}>
                {Array.from(phaseTotals.entries()).map(([k, v]) => `${k} ${fmtMs(v)}`).join(" · ")}
                {idleMs > 60_000 ? <span style={{ color: "var(--sx-ink-300)" }}> · idle {fmtMs(idleMs)}</span> : null}
                {insights.friction_ticks.length > 0
                    ? <span style={{ color: "var(--sx-red-700)" }}> · ✕{insights.friction_ticks.length} corrections</span> : null}
                {insights.commits.length > 0
                    ? <span style={{ color: "var(--sx-green-700)" }}> · ●{insights.commits.length - reverted} commits</span> : null}
                {reverted > 0 ? <span style={{ color: "var(--sx-red-700)" }}> ✕{reverted} reverted</span> : null}
                {insights.subagent_spans.length > 0
                    ? <span style={{ color: "var(--sx-violet-700)" }}> · ▬ {insights.subagent_spans.length} subagents
                        {insights.delegation_ratio !== null ? ` (${Math.round(insights.delegation_ratio * 100)}% delegated)` : ""}</span>
                    : null}
            </div>
        </div>
    );
}
```

- [ ] **Step 2: InsightPanel (fetch + bands + footer + cells)**

```tsx
// apps/studio/src/components/session-insight/InsightPanel.tsx
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api.ts";
import type { SessionInsightsPayload, SessionListRow } from "@ax/lib/shared/dashboard-types";
import { StoryBar } from "./StoryBar.tsx";

const LBL: React.CSSProperties = {
    fontSize: 10, color: "var(--sx-ink-500)", letterSpacing: "0.06em",
    textTransform: "uppercase", fontWeight: 600, marginBottom: 8,
};
const CAP: React.CSSProperties = {
    fontSize: 10, color: "var(--sx-ink-500)", marginTop: 6, lineHeight: 1.5,
    whiteSpace: "normal", overflowWrap: "anywhere",
};
const CHART_BAND: React.CSSProperties = {
    minHeight: 36, display: "flex", flexDirection: "column", justifyContent: "center",
};

function OutcomeCell({ p }: { readonly p: SessionInsightsPayload }) {
    const hasChecks = p.checks.length > 0;
    const hasCommits = p.commits.length > 0;
    if (!hasChecks && !hasCommits && p.durability === null) return null;
    const reverted = p.commits.filter((c) => c.reverted).length;
    return (
        <div style={{ padding: "0 14px", minWidth: 0 }}>
            <div style={LBL}>Outcome</div>
            <div style={CHART_BAND}>
                {p.checks.map((c) => (
                    <div key={c.kind} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "var(--sx-ink-500)", height: 13 }}>
                        <span style={{ width: 36, overflow: "hidden", textOverflow: "ellipsis" }}>{c.kind}</span>
                        {c.runs.map((r, i) => (
                            <span key={i} style={{
                                width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
                                background: r.ok ? "var(--sx-green-700)" : "var(--sx-red-700)",
                            }} />
                        ))}
                    </div>
                ))}
                {p.durability !== null ? (
                    <div style={{ marginTop: 5, maxWidth: 160, height: 6, borderRadius: 2, overflow: "hidden", display: "flex" }}>
                        <span style={{ width: `${Math.round(p.durability * 100)}%`, background: "var(--sx-green-300)" }} />
                        <span style={{ flex: 1, background: "var(--sx-red-300)" }} />
                    </div>
                ) : null}
            </div>
            <div style={CAP}>
                {hasCommits ? <>{p.commits.length} commits{reverted > 0 ? <span style={{ color: "var(--sx-red-700)" }}> · {reverted} reverted</span> : null}</> : "no commits"}
                {p.durability !== null ? <> · durability {p.durability.toFixed(1)}</> : null}
            </div>
        </div>
    );
}

function LocCell({ p }: { readonly p: SessionInsightsPayload }) {
    if (!p.loc || (p.loc.added === 0 && p.loc.removed === 0)) return null;
    const total = Math.max(1, p.loc.added + p.loc.removed);
    const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    return (
        <div style={{ padding: "0 14px", minWidth: 0 }}>
            <div style={LBL}>ΔLOC</div>
            <div style={CHART_BAND}>
                <div style={{ display: "flex", alignItems: "center", maxWidth: 180 }}>
                    <span style={{ width: `${(p.loc.added / total) * 100}%`, height: 6, background: "var(--sx-green-300)", borderRadius: 1 }} />
                    <span style={{ width: `${(p.loc.removed / total) * 100}%`, height: 6, background: "var(--sx-red-300)", borderRadius: 1, marginLeft: 2 }} />
                </div>
            </div>
            <div style={CAP}>
                <span style={{ color: "var(--sx-green-700)" }}>+{fmt(p.loc.added)}</span>{" "}
                <span style={{ color: "var(--sx-red-700)" }}>−{fmt(p.loc.removed)}</span>
            </div>
        </div>
    );
}

function SkillArcCell({ p }: { readonly p: SessionInsightsPayload }) {
    if (p.skills.length === 0) return null;
    // dedupe consecutive repeats; the arc is the sequence, not the volume
    const arc = p.skills.filter((s, i) => i === 0 || s.name !== p.skills[i - 1]!.name);
    return (
        <div style={{ padding: "0 14px", minWidth: 0 }}>
            <div style={LBL}>Skill arc</div>
            <div style={CHART_BAND}>
                <div style={{ lineHeight: 1.7 }}>
                    {arc.slice(0, 8).map((s, i) => (
                        <span key={i}>
                            {i > 0 ? <span style={{ color: "var(--sx-ink-300)" }}> → </span> : null}
                            <span style={{
                                display: "inline-block", fontSize: 10, padding: "1px 7px",
                                borderRadius: 8, background: "var(--sx-line-100)", color: "var(--sx-ink-600)",
                            }}>{s.name}</span>
                        </span>
                    ))}
                    {arc.length > 8 ? <span style={{ color: "var(--sx-ink-300)" }}> +{arc.length - 8}</span> : null}
                </div>
            </div>
            <div style={CAP}>{arc.length} skills</div>
        </div>
    );
}

function ContextCell({ p }: { readonly p: SessionInsightsPayload }) {
    if (p.context_curve.length < 2) return null;
    const tMax = Math.max(...p.context_curve.map((c) => c.t), 1);
    const W = 160, H = 32;
    const path = p.context_curve
        .map((c, i) => `${i === 0 ? "M" : "L"}${((c.t / tMax) * W).toFixed(1)},${(H - 2 - c.pct * (H - 6)).toFixed(1)}`)
        .join(" ");
    const peak = Math.max(...p.context_curve.map((c) => c.pct));
    const last = p.context_curve[p.context_curve.length - 1]!.pct;
    return (
        <div style={{ padding: "0 14px", minWidth: 0 }}>
            <div style={LBL}>Context</div>
            <div style={CHART_BAND}>
                <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
                    <line x1={0} y1={H - 2 - 0.9 * (H - 6)} x2={W} y2={H - 2 - 0.9 * (H - 6)}
                        stroke="var(--sx-line-200)" strokeWidth={1} strokeDasharray="3,3" />
                    <path d={path} fill="none" stroke="var(--sx-chart-line)" strokeWidth={1.5} />
                    {p.compactions.map((c, i) => {
                        const ct = new Date(c.ts).getTime();
                        const t0c = p.context_curve[0]!.t;
                        // compaction ts is absolute; curve t is offset - find nearest point
                        const nearest = p.context_curve.reduce((best, pt) =>
                            Math.abs(pt.t - (ct - t0c)) < Math.abs(best.t - (ct - t0c)) ? pt : best);
                        return <circle key={i} cx={(nearest.t / tMax) * W} cy={H - 2 - nearest.pct * (H - 6)}
                            r={2.4} fill="var(--sx-amber-500)" />;
                    })}
                </svg>
            </div>
            <div style={CAP}>
                {p.compactions.length} compaction{p.compactions.length === 1 ? "" : "s"} · peak {Math.round(peak * 100)}% · ends {Math.round(last * 100)}%
            </div>
        </div>
    );
}

function BaselineFooter({ p }: { readonly p: SessionInsightsPayload }) {
    const { cost_ratio, friction_ratio, land_ratio, cache_pct } = p.baseline;
    if (cost_ratio === null && friction_ratio === null && land_ratio === null) return null;
    const delta = (label: string, r: number | null, higherIsWorse: boolean) => {
        if (r === null) return null;
        const worse = higherIsWorse ? r > 1 : r < 1;
        return (
            <span> · {label} <span style={{ color: worse ? "var(--sx-red-700)" : "var(--sx-green-700)" }}>
                {r.toFixed(1)}×{r > 1 ? "↑" : "↓"}
            </span></span>
        );
    };
    return (
        <div style={{
            marginTop: 14, paddingTop: 8, borderTop: "1px dashed var(--sx-line-200)",
            fontSize: 10, color: "var(--sx-ink-500)", textAlign: "right",
        }}>
            vs 30d median
            {delta("cost", cost_ratio, true)}
            {delta("friction", friction_ratio, true)}
            {delta("landed", land_ratio, true)}
            {cache_pct !== null ? <span> · cache {Math.round(cache_pct * 100)}%</span> : null}
        </div>
    );
}

/** Accordion body for an expanded sessions-list row. Fetches lazily on first
 *  expand; TanStack Query caches per session id. */
export function InsightPanel({ row }: { readonly row: SessionListRow }) {
    const q = useQuery({
        queryKey: ["session-insights", row.id],
        queryFn: () => api.sessionInsights(row.id),
        staleTime: 5 * 60_000,
    });
    if (q.isLoading) {
        return <div style={{ padding: "12px 16px", fontSize: 10, color: "var(--sx-ink-300)" }}>loading insights…</div>;
    }
    if (q.error || !q.data) {
        return (
            <div style={{ padding: "12px 16px", fontSize: 10, color: "var(--sx-ink-300)" }}>
                failed to load insights · <button onClick={() => void q.refetch()} style={{
                    border: "none", background: "transparent", color: "var(--sx-ink-500)",
                    cursor: "pointer", fontSize: 10, textDecoration: "underline", padding: 0,
                }}>retry</button>
            </div>
        );
    }
    const p = q.data;
    const cells = [
        <OutcomeCell key="o" p={p} />, <LocCell key="l" p={p} />,
        <SkillArcCell key="s" p={p} />, <ContextCell key="c" p={p} />,
    ];
    const empty = p.phases.length === 0 && p.commits.length === 0 && p.skills.length === 0
        && p.context_curve.length < 2 && !p.loc;
    if (empty) {
        return <div style={{ padding: "12px 16px", fontSize: 10, color: "var(--sx-ink-300)" }}>no insight data for this session</div>;
    }
    return (
        <div style={{ padding: "12px 16px 14px 38px" }}>
            <StoryBar insights={p} startedAt={row.started_at} endedAt={row.ended_at} />
            <div style={{
                display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                gap: "14px 0", marginTop: 16,
            }}>
                {cells}
            </div>
            <BaselineFooter p={p} />
        </div>
    );
}
```

Note: band-2 cell dividers (`border-right`) are omitted deliberately - with `auto-fit` wrapping, hard-coded dividers leak onto row ends; padding + the grid gap carry the separation. If the executor wants dividers, do it with `box-shadow: 1px 0 0 var(--sx-line-200)` and accept the trailing edge.

- [ ] **Step 3: Typecheck + commit**

Run: `bun run typecheck`
Expected: PASS

```bash
git add apps/studio/src/components/session-insight/StoryBar.tsx apps/studio/src/components/session-insight/InsightPanel.tsx
git commit -m "feat(studio): StoryBar + InsightPanel accordion components"
```

---

### Task 10: SPA - wire the sessions route

**Files:**
- Modify: `apps/studio/src/routes/sessions.tsx`

- [ ] **Step 1: Extend the `Row` component**

In `apps/studio/src/routes/sessions.tsx`:

Imports to add:

```tsx
import { BurnSpark } from "../components/session-insight/BurnSpark.tsx";
import { SignalBadge } from "../components/session-insight/SignalBadge.tsx";
import { InsightPanel } from "../components/session-insight/InsightPanel.tsx";
```

Extend `RowProps`:

```tsx
interface RowProps {
    readonly s: SessionListRow;
    readonly indent?: boolean;
    readonly expandedToggle?: { expanded: boolean; childCount: number; loading?: boolean; onToggle: () => void };
    readonly select?: { checked: boolean; onToggle: () => void };
    readonly burnP90?: number | null;
    readonly insight?: { open: boolean; onToggle: () => void };
}
```

In the `Row` function body, derive the accordion styling and add the new cells. Replace the current `<tr style={rowStyle} ...>` opening and the cells as follows (keep the existing checkbox + id + source + project + started cells; the full new cell order is: checkbox · id (with chevron) · source · project · started · duration · turns · burn · cost · signal · open-link):

```tsx
    const open = insight?.open ?? false;
    const rowStyle: React.CSSProperties | undefined = open
        ? { background: "var(--sx-tint-50)", boxShadow: "inset 3px 0 0 var(--sx-ink-900)", cursor: "pointer" }
        : indent
            ? { background: "#fafafa" }
            : insight ? { cursor: "pointer" } : undefined;
```

```tsx
        <tr
            style={rowStyle}
            onMouseEnter={onIntent}
            onFocus={onIntent}
            onClick={insight ? (e) => {
                // don't hijack checkbox/button/link clicks
                const t = e.target as HTMLElement;
                if (t.closest("a,button,input")) return;
                insight.onToggle();
            } : undefined}
            aria-expanded={insight ? open : undefined}
        >
```

In the id cell, render an insight chevron before the existing subagent toggle (live dot precedes the id):

```tsx
                {insight ? (
                    <span style={{
                        display: "inline-block", fontSize: 9, color: "var(--sx-ink-500)",
                        transition: "transform .15s", transform: open ? "rotate(90deg)" : "none",
                        width: 12,
                    }}>▶</span>
                ) : <span style={{ display: "inline-block", width: 12 }} />}
                {s.is_live ? (
                    <span title="live" style={{
                        display: "inline-block", width: 7, height: 7, borderRadius: "50%",
                        background: "var(--sx-green-700)", boxShadow: "0 0 0 2px var(--sx-green-100)",
                        marginRight: 4,
                    }} />
                ) : null}
```

After the existing turns `<td>` (line ~107), add three cells:

```tsx
            <td style={{ padding: "0 8px" }}>
                <BurnSpark buckets={s.burn_buckets} p90={burnP90 ?? null} />
            </td>
            <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace", fontSize: 12, fontVariantNumeric: "tabular-nums", color: s.cost_usd !== null ? "var(--ink)" : "var(--muted-2)" }}>
                {s.cost_usd !== null ? `$${s.cost_usd.toFixed(2)}` : "–"}
            </td>
            <td><SignalBadge signal={s.signal} friction={s.friction} /></td>
```

- [ ] **Step 2: Wire accordion state in `SessionsRoute`**

Add state next to `expanded`:

```tsx
    const [insightOpen, setInsightOpen] = useState<ReadonlySet<string>>(() => new Set());
    const toggleInsight = (id: string) => {
        setInsightOpen((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };
```

In the `<thead>` row, add the three new headers after `turns` (and keep the trailing blank th for the open-link column):

```tsx
                            <th style={{ textAlign: "left", padding: "6px 8px" }}>burn</th>
                            <th style={{ textAlign: "right", padding: "6px 8px" }}>cost</th>
                            <th style={{ textAlign: "left", padding: "6px 8px" }}>signal</th>
```

In the row-render loop, pass the new props to root `Row`s and render the panel row when open (children rows keep the old props - no insight accordion on subagents in v1):

```tsx
                                    <Row
                                        s={parent}
                                        burnP90={query.data?.burn_p90 ?? null}
                                        insight={{ open: insightOpen.has(parent.id), onToggle: () => toggleInsight(parent.id) }}
                                        select={{ checked: selected.has(parent.id), onToggle: () => toggleSelected(parent.id) }}
                                        {...(childCount > 0 ? { expandedToggle: { /* unchanged */ ... } } : {})}
                                    />
                                    {insightOpen.has(parent.id) ? (
                                        <tr>
                                            <td colSpan={11} style={{
                                                padding: 0,
                                                background: "var(--sx-tint-50)",
                                                boxShadow: "inset 3px 0 0 var(--sx-ink-900)",
                                                borderBottom: "1px solid var(--sx-line-200)",
                                            }}>
                                                <InsightPanel row={parent} />
                                            </td>
                                        </tr>
                                    ) : null}
```

(`colSpan={11}` = the new column count: checkbox, id, source, project, started, duration, turns, burn, cost, signal, open-link. Recount after your edits and keep the sentinel row's `colSpan` in sync.)

The `{ /* unchanged */ ... }` above means: keep the exact existing `expandedToggle` object - do not retype it.

- [ ] **Step 3: Typecheck + build**

Run: `bun run typecheck && bunx turbo run build --filter=axctl`
Expected: PASS. (The studio bundle is built/staged by its own script - run `rg -n "stage-studio" package.json scripts/` and run that script if the dashboard serves a prebuilt bundle; per memory, `scripts/stage-studio.ts` builds the web target.)

- [ ] **Step 4: Visual verification (the real gate)**

```bash
bin/axctl serve
```

Open `http://127.0.0.1:1799/sessions` and verify against the locked mockup (`.superpowers/brainstorm/81395-1781156096/content/panel-v5.html`):

1. Rows show turns (non-zero where health data exists), burn sparkline, cost, signal badge.
2. Sparkline amber appears only on outlier rows (roughly 1-in-8, not every row).
3. Clicking a row opens the accordion: ink left rail + tinted background flowing row → panel; chevron rotates.
4. Panel: story bar with phase segments/ticks/commit dots; band-2 cells wrap responsively when the window narrows (4 → 2×2 → 1); captions wrap without overlap.
5. A data-poor session (codex hook-probe) shows `no insight data for this session`.
6. Subagent expand (`▶ N`) and compare/checkbox flows still work; row-click does NOT hijack checkbox/link clicks.
7. Several rows open at once stay scannable (rail per group, 1px gray closers, no blue stripes).

Screenshot the expanded state and compare to the mockup.

- [ ] **Step 5: Commit**

```bash
git add apps/studio/src/routes/sessions.tsx
git commit -m "feat(studio): sessions list remakeover - signal columns + insight accordion"
```

---

### Task 11: Full verification sweep

- [ ] **Step 1: Repo gates**

```bash
bun run typecheck
bun test
bunx turbo run build
```

Expected: all PASS. `bun test` is the CI gate - fix anything red before proceeding.

- [ ] **Step 2: Backfill check (manual)**

Run a scoped re-ingest so recent sessions get `burn_buckets`:

```bash
bin/axctl ingest --since=7
```

Then reload `/sessions` and confirm sparklines render for recent Claude sessions. (Watcher-race caveat: don't touch live transcripts mid-ingest; see memory "Re-ingest watcher daemon race".)

- [ ] **Step 3: Commit any stragglers + push + PR**

```bash
git status --short   # review - no unrelated files (never git add -A in this repo)
git push -u origin feat/sessions-list-remakeover
gh pr create --title "feat(dashboard): sessions list remakeover - enriched rows + insight accordion" --body "$(cat <<'EOF'
Implements docs/superpowers/specs/2026-06-11-sessions-list-remakeover-design.md

- Enriched /api/sessions rows: turns, cost, burn sparkline buckets, friction signal, commit/LOC counts, live dot - all from per-session aggregate tables (no turn scans / graph-deref aggregates)
- New /api/sessions/:id/insights endpoint + accordion insight panel (story bar, outcome, ΔLOC, skill arc, context curve, 30d-baseline footer)
- New session_token_usage.burn_buckets field, precomputed at ingest (claude + codex)
- 30d baselines module (medians + burn p90) with in-process cache

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes (already applied)

- Spec coverage: row design → Tasks 1/4/8/10; accordion → 9/10; story bar → 9; band-2 cells → 9; footer → 9; palette/type → 7; API split → 4/6; burn_buckets schema+ingest → 2/3; baselines+p90 → 5; empty/error states → 6/9; testing → per-task. Out-of-scope items from the spec have no tasks (correct).
- Known judgment calls the executor may revisit: codex burn_buckets batching caveat (Task 3 Step 4), SurrealQL nested-select fallbacks (Tasks 5/6), `top_file` from the spec's ΔLOC caption is NOT implemented (no cheap per-session top-file aggregate exists; the cell ships without it - deviation noted, acceptable), task_label / "≈ classic ship arc" editorial labels deferred.
