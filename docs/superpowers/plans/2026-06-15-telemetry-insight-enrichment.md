# Multi-hop Telemetry → Insight Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach OTLP-sourced cost/latency to existing behavior insights via the `session -> telemetry_of -> otel_*` edge - a shared batched rollup helper consumed by 4 existing surfaces (friction, churn, fragility, recovery).

**Architecture:** One new `telemetry-rollup.ts` query helper (batched, deref-free, session-id keyed). Each of the 4 existing queries collects its session-id set, calls the helper once, merges cost/latency onto rows in JS. OTLP-sourced, kept separate from transcript cost (no double-count). Sessions without telemetry → null (graceful).

**Tech Stack:** Bun, TS strict, effect@beta, SurrealDB 3.x via `@ax/lib/db`, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-06-15-telemetry-insight-enrichment-design.md`

**Key codebase facts (from recon):**
- DB read: `const db = yield* SurrealClient; const rows = (yield* db.query<[Array<Record<string,unknown>>]>(sql))?.[0] ?? [];` (import `SurrealClient` from `@ax/lib/db`).
- Session-id list → SQL literals: `sessionRefList(ids)` from `apps/axctl/src/metrics/util.ts` → `session:⟨a⟩, session:⟨b⟩`. Chunk at 500 (`chunked` helper, same file/pattern as session-churn).
- `WHERE in IN [${sessionRefList(ids)}]` on the `telemetry_of` edge is SAFE (indexed `in` field) - this is the established pattern (`produced`, `tool_call` queries in session-churn.ts).
- otel tables: `otel_metric_point` (harness, metric, value, session_id, model), `otel_log_event` (harness, event_name, session_id, input/output/reasoning/cached/tool_tokens, duration_ms), `otel_span` (duration_ms - **currently empty**, CC/Codex emit metrics/logs not spans).
- SurrealDB v3: `type::record("session:"+id)` not `type::thing`.

---

## Task 1: `telemetry-rollup.ts` shared helper

**Files:**
- Create: `apps/axctl/src/queries/telemetry-rollup.ts`
- Test: `apps/axctl/src/queries/telemetry-rollup.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { sessionTelemetryCost, sessionTelemetryLatency } from "./telemetry-rollup.ts";

// Stub returns telemetry rows keyed by the SELECT'd table.
const db = (rows: { metric?: unknown[]; log?: unknown[] }) =>
    Layer.succeed(SurrealClient, {
        query: <T>(sql: string) => {
            if (/FROM otel_metric_point/.test(sql)) return Effect.succeed([rows.metric ?? []] as unknown as T);
            if (/FROM otel_log_event/.test(sql)) return Effect.succeed([rows.log ?? []] as unknown as T);
            return Effect.succeed([[]] as unknown as T);
        },
    } as never);

const run = <A>(e: Effect.Effect<A, unknown, SurrealClient>, layer: Layer.Layer<SurrealClient>) =>
    Effect.runPromise(e.pipe(Effect.provide(layer)));

describe("sessionTelemetryCost", () => {
    test("sums claude cost.usage → cost_usd and token.usage → tokens", async () => {
        const layer = db({ metric: [
            { session: "s1", metric: "claude_code.cost.usage", value: 0.5 },
            { session: "s1", metric: "claude_code.token.usage", value: 1200 },
        ] });
        const m = await run(sessionTelemetryCost(["s1"]), layer);
        expect(m.get("s1")?.cost_usd).toBe(0.5);
        expect(m.get("s1")?.tokens).toBe(1200);
        expect(m.get("s1")?.source).toBe("otlp");
    });

    test("codex log tokens with no cost metric → cost_usd null, tokens summed", async () => {
        const layer = db({ log: [
            { session: "c1", input_tokens: 100, output_tokens: 50, reasoning_tokens: 10, tool_tokens: 0 },
        ] });
        const m = await run(sessionTelemetryCost(["c1"]), layer);
        expect(m.get("c1")?.cost_usd).toBeNull();
        expect(m.get("c1")?.tokens).toBe(160);
    });

    test("session with no telemetry is absent from the map", async () => {
        const m = await run(sessionTelemetryCost(["x"]), db({}));
        expect(m.has("x")).toBe(false);
    });

    test("empty input → empty map, no query", async () => {
        const m = await run(sessionTelemetryCost([]), db({}));
        expect(m.size).toBe(0);
    });
});

describe("sessionTelemetryLatency", () => {
    test("sums log duration_ms → duration_ms", async () => {
        const layer = db({ log: [
            { session: "c1", duration_ms: 693 }, { session: "c1", duration_ms: 1000 },
        ] });
        const m = await run(sessionTelemetryLatency(["c1"]), layer);
        expect(m.get("c1")?.duration_ms).toBe(1693);
    });
});
```

- [ ] **Step 2: Run, expect FAIL** - `bun test apps/axctl/src/queries/telemetry-rollup.test.ts`

- [ ] **Step 3: Implement** `telemetry-rollup.ts`:

```ts
import { Effect } from "effect";
import { SurrealClient, type DbError } from "@ax/lib/db";
import { sessionRefList } from "../metrics/util.ts";

export interface TelemetryCost { readonly cost_usd: number | null; readonly tokens: number; readonly source: "otlp"; }
export interface TelemetryLatency { readonly duration_ms: number | null; readonly span_count: number; }

const CHUNK = 500;
const chunk = <T>(xs: readonly T[], n: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
    return out;
};
const numOf = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : 0);
const bareSession = (v: unknown): string => { const s = String(v ?? ""); const c = s.indexOf(":"); return c >= 0 ? s.slice(c + 1) : s; };

/**
 * OTLP cost/tokens per session via session_id match on the otel tables.
 * Batched (chunked IN-list), deref-free - never walks <-telemetry_of per row.
 * Claude cost from otel_metric_point claude_code.cost.usage; tokens from
 * claude_code.token.usage + codex otel_log_event token columns. cost_usd is
 * null for codex (token-only). Sessions with no telemetry are absent.
 */
export const sessionTelemetryCost = (
    sessionIds: readonly string[],
): Effect.Effect<Map<string, TelemetryCost>, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const out = new Map<string, { cost_usd: number | null; tokens: number }>();
        if (sessionIds.length === 0) return new Map();
        const db = yield* SurrealClient;
        for (const ids of chunk(sessionIds, CHUNK)) {
            const refs = sessionRefList(ids);
            // metric points (claude): cost.usage + token.usage
            const mrows = (yield* db.query<[Array<Record<string, unknown>>]>(
                `SELECT session_id, metric, math::sum(value) AS total FROM otel_metric_point`
                + ` WHERE session_id IN [${refs.replace(/session:/g, "")}] OR session_id IN [${ids.map((i) => `"${bareSession(i)}"`).join(", ")}]`
                + ` GROUP BY session_id, metric;`,
            ))?.[0] ?? [];
            for (const r of mrows) {
                const sid = bareSession(r.session_id);
                const cur = out.get(sid) ?? { cost_usd: null, tokens: 0 };
                if (r.metric === "claude_code.cost.usage") cur.cost_usd = (cur.cost_usd ?? 0) + numOf(r.total);
                if (r.metric === "claude_code.token.usage") cur.tokens += numOf(r.total);
                out.set(sid, cur);
            }
            // log events (codex): token columns
            const lrows = (yield* db.query<[Array<Record<string, unknown>>]>(
                `SELECT session_id, math::sum(input_tokens) AS i, math::sum(output_tokens) AS o,`
                + ` math::sum(reasoning_tokens) AS r, math::sum(tool_tokens) AS t FROM otel_log_event`
                + ` WHERE session_id IN [${ids.map((i) => `"${bareSession(i)}"`).join(", ")}] GROUP BY session_id;`,
            ))?.[0] ?? [];
            for (const r of lrows) {
                const sid = bareSession(r.session_id);
                const cur = out.get(sid) ?? { cost_usd: null, tokens: 0 };
                cur.tokens += numOf(r.i) + numOf(r.o) + numOf(r.r) + numOf(r.t);
                out.set(sid, cur);
            }
        }
        const result = new Map<string, TelemetryCost>();
        for (const [k, v] of out) result.set(k, { ...v, source: "otlp" });
        return result;
    });

export const sessionTelemetryLatency = (
    sessionIds: readonly string[],
): Effect.Effect<Map<string, TelemetryLatency>, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const out = new Map<string, TelemetryLatency>();
        if (sessionIds.length === 0) return out;
        const db = yield* SurrealClient;
        for (const ids of chunk(sessionIds, CHUNK)) {
            const list = ids.map((i) => `"${bareSession(i)}"`).join(", ");
            const rows = (yield* db.query<[Array<Record<string, unknown>>]>(
                `SELECT session_id, math::sum(duration_ms) AS d, count() AS n FROM otel_log_event`
                + ` WHERE session_id IN [${list}] AND duration_ms != NONE GROUP BY session_id;`,
            ))?.[0] ?? [];
            for (const r of rows) out.set(bareSession(r.session_id), { duration_ms: numOf(r.d), span_count: numOf(r.n) });
        }
        return out;
    });
```

NOTE on the session_id match: `otel_metric_point.session_id` is a plain `string` column (not a record ref) holding the bare session uuid (Claude `session.id` attr) OR the codex `conversation.id`. The existing `session` rows are keyed by their own id. The join is **string equality on the bare id**. The metric query's first `IN [...]` (refs with `session:` stripped) is belt-and-suspenders; the authoritative match is the quoted bare-id list. The implementer MUST verify against real data whether `otel_metric_point.session_id` equals the bare `session` key - if the stored session_id differs (e.g. claude session.id vs ax session key), document the mismatch (correlation/enrichment then yields empty until reconciled - acceptable, graceful-null). Simplify the metric WHERE to just the quoted bare-id list if the refs form is redundant.

- [ ] **Step 4: Run, expect PASS.** **Step 5: typecheck.** **Step 6: commit**
```bash
git add apps/axctl/src/queries/telemetry-rollup.ts apps/axctl/src/queries/telemetry-rollup.test.ts
git commit -m "feat(insights): telemetry-rollup helper (batched session cost/latency)"
```

---

## Task 2 (Lens B): churn episode → cost

**Files:**
- Modify: `apps/axctl/src/metrics/session-churn.ts` (`SessionChurnRow`, `fetchSessionChurnSummary`, `formatSessionChurnSummary`)
- Test: `apps/axctl/src/metrics/session-churn.test.ts` (extend)

- [ ] **Step 1: Write failing test** - add a test that `fetchSessionChurnSummary` populates `otlp_cost_usd`/`otlp_tokens` on hot-session rows when telemetry exists. Stub `SurrealClient` so the otel queries return a cost row for one hot session; assert that row's `otlp_cost_usd` matches and a session without telemetry has `otlp_cost_usd: null`. (Model the stub on the existing session-churn tests in this file - match their stub shape.)

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement:**
  - Add to `SessionChurnRow`: `readonly otlp_cost_usd: number | null; readonly otlp_tokens: number | null;`
  - `computeSessionChurn` is pure - default these to `null` there (it has no DB). Initialize both `null` when building each row.
  - In `fetchSessionChurnSummary`, AFTER `hotSessions` is computed: collect `const ids = summary.hotSessions.map(r => r.session)`, call `const cost = yield* sessionTelemetryCost(ids)`, and map onto each hot row: `otlp_cost_usd: cost.get(r.session)?.cost_usd ?? null, otlp_tokens: cost.get(r.session)?.tokens ?? null`. Return the updated summary. Import `sessionTelemetryCost` from `../queries/telemetry-rollup.ts`.
  - In `formatSessionChurnSummary`: add a `cost$` column to the hot-sessions table ONLY when at least one row has non-null `otlp_cost_usd` (else omit the column to avoid an all-`-` column). Render `otlp_cost_usd` as `$X.XXX` or `-`.

- [ ] **Step 4: Run → PASS** (`bun test apps/axctl/src/metrics/session-churn.test.ts`). **Step 5: typecheck.** **Step 6: commit**
```bash
git add apps/axctl/src/metrics/session-churn.ts apps/axctl/src/metrics/session-churn.test.ts
git commit -m "feat(insights): OTLP cost per churn episode/session (lens B)"
```

---

## Task 3 (Lens C): fragility cascade → downstream cost

**Files:**
- Modify: `apps/axctl/src/metrics/fragility-cascade.ts` (`CascadeEdge`, `readFragilityCascade`)
- Test: `apps/axctl/src/metrics/fragility-cascade.test.ts` (extend)

- [ ] **Step 1: Write failing test** - stub `SurrealClient` so `readFragilityCascade`'s edge query returns one `{origin, downstream, weight}` and the otel cost query returns a cost for the downstream session; assert the returned edge has `downstream_cost_usd`/`downstream_tokens` populated; an edge whose downstream has no telemetry → null. Match the existing fragility test stub shape.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement:**
  - Add to `CascadeEdge`: `readonly downstream_cost_usd: number | null; readonly downstream_tokens: number | null;`
  - In `readFragilityCascade`, after reading edges: collect downstream ids (`edges.map(e => e.downstream)`, dedup), call `sessionTelemetryCost(ids)`, merge onto each edge by `e.downstream`. `CascadeEdge.downstream` is `type::string` form (`"session:uuid"`); the rollup's `bareSession` handles the prefix, so pass `e.downstream` through (the helper strips `session:`). Import the helper.

- [ ] **Step 4: Run → PASS.** **Step 5: typecheck.** **Step 6: commit**
```bash
git add apps/axctl/src/metrics/fragility-cascade.ts apps/axctl/src/metrics/fragility-cascade.test.ts
git commit -m "feat(insights): downstream OTLP cost on fragility cascades (lens C)"
```

---

## Task 4 (Lens A): friction → cost

**Files:**
- Modify: `apps/axctl/src/cli/commands/report.ts` (`enrichInsightRows` for the `friction` view) OR `apps/axctl/src/queries/insights.ts`
- Test: a test for the friction enrichment (place beside report/insights logic)

- [ ] **Step 1: Write failing test** - assert that friction rows, after enrichment, carry an `otlp_cost_usd` field sourced from the rollup keyed by the row's `session`. Stub the rollup's DB queries. (If `enrichInsightRows` is the chosen seam, test it directly with view="friction".)

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement:** extend `enrichInsightRows` (report.ts) so the `friction` view gets a JS-side join: collect `rows.map(r => bareSession(r.session))`, call `sessionTelemetryCost(ids)`, attach `otlp_cost_usd`/`otlp_tokens` to each row. Ensure `formatInsightRows` includes the new fields in `--json` and, for table output, adds a `cost$` column only when populated. (`session` in friction rows is a record ref - cast/normalize with the same bare-id logic.) Import the helper + reuse `bareSession` (export it from telemetry-rollup.ts or duplicate the 1-liner).

- [ ] **Step 4: Run → PASS.** **Step 5: typecheck.** **Step 6: commit**
```bash
git add apps/axctl/src/cli/commands/report.ts apps/axctl/src/queries/insights.ts apps/axctl/src/cli/insights-format.ts <test>
git commit -m "feat(insights): OTLP cost on friction events (lens A)"
```

---

## Task 5 (Lens E): recovery → latency  ⚠️ data-thin

**Files:**
- Modify: `apps/axctl/src/dashboard/skills-weighted.ts` (`WeightedSkillRow`, `fetchSkillsWeighted`)
- Test: `apps/axctl/src/dashboard/skills-weighted.test.ts` (extend)

**Caveat:** latency source is `otel_log_event.duration_ms` (NOT `otel_span` - spans are currently unpopulated). `WeightedSkillRow` has no session ids, so this needs a separate pass: `recovered_by` (turn→skill) → resolve the turn's `session` → `sessionTelemetryLatency`. If this proves structurally hostile, ship it as a `--json`-only field (`median_recovery_ms`) rather than a table column, and note it. This lens lights up only once recovery sessions have telemetry.

- [ ] **Step 1: Write failing test** - stub so a `recovered_by`-grouped query yields skill→sessionIds, and the latency rollup yields a duration for those sessions; assert the skill row gains `median_recovery_ms`. Null when no telemetry.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement:**
  - Add to `WeightedSkillRow`: `readonly median_recovery_ms: number | null;`
  - In `fetchSkillsWeighted`, add a pass: `SELECT out AS skill, in.session AS session FROM recovered_by;` (resolve turn→session via the edge's `in` turn record's `session` field - verify the turn carries `session`). Group session ids by skill in JS, call `sessionTelemetryLatency(allSessionIds)`, compute per-skill median of the sessions' `duration_ms`, attach as `median_recovery_ms` (null if none). Keep the existing weighted query UNCHANGED (deref-free per [[weighted-query-per-edge-deref-hang]] - do the join as a separate batched query + JS merge, NOT stacked derefs in the main aggregate).

- [ ] **Step 4: Run → PASS.** **Step 5: typecheck.** **Step 6: commit**
```bash
git add apps/axctl/src/dashboard/skills-weighted.ts apps/axctl/src/dashboard/skills-weighted.test.ts
git commit -m "feat(insights): recovery latency per skill (lens E)"
```

---

## Task 6: docs + full verification

**Files:** Modify `CLAUDE.md`.

- [ ] **Step 1:** Add a short note (near the OTLP receiver section or the cost-analytics section): existing insights now traverse `telemetry_of` to attach OTLP cost/latency - `ax sessions churn` (cost/episode), fragility cascades (downstream cost), `ax insights friction` (per-kind cost), `ax skills weighted` (recovery latency). OTLP-sourced, separate from transcript cost. Module: `apps/axctl/src/queries/telemetry-rollup.ts`.
- [ ] **Step 2:** Full suite + typecheck: `bun test` + `bun run typecheck`. Fix any enrichment-caused breakage; report counts.
- [ ] **Step 3: commit**
```bash
git add CLAUDE.md
git commit -m "docs(insights): telemetry-enriched behavior insights"
```

---

## Verification (whole-plan)
- [ ] `bun test` green; `bun run typecheck` clean.
- [ ] Each lens: new column/field populates with stubbed telemetry, null when absent (graceful).
- [ ] No double-count: OTLP `otlp_*`/`median_recovery_ms` fields are separate from transcript `session_token_usage`/`estimatedCostUsd`.
- [ ] Live (controller): with the dogfood telemetry present, `ax sessions churn` shows a cost column for sessions that have OTLP data.

## Open items
1. **session_id join key** - verify `otel_metric_point.session_id` / `otel_log_event.session_id` equals the bare `session` table key. If claude `session.id` / codex `conversation.id` differ from ax's session key, enrichment yields empty until reconciled (graceful null; document). This is the single highest-risk assumption - Task 1 implementer must check against real rows.
2. Lens E latency from logs (spans empty); degrade to `--json` field if the weighted query can't cleanly carry it.
