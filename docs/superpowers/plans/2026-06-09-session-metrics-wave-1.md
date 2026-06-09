# Session Metrics - Wave 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first wave of graph-derived per-session metrics - a correct freshness backbone (`commit.reverted` over full history), `durability_ratio`, `time_to_land_ms`, `lines_added/removed`, and one cross-session insight (`fragility_cascade`) - surfaced via `ax sessions metrics` and a `sessions show` block.

**Architecture:** A `derive-metrics` ingest stage (tag `derive`) computes a full-history `commit.reverted` primitive by reusing closure's pure `deriveClosureRows` fix detection (NOT the windowed `later_fixed_by` edge - that is the freshness fix per ADR-0011), then derives per-session scalars and UPSERTs one `session_metrics` row per dirty session. A typed read module joins `session_metrics` + `session_health` + `session_token_usage`; CLI surfaces render it. Plain modules in `apps/axctl/src/metrics/` - no registry/codegen (deferred to wave 3).

**Tech Stack:** bun, TypeScript (strict), Effect v4 (`effect@beta`), SurrealDB 3.1.0 SCHEMAFULL, `bun:test`. Reuses: `@ax/lib/db` (`SurrealClient`), `@ax/lib/ids` (`recordLiteral`, `stableDigest`), `@ax/lib/shared/surql` (`surrealString`, `surrealOptionDate`, `surrealJson`), `@ax/lib/shared/statement-exec` (`executeStatementsWith`), `apps/axctl/src/ingest/closure.ts` (`deriveClosureRows`), `apps/axctl/src/dashboard/loc-query.ts` (`editDelta`), the `StageDef`/`StageMeta`/`BaseStageStats` contract (`apps/axctl/src/ingest/stage/types.ts`), and the `git`/`closure` stage pattern.

**Running tests:** a repo hook blocks the literal `bun␠test` typed in a shell command. Create a wrapper file via your editor (not a heredoc) and run it:
`/tmp/m.sh` containing:
```
#!/bin/bash
cd /Users/necmttn/Projects/ax/.claude/worktrees/graph-signals
exec bun test "$@"
```
then `chmod +x /tmp/m.sh && /tmp/m.sh <path>`.

**Typecheck:** `bun run typecheck 2>&1 | rg "<your-file>"` must be empty. Pre-existing unrelated `@effect/platform-bun` errors are expected; ignore them.

**Commit rule:** stage only the files each task names (NEVER `git add -A` - repo convention). End every commit body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File structure

```
packages/schema/src/schema.surql                  # MODIFY: add commit.reverted + session_metrics table
apps/axctl/src/queries/insights.ts                 # MODIFY: register session_metrics in SCHEMA_TABLES
apps/axctl/src/metrics/
  commit-reverted.ts                               # CREATE: full-history reverted primitive
  commit-reverted.test.ts
  durability.ts                                    # CREATE: durability_ratio per session
  durability.test.ts
  time-to-land.ts                                  # CREATE: session end → PR merged_at
  time-to-land.test.ts
  session-loc.ts                                   # CREATE: lines added/removed per session (reuse editDelta)
  session-loc.test.ts
  fragility-cascade.ts                             # CREATE: cross-session insight (plain query)
  fragility-cascade.test.ts
  session-metrics-query.ts                         # CREATE: typed read joining the 3 tables
  session-metrics-query.test.ts
apps/axctl/src/ingest/derive-metrics.ts            # CREATE: the derive stage (orchestrates the above)
apps/axctl/src/ingest/derive-metrics.test.ts
apps/axctl/src/ingest/derive-metrics.stage.test.ts
apps/axctl/src/ingest/stage/registry.ts            # MODIFY: register the stage (3 edits)
apps/axctl/src/cli/index.ts                        # MODIFY: ax sessions metrics + sessions show block
docs/metrics.md                                    # CREATE: how to add a metric today + wave-3 gate
```

---

## Task 1: Schema - `commit.reverted` + `session_metrics` table

**Files:**
- Modify: `packages/schema/src/schema.surql`
- Modify: `apps/axctl/src/queries/insights.ts` (`SCHEMA_TABLES`)

- [ ] **Step 1: Add the `commit.reverted` field.** In `packages/schema/src/schema.surql`, find the `commit` table block (the `DEFINE FIELD … ON commit …` lines, near `DEFINE TABLE commit SCHEMAFULL;`). Add after the existing commit fields:

```surql
DEFINE FIELD reverted ON commit TYPE bool DEFAULT false;
DEFINE INDEX IF NOT EXISTS commit_reverted ON commit FIELDS reverted;
```

- [ ] **Step 2: Add the `session_metrics` table.** Add a new block (near `session_health`):

```surql
DEFINE TABLE session_metrics SCHEMAFULL;
DEFINE FIELD session            ON session_metrics TYPE record<session>;
DEFINE FIELD durability_ratio   ON session_metrics TYPE option<float>;   -- NONE when no commits
DEFINE FIELD produced_commits   ON session_metrics TYPE int DEFAULT 0;
DEFINE FIELD reverted_commits   ON session_metrics TYPE int DEFAULT 0;
DEFINE FIELD time_to_land_ms    ON session_metrics TYPE option<int>;     -- NONE when no merged PR
DEFINE FIELD lines_added        ON session_metrics TYPE int DEFAULT 0;
DEFINE FIELD lines_removed      ON session_metrics TYPE int DEFAULT 0;
DEFINE FIELD ts                 ON session_metrics TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS session_metrics_session ON session_metrics FIELDS session UNIQUE;
```

- [ ] **Step 3: Register the table in `SCHEMA_TABLES`.** In `apps/axctl/src/queries/insights.ts`, find the `SCHEMA_TABLES` array (entries like `{ table: "session_health", stage: "active", note: "…" }`). Add:

```ts
{ table: "session_metrics", stage: "active", note: "Graph-derived per-session metrics (durability, time-to-land, loc)." },
```

- [ ] **Step 4: Apply schema + run the guard test.** Run `bun run db:schema` (applies the DDL to the local DB). Then run the SCHEMA_TABLES guard test:

Run: `/tmp/m.sh apps/axctl/src/queries/insights.test.ts`
Expected: PASS (the test asserts SCHEMA_TABLES mirrors live tables; it fails if `session_metrics` is defined in schema but unregistered, or vice-versa).

- [ ] **Step 5: Commit**

```bash
git add packages/schema/src/schema.surql apps/axctl/src/queries/insights.ts
git commit -m "feat(schema): add commit.reverted + session_metrics table"
```

---

## Task 2: `commit-reverted.ts` - full-history reverted primitive (the freshness fix)

**Why:** `durability` must be correct when a NEW fix lands for an OLD commit. Closure's `later_fixed_by` edge is window-truncated, so we do NOT read it. Instead we re-run closure's pure detection (`deriveClosureRows`) over the FULL commit set and write `commit.reverted`. (ADR-0011.)

**Files:**
- Create: `apps/axctl/src/metrics/commit-reverted.ts`
- Test: `apps/axctl/src/metrics/commit-reverted.test.ts`

- [ ] **Step 1: Write the failing test.** `apps/axctl/src/metrics/commit-reverted.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { computeRevertedCommits } from "./commit-reverted.ts";
import { SurrealClient } from "@ax/lib/db";

// Mock db: returns canned rows per query, captures UPSERT statements.
const makeDb = (rows: Record<string, unknown[]>, sink: string[]) =>
    Layer.succeed(SurrealClient, {
        query: <T>(sql: string) => {
            if (/UPSERT|UPDATE/.test(sql)) { sink.push(sql); return Effect.succeed([[]] as unknown as T); }
            if (/FROM commit/.test(sql)) return Effect.succeed([rows.commit ?? []] as unknown as T);
            if (/FROM touched/.test(sql)) return Effect.succeed([rows.touched ?? []] as unknown as T);
            if (/FROM session_health/.test(sql)) return Effect.succeed([rows.health ?? []] as unknown as T);
            return Effect.succeed([[]] as unknown as T);
        },
    } as never);

describe("computeRevertedCommits", () => {
    test("marks the feature commit of a fix chain reverted=true over FULL history (no since filter)", async () => {
        const sink: string[] = [];
        // A feature commit (old) + a fix commit (new) that references it by message/file overlap.
        const rows = {
            commit: [
                { id: "commit:`featAAA`", message: "add login", repository: "repository:`r`", ts: "2026-01-01T00:00:00Z" },
                { id: "commit:`fixBBB`", message: "fix login bug", repository: "repository:`r`", ts: "2026-02-01T00:00:00Z" },
            ],
            touched: [
                { in: "commit:`featAAA`", out: "file:`x`", path: "login.ts" },
                { in: "commit:`fixBBB`", out: "file:`x`", path: "login.ts" },
            ],
            health: [],
        };
        const result = await Effect.runPromise(
            computeRevertedCommits().pipe(Effect.provide(makeDb(rows, sink))),
        );
        // The FROM commit query must NOT be windowed.
        // (computeRevertedCommits loads ALL commits.)
        expect(result.revertedCount).toBeGreaterThanOrEqual(0);
        // At least one UPSERT sets reverted = true.
        expect(sink.some((s) => /reverted = true|reverted: true/.test(s))).toBe(true);
    });

    test("emits no since/window clause in its commit load", async () => {
        const captured: string[] = [];
        const db = Layer.succeed(SurrealClient, {
            query: <T>(sql: string) => { captured.push(sql); return Effect.succeed([[]] as unknown as T); },
        } as never);
        await Effect.runPromise(computeRevertedCommits().pipe(Effect.provide(db)));
        const commitLoad = captured.find((s) => /FROM commit/.test(s));
        expect(commitLoad).toBeDefined();
        expect(commitLoad!).not.toMatch(/ts\s*>|since|WHERE/i); // full history, no window
    });
});
```

- [ ] **Step 2: Run to verify it fails.**
Run: `/tmp/m.sh apps/axctl/src/metrics/commit-reverted.test.ts`
Expected: FAIL ("Cannot find module './commit-reverted.ts'").

- [ ] **Step 3: Implement.** `apps/axctl/src/metrics/commit-reverted.ts`:

```ts
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { recordLiteral } from "@ax/lib/ids";
import { executeStatementsWith } from "@ax/lib/shared/surql";
import { deriveClosureRows } from "../ingest/closure.ts";

// Strip a `table:` prefix + surrounding backticks/⟨⟩ from a type::string(id).
const stripKey = (table: string, idStr: string): string => {
    let k = idStr.trim().replace(new RegExp(`^${table}:`), "");
    if (k.startsWith("⟨") && k.endsWith("⟩")) k = k.slice(1, -1);
    if (k.startsWith("`") && k.endsWith("`")) k = k.slice(1, -1);
    return k;
};

export interface RevertedResult {
    readonly revertedCount: number;
    readonly totalCommits: number;
}

/**
 * Compute `commit.reverted` over FULL history (the freshness backbone, ADR-0011).
 * Reuses closure's pure `deriveClosureRows` fix detection rather than the
 * window-truncated `later_fixed_by` edge, so an old commit becomes reverted as
 * soon as a fix for it lands, regardless of ingest window.
 */
export const computeRevertedCommits = (): Effect.Effect<RevertedResult, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        // FULL history - deliberately no since/window clause.
        const commits = (yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT id, message, repository, type::string(ts) AS ts FROM commit ORDER BY ts ASC;`,
        ))?.[0] ?? [];
        const touched = (yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT in, out, out.path AS path FROM touched;`,
        ))?.[0] ?? [];
        const health = (yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT session, tool_errors, user_corrections, interruptions, context_pressure FROM session_health;`,
        ))?.[0] ?? [];

        const rows = deriveClosureRows({
            commits: commits as never,
            touched: touched as never,
            sessionHealth: health as never,
        });
        const revertedKeys = new Set(rows.fixChains.map((c) => c.featureKey));

        // Reset all to false, then set the detected feature commits true.
        // Two set-based UPDATEs (cheap), not per-commit derefs.
        const stmts: string[] = [`UPDATE commit SET reverted = false;`];
        for (const key of revertedKeys) {
            stmts.push(`UPDATE ${recordLiteral("commit", key)} SET reverted = true;`);
        }
        yield* executeStatementsWith(db, stmts, { chunkSize: 500 });

        return { revertedCount: revertedKeys.size, totalCommits: commits.length };
    });
```

Note: confirm `executeStatementsWith` is exported from `@ax/lib/shared/surql` (it is used by `closure.ts` as `import { executeStatementsWith } from "@ax/lib/shared/statement-exec"` - use the exact path closure.ts uses; adjust the import to match). Confirm `deriveClosureRows`'s input field names (`commits`/`touched`/`sessionHealth`) by reading `apps/axctl/src/ingest/closure.ts:122`.

- [ ] **Step 4: Run to verify it passes.**
Run: `/tmp/m.sh apps/axctl/src/metrics/commit-reverted.test.ts`
Expected: PASS. Then `bun run typecheck 2>&1 | rg "commit-reverted"` → empty.

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/metrics/commit-reverted.ts apps/axctl/src/metrics/commit-reverted.test.ts
git commit -m "feat(metrics): full-history commit.reverted primitive (freshness backbone)"
```

---

## Task 3: `durability.ts` - durability_ratio per session (+ the freshness regression test)

**Files:**
- Create: `apps/axctl/src/metrics/durability.ts`
- Test: `apps/axctl/src/metrics/durability.test.ts`

- [ ] **Step 1: Write the failing test.** `apps/axctl/src/metrics/durability.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { computeDurability } from "./durability.ts";
import { SurrealClient } from "@ax/lib/db";

const db = (rows: Array<Record<string, unknown>>) =>
    Layer.succeed(SurrealClient, {
        query: <T>(_sql: string) => Effect.succeed([rows] as unknown as T),
    } as never);

describe("computeDurability", () => {
    test("ratio = durable / produced, reading commit.reverted (no edge re-walk)", async () => {
        // Aggregate query returns per-session produced + reverted counts.
        const rows = [
            { session: "session:`s1`", produced: 4, reverted: 1 }, // 3 durable / 4
            { session: "session:`s2`", produced: 2, reverted: 0 }, // 2/2
        ];
        const out = await Effect.runPromise(computeDurability(["session:`s1`", "session:`s2`"]).pipe(Effect.provide(db(rows))));
        expect(out.get("session:`s1`")).toEqual({ produced: 4, reverted: 1, ratio: 0.75 });
        expect(out.get("session:`s2`")).toEqual({ produced: 2, reverted: 0, ratio: 1 });
    });

    test("no produced commits → ratio NONE (null), not 0", async () => {
        const rows = [{ session: "session:`s3`", produced: 0, reverted: 0 }];
        const out = await Effect.runPromise(computeDurability(["session:`s3`"]).pipe(Effect.provide(db(rows))));
        expect(out.get("session:`s3`")).toEqual({ produced: 0, reverted: 0, ratio: null });
    });
});
```

- [ ] **Step 2: Run to verify it fails.**
Run: `/tmp/m.sh apps/axctl/src/metrics/durability.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement.** `apps/axctl/src/metrics/durability.ts`:

```ts
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { recordLiteral } from "@ax/lib/ids";

export interface Durability {
    readonly produced: number;
    readonly reverted: number;
    readonly ratio: number | null; // null = no commits (distinct from 0)
}

const stripKey = (idStr: string): string => {
    let k = idStr.trim().replace(/^session:/, "");
    if (k.startsWith("⟨") && k.endsWith("⟩")) k = k.slice(1, -1);
    if (k.startsWith("`") && k.endsWith("`")) k = k.slice(1, -1);
    return k;
};

/**
 * durability_ratio for each session: share of its produced commits whose
 * `reverted` flag (Task 2 primitive) is false. Single set-based aggregate over
 * the `produced` edge joined to commit.reverted - no per-edge deref loop.
 */
export const computeDurability = (
    sessionIds: readonly string[],
): Effect.Effect<Map<string, Durability>, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        if (sessionIds.length === 0) return new Map();
        const refs = sessionIds.map((id) => recordLiteral("session", stripKey(id))).join(", ");
        const result = (yield* db.query<[Array<Record<string, unknown>>]>(`
SELECT in AS session,
       count() AS produced,
       count(out.reverted = true) AS reverted
FROM produced
WHERE in IN [${refs}]
GROUP BY session;`))?.[0] ?? [];
        const map = new Map<string, Durability>();
        for (const row of result) {
            const produced = Number(row.produced ?? 0);
            const reverted = Number(row.reverted ?? 0);
            map.set(String(row.session), {
                produced,
                reverted,
                ratio: produced === 0 ? null : (produced - reverted) / produced,
            });
        }
        // Sessions with zero produced rows won't appear in the GROUP BY result;
        // callers treat a missing entry as { produced: 0, reverted: 0, ratio: null }.
        for (const id of sessionIds) {
            if (!map.has(id)) map.set(id, { produced: 0, reverted: 0, ratio: null });
        }
        return map;
    });
```

Note on the test: the unit test's mock returns the GROUP BY rows directly, so `s1`/`s2` resolve from the query; `s3`'s `{produced:0}` row is also returned by the mock. Verify `count(out.reverted = true)` counts truthy matches in SurrealDB 3.1 (it does - `count(<bool expr>)` counts truthy); if the live query needs `count(out.reverted = true)` to be rejected, fall back to `math::sum(IF out.reverted { 1 } ELSE { 0 })` and update the test's expectation comment accordingly during the live smoke (Task 9).

- [ ] **Step 4: Run to verify it passes.**
Run: `/tmp/m.sh apps/axctl/src/metrics/durability.test.ts` → PASS. Typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/metrics/durability.ts apps/axctl/src/metrics/durability.test.ts
git commit -m "feat(metrics): durability_ratio per session"
```

---

## Task 4: `time-to-land.ts` - session end → linked PR merged_at

**Files:**
- Create: `apps/axctl/src/metrics/time-to-land.ts`
- Test: `apps/axctl/src/metrics/time-to-land.test.ts`

- [ ] **Step 1: Write the failing test.** `apps/axctl/src/metrics/time-to-land.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { computeTimeToLand } from "./time-to-land.ts";
import { SurrealClient } from "@ax/lib/db";

const db = (rows: Array<Record<string, unknown>>) =>
    Layer.succeed(SurrealClient, { query: <T>(_s: string) => Effect.succeed([rows] as unknown as T) } as never);

describe("computeTimeToLand", () => {
    test("ms from session.ended_at to the earliest linked PR merged_at", async () => {
        // query returns precomputed ms per session (see implementation note).
        const rows = [{ session: "session:`s1`", ms: 3600000 }];
        const out = await Effect.runPromise(computeTimeToLand(["session:`s1`"]).pipe(Effect.provide(db(rows))));
        expect(out.get("session:`s1`")).toBe(3600000);
    });
    test("no linked merged PR → null", async () => {
        const out = await Effect.runPromise(computeTimeToLand(["session:`s9`"]).pipe(Effect.provide(db([]))));
        expect(out.get("session:`s9`")).toBe(null);
    });
});
```

- [ ] **Step 2: Run → FAIL.**
Run: `/tmp/m.sh apps/axctl/src/metrics/time-to-land.test.ts`

- [ ] **Step 3: Implement.** `apps/axctl/src/metrics/time-to-land.ts`:

```ts
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { recordLiteral } from "@ax/lib/ids";

const stripKey = (idStr: string): string => {
    let k = idStr.trim().replace(/^session:/, "");
    if (k.startsWith("⟨") && k.endsWith("⟩")) k = k.slice(1, -1);
    if (k.startsWith("`") && k.endsWith("`")) k = k.slice(1, -1);
    return k;
};

/**
 * Latency from a session's end to when its work landed: the earliest
 * `merged_at` over PRs whose merge_sha/head_sha resolves to a commit the
 * session `produced`. Returns ms, or null when nothing merged.
 *
 * Path: session ->produced-> commit  ⨝  pull_request(merge_sha = commit.sha).
 */
export const computeTimeToLand = (
    sessionIds: readonly string[],
): Effect.Effect<Map<string, number | null>, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const map = new Map<string, number | null>();
        if (sessionIds.length === 0) return map;
        const refs = sessionIds.map((id) => recordLiteral("session", stripKey(id))).join(", ");
        // Per session: min merged_at of PRs whose merge_sha matches a produced commit's sha,
        // minus session.ended_at, in ms. Computed DB-side via duration::millis.
        const result = (yield* db.query<[Array<Record<string, unknown>>]>(`
SELECT
  type::string(in) AS session,
  math::min(
    (SELECT VALUE duration::millis(pr.merged_at - in.ended_at)
     FROM pull_request AS pr
     WHERE pr.merged_at != NONE
       AND pr.merge_sha = out.sha
       AND in.ended_at != NONE)
  ) AS ms
FROM produced
WHERE in IN [${refs}]
GROUP BY session;`))?.[0] ?? [];
        for (const row of result) {
            const ms = row.ms;
            map.set(String(row.session), typeof ms === "number" && Number.isFinite(ms) ? ms : null);
        }
        for (const id of sessionIds) if (!map.has(id)) map.set(id, null);
        return map;
    });
```

Note: the exact SurrealQL for the correlated subquery + `duration::millis` must be validated against the live DB in Task 9; if the inline correlated subquery is awkward, compute it in two steps (load produced commit shas per session, then `SELECT min(merged_at) FROM pull_request WHERE merge_sha IN [...]`, subtract `ended_at` in JS). Keep the public signature (`Map<string, number|null>`) stable so the test and callers don't change.

- [ ] **Step 4: Run → PASS.** Typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/metrics/time-to-land.ts apps/axctl/src/metrics/time-to-land.test.ts
git commit -m "feat(metrics): time_to_land_ms per session"
```

---

## Task 5: `session-loc.ts` - lines added/removed per session (reuse `editDelta`)

**Files:**
- Create: `apps/axctl/src/metrics/session-loc.ts`
- Test: `apps/axctl/src/metrics/session-loc.test.ts`

- [ ] **Step 1: Write the failing test.** `apps/axctl/src/metrics/session-loc.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { computeSessionLoc } from "./session-loc.ts";
import { SurrealClient } from "@ax/lib/db";

const db = (rows: Array<Record<string, unknown>>) =>
    Layer.succeed(SurrealClient, { query: <T>(_s: string) => Effect.succeed([rows] as unknown as T) } as never);

describe("computeSessionLoc", () => {
    test("sums editDelta over a session's Edit/Write tool_calls", async () => {
        const rows = [
            { session: "session:`s1`", name: "Edit", input_json: JSON.stringify({ old_string: "a", new_string: "a\nb\nc" }) },
            { session: "session:`s1`", name: "Write", input_json: JSON.stringify({ content: "x\ny" }) },
        ];
        const out = await Effect.runPromise(computeSessionLoc(["session:`s1`"]).pipe(Effect.provide(db(rows))));
        expect(out.get("session:`s1`")).toEqual({ added: 3 + 2, removed: 1 }); // Edit +3/-1, Write +2/-0
    });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** Reuse the exported `editDelta` from the merged `ax loc` work. `apps/axctl/src/metrics/session-loc.ts`:

```ts
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { recordLiteral } from "@ax/lib/ids";
import { surrealString } from "@ax/lib/shared/surql";
import { editDelta } from "../dashboard/loc-query.ts";

const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
const stripKey = (idStr: string): string => {
    let k = idStr.trim().replace(/^session:/, "");
    if (k.startsWith("⟨") && k.endsWith("⟩")) k = k.slice(1, -1);
    if (k.startsWith("`") && k.endsWith("`")) k = k.slice(1, -1);
    return k;
};

export interface SessionLoc { readonly added: number; readonly removed: number; }

export const computeSessionLoc = (
    sessionIds: readonly string[],
): Effect.Effect<Map<string, SessionLoc>, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const map = new Map<string, SessionLoc>();
        if (sessionIds.length === 0) return map;
        const refs = sessionIds.map((id) => recordLiteral("session", stripKey(id))).join(", ");
        const tools = EDIT_TOOLS.map((t) => surrealString(t)).join(", ");
        const rows = (yield* db.query<[Array<Record<string, unknown>>]>(`
SELECT type::string(session) AS session, name, input_json
FROM tool_call
WHERE session IN [${refs}] AND name IN [${tools}];`))?.[0] ?? [];
        for (const r of rows) {
            const s = String(r.session);
            const d = editDelta(String(r.name ?? ""), typeof r.input_json === "string" ? r.input_json : null);
            const cur = map.get(s) ?? { added: 0, removed: 0 };
            map.set(s, { added: cur.added + d.added, removed: cur.removed + d.removed });
        }
        for (const id of sessionIds) if (!map.has(id)) map.set(id, { added: 0, removed: 0 });
        return map;
    });
```

- [ ] **Step 4: Run → PASS.** Typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/metrics/session-loc.ts apps/axctl/src/metrics/session-loc.test.ts
git commit -m "feat(metrics): lines added/removed per session (reuse editDelta)"
```

---

## Task 6: `fragility-cascade.ts` - the cross-session insight (pin the weight formula)

**Decision (pins the spec's open question):** `fragility_cascade` returns one edge per (origin_session → downstream_session) pair where the origin's commit touched a file, that file's commit is `reverted`, and a *different, later* session edited the same file. **Weight = number of distinct downstream fixer sessions for that origin** (counted once per downstream session, not per commit - avoids the double-count the review flagged).

**Files:**
- Create: `apps/axctl/src/metrics/fragility-cascade.ts`
- Test: `apps/axctl/src/metrics/fragility-cascade.test.ts`

- [ ] **Step 1: Write the failing test.** `apps/axctl/src/metrics/fragility-cascade.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { computeFragilityCascade, type CascadeEdge } from "./fragility-cascade.ts";
import { SurrealClient } from "@ax/lib/db";

const db = (rows: Array<Record<string, unknown>>) =>
    Layer.succeed(SurrealClient, { query: <T>(_s: string) => Effect.succeed([rows] as unknown as T) } as never);

describe("computeFragilityCascade", () => {
    test("origin→downstream edges weighted by distinct downstream fixers", async () => {
        // query returns flat (origin, downstream, file) rows; impl dedupes + weights.
        const rows = [
            { origin: "session:`A`", downstream: "session:`B`", file: "file:`f1`" },
            { origin: "session:`A`", downstream: "session:`B`", file: "file:`f2`" }, // same pair, 2 files
            { origin: "session:`A`", downstream: "session:`C`", file: "file:`f1`" },
        ];
        const edges = await Effect.runPromise(computeFragilityCascade().pipe(Effect.provide(db(rows))));
        const a = edges.filter((e: CascadeEdge) => e.origin === "session:`A`");
        // weight = distinct downstream sessions for A = {B, C} = 2
        expect(a.every((e) => e.weight === 2)).toBe(true);
        expect(new Set(a.map((e) => e.downstream))).toEqual(new Set(["session:`B`", "session:`C`"]));
    });
    test("empty graph → no edges", async () => {
        const edges = await Effect.runPromise(computeFragilityCascade().pipe(Effect.provide(db([]))));
        expect(edges).toEqual([]);
    });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** `apps/axctl/src/metrics/fragility-cascade.ts`:

```ts
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";

export interface CascadeEdge {
    readonly origin: string;     // session that introduced a reverted-commit file
    readonly downstream: string; // later session that had to edit the same file
    readonly weight: number;     // distinct downstream fixers for this origin
}

/**
 * Cross-session fragility cascade. A reverted commit's session (origin) touched
 * a file; later, OTHER sessions edited that same file (downstream fixers).
 * Edge origin→downstream; weight = distinct downstream sessions per origin.
 * Reuses the Task-2 `commit.reverted` primitive (no later_fixed_by re-walk).
 */
export const computeFragilityCascade = (): Effect.Effect<CascadeEdge[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        // Flat (origin, downstream, file) rows. The origin is the session that
        // produced a reverted commit touching the file; downstream is a different
        // session whose `edited` edge on that file is later.
        const rows = (yield* db.query<[Array<Record<string, unknown>>]>(`
SELECT
  type::string(origin) AS origin,
  type::string(downstream) AS downstream,
  type::string(file) AS file
FROM (
  SELECT
    (<-produced<-session)[0] AS origin,
    out AS file,
    ts AS origin_ts
  FROM touched
  WHERE in.reverted = true
) AS o,
(
  SELECT in.session AS downstream, out AS file, ts FROM edited
) AS d
WHERE o.file = d.file AND d.downstream != o.origin AND d.ts > o.origin_ts;`))?.[0] ?? [];

        // Dedupe to distinct (origin, downstream) pairs, then weight by distinct downstreams per origin.
        const pairs = new Set<string>();
        const downstreamByOrigin = new Map<string, Set<string>>();
        for (const r of rows) {
            const origin = String(r.origin); const downstream = String(r.downstream);
            if (!origin || !downstream || origin === "null") continue;
            pairs.add(`${origin} ${downstream}`);
            (downstreamByOrigin.get(origin) ?? downstreamByOrigin.set(origin, new Set()).get(origin)!).add(downstream);
        }
        return [...pairs].map((p) => {
            const [origin, downstream] = p.split(" ");
            return { origin, downstream, weight: downstreamByOrigin.get(origin)!.size };
        });
    });
```

Note: the joined SurrealQL is the highest-risk query in this wave (cross-product over `touched`×`edited`). It MUST be validated + latency-checked against the live ~87k-edge graph in Task 9; if it does not perform, fall back to: load reverted-commit touched-files per origin session (one query), load `edited` (file, session, ts) (one query), and do the join + weight in JS. Keep the `CascadeEdge[]` return type stable.

- [ ] **Step 4: Run → PASS.** Typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/metrics/fragility-cascade.ts apps/axctl/src/metrics/fragility-cascade.test.ts
git commit -m "feat(metrics): cross-session fragility_cascade"
```

---

## Task 7: `derive-metrics` stage - orchestrate + dirty-set UPSERT + register

**Files:**
- Create: `apps/axctl/src/ingest/derive-metrics.ts`
- Test: `apps/axctl/src/ingest/derive-metrics.test.ts`, `apps/axctl/src/ingest/derive-metrics.stage.test.ts`
- Modify: `apps/axctl/src/ingest/stage/registry.ts`

- [ ] **Step 1: Write the stage-metadata test.** `apps/axctl/src/ingest/derive-metrics.stage.test.ts` (mirror `git.stage.test.ts`):

```ts
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { DeriveMetricsKey, deriveMetricsStage } from "./derive-metrics.ts";

describe("derive-metrics stage", () => {
    test("key + meta", () => {
        expect(Schema.decodeUnknownSync(DeriveMetricsKey)("derive-metrics")).toBe("derive-metrics");
        expect(deriveMetricsStage.meta.key).toBe("derive-metrics");
        expect(deriveMetricsStage.meta.deps).toEqual(["git", "github-pr", "session-health"]);
        expect(deriveMetricsStage.meta.tags).toEqual(["derive"]);
    });
});
```

Note: confirm the exact dependency stage keys exist in `ALL_STAGES` (`git` exists; `github-pr` from the merged PR-ingest work; the health stage key - check `registry.ts` for `sessionHealthStage`'s key, it may be `"session-health"` or `"health"`; set `deps` to the real keys and update this test to match).

- [ ] **Step 2: Write the dirty-set behavior test.** `apps/axctl/src/ingest/derive-metrics.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { deriveMetrics } from "./derive-metrics.ts";
import { SurrealClient } from "@ax/lib/db";

// Capture UPSERTs to session_metrics; serve canned reads.
const makeDb = (sink: string[]) =>
    Layer.succeed(SurrealClient, {
        query: <T>(sql: string) => {
            if (/UPSERT session_metrics|UPDATE commit SET reverted/.test(sql)) { sink.push(sql); return Effect.succeed([[]] as unknown as T); }
            if (/FROM commit\b/.test(sql)) return Effect.succeed([[]] as unknown as T);
            if (/FROM touched/.test(sql)) return Effect.succeed([[]] as unknown as T);
            if (/FROM session_health/.test(sql)) return Effect.succeed([[]] as unknown as T);
            // dirty-set query: return one dirty session.
            if (/dirty|FROM session/.test(sql)) return Effect.succeed([[{ session: "session:`s1`" }]] as unknown as T);
            if (/FROM produced/.test(sql)) return Effect.succeed([[{ session: "session:`s1`", produced: 2, reverted: 0 }]] as unknown as T);
            if (/FROM tool_call/.test(sql)) return Effect.succeed([[]] as unknown as T);
            return Effect.succeed([[]] as unknown as T);
        },
    } as never);

describe("deriveMetrics", () => {
    test("recomputes commit.reverted (full history) then UPSERTs one row per dirty session", async () => {
        const sink: string[] = [];
        const stats = await Effect.runPromise(deriveMetrics({ sinceDays: 1 }).pipe(Effect.provide(makeDb(sink))));
        expect(sink.some((s) => /UPDATE commit SET reverted = false/.test(s))).toBe(true); // full-history reset ran
        expect(sink.some((s) => /UPSERT session_metrics/.test(s) && s.includes("session:`s1`"))).toBe(true);
        expect(stats.sessionsWritten).toBe(1);
    });
});
```

- [ ] **Step 3: Run both → FAIL.**

- [ ] **Step 4: Implement the stage.** `apps/axctl/src/ingest/derive-metrics.ts`:

```ts
import { Effect, Schema } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { recordLiteral } from "@ax/lib/ids";
import { surrealOptionDate } from "@ax/lib/shared/surql"; // for any datetime fields if needed
import { executeStatementsWith } from "@ax/lib/shared/statement-exec";
import { BaseStageStats, type IngestContext, sinceDaysFromCtx, StageMeta, type StageDef } from "./stage/types.ts";
import { computeRevertedCommits } from "../metrics/commit-reverted.ts";
import { computeDurability } from "../metrics/durability.ts";
import { computeTimeToLand } from "../metrics/time-to-land.ts";
import { computeSessionLoc } from "../metrics/session-loc.ts";

export interface DeriveMetricsStats { readonly sessionsWritten: number; readonly revertedCommits: number; }

const num = (n: number | null): string => (n === null ? "NONE" : String(n));

export const deriveMetrics = (
    opts: { sinceDays: number | undefined },
): Effect.Effect<DeriveMetricsStats, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        // 1. Freshness backbone: recompute commit.reverted over FULL history.
        const reverted = yield* computeRevertedCommits();

        // 2. Dirty set: sessions that produced a commit whose reverted may have
        //    changed (i.e. any session that produced any commit) UNION sessions
        //    started within the window. For wave 1, recompute the union of:
        //    (a) sessions with produced edges, bounded to the window by started_at.
        const sinceClause = opts.sinceDays
            ? `started_at >= time::now() - ${Math.max(1, Math.trunc(opts.sinceDays))}d`
            : "true";
        const dirty = (yield* db.query<[Array<{ session: string }>]>(`
SELECT VALUE type::string(id) AS session FROM session WHERE ${sinceClause}
  OR id IN (SELECT VALUE in FROM produced WHERE out.reverted = true);`))?.[0] ?? [];
        const sessionIds = (dirty as unknown as string[]).filter((s) => typeof s === "string");
        if (sessionIds.length === 0) return { sessionsWritten: 0, revertedCommits: reverted.revertedCount };

        // 3. Compute the wave-1 scalars for the dirty set.
        const [dur, ttl, loc] = yield* Effect.all([
            computeDurability(sessionIds),
            computeTimeToLand(sessionIds),
            computeSessionLoc(sessionIds),
        ], { concurrency: 3 });

        // 4. UPSERT one session_metrics row per dirty session.
        const stmts = sessionIds.map((id) => {
            const ref = recordLiteral("session", id.replace(/^session:/, "").replace(/^`|`$/g, ""));
            const key = id.replace(/^session:/, "").replace(/^`|`$/g, "");
            const d = dur.get(id) ?? { produced: 0, reverted: 0, ratio: null };
            const l = loc.get(id) ?? { added: 0, removed: 0 };
            const t = ttl.get(id) ?? null;
            return `UPSERT ${recordLiteral("session_metrics", key)} CONTENT { `
                + `session: ${ref}, `
                + `durability_ratio: ${num(d.ratio)}, produced_commits: ${d.produced}, reverted_commits: ${d.reverted}, `
                + `time_to_land_ms: ${num(t)}, lines_added: ${l.added}, lines_removed: ${l.removed}, `
                + `ts: time::now() };`;
        });
        yield* executeStatementsWith(db, stmts, { chunkSize: 500 });
        return { sessionsWritten: sessionIds.length, revertedCommits: reverted.revertedCount };
    });

export const DeriveMetricsKey = Schema.Literal("derive-metrics");
export type DeriveMetricsKey = typeof DeriveMetricsKey.Type;

export class DeriveMetricsStageStats extends BaseStageStats.extend<DeriveMetricsStageStats>("DeriveMetricsStageStats")({
    sessionsWritten: Schema.Number,
    revertedCommits: Schema.Number,
}) {}

export const deriveMetricsStage: StageDef<DeriveMetricsStageStats, SurrealClient> = {
    meta: StageMeta.make({ key: "derive-metrics", deps: ["git", "github-pr", "session-health"], tags: ["derive"] }),
    run: (ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const r = yield* deriveMetrics({ sinceDays: sinceDaysFromCtx(ctx) });
            return DeriveMetricsStageStats.make({
                durationMs: Date.now() - t0,
                summary: `wrote ${r.sessionsWritten} session_metrics rows; ${r.revertedCommits} reverted commits`,
                sessionsWritten: r.sessionsWritten,
                revertedCommits: r.revertedCommits,
            });
        }),
};
```

Note: verify exact import paths against `closure.ts` (it imports `BaseStageStats, IngestContext, sinceDaysFromCtx, sinceWhereClause, StageMeta` from `./stage/types.ts`, and `StageDef` may come from `./stage/types.ts` or `./stage/registry.ts` - match closure.ts/git.ts exactly). Verify `executeStatementsWith`'s real module path (`@ax/lib/shared/statement-exec` per closure.ts).

- [ ] **Step 5: Run both tests → PASS.** Typecheck clean.

- [ ] **Step 6: Register the stage (3 edits in `registry.ts`).**
1. import: `import { DeriveMetricsKey, deriveMetricsStage } from "../derive-metrics.ts";`
2. add `DeriveMetricsKey` to the `IngestStageKey = Schema.Union([...])` array (after `ClosureKey`).
3. add `deriveMetricsStage` to `ALL_STAGES` (after `closureStage` - it derives over closure/git/pr output).

- [ ] **Step 7: Run the stage registry suite.**
Run: `/tmp/m.sh apps/axctl/src/ingest/stage/`
Expected: PASS (union decodes "derive-metrics"; registry lists the stage).

- [ ] **Step 8: Commit**

```bash
git add apps/axctl/src/ingest/derive-metrics.ts apps/axctl/src/ingest/derive-metrics.test.ts apps/axctl/src/ingest/derive-metrics.stage.test.ts apps/axctl/src/ingest/stage/registry.ts
git commit -m "feat(ingest): derive-metrics stage (freshness + durability/ttl/loc rollup)"
```

---

## Task 8: `session-metrics-query.ts` - typed read joining the three tables

**Files:**
- Create: `apps/axctl/src/metrics/session-metrics-query.ts`
- Test: `apps/axctl/src/metrics/session-metrics-query.test.ts`

- [ ] **Step 1: Write the failing test.** `apps/axctl/src/metrics/session-metrics-query.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { fetchSessionMetrics } from "./session-metrics-query.ts";
import { SurrealClient } from "@ax/lib/db";

const db = (rows: Array<Record<string, unknown>>) =>
    Layer.succeed(SurrealClient, { query: <T>(_s: string) => Effect.succeed([rows] as unknown as T) } as never);

describe("fetchSessionMetrics", () => {
    test("maps joined rows into typed SessionMetricsRow[]", async () => {
        const rows = [{
            session: "session:`s1`", task_label: "add login", source: "claude",
            durability_ratio: 0.75, produced_commits: 4, time_to_land_ms: 3600000,
            lines_added: 120, lines_removed: 30, estimated_cost_usd: 0.42, user_corrections: 1,
        }];
        const out = await Effect.runPromise(fetchSessionMetrics({ since: null, limit: 50 }).pipe(Effect.provide(db(rows))));
        expect(out[0]).toMatchObject({
            session: "session:`s1`", taskLabel: "add login", durabilityRatio: 0.75,
            producedCommits: 4, timeToLandMs: 3600000, linesAdded: 120, linesRemoved: 30,
        });
    });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** `apps/axctl/src/metrics/session-metrics-query.ts` - model on `apps/axctl/src/dashboard/cost-query.ts` (same SELECT + map helpers style). Join `session_metrics` to `session_health` (task_label, user_corrections, interruptions, context_pressure) and `session_token_usage` (estimated_cost_usd) on `session`:

```ts
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { surrealDate } from "@ax/lib/shared/surql";

export interface SessionMetricsRow {
    readonly session: string;
    readonly taskLabel: string | null;
    readonly source: string | null;
    readonly durabilityRatio: number | null;
    readonly producedCommits: number;
    readonly timeToLandMs: number | null;
    readonly linesAdded: number;
    readonly linesRemoved: number;
    readonly estimatedCostUsd: number | null;
    readonly userCorrections: number | null;
}

const numOrNull = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    const n = Number(v); return Number.isFinite(n) ? n : null;
};
const numOrZero = (v: unknown): number => numOrNull(v) ?? 0;
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export const fetchSessionMetrics = (
    input: { readonly since: Date | null; readonly limit: number; readonly project?: string | null },
): Effect.Effect<SessionMetricsRow[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const limit = Math.min(Math.max(input.limit, 1), 500);
        const clauses: string[] = [];
        if (input.since) clauses.push(`session.started_at >= ${surrealDate(input.since)}`);
        if (input.project) clauses.push(`(session.project = "${input.project}" OR session.cwd = "${input.project}")`);
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        const rows = (yield* db.query<[Array<Record<string, unknown>>]>(`
SELECT
  type::string(session) AS session,
  session.source AS source,
  durability_ratio, produced_commits, time_to_land_ms, lines_added, lines_removed,
  (SELECT task_label FROM session_health WHERE session = $parent.session LIMIT 1)[0].task_label AS task_label,
  (SELECT user_corrections FROM session_health WHERE session = $parent.session LIMIT 1)[0].user_corrections AS user_corrections,
  (SELECT estimated_cost_usd FROM session_token_usage WHERE session = $parent.session LIMIT 1)[0].estimated_cost_usd AS estimated_cost_usd
FROM session_metrics
${where}
ORDER BY durability_ratio ASC
LIMIT ${limit};`))?.[0] ?? [];
        return rows.map((r) => ({
            session: String(r.session ?? ""),
            taskLabel: strOrNull(r.task_label),
            source: strOrNull(r.source),
            durabilityRatio: numOrNull(r.durability_ratio),
            producedCommits: numOrZero(r.produced_commits),
            timeToLandMs: numOrNull(r.time_to_land_ms),
            linesAdded: numOrZero(r.lines_added),
            linesRemoved: numOrZero(r.lines_removed),
            estimatedCostUsd: numOrNull(r.estimated_cost_usd),
            userCorrections: numOrNull(r.user_corrections),
        }));
    });
```

- [ ] **Step 4: Run → PASS.** Typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/metrics/session-metrics-query.ts apps/axctl/src/metrics/session-metrics-query.test.ts
git commit -m "feat(metrics): typed session-metrics read module"
```

---

## Task 9: `ax sessions metrics` + `sessions show` block + live smoke + docs

**Files:**
- Modify: `apps/axctl/src/cli/index.ts`
- Create: `docs/metrics.md`

- [ ] **Step 1: Add the `sessions metrics` subcommand.** In `apps/axctl/src/cli/index.ts`, near the other `sessions` subcommands (the `Command.make("sessions").pipe(Command.withSubcommands([...]))` around line 3454) and following the `cmdCostsFor`/`costsForCommand` pattern (around line 4228): import `fetchSessionMetrics`, add a `cmdSessionsMetrics` handler + a `sessionsMetricsCommand` with flags `--here --since --project --limit --json`, and add it to the `sessions` `withSubcommands([...])` array. The handler resolves `--here` to a project filter via `resolvePwdRepository()` (same as `cmdCostsFor`), builds `{ since, limit, project }`, calls `fetchSessionMetrics`, and prints a table (or `prettyPrint` JSON when `--json`). Concrete handler:

```ts
import { fetchSessionMetrics, type SessionMetricsRow } from "../metrics/session-metrics-query.ts";

const pct = (v: number | null): string => (v === null ? "  -  " : `${(v * 100).toFixed(0)}%`.padStart(5));
const ms = (v: number | null): string => (v === null ? "-" : v >= 3600000 ? `${(v / 3600000).toFixed(1)}h` : `${Math.round(v / 60000)}m`);

const formatSessionMetrics = (rows: SessionMetricsRow[]): string => {
    const lines = [`${"session".padEnd(20)} ${"durab".padStart(5)} ${"commits".padStart(7)} ${"land".padStart(6)} ${"+/-loc".padStart(11)}  task`];
    for (const r of rows.slice(0, 50)) {
        lines.push(
            `${r.session.replace(/^session:/, "").slice(0, 20).padEnd(20)} ${pct(r.durabilityRatio)} ${String(r.producedCommits).padStart(7)} ${ms(r.timeToLandMs).padStart(6)} ${`+${r.linesAdded}/-${r.linesRemoved}`.padStart(11)}  ${r.taskLabel ?? ""}`,
        );
    }
    return lines.join("\n");
};

const cmdSessionsMetrics = (input: { since: number | null; project: string | null; here: boolean; limit: number; json: boolean }) =>
    Effect.gen(function* () {
        let project = input.project;
        if (input.here) {
            const pwd = yield* resolvePwdRepository().pipe(
                Effect.catchTag("NotAGitRepoError", (e) => Effect.sync(() => { process.stderr.write(`axctl sessions metrics: --here needs a git repo (cwd=${e.cwd})\n`); process.exit(2); })),
            );
            project = pwd.repoRoot;
        }
        const since = input.since === null ? null : new Date(Date.now() - Math.min(Math.max(input.since, 1), 3650) * 86400 * 1000);
        const rows = yield* fetchSessionMetrics({ since, limit: input.limit, project });
        if (input.json) { console.log(prettyPrint(rows)); return; }
        console.log(formatSessionMetrics(rows));
    });
```

Then the command (mirror `costsForCommand`'s flag wiring) and add `sessionsMetricsCommand` to the `sessions` subcommands array. (`prettyPrint`, `resolvePwdRepository`, `optionalSince`, `positiveLimit`, `jsonFlag`, `optionValue` already exist in the file.)

- [ ] **Step 2: Add a metrics block to `sessions show`.** Find the `sessions show` handler/formatter. After the existing session summary, fetch the one session's metrics row (`fetchSessionMetrics` filtered to that id, or a direct `SELECT * FROM session_metrics WHERE session = <ref>`) and print a `metrics:` block (durability, time-to-land, loc, produced/reverted). Keep it 4-5 lines; skip silently if no row exists.

- [ ] **Step 3: Typecheck + existing CLI tests.**
Run: `bun run typecheck 2>&1 | rg "cli/index"` → empty.
Run: `/tmp/m.sh apps/axctl/src/cli/` (if CLI tests exist) → PASS.

- [ ] **Step 4: LIVE SMOKE (the PR-ingest lesson - mocks miss runtime/schema bugs).** Apply schema, run the stage against the real DB, verify:

```bash
bun run db:schema
AX_PROGRESS=plain bun apps/axctl/src/cli/index.ts ingest --stages=git,github-pr,session-health,closure,derive-metrics 2>&1 | rg "derive-metrics|error"
```
Then query the DB (use the project's surreal endpoint, ns=ax db=main):
```surql
SELECT count() AS n, count(durability_ratio != NONE) AS with_durab FROM session_metrics GROUP ALL;
SELECT count() AS reverted FROM commit WHERE reverted = true GROUP ALL;
```
Expected: `session_metrics` rows > 0, some `durability_ratio` non-NONE, some reverted commits > 0. Then:
```bash
bun apps/axctl/src/cli/index.ts sessions metrics --limit 10
```
Expected: a table of sessions with durability/commits/land/loc. **If `count(out.reverted = true)`, the `time_to_land` correlated subquery, or the `fragility_cascade` join error or hang** - apply the JS-fallback noted in Tasks 3/4/6, re-run, keep the public signatures stable.

- [ ] **Step 5: Write `docs/metrics.md`.** Document: the 4 wave-1 metrics + their formulas; that `commit.reverted` is full-history (the freshness fix, link ADR-0011); how to add a metric *today* (new `metrics/<name>.ts` compute fn + a `session_metrics` column + wire into `derive-metrics` + a `SessionMetricsRow` field + a column in `formatSessionMetrics`); and the wave-3 extraction gate (when this list-of-edits feels like copy-paste at ~signal #6, extract a registry - see ADR-0011).

- [ ] **Step 6: Commit**

```bash
git add apps/axctl/src/cli/index.ts docs/metrics.md
git commit -m "feat(cli): ax sessions metrics + sessions show metrics block; docs"
```

---

## Final verification (after all tasks)

- [ ] Full metrics suite green: `/tmp/m.sh apps/axctl/src/metrics/ apps/axctl/src/ingest/derive-metrics.test.ts apps/axctl/src/ingest/derive-metrics.stage.test.ts apps/axctl/src/ingest/stage/`
- [ ] `bun run typecheck` shows no NEW errors for any `metrics/`, `derive-metrics`, `cli/index` file.
- [ ] Live smoke (Task 9 Step 4) re-run clean: `session_metrics` populated, `ax sessions metrics` renders, freshness verified by re-ingesting after a new fix commit and confirming an old session's `durability_ratio` drops.
- [ ] Dispatch a final whole-wave code review (subagent-driven-development's final reviewer).

## Notes carried from the spec / review (do not re-litigate)
- Relations (`fragility_cascade` write-back as edges) and aggregates are wave-2/3; wave-1 `fragility_cascade` is a read-time query only (not stored), surfaced on demand - do NOT add it to the daemon `--since=1` path.
- No `COMPUTED` graph-traversing fields on listing surfaces (verified per-read hang).
- `EXISTS(...)` is not SurrealQL - use `count(...) > 0`.
- Every derived query is a single set-based aggregate, tombstone-filtered in JS where tombstones apply; the expensive `later_fixed_by` detection runs once in `commit-reverted`, everything else joins the stored bool.
