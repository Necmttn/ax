# Ingest reaper + staleness warning + derive budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close issue #697 - the serve daemon auto-reaps stranded `ingest_run` rows, every DB-backed read command warns when the graph is stale, and derive stages can't push a pass past its wall-clock deadline.

**Architecture:** Three seams, no new tables. (a) A periodic `Effect.repeat(Schedule.spaced(...))` loop forked onto the existing serve runtime calls the already-shipped `reapStaleIngestRuns` - the #597 reap is correct but only fires at ingest start, and on the IDE-daemon model (no watcher) ingest never re-ran, so nothing swept it. (b) `withDb` in the CLI gains an `Effect.ensuring` staleness probe - one indexed query, stderr-only, fail-open. (c) The existing derive watchdog (`AX_STAGE_TIMEOUT_SECONDS`, 300s, #671) gains deadline-awareness: a derive stage's cap becomes `min(staticCap, timeUntilRunDeadline - reserve)`, so derives end before the outer `AX_INGEST_TIMEOUT_SECONDS` guillotine fires and the run finalizes cleanly instead of leaving a cooldown lock.

**Tech Stack:** TypeScript strict, Effect v4 beta (`effect@beta`), SurrealDB 3.x, bun:test.

## Global Constraints

- Tests are **bun:test** (`import { describe, expect, test } from "bun:test"`), NOT vitest. `TestClock` comes from `effect/testing` (pattern: `apps/studio-desktop/src/backend/DesktopIngestScheduler.test.ts`).
- NEVER touch the live daemon/DB at `127.0.0.1:8521` / `1738`. All tests use `makeTestSurrealClient` / `AxConfigTest` layers. No live-DB e2e.
- Work ONLY in `/Users/necmttn/Projects/ax/.claude/worktrees/697-fix`. `pwd` must match before any git command.
- Every write is fail-open: a reap/staleness/budget defect must never break ingest or a read command.
- Do NOT expand into #689 (usage derive exceeds watchdog, cascades). File a follow-up instead.
- Gates: `bun run typecheck` exits 0 (check the REAL exit code) + `bun test` green on touched suites.

---

### Task 1: Shared stranded-run predicate (`@ax/lib/shared/ingest-staleness`)

The stale-"running" rule is currently written TWICE - `staleRunningIngestRuns` (`apps/axctl/src/cli/install.ts:951`, doctor's HTTP probe) and `isStranded` (`apps/axctl/src/ingest/reap-runs.ts:30`, the reaper). Same logic, two copies; the daemon reaper (Task 2) and the staleness warning (Task 3) would make it four. Extract the predicate + the graph-staleness formatter into one dep-free module both sides import.

**Files:**
- Create: `packages/lib/src/shared/ingest-staleness.ts`
- Create: `packages/lib/src/shared/ingest-staleness.test.ts`
- Modify: `packages/lib/package.json` (add the `./shared/ingest-staleness` export)
- Modify: `apps/axctl/src/ingest/reap-runs.ts:17-34` (import the predicate, re-export `REAP_GRACE_SECONDS`)
- Modify: `apps/axctl/src/cli/install.ts:951-962,1029` (import the predicate + grace constant)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface IngestRunHeartbeatRow { readonly id?: unknown; readonly started_at?: unknown; readonly last_progress_at?: unknown }`
  - `const REAP_GRACE_SECONDS: number` (= 60)
  - `const isStrandedRun: (row: IngestRunHeartbeatRow, nowMs: number, staleAfterMs: number) => boolean`
  - `const STALE_INGEST_AFTER_HOURS: number` (= 48)
  - `const formatStaleIngestWarning: (input: { readonly lastOkMs: number | null; readonly nowMs: number; readonly thresholdMs: number }) => string | null`

- [ ] **Step 1: Write the failing test**

Create `packages/lib/src/shared/ingest-staleness.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
    formatStaleIngestWarning,
    isStrandedRun,
    REAP_GRACE_SECONDS,
    STALE_INGEST_AFTER_HOURS,
} from "./ingest-staleness.ts";

describe("isStrandedRun", () => {
    const now = Date.parse("2026-07-16T12:00:00.000Z");
    const staleAfterMs = 960_000; // 900s ingest timeout + 60s grace

    test("strands a run whose heartbeat is older than the budget", () => {
        expect(isStrandedRun(
            { id: "ingest_run:dead", started_at: "2026-07-16T11:00:00.000Z", last_progress_at: "2026-07-16T11:30:00.000Z" },
            now,
            staleAfterMs,
        )).toBe(true);
    });

    test("spares a run whose heartbeat is within the budget", () => {
        expect(isStrandedRun(
            { id: "ingest_run:live", started_at: "2026-07-16T10:00:00.000Z", last_progress_at: "2026-07-16T11:59:00.000Z" },
            now,
            staleAfterMs,
        )).toBe(false);
    });

    test("falls back to started_at when last_progress_at is absent", () => {
        expect(isStrandedRun({ id: "a", started_at: "2026-07-16T11:58:00.000Z" }, now, staleAfterMs)).toBe(false);
        expect(isStrandedRun({ id: "b", started_at: "2026-07-16T11:00:00.000Z" }, now, staleAfterMs)).toBe(true);
    });

    test("strands a row with no parseable timestamp (can't prove it's live)", () => {
        expect(isStrandedRun({ id: "ingest_run:mystery" }, now, staleAfterMs)).toBe(true);
    });

    test("REAP_GRACE_SECONDS is the shared 60s margin doctor and the reaper both use", () => {
        expect(REAP_GRACE_SECONDS).toBe(60);
    });
});

describe("formatStaleIngestWarning", () => {
    const now = Date.parse("2026-07-16T12:00:00.000Z");
    const thresholdMs = STALE_INGEST_AFTER_HOURS * 3_600_000;

    test("no warning when the last successful ingest is inside the threshold", () => {
        expect(formatStaleIngestWarning({
            lastOkMs: now - 3_600_000,
            nowMs: now,
            thresholdMs,
        })).toBeNull();
    });

    test("warns in days once the graph is older than the threshold", () => {
        const warning = formatStaleIngestWarning({
            lastOkMs: Date.parse("2026-07-03T12:00:00.000Z"),
            nowMs: now,
            thresholdMs,
        });
        expect(warning).toContain("graph is stale");
        expect(warning).toContain("13d ago");
        expect(warning).toContain("ax ingest");
    });

    test("warns in hours just past the threshold", () => {
        const warning = formatStaleIngestWarning({
            lastOkMs: now - 50 * 3_600_000,
            nowMs: now,
            thresholdMs,
        });
        expect(warning).toContain("50h ago");
    });

    test("warns with tailored copy when no successful ingest was ever recorded", () => {
        const warning = formatStaleIngestWarning({ lastOkMs: null, nowMs: now, thresholdMs });
        expect(warning).toContain("no successful ingest");
        expect(warning).toContain("ax ingest");
    });

    test("a non-positive threshold disables the warning entirely", () => {
        expect(formatStaleIngestWarning({ lastOkMs: null, nowMs: now, thresholdMs: 0 })).toBeNull();
        expect(formatStaleIngestWarning({ lastOkMs: 0, nowMs: now, thresholdMs: 0 })).toBeNull();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/lib/src/shared/ingest-staleness.test.ts`
Expected: FAIL - `Cannot find module './ingest-staleness.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/lib/src/shared/ingest-staleness.ts`:

```ts
/**
 * Ingest staleness rules, shared by every surface that judges "is the graph
 * current?" - `ax doctor`'s HTTP probe (cli/install.ts), the ingest-start +
 * daemon reapers (ingest/reap-runs.ts, dashboard/reap-loop.ts), and the
 * read-command warning (queries/ingest-staleness.ts).
 *
 * Two distinct questions live here on purpose - they are the same subject
 * (#697) and drifted apart once already:
 *  - {@link isStrandedRun}: is THIS "running" row a crash leftover?
 *  - {@link formatStaleIngestWarning}: is the graph as a whole out of date?
 *
 * Dep-free (no Effect, no DB) so doctor's no-layer code path and the site can
 * both import it.
 */

/** The `ingest_run` columns the stranded check reads. Shape is shared by
 *  doctor's raw HTTP probe and the reaper's SurrealClient query. */
export interface IngestRunHeartbeatRow {
    readonly id?: unknown;
    readonly started_at?: unknown;
    readonly last_progress_at?: unknown;
}

/** Grace beyond the ingest timeout before a still-"running" row is deemed
 *  stranded. Doctor, the ingest-start reaper and the daemon reaper share it so
 *  they can never disagree about what "stuck" means. */
export const REAP_GRACE_SECONDS = 60;

/**
 * Is this "running" row crash residue? Every clean exit path (ok / error /
 * interrupt / timeout) settles the row, so a row whose newest heartbeat
 * (`last_progress_at`, else `started_at`) is past the budget was killed
 * without finalizing. No parseable timestamp => can't prove it's live => treat
 * as stranded.
 */
export const isStrandedRun = (
    row: IngestRunHeartbeatRow,
    nowMs: number,
    staleAfterMs: number,
): boolean => {
    const beat = Date.parse(String(row.last_progress_at ?? row.started_at ?? ""));
    if (!Number.isFinite(beat)) return true;
    return nowMs - beat > staleAfterMs;
};

/** Age past which the graph is called stale on read commands (#697: two weeks
 *  of empty `ax cost` / `ax dispatches` went unflagged). */
export const STALE_INGEST_AFTER_HOURS = 48;

/** `50h` / `13d` - days once we're past two days, where "13d" reads better. */
const formatAge = (ageMs: number): string => {
    const hours = Math.floor(ageMs / 3_600_000);
    return hours >= 48 ? `${Math.floor(hours / 24)}d` : `${hours}h`;
};

/**
 * One-line warning for a stale graph, or null when it's current (or the check
 * is disabled with a non-positive threshold).
 *
 * `lastOkMs` is the newest run that finished with status "ok". Deliberately
 * NOT "ok or partial": the reaper settles crash residue as "partial", so
 * counting partials would let the ghost rows from #697 suppress the very
 * warning that exists to surface them.
 */
export const formatStaleIngestWarning = (input: {
    readonly lastOkMs: number | null;
    readonly nowMs: number;
    readonly thresholdMs: number;
}): string | null => {
    if (input.thresholdMs <= 0) return null;
    if (input.lastOkMs === null) {
        return "ax: no successful ingest recorded - results are empty until you run 'ax ingest'.";
    }
    const ageMs = input.nowMs - input.lastOkMs;
    if (ageMs <= input.thresholdMs) return null;
    return `ax: graph is stale - last successful ingest ${formatAge(ageMs)} ago; ` +
        `results may be incomplete. Run 'ax ingest' ('ax doctor' to diagnose).`;
};
```

Add the export to `packages/lib/package.json`, directly after the `"./shared/fs-classify"` line:

```json
    "./shared/ingest-staleness": "./src/shared/ingest-staleness.ts",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/lib/src/shared/ingest-staleness.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Point the two existing copies at the shared predicate**

In `apps/axctl/src/ingest/reap-runs.ts`, delete the local `RunningIngestRunRow` interface, the local `REAP_GRACE_SECONDS`, and the local `isStranded`, then import the shared ones. The exported `REAP_GRACE_SECONDS` is re-exported so existing importers keep working:

```ts
import {
    isStrandedRun,
    REAP_GRACE_SECONDS,
    type IngestRunHeartbeatRow,
} from "@ax/lib/shared/ingest-staleness";

export { REAP_GRACE_SECONDS };
```

Then update `selectStrandedRunIds` to use it (keep `bareRunId` exactly as-is):

```ts
/** Pure selector: the bare ids of rows that should be reaped. Exported for tests. */
export function selectStrandedRunIds(
    rows: readonly IngestRunHeartbeatRow[],
    nowMs: number,
    staleAfterMs: number,
): string[] {
    return rows.filter((row) => isStrandedRun(row, nowMs, staleAfterMs)).map((row) => bareRunId(row.id));
}
```

In `apps/axctl/src/cli/install.ts`, delete the local `RunningIngestRunRow` interface and rewrite `staleRunningIngestRuns` over the shared predicate (keep the exported name - `install.test.ts` uses it):

```ts
import {
    isStrandedRun,
    REAP_GRACE_SECONDS,
    type IngestRunHeartbeatRow,
} from "@ax/lib/shared/ingest-staleness";

/**
 * Rows whose newest heartbeat is older than `staleAfterMs` - crash residue that
 * never finalized (issue #269). Thin filter over the shared
 * {@link isStrandedRun} rule so doctor and the reapers can't drift. Exported
 * for tests.
 */
export function staleRunningIngestRuns(
    rows: readonly IngestRunHeartbeatRow[],
    nowMs: number,
    staleAfterMs: number,
): IngestRunHeartbeatRow[] {
    return rows.filter((row) => isStrandedRun(row, nowMs, staleAfterMs));
}
```

Replace the hardcoded `60` at `install.ts:1029` with the shared constant:

```ts
        const staleIngestRuns = dbReachable
            ? yield* Effect.promise(() =>
                probeStaleIngestRuns(daemon.endpoint, (ingestTimeoutSeconds + REAP_GRACE_SECONDS) * 1000))
            : null;
```

Also swap the `RunningIngestRunRow` annotations inside `probeStaleIngestRuns` for `IngestRunHeartbeatRow`.

- [ ] **Step 6: Run the affected suites**

Run: `bun test packages/lib/src/shared/ingest-staleness.test.ts apps/axctl/src/ingest/reap-runs.test.ts apps/axctl/src/cli/install.test.ts`
Expected: PASS - the pre-existing reap + install tests still pass against the shared predicate (proof the extraction is behavior-preserving).

- [ ] **Step 7: Typecheck**

Run: `bun run typecheck`
Expected: exit 0.

---

### Task 2: Daemon auto-reap loop (issue #697 part 1a)

`reapStaleIngestRuns` (#597) is correct but only fires at ingest START. On the IDE-daemon model there is no watcher, so when ingest stopped running the two crashed rows from Jul 3 sat "running" for two weeks with nothing to sweep them. Fix the trigger, not the reap: fork a periodic reap onto the serve runtime, which IS always up.

**Files:**
- Create: `apps/axctl/src/dashboard/reap-loop.ts`
- Create: `apps/axctl/src/dashboard/reap-loop.test.ts`
- Modify: `apps/axctl/src/ingest/reap-runs.test.ts` (add the real-seam test)
- Modify: `apps/axctl/src/dashboard/server.ts:290-296` (fork the loop after listen)

**Interfaces:**
- Consumes: `reapStaleIngestRuns` from `../ingest/reap-runs.ts` (Task 1 leaves its signature unchanged: `(opts?: { dryRun?: boolean }) => Effect.Effect<ReapStaleRunsResult, DbError, SurrealClient | AxConfig>`).
- Produces:
  - `const reapIntervalSeconds: (env?: NodeJS.ProcessEnv) => number` (default 300, `AX_REAP_INTERVAL_SECONDS`, 0 disables)
  - `const runReapLoop: (opts: { readonly intervalSeconds: number }) => Effect.Effect<void, never, SurrealClient | AxConfig>`

- [ ] **Step 1: Write the failing real-seam test for the reap itself**

The existing `reap-runs.test.ts` only covers the pure selector - nothing asserts a stuck row actually gets finalized. Append to `apps/axctl/src/ingest/reap-runs.test.ts` (add the imports at the top of the file):

```ts
import { Effect, Layer, Path } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { AxConfigTest } from "@ax/lib/config";
import { makeTestSurrealClient } from "@ax/lib/testing/surreal";
import { reapStaleIngestRuns, selectStrandedRunIds } from "./reap-runs.ts";

describe("reapStaleIngestRuns (real seam)", () => {
    // One stranded row (heartbeat in 2020) + one live row (heartbeat now). Only
    // the DB leaf is faked; the reap logic under test is the real one.
    const rows = () => [
        { id: "ingest_run:⟨070849df-4eba-4545-bd3d-c8e47d3e751a⟩", started_at: "2020-01-01T00:00:00.000Z" },
        { id: "ingest_run:live", started_at: new Date().toISOString(), last_progress_at: new Date().toISOString() },
    ];

    const harness = () => {
        const tc = makeTestSurrealClient({
            routes: { "FROM ingest_run WHERE status = 'running'": [rows()] },
        });
        const layer = Layer.mergeAll(
            tc.layer,
            AxConfigTest({ knobs: { ingestTimeoutSeconds: 900 } }).pipe(Layer.provide(BunFileSystem.layer)),
            BunFileSystem.layer,
            Path.layer,
        );
        return { tc, layer };
    };

    test("finalizes the stranded row as partial and leaves the live one alone", async () => {
        const { tc, layer } = harness();
        const result = await Effect.runPromise(reapStaleIngestRuns().pipe(Effect.provide(layer)));

        expect(result.reaped).toBe(1);
        expect(result.ids).toEqual(["070849df-4eba-4545-bd3d-c8e47d3e751a"]);

        // The observable effect: an UPDATE actually went to the DB for the dead
        // row, settling it as "partial" with the reaped marker.
        const updates = tc.captured.filter((sql) => sql.startsWith("UPDATE ingest_run:"));
        expect(updates).toHaveLength(1);
        expect(updates[0]).toContain("070849df-4eba-4545-bd3d-c8e47d3e751a");
        expect(updates[0]).toContain(`status = "partial"`);
        expect(updates[0]).toContain("reaped");
        expect(updates.join()).not.toContain("live");
    });

    test("dry-run reports the row but issues no UPDATE", async () => {
        const { tc, layer } = harness();
        const result = await Effect.runPromise(reapStaleIngestRuns({ dryRun: true }).pipe(Effect.provide(layer)));

        expect(result.found).toBe(1);
        expect(result.reaped).toBe(0);
        expect(tc.captured.filter((sql) => sql.startsWith("UPDATE ingest_run:"))).toHaveLength(0);
    });
});
```

- [ ] **Step 2: Run it to verify it passes (the reap is already correct)**

Run: `bun test apps/axctl/src/ingest/reap-runs.test.ts`
Expected: PASS. This test is a characterization pin, not a red - #697's bug is the missing TRIGGER, and Step 3's test is the red. If this FAILS, stop: the reap itself is broken and the plan's premise is wrong.

- [ ] **Step 3: Write the failing test for the loop**

Create `apps/axctl/src/dashboard/reap-loop.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Duration, Effect, Fiber, Layer, Path } from "effect";
import { TestClock } from "effect/testing";
import { BunFileSystem } from "@effect/platform-bun";
import { AxConfigTest } from "@ax/lib/config";
import { DbError } from "@ax/lib/errors";
import { makeTestSurrealClient, type TestSurrealRoutes } from "@ax/lib/testing/surreal";
import { reapIntervalSeconds, runReapLoop } from "./reap-loop.ts";

const strandedRow = { id: "ingest_run:dead", started_at: "2020-01-01T00:00:00.000Z" };

const harness = (routes: TestSurrealRoutes) => {
    const tc = makeTestSurrealClient({ routes });
    const layer = Layer.mergeAll(
        tc.layer,
        AxConfigTest({ knobs: { ingestTimeoutSeconds: 900 } }).pipe(Layer.provide(BunFileSystem.layer)),
        BunFileSystem.layer,
        Path.layer,
    );
    return { tc, layer };
};

const reapUpdates = (captured: readonly string[]): string[] =>
    captured.filter((sql) => sql.startsWith("UPDATE ingest_run:"));

describe("reapIntervalSeconds", () => {
    test("defaults to 300s", () => {
        expect(reapIntervalSeconds({} as NodeJS.ProcessEnv)).toBe(300);
    });

    test("honours AX_REAP_INTERVAL_SECONDS", () => {
        expect(reapIntervalSeconds({ AX_REAP_INTERVAL_SECONDS: "30" } as NodeJS.ProcessEnv)).toBe(30);
    });

    test("0 disables the loop; garbage falls back to the default", () => {
        expect(reapIntervalSeconds({ AX_REAP_INTERVAL_SECONDS: "0" } as NodeJS.ProcessEnv)).toBe(0);
        expect(reapIntervalSeconds({ AX_REAP_INTERVAL_SECONDS: "nonsense" } as NodeJS.ProcessEnv)).toBe(300);
    });
});

describe("runReapLoop", () => {
    test("reaps a stranded row on the first tick, without waiting for an interval", async () => {
        const { tc, layer } = harness({ "FROM ingest_run WHERE status = 'running'": [[strandedRow]] });

        await Effect.runPromise(
            Effect.gen(function* () {
                const fiber = yield* Effect.forkChild(runReapLoop({ intervalSeconds: 300 }));
                yield* TestClock.adjust(Duration.zero);
                // The real observable effect: the stuck row is settled in the DB.
                expect(reapUpdates(tc.captured)).toHaveLength(1);
                expect(reapUpdates(tc.captured)[0]).toContain(`status = "partial"`);
                yield* Fiber.interrupt(fiber);
            }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer()), Effect.scoped),
        );
    });

    test("keeps sweeping on each interval", async () => {
        const { tc, layer } = harness({ "FROM ingest_run WHERE status = 'running'": [[strandedRow]] });

        await Effect.runPromise(
            Effect.gen(function* () {
                const fiber = yield* Effect.forkChild(runReapLoop({ intervalSeconds: 300 }));
                yield* TestClock.adjust(Duration.zero);
                expect(reapUpdates(tc.captured)).toHaveLength(1);
                yield* TestClock.adjust(Duration.minutes(5));
                expect(reapUpdates(tc.captured)).toHaveLength(2);
                yield* TestClock.adjust(Duration.minutes(5));
                expect(reapUpdates(tc.captured)).toHaveLength(3);
                yield* Fiber.interrupt(fiber);
            }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer()), Effect.scoped),
        );
    });

    test("a failing DB does not kill the loop - the next tick still sweeps", async () => {
        let call = 0;
        const { tc, layer } = harness({
            "FROM ingest_run WHERE status = 'running'": () => {
                call += 1;
                return call === 1
                    ? Effect.fail(new DbError({ message: "connection refused" }))
                    : [[strandedRow]];
            },
        });

        await Effect.runPromise(
            Effect.gen(function* () {
                const fiber = yield* Effect.forkChild(runReapLoop({ intervalSeconds: 300 }));
                yield* TestClock.adjust(Duration.zero);
                expect(reapUpdates(tc.captured)).toHaveLength(0); // first tick failed
                yield* TestClock.adjust(Duration.minutes(5));
                expect(reapUpdates(tc.captured)).toHaveLength(1); // recovered
                yield* Fiber.interrupt(fiber);
            }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer()), Effect.scoped),
        );
    });

    test("leaves a live run alone", async () => {
        const live = {
            id: "ingest_run:live",
            started_at: new Date().toISOString(),
            last_progress_at: new Date().toISOString(),
        };
        const { tc, layer } = harness({ "FROM ingest_run WHERE status = 'running'": [[live]] });

        await Effect.runPromise(
            Effect.gen(function* () {
                const fiber = yield* Effect.forkChild(runReapLoop({ intervalSeconds: 300 }));
                yield* TestClock.adjust(Duration.zero);
                expect(reapUpdates(tc.captured)).toHaveLength(0);
                yield* Fiber.interrupt(fiber);
            }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer()), Effect.scoped),
        );
    });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `bun test apps/axctl/src/dashboard/reap-loop.test.ts`
Expected: FAIL - `Cannot find module './reap-loop.ts'`

- [ ] **Step 5: Write minimal implementation**

Create `apps/axctl/src/dashboard/reap-loop.ts`:

```ts
/**
 * Periodic ingest_run reaper for the serve daemon (#697).
 *
 * `reapStaleIngestRuns` (#282/#597) sweeps crash residue, but only at INGEST
 * START. That covers the watcher model, where the next transcript write fires
 * an ingest within minutes. It does NOT cover the IDE daemon model (studio.app
 * owns surreal + serve, no LaunchAgent watcher): when ingest stops running,
 * nothing ever calls the reaper again. That is exactly how two rows sat
 * "running" from Jul 3 to Jul 16 with `ax doctor` the only thing that would
 * have said so - and doctor only runs when a human runs it.
 *
 * So: fork the same reap onto the daemon, which IS always up. The reap itself
 * is unchanged (stranded = heartbeat past ingest timeout + grace, so a live
 * concurrent run is never touched) - only the trigger is new.
 */
import { Duration, Effect, Schedule } from "effect";
import { AxConfig } from "@ax/lib/config";
import { SurrealClient } from "@ax/lib/db";
import { reapStaleIngestRuns } from "../ingest/reap-runs.ts";

/** Gap between sweeps. Cheap (one indexed query over `status = 'running'`,
 *  normally 0-1 rows), so 5min is generous and still bounds a crashed row's
 *  lifetime to minutes instead of weeks. `AX_REAP_INTERVAL_SECONDS`; 0
 *  disables. Exported for tests. */
export const reapIntervalSeconds = (env: NodeJS.ProcessEnv = process.env): number => {
    const raw = Number(env.AX_REAP_INTERVAL_SECONDS);
    return Number.isFinite(raw) && raw >= 0 ? raw : 300;
};

/**
 * Sweep stranded `ingest_run` rows now, then every `intervalSeconds`. Never
 * settles - the caller forks it onto the serve runtime, which interrupts it on
 * dispose.
 *
 * Fail-open per tick: a DB blip (daemon started before surreal, connection
 * dropped) must not kill the loop, or the daemon silently stops reaping and we
 * are back to #697. Logged at debug - a transient reap failure is not something
 * a user needs on their terminal.
 */
export const runReapLoop = (opts: {
    readonly intervalSeconds: number;
}): Effect.Effect<void, never, SurrealClient | AxConfig> =>
    reapStaleIngestRuns().pipe(
        Effect.tap((result) =>
            result.reaped > 0
                ? Effect.logWarning(
                    `ax serve: reaped ${result.reaped} stranded ingest_run row(s) ` +
                        `(${result.ids.join(", ")}) - a previous ingest died without finalizing`,
                )
                : Effect.void,
        ),
        Effect.catchCause((cause) => Effect.logDebug("ax serve: ingest_run reap tick failed", cause)),
        Effect.repeat(Schedule.spaced(Duration.seconds(opts.intervalSeconds))),
        Effect.asVoid,
    );
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test apps/axctl/src/dashboard/reap-loop.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 7: Fork the loop from the serve daemon**

In `apps/axctl/src/dashboard/server.ts`, directly after the `prewarmDashboardCaches` block (~line 295) and before the shutdown handlers, add:

```ts
    // Sweep ingest_run rows stranded by a crashed ingest, now and every
    // interval (#697). The ingest-start reaper (#282) can't help when nothing
    // re-runs ingest - the IDE daemon model has no watcher - so the daemon,
    // which is always up, owns the recurring sweep. Fire-and-forget on the
    // server runtime: `handle.dispose()` interrupts it at shutdown.
    const { reapIntervalSeconds, runReapLoop } = await import("./reap-loop.ts");
    const reapInterval = reapIntervalSeconds();
    if (reapInterval > 0) {
        void handle.runner(runReapLoop({ intervalSeconds: reapInterval })).catch(() => undefined);
    }
```

- [ ] **Step 8: Typecheck + full affected suites**

Run: `bun run typecheck && bun test apps/axctl/src/dashboard/reap-loop.test.ts apps/axctl/src/ingest/reap-runs.test.ts`
Expected: exit 0, all green.

- [ ] **Step 9: Commit**

```bash
git add packages/lib apps/axctl/src/dashboard/reap-loop.ts apps/axctl/src/dashboard/reap-loop.test.ts apps/axctl/src/dashboard/server.ts apps/axctl/src/ingest/reap-runs.ts apps/axctl/src/ingest/reap-runs.test.ts apps/axctl/src/cli/install.ts
git commit -m "fix(ingest): auto-reap stranded ingest_run rows from the serve daemon (#697)"
```

---

### Task 3: Stale-graph warning on read commands (issue #697 part 1b)

Two weeks of `ax cost` / `ax dispatches` returned empty and nothing said why. Every DB-backed command routes through `withDb`, so one `Effect.ensuring` there covers sessions/cost/dispatches/recall and everything else, forever.

**Files:**
- Create: `apps/axctl/src/queries/ingest-staleness.ts`
- Create: `apps/axctl/src/queries/ingest-staleness.test.ts`
- Modify: `apps/axctl/src/cli/index.ts:218-219` (`withDb`)

**Interfaces:**
- Consumes: `formatStaleIngestWarning`, `STALE_INGEST_AFTER_HOURS` from `@ax/lib/shared/ingest-staleness` (Task 1).
- Produces:
  - `const staleIngestThresholdMs: (env?: NodeJS.ProcessEnv) => number`
  - `const fetchLastSuccessfulIngestAt: Effect.Effect<number | null, DbError, SurrealClient>`
  - `const warnIfIngestStale: Effect.Effect<void, never, SurrealClient>`

- [ ] **Step 1: Write the failing test**

Create `apps/axctl/src/queries/ingest-staleness.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { DbError } from "@ax/lib/errors";
import { makeMockDb, makeTestSurrealClient, runWithMock } from "@ax/lib/testing/surreal";
import {
    fetchLastSuccessfulIngestAt,
    staleIngestThresholdMs,
    warnIfIngestStale,
} from "./ingest-staleness.ts";

describe("staleIngestThresholdMs", () => {
    test("defaults to 48h", () => {
        expect(staleIngestThresholdMs({} as NodeJS.ProcessEnv)).toBe(48 * 3_600_000);
    });

    test("honours AX_STALE_INGEST_HOURS; 0 disables", () => {
        expect(staleIngestThresholdMs({ AX_STALE_INGEST_HOURS: "6" } as NodeJS.ProcessEnv)).toBe(6 * 3_600_000);
        expect(staleIngestThresholdMs({ AX_STALE_INGEST_HOURS: "0" } as NodeJS.ProcessEnv)).toBe(0);
    });
});

describe("fetchLastSuccessfulIngestAt", () => {
    test("reads the newest ok run via one status-filtered indexed query", async () => {
        const db = makeMockDb([[[{ ended_at: "2026-07-03T12:00:00.000Z", started_at: "2026-07-03T11:50:00.000Z" }]]]);
        const at = await runWithMock(db, fetchLastSuccessfulIngestAt);

        expect(at).toBe(Date.parse("2026-07-03T12:00:00.000Z"));
        expect(db.captured).toHaveLength(1);
        // Must hit the ingest_run_status_started index: filter on status, order
        // by started_at. A full scan here would tax every read command.
        expect(db.captured[0]).toContain("FROM ingest_run");
        expect(db.captured[0]).toContain("status = 'ok'");
        expect(db.captured[0]).toContain("ORDER BY started_at DESC");
        expect(db.captured[0]).toContain("LIMIT 1");
    });

    test("falls back to started_at when ended_at is absent", async () => {
        const db = makeMockDb([[[{ started_at: "2026-07-03T11:50:00.000Z" }]]]);
        expect(await runWithMock(db, fetchLastSuccessfulIngestAt)).toBe(Date.parse("2026-07-03T11:50:00.000Z"));
    });

    test("null when no ok run exists", async () => {
        const db = makeMockDb([[[]]]);
        expect(await runWithMock(db, fetchLastSuccessfulIngestAt)).toBeNull();
    });

    test("null when the timestamps are unparseable", async () => {
        const db = makeMockDb([[[{ ended_at: "not-a-date" }]]]);
        expect(await runWithMock(db, fetchLastSuccessfulIngestAt)).toBeNull();
    });
});

describe("warnIfIngestStale (real seam)", () => {
    // Capture stderr around the run: the observable effect IS the printed line.
    const captureStderr = async (effect: Effect.Effect<void, never, never>): Promise<string> => {
        const original = process.stderr.write.bind(process.stderr);
        let out = "";
        // @ts-expect-error - narrow test double for the write overloads
        process.stderr.write = (chunk: string) => {
            out += String(chunk);
            return true;
        };
        try {
            await Effect.runPromise(effect);
        } finally {
            process.stderr.write = original;
        }
        return out;
    };

    const okRunFrom = (iso: string) =>
        makeTestSurrealClient({ routes: { "FROM ingest_run": [[{ ended_at: iso, started_at: iso }]] } });

    test("prints one warning line when the last ok ingest is older than 48h", async () => {
        const db = okRunFrom(new Date(Date.now() - 13 * 86_400_000).toISOString());
        const out = await captureStderr(warnIfIngestStale.pipe(Effect.provide(db.layer)));

        expect(out).toContain("graph is stale");
        expect(out).toContain("13d ago");
        expect(out.trimEnd().split("\n")).toHaveLength(1);
    });

    test("stays silent when the graph is fresh", async () => {
        const db = okRunFrom(new Date(Date.now() - 3_600_000).toISOString());
        expect(await captureStderr(warnIfIngestStale.pipe(Effect.provide(db.layer)))).toBe("");
    });

    test("degrades silently when the DB is unreachable", async () => {
        const db = makeTestSurrealClient({
            routes: { "FROM ingest_run": Effect.fail(new DbError({ message: "connection refused" })) },
        });
        expect(await captureStderr(warnIfIngestStale.pipe(Effect.provide(db.layer)))).toBe("");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/queries/ingest-staleness.test.ts`
Expected: FAIL - `Cannot find module './ingest-staleness.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `apps/axctl/src/queries/ingest-staleness.ts`:

```ts
/**
 * Stale-graph warning for read commands (#697).
 *
 * `ax dispatches` / `ax cost` returned empty for two weeks while ingest was
 * dead, and nothing said so - an empty table reads as "you have no data", not
 * "your data stopped 13 days ago". Doctor knew, but only when run by hand.
 *
 * So every DB-backed command pays one indexed query (`status = 'ok'` ORDER BY
 * the indexed `started_at`, LIMIT 1) and prints at most one stderr line. It is
 * wired into `withDb` (cli/index.ts) rather than per-command, so a new read
 * command inherits it without knowing this exists.
 *
 * Fail-open: an unreachable DB prints nothing (the command's own error already
 * says that) and a warning never touches stdout, so `--json` stays machine-clean.
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import {
    formatStaleIngestWarning,
    STALE_INGEST_AFTER_HOURS,
} from "@ax/lib/shared/ingest-staleness";

/** Age past which the graph is called stale. `AX_STALE_INGEST_HOURS`; 0
 *  disables the warning. Exported for tests. */
export const staleIngestThresholdMs = (env: NodeJS.ProcessEnv = process.env): number => {
    const raw = Number(env.AX_STALE_INGEST_HOURS);
    const hours = Number.isFinite(raw) && raw >= 0 ? raw : STALE_INGEST_AFTER_HOURS;
    return hours * 3_600_000;
};

/** Hard cap on the probe. A wedged DB must not add latency to a command that
 *  is already failing - the warning is a courtesy, not a feature. */
const PROBE_TIMEOUT_MS = 2_000;

interface LastOkRunRow {
    readonly ended_at?: unknown;
    readonly started_at?: unknown;
}

/**
 * Epoch ms of the newest ingest that finished with status "ok", or null when
 * there is none (or its timestamps are unreadable). Hits the
 * `ingest_run_status_started` index: equality on `status`, ordered by the
 * indexed `started_at`. Reads `ended_at` as the completion instant, falling
 * back to `started_at` for rows written before `ended_at` existed.
 */
export const fetchLastSuccessfulIngestAt: Effect.Effect<number | null, DbError, SurrealClient> =
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const [rows] = yield* db.query<[LastOkRunRow[]]>(
            "SELECT ended_at, started_at FROM ingest_run WHERE status = 'ok' ORDER BY started_at DESC LIMIT 1;",
        );
        const row = rows?.[0];
        if (row === undefined) return null;
        const at = Date.parse(String(row.ended_at ?? row.started_at ?? ""));
        return Number.isFinite(at) ? at : null;
    });

/**
 * Print the stale-graph warning to stderr if the graph is out of date. Never
 * fails, never throws, never writes to stdout.
 */
export const warnIfIngestStale: Effect.Effect<void, never, SurrealClient> = Effect.gen(
    function* () {
        const thresholdMs = staleIngestThresholdMs();
        if (thresholdMs <= 0) return;
        const lastOkMs = yield* fetchLastSuccessfulIngestAt;
        const warning = formatStaleIngestWarning({ lastOkMs, nowMs: Date.now(), thresholdMs });
        if (warning === null) return;
        yield* Effect.sync(() => process.stderr.write(`${warning}\n`));
    },
).pipe(
    Effect.timeoutOption(PROBE_TIMEOUT_MS),
    Effect.asVoid,
    Effect.ignore,
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/queries/ingest-staleness.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Wire it into `withDb`**

In `apps/axctl/src/cli/index.ts`, add the import alongside the other query imports:

```ts
import { warnIfIngestStale } from "../queries/ingest-staleness.ts";
```

and replace `withDb` (lines 213-219) with:

```ts
/**
 * Provide AppLayer (SurrealClient + AxConfig + ProcessService) and a
 * scope so handlers that allocate scoped resources work. Used by commands
 * whose handlers actually touch SurrealDB.
 *
 * Every such command also gets the stale-graph warning (#697): one indexed
 * query, stderr only, after the command's own output so it lands next to the
 * prompt. `ensuring` (not `tap`) so a command that returned empty BECAUSE the
 * graph is stale - the #697 symptom - still explains itself when it fails.
 */
const withDb = (args: ReadonlyArray<string>): CliProgram =>
    runCli(args).pipe(
        Effect.ensuring(warnIfIngestStale),
        Effect.provide(AppLayer),
        Effect.scoped,
    );
```

- [ ] **Step 6: Verify the warning does not leak into stdout**

Run: `bun test apps/axctl/src/queries/ingest-staleness.test.ts apps/axctl/src/cli/index.test.ts`
Expected: PASS. (If `apps/axctl/src/cli/index.test.ts` does not exist, run only the first suite and note it.)

- [ ] **Step 7: Typecheck**

Run: `bun run typecheck`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add apps/axctl/src/queries/ingest-staleness.ts apps/axctl/src/queries/ingest-staleness.test.ts apps/axctl/src/cli/index.ts
git commit -m "feat(cli): warn on read commands when the graph is >48h stale (#697)"
```

---

### Task 4: Deadline-aware derive budget (issue #697 part 2)

**Premise correction, read before starting:** a per-stage derive watchdog ALREADY exists - `deriveStageTimeoutSeconds` (`apps/axctl/src/ingest/stage/runner.ts:28`, default 300s, `AX_STAGE_TIMEOUT_SECONDS`, #671), applied to `derive`-tagged stages only, failing open with empty stats. `derive-metrics` and `outcomes` are both `derive`-tagged, so they are already capped at 300s each. Do NOT re-add it.

The remaining gap is that the cap is a fixed 300s with no idea of the run's own deadline. Under a backlog, provider stages eat most of the 900s `AX_INGEST_TIMEOUT_SECONDS`, then derives start their own 300s clocks and blow through the outer cap. The outer timeout then guillotines the pass, which by design LEAVES the ingest lock in place as a cooldown - so the watcher's next fires SKIP, and the user is left re-running ingest by hand ("completion needs many manual re-runs"). Fix: cap each derive by whatever is actually left before the deadline, keeping a reserve so the run finalizes itself cleanly rather than being killed.

Scope discipline: this makes passes END CLEANLY. It does NOT make a heavy derive COMPLETE - that needs chunked/resumable derive, which is #689's territory. File the follow-up (Step 8); do not build it here.

**Files:**
- Create: `apps/axctl/src/ingest/stage/derive-budget.ts`
- Create: `apps/axctl/src/ingest/stage/derive-budget.test.ts`
- Modify: `apps/axctl/src/ingest/stage/runner.ts:138-237` (`runPipeline`)
- Modify: `apps/axctl/src/ingest/stage/runner.test.ts` (real-seam pipeline tests)
- Modify: `apps/axctl/src/ingest/run.ts:316` (pass the deadline)

**Interfaces:**
- Consumes: `deriveStageTimeoutSeconds` from `./runner.ts` (unchanged); `BaseStageStats`, `StageDef`, `IngestContext` from `./types.ts`.
- Produces:
  - `type DeriveStageBudget = { readonly _tag: "uncapped" } | { readonly _tag: "capped"; readonly capMs: number } | { readonly _tag: "skip"; readonly reason: string }`
  - `const DERIVE_RESERVE_SECONDS: number` (= 30)
  - `const deriveReserveMs: (env?: NodeJS.ProcessEnv) => number`
  - `const deriveStageBudget: (input: { readonly staticCapMs: number; readonly deadlineMs: number | null; readonly nowMs: number; readonly reserveMs: number }) => DeriveStageBudget`
  - `runPipeline` gains a third parameter: `opts: { readonly deadlineMs?: number; readonly reserveMs?: number } = {}`

- [ ] **Step 1: Write the failing test for the pure allocator**

Create `apps/axctl/src/ingest/stage/derive-budget.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { deriveReserveMs, deriveStageBudget, DERIVE_RESERVE_SECONDS } from "./derive-budget.ts";

describe("deriveReserveMs", () => {
    test("defaults to 30s", () => {
        expect(deriveReserveMs({} as NodeJS.ProcessEnv)).toBe(DERIVE_RESERVE_SECONDS * 1000);
        expect(DERIVE_RESERVE_SECONDS).toBe(30);
    });

    test("honours AX_DERIVE_RESERVE_SECONDS, including 0", () => {
        expect(deriveReserveMs({ AX_DERIVE_RESERVE_SECONDS: "5" } as NodeJS.ProcessEnv)).toBe(5_000);
        expect(deriveReserveMs({ AX_DERIVE_RESERVE_SECONDS: "0" } as NodeJS.ProcessEnv)).toBe(0);
        expect(deriveReserveMs({ AX_DERIVE_RESERVE_SECONDS: "junk" } as NodeJS.ProcessEnv)).toBe(30_000);
    });
});

describe("deriveStageBudget", () => {
    const now = 1_000_000;

    test("uses the static cap when the deadline is far away", () => {
        expect(deriveStageBudget({
            staticCapMs: 300_000,
            deadlineMs: now + 900_000,
            nowMs: now,
            reserveMs: 30_000,
        })).toEqual({ _tag: "capped", capMs: 300_000 });
    });

    test("shrinks to the remaining budget when the deadline is nearer than the static cap", () => {
        // 100s left, minus a 30s reserve => 70s for this stage, not the full 300s.
        expect(deriveStageBudget({
            staticCapMs: 300_000,
            deadlineMs: now + 100_000,
            nowMs: now,
            reserveMs: 30_000,
        })).toEqual({ _tag: "capped", capMs: 70_000 });
    });

    test("skips once the reserve is all that is left - the run must finalize itself", () => {
        const budget = deriveStageBudget({
            staticCapMs: 300_000,
            deadlineMs: now + 30_000,
            nowMs: now,
            reserveMs: 30_000,
        });
        expect(budget._tag).toBe("skip");
    });

    test("skips when the deadline has already passed", () => {
        expect(deriveStageBudget({
            staticCapMs: 300_000,
            deadlineMs: now - 1,
            nowMs: now,
            reserveMs: 30_000,
        })._tag).toBe("skip");
    });

    test("no deadline: the static cap still applies (today's behaviour)", () => {
        expect(deriveStageBudget({
            staticCapMs: 300_000,
            deadlineMs: null,
            nowMs: now,
            reserveMs: 30_000,
        })).toEqual({ _tag: "capped", capMs: 300_000 });
    });

    test("no deadline and a disabled static cap: uncapped", () => {
        expect(deriveStageBudget({
            staticCapMs: 0,
            deadlineMs: null,
            nowMs: now,
            reserveMs: 30_000,
        })).toEqual({ _tag: "uncapped" });
    });

    test("disabled static cap still respects the deadline", () => {
        expect(deriveStageBudget({
            staticCapMs: 0,
            deadlineMs: now + 100_000,
            nowMs: now,
            reserveMs: 30_000,
        })).toEqual({ _tag: "capped", capMs: 70_000 });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/ingest/stage/derive-budget.test.ts`
Expected: FAIL - `Cannot find module './derive-budget.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `apps/axctl/src/ingest/stage/derive-budget.ts`:

```ts
/**
 * How long may a derive stage run, given the pass's own deadline? (#697)
 *
 * The static watchdog (`AX_STAGE_TIMEOUT_SECONDS`, #671) caps ONE derive at
 * 300s but knows nothing about the run's wall-clock budget
 * (`AX_INGEST_TIMEOUT_SECONDS`, 900s). Under a backlog the provider stages eat
 * most of the budget, then each derive starts a fresh 300s clock and pushes the
 * pass past the outer cap. The outer timeout is not a soft landing: it
 * deliberately LEAVES the ingest lock as a cooldown (see ingest-lock.ts), so
 * the watcher's next fires skip and a human is left re-running ingest by hand.
 *
 * So a derive gets `min(staticCap, timeLeftBeforeDeadline - reserve)`, and is
 * skipped outright once only the reserve remains. The reserve is what the run
 * needs to finalize its own `ingest_run` row and exit clean.
 *
 * This bounds the pass. It does NOT make a heavy derive finish - that wants
 * chunked/resumable derive (#689).
 */

/** What a derive stage is allowed this pass. */
export type DeriveStageBudget =
    /** Run it with no timeout (no deadline and the static cap is disabled). */
    | { readonly _tag: "uncapped" }
    /** Run it, but time it out after `capMs`. */
    | { readonly _tag: "capped"; readonly capMs: number }
    /** Don't start it: there is no budget left. */
    | { readonly _tag: "skip"; readonly reason: string };

/** Wall-clock held back from derives so the run can finalize its `ingest_run`
 *  row (and the outer lock release) instead of being guillotined mid-write. */
export const DERIVE_RESERVE_SECONDS = 30;

/** `AX_DERIVE_RESERVE_SECONDS`; 0 is a legal "no reserve". Exported for tests. */
export const deriveReserveMs = (env: NodeJS.ProcessEnv = process.env): number => {
    const raw = Number(env.AX_DERIVE_RESERVE_SECONDS);
    return (Number.isFinite(raw) && raw >= 0 ? raw : DERIVE_RESERVE_SECONDS) * 1000;
};

/**
 * Budget for the derive stage about to start. `staticCapMs <= 0` disables the
 * static cap; `deadlineMs === null` means the caller has no wall-clock budget
 * (tests, `--derive-only` invocations without a timeout), in which case this
 * degrades to exactly today's static-cap behaviour.
 */
export const deriveStageBudget = (input: {
    readonly staticCapMs: number;
    readonly deadlineMs: number | null;
    readonly nowMs: number;
    readonly reserveMs: number;
}): DeriveStageBudget => {
    const untilDeadline = input.deadlineMs === null
        ? Number.POSITIVE_INFINITY
        : input.deadlineMs - input.reserveMs - input.nowMs;
    if (untilDeadline <= 0) {
        return {
            _tag: "skip",
            reason: "no time left before the ingest deadline (raise AX_INGEST_TIMEOUT_SECONDS, " +
                "or run 'ax ingest --derive-only' to catch derives up)",
        };
    }
    const staticCap = input.staticCapMs > 0 ? input.staticCapMs : Number.POSITIVE_INFINITY;
    const capMs = Math.min(staticCap, untilDeadline);
    return Number.isFinite(capMs) ? { _tag: "capped", capMs } : { _tag: "uncapped" };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/ingest/stage/derive-budget.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Write the failing real-seam pipeline test**

Append to `apps/axctl/src/ingest/stage/runner.test.ts` (reuse whatever stage-fixture helpers the file already has; if it has none, use these verbatim):

```ts
import { Effect } from "effect";
import { runPipeline } from "./runner.ts";
import { BaseStageStats, IngestContext, StageMeta } from "./types.ts";
import type { StageDef } from "./types.ts";

describe("runPipeline derive budget (#697)", () => {
    const ctx = IngestContext.make({ cwd: "/tmp", since: new Date(0), debug: false });

    const stage = (
        key: string,
        tags: ReadonlyArray<"ingest" | "derive">,
        run: Effect.Effect<BaseStageStats, never, never>,
    ): StageDef<BaseStageStats, never> => ({
        meta: StageMeta.make({ key, deps: [], tags }),
        run: () => run,
    });

    const instant = (key: string, tags: ReadonlyArray<"ingest" | "derive">) =>
        stage(key, tags, Effect.succeed(BaseStageStats.make({ durationMs: 0, summary: `${key} ok` })));

    /** A stage that would run far past any test's patience. */
    const hangs = (key: string, tags: ReadonlyArray<"ingest" | "derive">) =>
        stage(key, tags, Effect.never as Effect.Effect<BaseStageStats, never, never>);

    test("a derive stage past the deadline is skipped and the pass still completes", async () => {
        const stats = await Effect.runPromise(
            runPipeline([instant("claude", ["ingest"]), hangs("derive-metrics", ["derive"])], ctx, {
                deadlineMs: Date.now() - 1, // budget already blown, as after a backlog
                reserveMs: 0,
            }),
        );

        // The real observable effect: the pipeline RETURNS instead of hanging
        // until the outer 900s timeout guillotines it (and leaves a cooldown lock).
        expect(stats).toHaveLength(2);
        const derive = stats.find((s) => s.summary.includes("skipped"));
        expect(derive).toBeDefined();
        expect(stats.some((s) => s.summary === "claude ok")).toBe(true);
    });

    test("a derive stage is capped by the time left, not its static 300s cap", async () => {
        const started = Date.now();
        const stats = await Effect.runPromise(
            runPipeline([hangs("outcomes", ["derive"])], ctx, {
                deadlineMs: Date.now() + 150,
                reserveMs: 0,
            }),
        );

        // Bounded by the deadline (150ms), NOT by AX_STAGE_TIMEOUT_SECONDS (300s).
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(stats[0]?.summary).toContain("timed out");
    });

    test("an ingest-tagged stage is exempt - a real backfill legitimately runs long", async () => {
        const exit = await Effect.runPromiseExit(
            runPipeline([instant("skills", ["ingest"])], ctx, {
                deadlineMs: Date.now() - 1,
                reserveMs: 0,
            }),
        );

        // Provider stages must not be skipped by the derive budget.
        expect(exit._tag).toBe("Success");
    });

    test("no deadline: unchanged behaviour (stages run to completion)", async () => {
        const stats = await Effect.runPromise(
            runPipeline([instant("claude", ["ingest"]), instant("outcomes", ["derive"])], ctx),
        );
        expect(stats.map((s) => s.summary).sort()).toEqual(["claude ok", "outcomes ok"]);
    });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `bun test apps/axctl/src/ingest/stage/runner.test.ts`
Expected: FAIL - `runPipeline` takes 2 args, so the `opts` are ignored: the skip test hangs (or the `stats.find(...skipped)` assertion fails) and the cap test blows the 5s bound.

- [ ] **Step 7: Wire the budget into `runPipeline`**

In `apps/axctl/src/ingest/stage/runner.ts`, add the import:

```ts
import { deriveReserveMs, deriveStageBudget } from "./derive-budget.ts";
```

Change the signature (line 138) to take opts:

```ts
/** Run the given stages with DAG scheduling. Each stage waits for its in-graph
 *  deps via Deferreds; only `PIPELINE_CONCURRENCY` are inside the semaphore at
 *  once. Each stage is wrapped in `LiveTrace.step` so progress flows through
 *  the configured `TraceTransport` (ADR-0007).
 *
 *  `opts.deadlineMs` is the run's wall-clock deadline (epoch ms). Derive stages
 *  are budgeted against it so the pass ends cleanly instead of being killed by
 *  the outer ingest timeout (#697); omit it and derives keep only their static
 *  `AX_STAGE_TIMEOUT_SECONDS` cap. `opts.reserveMs` overrides the finalization
 *  reserve (env default) - tests pass 0. */
export const runPipeline = <S extends BaseStageStats, R>(
    stages: ReadonlyArray<StageDef<S, R>>,
    ctx: IngestContext,
    opts: { readonly deadlineMs?: number; readonly reserveMs?: number } = {},
): Effect.Effect<ReadonlyArray<S>, DbError, R> =>
```

Inside, after `const stageTimeoutMs = deriveStageTimeoutSeconds() * 1000;` (line 154) add:

```ts
        const deadlineMs = opts.deadlineMs ?? null;
        const reserveMs = opts.reserveMs ?? deriveReserveMs();
```

Then replace the whole `const guarded = ...` block (lines 178-196) with a suspended, budget-aware version. It MUST be `Effect.suspend` so `Date.now()` is read when the stage actually starts - i.e. after it has waited on its deps AND acquired a semaphore permit - not when the pipeline was built:

```ts
                // Watchdog: cap `derive` stages so one stuck or backlogged derive
                // can't wedge the run OR push the pass past its deadline (#671,
                // #697). Fails OPEN - a warning plus sentinel stats - because
                // downstream deps only await this Deferred (they never read its
                // value; they re-query the DB) and the totals roll-up skips
                // `durationMs` + non-numeric fields, so an empty BaseStageStats is
                // safe. Heavy provider stages (claude, codex, git) are exempt: a
                // full backfill legitimately runs for many minutes.
                // Suspended so `Date.now()` is read at stage START (post-deps,
                // post-permit) - reading it at build time would hand every stage
                // the budget the FIRST one had.
                const guarded = !s.meta.tags.includes("derive")
                    ? body
                    : Effect.suspend(() => {
                        const budget = deriveStageBudget({
                            staticCapMs: stageTimeoutMs,
                            deadlineMs,
                            nowMs: Date.now(),
                            reserveMs,
                        });
                        if (budget._tag === "uncapped") return body;
                        if (budget._tag === "skip") {
                            return Effect.logWarning(
                                `ingest: skipping derive stage '${s.meta.key}' - ${budget.reason}.`,
                            ).pipe(
                                Effect.as({
                                    durationMs: 0,
                                    summary: "skipped (out of budget)",
                                } as unknown as S),
                            );
                        }
                        return body.pipe(
                            Effect.timeoutOrElse({
                                duration: budget.capMs,
                                orElse: () =>
                                    Effect.logWarning(
                                        `ingest: derive stage '${s.meta.key}' exceeded ${Math.round(budget.capMs / 1000)}s - ` +
                                            `skipping it (failed open) so the run can finish. ` +
                                            `Raise/disable with AX_STAGE_TIMEOUT_SECONDS.`,
                                    ).pipe(
                                        Effect.as({
                                            durationMs: budget.capMs,
                                            summary: "timed out (watchdog)",
                                        } as unknown as S),
                                    ),
                            }),
                        );
                    });
```

- [ ] **Step 8: Run test to verify it passes**

Run: `bun test apps/axctl/src/ingest/stage/runner.test.ts apps/axctl/src/ingest/stage/derive-budget.test.ts`
Expected: PASS - including the pre-existing runner tests (the no-deadline path must be unchanged).

- [ ] **Step 9: Pass the deadline from `runIngest`**

In `apps/axctl/src/ingest/run.ts`, `runIngest` already has `AxConfig` in its requirements. Add after `const registry = yield* StageRegistry;` (line 279):

```ts
        const config = yield* AxConfig;
        // The pass's wall-clock deadline, mirroring the `withIngestLock` timeout
        // that wraps this run (cli/commands/ingest.ts). Derives are budgeted
        // against it so the pass finalizes itself instead of being guillotined -
        // the outer timeout deliberately leaves the lock as a cooldown, which is
        // what turned #697's backlog into "re-run ingest by hand, repeatedly".
        // The lock starts fractionally earlier than this, so our deadline is a
        // hair late; the derive reserve absorbs that.
        const deadlineMs = config.knobs.ingestTimeoutSeconds > 0
            ? Date.now() + config.knobs.ingestTimeoutSeconds * 1000
            : undefined;
```

and change the `runPipeline` call (line 316) to:

```ts
        const stageStats = yield* runPipeline(
            wrappedStages,
            ctx,
            deadlineMs === undefined ? {} : { deadlineMs },
        ).pipe(
```

(the rest of the `.pipe(...)` chain is unchanged).

- [ ] **Step 10: Typecheck + the ingest suites**

Run: `bun run typecheck && bun test apps/axctl/src/ingest/stage/ apps/axctl/src/ingest/run.test.ts`
Expected: exit 0, green.

- [ ] **Step 11: File the chunked-derive follow-up (do NOT implement)**

```bash
gh issue comment 697 --body "$(cat <<'EOF'
Deadline-aware derive budgets landed: a derive stage now gets `min(AX_STAGE_TIMEOUT_SECONDS, timeLeftBeforeDeadline - reserve)`, so a pass finalizes cleanly instead of being guillotined by the outer `AX_INGEST_TIMEOUT_SECONDS` (which leaves the ingest lock as a cooldown and forces the manual re-runs reported here).

Not addressed, and deliberately out of scope: a heavy derive still does not COMPLETE under a large backlog - it fails open each pass. That needs chunked/resumable derive, which overlaps #689 (usage derive exceeds watchdog, cascades). Tracking it there.
EOF
)"
```

- [ ] **Step 12: Commit**

```bash
git add apps/axctl/src/ingest/stage/derive-budget.ts apps/axctl/src/ingest/stage/derive-budget.test.ts apps/axctl/src/ingest/stage/runner.ts apps/axctl/src/ingest/stage/runner.test.ts apps/axctl/src/ingest/run.ts
git commit -m "fix(ingest): budget derive stages against the run deadline (#697)"
```

---

## Verification (all tasks)

- [ ] `bun run typecheck` exits 0 (capture the REAL exit code - do not pipe through `tail`/`grep` before checking `$?`).
- [ ] `bun test packages/lib/src/shared/ingest-staleness.test.ts apps/axctl/src/ingest/reap-runs.test.ts apps/axctl/src/dashboard/reap-loop.test.ts apps/axctl/src/queries/ingest-staleness.test.ts apps/axctl/src/ingest/stage/derive-budget.test.ts apps/axctl/src/ingest/stage/runner.test.ts apps/axctl/src/cli/install.test.ts` - all green.
- [ ] No live-DB e2e suites run. The daemon at `127.0.0.1:8521`/`1738` is untouched.
- [ ] `git status` clean (apart from `BRIEF.md` / `REPORT.md`).

## Open questions

1. **Warning placement** - `withDb` covers `ax tui` too. `ensuring` fires after the TUI tears down, so the line lands on the shell prompt, not into the OpenTUI canvas. Acceptable; revisit if it looks wrong in practice.
2. **`status = 'ok'` strictness** - a run that ends `partial` (outer timeout) does not clear the stale warning even though it landed data. Deliberate: the reaper writes `partial`, so counting partials would let #697's ghost rows silence the warning. Task 4 makes clean `ok` endings the norm, so the two changes reinforce each other.
