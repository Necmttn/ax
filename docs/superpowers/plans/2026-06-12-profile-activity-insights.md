# Profile Activity + Insights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend ProfileV1 with optional `activity` (daily sessions+tokens) and `insights` (session depth, parallelism, spawns, commits, top tools) sections, wired from new windowed SurrealDB queries through pure derivers to the CLI formatter and site validator.

**Architecture:** Each piece is independently tested - new SurrealDB queries mirror existing ones in `profile/queries.ts`, pure interval math lives in a new `profile/insights.ts`, `buildProfile` in `render.ts` appends the new query calls at the end (preserving mock order for existing tests), and the site validator's manual type-check is extended inline. The `activity` section reuses query data already needed by `insights`. TDD throughout: write the failing test, then the implementation.

**Tech Stack:** Bun ≥1.3, TypeScript strict, Effect v4 beta, SurrealDB 3.x (no stacked in/out derefs in grouped aggregates), `@ax/lib/testing/surreal` mock helpers.

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `apps/axctl/src/profile/schema.ts` | Modify | Add `activity` + `insights` optional sections to ProfileV1 |
| `apps/axctl/src/profile/schema.test.ts` | Modify | Tests for new sections decode/reject correctly |
| `apps/axctl/src/profile/queries.ts` | Modify | Add 6 new windowed fetchers |
| `apps/axctl/src/profile/queries.test.ts` | Modify | Tests for each new fetcher |
| `apps/axctl/src/profile/insights.ts` | **Create** | Pure `deriveInsights()` + `deriveDailyFull()` functions |
| `apps/axctl/src/profile/insights.test.ts` | **Create** | Unit tests for all pure math |
| `apps/axctl/src/profile/render.ts` | Modify | Append new query calls + wire insights into decodeProfile |
| `apps/axctl/src/profile/render.test.ts` | Modify | Extend mockResults (8 new slots) + assert new fields |
| `apps/axctl/src/cli/commands/profile.ts` | Modify | `money()` helper + insights block in `formatProfile` |
| `apps/site/app/lib/community.ts` | Modify | Extend ProfileV1 interface + validateProfileV1 for new sections |
| `apps/site/app/lib/community.test.ts` | Modify | Accept+reject tests for new sections |

---

## Task 1: Schema - add activity + insights to ProfileV1

**Files:**
- Modify: `apps/axctl/src/profile/schema.ts`
- Modify: `apps/axctl/src/profile/schema.test.ts`

### Step 1.1 - Write failing schema tests

- [ ] Open `apps/axctl/src/profile/schema.test.ts` and add these tests **after** the existing `describe` block (do not alter existing tests):

```typescript
describe("activity + insights sections", () => {
    const withSections = {
        ...validProfile,
        activity: {
            daily: [
                { date: "2026-06-09", sessions: 31, tokens: 800_000 },
                { date: "2026-06-12", sessions: 12, tokens: 120_000_000 },
            ],
        },
        insights: {
            hours_total: 307.2,
            longest_session_minutes: 960,
            deep_session_share: 0.58,
            peak_hour_utc: 13,
            busiest_day: { date: "2026-06-09", sessions: 31 },
            max_parallel_sessions: 11,
            subagents_spawned: 420,
            commits: 1000,
            tools_top: [
                { name: "Bash", runs: 5000 },
                { name: "Read", runs: 3200 },
            ],
        },
    };

    test("accepts valid profile with both sections", () => {
        const p = decodeProfile(withSections);
        expect(p.activity!.daily).toHaveLength(2);
        expect(p.activity!.daily[0]!.sessions).toBe(31);
        expect(p.insights!.hours_total).toBe(307.2);
        expect(p.insights!.busiest_day.date).toBe("2026-06-09");
        expect(p.insights!.tools_top[0]!.name).toBe("Bash");
    });

    test("activity section is optional - omit it and profile still decodes", () => {
        const { activity: _a, ...rest } = withSections;
        const p = decodeProfile(rest);
        expect(p.activity).toBeUndefined();
    });

    test("insights section is optional - omit it and profile still decodes", () => {
        const { insights: _i, ...rest } = withSections;
        const p = decodeProfile(rest);
        expect(p.insights).toBeUndefined();
    });

    test("rejects tools_top row with non-number runs", () => {
        const bad = {
            ...withSections,
            insights: {
                ...withSections.insights,
                tools_top: [{ name: "Bash", runs: "five-thousand" }],
            },
        };
        expect(() => decodeProfile(bad)).toThrow();
    });

    test("rejects tools_top row with non-string name", () => {
        const bad = {
            ...withSections,
            insights: {
                ...withSections.insights,
                tools_top: [{ name: 42, runs: 100 }],
            },
        };
        expect(() => decodeProfile(bad)).toThrow();
    });

    test("rejects activity daily row with missing tokens", () => {
        const bad = {
            ...withSections,
            activity: {
                daily: [{ date: "2026-06-09", sessions: 31 }],  // tokens missing
            },
        };
        expect(() => decodeProfile(bad)).toThrow();
    });
});
```

- [ ] Run failing tests:

```bash
/tmp/run-ax-tests.sh apps/axctl/src/profile/schema.test.ts
```

Expected: 6 new tests FAIL with decode/type errors.

### Step 1.2 - Implement schema additions

- [ ] Open `apps/axctl/src/profile/schema.ts`. After the `Rig` const, add:

```typescript
const DailyRow = Schema.Struct({
    date: Schema.String,
    sessions: Schema.Number,
    tokens: Schema.Number,
});

const BusiestDay = Schema.Struct({
    date: Schema.String,
    sessions: Schema.Number,
});

const ToolRun = Schema.Struct({
    name: Schema.String,
    runs: Schema.Number,
});

const Activity = Schema.Struct({
    daily: Schema.Array(DailyRow),
});

const Insights = Schema.Struct({
    hours_total: Schema.Number,
    longest_session_minutes: Schema.Number,
    deep_session_share: Schema.Number,
    peak_hour_utc: Schema.Number,
    busiest_day: BusiestDay,
    max_parallel_sessions: Schema.Number,
    subagents_spawned: Schema.Number,
    commits: Schema.Number,
    tools_top: Schema.Array(ToolRun),
});
```

Then in the `ProfileV1` struct, add two optional fields after `taste`:

```typescript
    activity: Schema.optional(Activity),
    insights: Schema.optional(Insights),
```

- [ ] Run tests again:

```bash
/tmp/run-ax-tests.sh apps/axctl/src/profile/schema.test.ts
```

Expected: all tests PASS (including the original set).

### Step 1.3 - Commit

```bash
git add apps/axctl/src/profile/schema.ts apps/axctl/src/profile/schema.test.ts
git commit -m "feat(profile): add activity + insights sections to ProfileV1 schema"
```

---

## Task 2: Queries - add 6 windowed fetchers

**Files:**
- Modify: `apps/axctl/src/profile/queries.ts`
- Modify: `apps/axctl/src/profile/queries.test.ts`

The commit table has a `ts` field of type `datetime` (confirmed in schema.surql). Use `ts > time::now() - ${win(d)}`.

### Step 2.1 - Write failing query tests

- [ ] Open `apps/axctl/src/profile/queries.test.ts`. Add these describe blocks after the existing ones:

```typescript
import {
    fetchDailyActivityFull,
    fetchSessionDurations,
    fetchPeakHour,
    fetchSpawnedCount,
    fetchCommitCount,
    fetchTopTools,
} from "./queries.ts";

describe("fetchDailyActivityFull", () => {
    test("returns date+sessions+tokens rows, window applied", async () => {
        const db = makeMockDb([
            // sessions-per-day from turn (query 1)
            [[{ date: "2026-06-11", sessions: 5 }, { date: "2026-06-12", sessions: 3 }]],
            // tokens-per-day from session_token_usage (query 2)
            [[{ date: "2026-06-11", tokens: 100_000 }, { date: "2026-06-12", tokens: 80_000 }]],
        ]);
        const r = await runWithMock(db, fetchDailyActivityFull({ windowDays: 30 }));
        expect(r).toHaveLength(2);
        expect(r[0]).toEqual({ date: "2026-06-11", sessions: 5, tokens: 100_000 });
        expect(r[1]).toEqual({ date: "2026-06-12", sessions: 3, tokens: 80_000 });
        expect(db.captured[0]).toContain("time::now() - 30d");
        expect(db.captured[0]).toContain("array::len(array::distinct(session))");
    });

    test("day with no tokens entry gets tokens=0", async () => {
        const db = makeMockDb([
            [[{ date: "2026-06-11", sessions: 5 }]],
            [[]], // no token rows
        ]);
        const r = await runWithMock(db, fetchDailyActivityFull({ windowDays: 30 }));
        expect(r[0]).toEqual({ date: "2026-06-11", sessions: 5, tokens: 0 });
    });

    test("empty window -> empty array", async () => {
        const db = makeMockDb([[[]], [[]]]);
        const r = await runWithMock(db, fetchDailyActivityFull({ windowDays: 30 }));
        expect(r).toHaveLength(0);
    });
});

describe("fetchSessionDurations", () => {
    test("returns started_at+ended_at as ISO strings, window applied", async () => {
        const db = makeMockDb([[[
            { started_at: "2026-06-11T10:00:00Z", ended_at: "2026-06-11T12:30:00Z" },
            { started_at: "2026-06-12T09:00:00Z", ended_at: "2026-06-12T10:00:00Z" },
        ]]]);
        const r = await runWithMock(db, fetchSessionDurations({ windowDays: 30 }));
        expect(r[0]!.started_at).toBe("2026-06-11T10:00:00Z");
        expect(r[0]!.ended_at).toBe("2026-06-11T12:30:00Z");
        expect(db.captured[0]).toContain("ended_at IS NOT NONE");
        expect(db.captured[0]).toContain("started_at IS NOT NONE");
        expect(db.captured[0]).toContain("time::now() - 30d");
    });

    test("empty window -> empty array", async () => {
        const db = makeMockDb([[[]]]);
        const r = await runWithMock(db, fetchSessionDurations({ windowDays: 30 }));
        expect(r).toHaveLength(0);
    });
});

describe("fetchPeakHour", () => {
    test("returns the peak hour as a number", async () => {
        const db = makeMockDb([[[{ hour: "13", count: 42 }]]]);
        const r = await runWithMock(db, fetchPeakHour({ windowDays: 30 }));
        expect(r).toBe(13);
        expect(db.captured[0]).toContain("time::format(started_at");
        expect(db.captured[0]).toContain("time::now() - 30d");
    });

    test("empty window -> null", async () => {
        const db = makeMockDb([[[]]]);
        const r = await runWithMock(db, fetchPeakHour({ windowDays: 30 }));
        expect(r).toBeNull();
    });
});

describe("fetchSpawnedCount", () => {
    test("returns spawned count in window", async () => {
        const db = makeMockDb([[[{ count: 420 }]]]);
        const r = await runWithMock(db, fetchSpawnedCount({ windowDays: 30 }));
        expect(r).toBe(420);
        expect(db.captured[0]).toContain("FROM spawned");
        expect(db.captured[0]).toContain("time::now() - 30d");
    });

    test("empty -> 0", async () => {
        const db = makeMockDb([[[]]]);
        const r = await runWithMock(db, fetchSpawnedCount({ windowDays: 30 }));
        expect(r).toBe(0);
    });
});

describe("fetchCommitCount", () => {
    test("returns commit count using ts field", async () => {
        const db = makeMockDb([[[{ count: 1000 }]]]);
        const r = await runWithMock(db, fetchCommitCount({ windowDays: 30 }));
        expect(r).toBe(1000);
        expect(db.captured[0]).toContain("FROM commit");
        expect(db.captured[0]).toContain("ts >"); // uses ts field
        expect(db.captured[0]).toContain("time::now() - 30d");
    });

    test("empty -> 0", async () => {
        const db = makeMockDb([[[]]]);
        const r = await runWithMock(db, fetchCommitCount({ windowDays: 30 }));
        expect(r).toBe(0);
    });
});

describe("fetchTopTools", () => {
    test("returns top 10 tools by run count, window applied", async () => {
        const db = makeMockDb([[[
            { tool: "Bash", count: 5000 },
            { tool: "Read", count: 3200 },
        ]]]);
        const r = await runWithMock(db, fetchTopTools({ windowDays: 30 }));
        expect(r[0]).toEqual({ name: "Bash", runs: 5000 });
        expect(r[1]).toEqual({ name: "Read", runs: 3200 });
        expect(db.captured[0]).toContain("FROM tool_call");
        expect(db.captured[0]).toContain("command_norm ?? name");
        expect(db.captured[0]).toContain("LIMIT 10");
        expect(db.captured[0]).toContain("time::now() - 30d");
    });

    test("empty -> empty array", async () => {
        const db = makeMockDb([[[]]]);
        const r = await runWithMock(db, fetchTopTools({ windowDays: 30 }));
        expect(r).toHaveLength(0);
    });
});
```

- [ ] Run failing tests:

```bash
/tmp/run-ax-tests.sh apps/axctl/src/profile/queries.test.ts
```

Expected: all 12 new tests FAIL (functions not found).

### Step 2.2 - Implement the 6 new fetchers

- [ ] Open `apps/axctl/src/profile/queries.ts`. Append the following after `fetchAcceptedProposals`:

```typescript
// --- daily activity full (sessions + tokens per day) -----------------------

export interface DailyActivityRow {
    readonly date: string;
    readonly sessions: number;
    readonly tokens: number;
}

const DAILY_SESSIONS_SQL = (d: number) => `
SELECT
    time::format(ts, "%Y-%m-%d") AS date,
    array::len(array::distinct(session)) AS sessions
FROM turn
WHERE ts > time::now() - ${win(d)} AND ts IS NOT NONE
GROUP BY date
ORDER BY date ASC;`;

const DAILY_TOKENS_SQL = (d: number) => `
SELECT
    time::format(ts, "%Y-%m-%d") AS date,
    math::sum(prompt_tokens ?? 0) + math::sum(completion_tokens ?? 0) AS tokens
FROM session_token_usage
WHERE ts > time::now() - ${win(d)} AND ts IS NOT NONE
GROUP BY date
ORDER BY date ASC;`;

export const fetchDailyActivityFull = Effect.fn("profile.fetchDailyActivityFull")(
    function* (opts: { readonly windowDays: number }) {
        const db = yield* SurrealClient;
        const sessionRows = yield* db
            .query<[Array<Record<string, unknown>>]>(DAILY_SESSIONS_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        const tokenRows = yield* db
            .query<[Array<Record<string, unknown>>]>(DAILY_TOKENS_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        // Join tokens onto session rows in JS (SurrealDB 3.x: no cross-query joins)
        const tokenMap = new Map(
            tokenRows
                .map((r) => [String(r.date), Number(r.tokens ?? 0)] as const)
                .filter(([d]) => d !== "undefined" && d !== "null"),
        );
        return sessionRows
            .map((r) => {
                const date = String(r.date);
                return { date, sessions: Number(r.sessions ?? 0), tokens: tokenMap.get(date) ?? 0 };
            })
            .filter((r) => r.date !== "undefined" && r.date !== "null") satisfies DailyActivityRow[];
    },
);

// --- session durations -------------------------------------------------------

export interface SessionDurationRow {
    readonly started_at: string;
    readonly ended_at: string;
}

const SESSION_DURATIONS_SQL = (d: number) => `
SELECT
    type::string(started_at) AS started_at,
    type::string(ended_at) AS ended_at
FROM session
WHERE started_at > time::now() - ${win(d)}
  AND started_at IS NOT NONE
  AND ended_at IS NOT NONE;`;

export const fetchSessionDurations = Effect.fn("profile.fetchSessionDurations")(
    function* (opts: { readonly windowDays: number }) {
        const db = yield* SurrealClient;
        const rows = yield* db
            .query<[Array<Record<string, unknown>>]>(SESSION_DURATIONS_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        return rows
            .filter((r) => r.started_at != null && r.ended_at != null)
            .map((r) => ({
                started_at: String(r.started_at),
                ended_at: String(r.ended_at),
            })) satisfies SessionDurationRow[];
    },
);

// --- peak hour ---------------------------------------------------------------

const PEAK_HOUR_SQL = (d: number) => `
SELECT
    time::format(started_at, "%H") AS hour,
    count() AS count
FROM session
WHERE started_at > time::now() - ${win(d)}
  AND started_at IS NOT NONE
GROUP BY hour
ORDER BY count DESC
LIMIT 1;`;

export const fetchPeakHour = Effect.fn("profile.fetchPeakHour")(
    function* (opts: { readonly windowDays: number }) {
        const db = yield* SurrealClient;
        const rows = yield* db
            .query<[Array<Record<string, unknown>>]>(PEAK_HOUR_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        const row = rows[0];
        if (row == null) return null;
        return Number(row.hour ?? 0);
    },
);

// --- spawned count -----------------------------------------------------------

const SPAWNED_COUNT_SQL = (d: number) => `
SELECT count() AS count
FROM spawned
WHERE ts > time::now() - ${win(d)}
GROUP ALL;`;

export const fetchSpawnedCount = Effect.fn("profile.fetchSpawnedCount")(
    function* (opts: { readonly windowDays: number }) {
        const db = yield* SurrealClient;
        const rows = yield* db
            .query<[Array<Record<string, unknown>>]>(SPAWNED_COUNT_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        return Number(rows[0]?.count ?? 0);
    },
);

// --- commit count ------------------------------------------------------------
// commit table uses `ts` (datetime) field - confirmed in schema.surql.

const COMMIT_COUNT_SQL = (d: number) => `
SELECT count() AS count
FROM commit
WHERE ts > time::now() - ${win(d)}
GROUP ALL;`;

export const fetchCommitCount = Effect.fn("profile.fetchCommitCount")(
    function* (opts: { readonly windowDays: number }) {
        const db = yield* SurrealClient;
        const rows = yield* db
            .query<[Array<Record<string, unknown>>]>(COMMIT_COUNT_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        return Number(rows[0]?.count ?? 0);
    },
);

// --- top tools ---------------------------------------------------------------

export interface TopToolRow {
    readonly name: string;
    readonly runs: number;
}

const TOP_TOOLS_SQL = (d: number) => `
SELECT
    (command_norm ?? name) AS tool,
    count() AS count
FROM tool_call
WHERE ts > time::now() - ${win(d)}
  AND (command_norm ?? name) IS NOT NONE
GROUP BY tool
ORDER BY count DESC
LIMIT 10;`;

export const fetchTopTools = Effect.fn("profile.fetchTopTools")(
    function* (opts: { readonly windowDays: number }) {
        const db = yield* SurrealClient;
        const rows = yield* db
            .query<[Array<Record<string, unknown>>]>(TOP_TOOLS_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        return rows.map((r) => ({
            name: String(r.tool),
            runs: Number(r.count ?? 0),
        })) satisfies TopToolRow[];
    },
);
```

- [ ] Run tests:

```bash
/tmp/run-ax-tests.sh apps/axctl/src/profile/queries.test.ts
```

Expected: all tests PASS.

### Step 2.3 - Commit

```bash
git add apps/axctl/src/profile/queries.ts apps/axctl/src/profile/queries.test.ts
git commit -m "feat(profile): add 6 windowed fetchers for activity + insights data"
```

---

## Task 3: Pure deriver - insights.ts (new file)

**Files:**
- Create: `apps/axctl/src/profile/insights.ts`
- Create: `apps/axctl/src/profile/insights.test.ts`

### Step 3.1 - Write failing insights tests

- [ ] Create `apps/axctl/src/profile/insights.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { deriveInsights } from "./insights.ts";
import type { DailyActivityRow, SessionDurationRow } from "./queries.ts";

// 90 minutes = 5400 seconds; deep session threshold
const s = (startIso: string, endIso: string): SessionDurationRow => ({
    started_at: startIso,
    ended_at: endIso,
});

describe("deriveInsights", () => {
    const baseDailyFull: DailyActivityRow[] = [
        { date: "2026-06-09", sessions: 31, tokens: 800_000 },
        { date: "2026-06-10", sessions: 8, tokens: 100_000 },
        { date: "2026-06-12", sessions: 12, tokens: 120_000_000 },
    ];

    const baseDurations: SessionDurationRow[] = [
        s("2026-06-12T10:00:00Z", "2026-06-12T12:30:00Z"),  // 2.5h = deep
        s("2026-06-12T11:00:00Z", "2026-06-12T11:30:00Z"),  // 30min = not deep
        s("2026-06-12T09:00:00Z", "2026-06-12T10:30:00Z"),  // 1.5h = deep
    ];

    test("hours_total sums all durations in hours", () => {
        const r = deriveInsights({
            durations: baseDurations,
            peakHour: 10,
            spawned: 5,
            commits: 20,
            tools: [{ name: "Bash", runs: 100 }],
            daily: baseDailyFull,
        });
        // 2.5 + 0.5 + 1.5 = 4.5h
        expect(r!.hours_total).toBeCloseTo(4.5, 1);
    });

    test("longest_session_minutes finds the longest", () => {
        const r = deriveInsights({
            durations: baseDurations,
            peakHour: 10,
            spawned: 5,
            commits: 20,
            tools: [],
            daily: baseDailyFull,
        });
        // 2.5h = 150min
        expect(r!.longest_session_minutes).toBe(150);
    });

    test("deep_session_share = sessions >= 90min / total sessions with duration", () => {
        const r = deriveInsights({
            durations: baseDurations,
            peakHour: 10,
            spawned: 5,
            commits: 20,
            tools: [],
            daily: baseDailyFull,
        });
        // 2 deep out of 3 = 0.667
        expect(r!.deep_session_share).toBeCloseTo(2 / 3, 3);
    });

    test("busiest_day = max sessions in daily; ties pick earliest", () => {
        const r = deriveInsights({
            durations: baseDurations,
            peakHour: 13,
            spawned: 5,
            commits: 20,
            tools: [],
            daily: baseDailyFull,
        });
        expect(r!.busiest_day.date).toBe("2026-06-09");
        expect(r!.busiest_day.sessions).toBe(31);
    });

    test("ties in busiest_day -> earliest date wins", () => {
        const tied: DailyActivityRow[] = [
            { date: "2026-06-10", sessions: 10, tokens: 0 },
            { date: "2026-06-09", sessions: 10, tokens: 0 },
        ];
        const r = deriveInsights({
            durations: [],
            peakHour: null,
            spawned: 0,
            commits: 0,
            tools: [],
            daily: tied,
        });
        expect(r!.busiest_day.date).toBe("2026-06-09");
    });

    test("max_parallel_sessions: sweep overlapping intervals", () => {
        // Three sessions overlapping at 10:15: [10:00-11:00], [10:00-10:30], [10:00-10:20]
        const durations: SessionDurationRow[] = [
            s("2026-06-12T10:00:00Z", "2026-06-12T11:00:00Z"),
            s("2026-06-12T10:00:00Z", "2026-06-12T10:30:00Z"),
            s("2026-06-12T10:00:00Z", "2026-06-12T10:20:00Z"),
            s("2026-06-12T10:35:00Z", "2026-06-12T11:30:00Z"),  // only 2 overlap here
        ];
        const r = deriveInsights({
            durations,
            peakHour: 10,
            spawned: 0,
            commits: 0,
            tools: [],
            daily: [{ date: "2026-06-12", sessions: 4, tokens: 0 }],
        });
        expect(r!.max_parallel_sessions).toBe(3);
    });

    test("max_parallel_sessions: no overlap -> 1", () => {
        const durations: SessionDurationRow[] = [
            s("2026-06-12T08:00:00Z", "2026-06-12T09:00:00Z"),
            s("2026-06-12T10:00:00Z", "2026-06-12T11:00:00Z"),
        ];
        const r = deriveInsights({
            durations,
            peakHour: 8,
            spawned: 0,
            commits: 0,
            tools: [],
            daily: [{ date: "2026-06-12", sessions: 2, tokens: 0 }],
        });
        expect(r!.max_parallel_sessions).toBe(1);
    });

    test("sessions clamped at 24h each (bad data)", () => {
        const durations: SessionDurationRow[] = [
            s("2026-06-01T00:00:00Z", "2026-06-10T00:00:00Z"), // 9 days → clamped to 24h
            s("2026-06-12T10:00:00Z", "2026-06-12T12:00:00Z"),  // 2h
        ];
        const r = deriveInsights({
            durations,
            peakHour: 10,
            spawned: 0,
            commits: 0,
            tools: [],
            daily: [{ date: "2026-06-12", sessions: 2, tokens: 0 }],
        });
        // clamped: 24h + 2h = 26h
        expect(r!.hours_total).toBeCloseTo(26.0, 1);
        // longest after clamp is 24h = 1440 min
        expect(r!.longest_session_minutes).toBe(1440);
    });

    test("peak_hour_utc mirrors input peakHour", () => {
        const r = deriveInsights({
            durations: baseDurations,
            peakHour: 13,
            spawned: 420,
            commits: 1000,
            tools: [{ name: "Bash", runs: 5000 }],
            daily: baseDailyFull,
        });
        expect(r!.peak_hour_utc).toBe(13);
        expect(r!.subagents_spawned).toBe(420);
        expect(r!.commits).toBe(1000);
        expect(r!.tools_top[0]!.name).toBe("Bash");
    });

    test("returns null when both durations and daily are empty", () => {
        const r = deriveInsights({
            durations: [],
            peakHour: null,
            spawned: 0,
            commits: 0,
            tools: [],
            daily: [],
        });
        expect(r).toBeNull();
    });

    test("daily non-empty but durations empty: hours_total=0, deep_share=0, max_parallel=0", () => {
        const r = deriveInsights({
            durations: [],
            peakHour: 9,
            spawned: 3,
            commits: 5,
            tools: [],
            daily: [{ date: "2026-06-12", sessions: 5, tokens: 0 }],
        });
        expect(r).not.toBeNull();
        expect(r!.hours_total).toBe(0);
        expect(r!.deep_session_share).toBe(0);
        expect(r!.max_parallel_sessions).toBe(0);
        expect(r!.busiest_day.date).toBe("2026-06-12");
    });
});
```

- [ ] Run failing tests:

```bash
/tmp/run-ax-tests.sh apps/axctl/src/profile/insights.test.ts
```

Expected: all tests FAIL (module not found).

### Step 3.2 - Implement insights.ts

- [ ] Create `apps/axctl/src/profile/insights.ts`:

```typescript
/**
 * Pure session-analytics derivers for the ProfileV1 `insights` section.
 * No IO, no Effect, no Date.now() - all inputs injected.
 * Clamps individual session duration at 24h to kill bad data.
 */
import type { DailyActivityRow, SessionDurationRow, TopToolRow } from "./queries.ts";

const MAX_SESSION_MS = 24 * 60 * 60 * 1000; // 24h cap per session
const DEEP_THRESHOLD_MIN = 90;

export interface InsightsInput {
    readonly durations: ReadonlyArray<SessionDurationRow>;
    readonly peakHour: number | null;
    readonly spawned: number;
    readonly commits: number;
    readonly tools: ReadonlyArray<TopToolRow>;
    readonly daily: ReadonlyArray<DailyActivityRow>;
}

export interface InsightsResult {
    readonly hours_total: number;
    readonly longest_session_minutes: number;
    readonly deep_session_share: number;
    readonly peak_hour_utc: number;
    readonly busiest_day: { readonly date: string; readonly sessions: number };
    readonly max_parallel_sessions: number;
    readonly subagents_spawned: number;
    readonly commits: number;
    readonly tools_top: ReadonlyArray<TopToolRow>;
}

/**
 * Returns null when both durations and daily are empty (no data → renderer omits section).
 */
export function deriveInsights(input: InsightsInput): InsightsResult | null {
    const { durations, peakHour, spawned, commits, tools, daily } = input;
    if (durations.length === 0 && daily.length === 0) return null;

    // --- duration stats -------------------------------------------------------
    let totalMs = 0;
    let longestMs = 0;
    let deepCount = 0;

    const events: Array<{ t: number; delta: 1 | -1 }> = [];

    for (const { started_at, ended_at } of durations) {
        const startMs = Date.parse(started_at);
        const endMs = Date.parse(ended_at);
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
        const rawMs = endMs - startMs;
        const clampedMs = Math.min(rawMs, MAX_SESSION_MS);
        totalMs += clampedMs;
        longestMs = Math.max(longestMs, clampedMs);
        const clampedMinutes = clampedMs / 60_000;
        if (clampedMinutes >= DEEP_THRESHOLD_MIN) deepCount++;
        events.push({ t: startMs, delta: 1 });
        events.push({ t: endMs, delta: -1 });
    }

    const hours_total = Math.round((totalMs / 3_600_000) * 10) / 10;
    const longest_session_minutes = Math.round(longestMs / 60_000);
    const deep_session_share = durations.length > 0
        ? deepCount / durations.length
        : 0;

    // --- max parallel sessions (sweep line) -----------------------------------
    let max_parallel_sessions = 0;
    if (events.length > 0) {
        events.sort((a, b) => a.t !== b.t ? a.t - b.t : a.delta - b.delta); // ends before starts on tie
        let current = 0;
        for (const { delta } of events) {
            current += delta;
            if (current > max_parallel_sessions) max_parallel_sessions = current;
        }
    }

    // --- busiest day (from daily rows) ----------------------------------------
    let busiestDate = "";
    let busiestSessions = 0;
    for (const row of daily) {
        if (
            row.sessions > busiestSessions ||
            (row.sessions === busiestSessions && busiestDate !== "" && row.date < busiestDate)
        ) {
            busiestDate = row.date;
            busiestSessions = row.sessions;
        }
    }
    // Fallback if daily is empty but durations are not (shouldn't happen in practice)
    if (busiestDate === "" && daily.length === 0) {
        busiestDate = "";
        busiestSessions = 0;
    }

    return {
        hours_total,
        longest_session_minutes,
        deep_session_share,
        peak_hour_utc: peakHour ?? 0,
        busiest_day: { date: busiestDate, sessions: busiestSessions },
        max_parallel_sessions,
        subagents_spawned: spawned,
        commits,
        tools_top: tools,
    };
}
```

- [ ] Run tests:

```bash
/tmp/run-ax-tests.sh apps/axctl/src/profile/insights.test.ts
```

Expected: all tests PASS.

### Step 3.3 - Commit

```bash
git add apps/axctl/src/profile/insights.ts apps/axctl/src/profile/insights.test.ts
git commit -m "feat(profile): pure deriveInsights with sweep-line parallelism + depth math"
```

---

## Task 4: Renderer - wire new data into buildProfile

**Files:**
- Modify: `apps/axctl/src/profile/render.ts`
- Modify: `apps/axctl/src/profile/render.test.ts`

The key constraint: `makeMockDb` replays results in call order. The existing tests expect mocks 1-7 in the current order. New fetchers must be **appended** (calls 8-15 in order).

### Step 4.1 - Write failing render tests

- [ ] Open `apps/axctl/src/profile/render.test.ts`. The existing `mockResults` array has 7 entries (indices 0-6). Add 8 more entries for the new queries:

```typescript
// Extended mockResults: append new results for new fetchers (calls 8-15)
// 8  fetchDailyActivityFull (sessions query)
// 9  fetchDailyActivityFull (tokens query)
// 10 fetchSessionDurations
// 11 fetchPeakHour
// 12 fetchSpawnedCount
// 13 fetchCommitCount
// 14 fetchTopTools
```

Replace the `mockResults` const in the file with:

```typescript
const mockResults = [
    // --- existing 7 ---
    [[{ prompt_tokens: 31_000_000, completion_tokens: 7_000_000, sessions: 142 }]],
    [[{ date: "2026-06-11" }, { date: "2026-06-12" }]],
    [[{ source: "claude" }, { source: "codex" }]],
    [[{ skill: "tdd", count: 88 }]],
    [[{ name: "tdd", scope: "plugin:superpowers" }]],
    [[{
        form: "guidance", title: "Stop edit loops early",
        hypothesis: "3+ edits means drift", confidence: "high", frequency: 12,
        updated_at: "2026-06-10T00:00:00Z", created_at: "2026-06-01T00:00:00Z",
    }]],
    [[{
        model: "fable", sessions: 100, prompt_tokens: 1, completion_tokens: 1,
        cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: 150,
    }, {
        model: "haiku", sessions: 42, prompt_tokens: 1, completion_tokens: 1,
        cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: 50,
    }]],
    // --- new: fetchDailyActivityFull (2 queries) ---
    [[{ date: "2026-06-11", sessions: 5 }, { date: "2026-06-12", sessions: 12 }]],
    [[{ date: "2026-06-11", tokens: 100_000 }, { date: "2026-06-12", tokens: 120_000_000 }]],
    // --- new: fetchSessionDurations ---
    [[
        { started_at: "2026-06-12T10:00:00Z", ended_at: "2026-06-12T12:30:00Z" },
        { started_at: "2026-06-12T09:00:00Z", ended_at: "2026-06-12T10:30:00Z" },
    ]],
    // --- new: fetchPeakHour ---
    [[{ hour: "13", count: 42 }]],
    // --- new: fetchSpawnedCount ---
    [[{ count: 420 }]],
    // --- new: fetchCommitCount ---
    [[{ count: 1000 }]],
    // --- new: fetchTopTools ---
    [[{ tool: "Bash", count: 5000 }, { tool: "Read", count: 3200 }]],
];
```

- [ ] Add new assertions at the end of the "assembles a valid ProfileV1" test (before closing `})`):

```typescript
        // activity
        expect(p.activity).toBeDefined();
        expect(p.activity!.daily).toHaveLength(2);
        expect(p.activity!.daily[0]!.date).toBe("2026-06-11");
        expect(p.activity!.daily[0]!.sessions).toBe(5);
        expect(p.activity!.daily[1]!.tokens).toBe(120_000_000);
        // insights
        expect(p.insights).toBeDefined();
        expect(p.insights!.peak_hour_utc).toBe(13);
        expect(p.insights!.subagents_spawned).toBe(420);
        expect(p.insights!.commits).toBe(1000);
        expect(p.insights!.tools_top[0]!.name).toBe("Bash");
        expect(p.insights!.busiest_day.date).toBe("2026-06-12");
```

- [ ] Run failing tests:

```bash
/tmp/run-ax-tests.sh apps/axctl/src/profile/render.test.ts
```

Expected: "assembles a valid ProfileV1" test FAILS on activity/insights assertions; other tests may error due to mock count mismatch (that's fine for now).

### Step 4.2 - Implement in render.ts

- [ ] Open `apps/axctl/src/profile/render.ts`. Add imports for new fetchers and the deriver:

```typescript
import {
    fetchCommitCount,
    fetchDailyActivityFull,
    fetchPeakHour,
    fetchSessionDurations,
    fetchSpawnedCount,
    fetchTopTools,
} from "./queries.ts";
import { deriveInsights } from "./insights.ts";
```

- [ ] Inside `buildProfile`, after the existing `const cost = yield* fetchCostModels(...)` call, append (update the sequential-order comment too):

```typescript
        // --- activity + insights (appended in order; keep mocks aligned) -------
        // 8 fetchDailyActivityFull (sessions)  9 fetchDailyActivityFull (tokens)
        // 10 fetchSessionDurations  11 fetchPeakHour  12 fetchSpawnedCount
        // 13 fetchCommitCount  14 fetchTopTools
        const dailyFull = yield* fetchDailyActivityFull({ windowDays });
        const durations = yield* fetchSessionDurations({ windowDays });
        const peakHour = yield* fetchPeakHour({ windowDays });
        const spawnedCount = yield* fetchSpawnedCount({ windowDays });
        const commitCount = yield* fetchCommitCount({ windowDays });
        const topTools = yield* fetchTopTools({ windowDays });

        const insights = deriveInsights({
            durations,
            peakHour,
            spawned: spawnedCount,
            commits: commitCount,
            tools: topTools,
            daily: dailyFull,
        });
```

- [ ] In the `decodeProfile({...})` call, add the two new optional sections after `...(patterns.length > 0 ? { taste: { patterns } } : {})`:

```typescript
            ...(dailyFull.length > 0 ? { activity: { daily: dailyFull } } : {}),
            ...(insights !== null ? { insights } : {}),
```

- [ ] Run tests:

```bash
/tmp/run-ax-tests.sh apps/axctl/src/profile/render.test.ts
```

Expected: all tests PASS (the existing three tests still pass because the mocks now have 15 entries and the new calls are fulfilled by entries 8-14).

**Note:** The existing tests for `includeCost=false` and `no proposals -> taste omitted` will now consume all 15 mock entries when run via `makeMockDb(mockResults)`. Verify they still pass - if they use the same `mockResults`, the mock db will just have extra buffered results which is harmless.

### Step 4.3 - Commit

```bash
git add apps/axctl/src/profile/render.ts apps/axctl/src/profile/render.test.ts
git commit -m "feat(profile): wire activity + insights into buildProfile"
```

---

## Task 5: CLI formatter - money() helper + insights block

**Files:**
- Modify: `apps/axctl/src/cli/commands/profile.ts`

### Step 5.1 - Add money() helper and update formatProfile

- [ ] Open `apps/axctl/src/cli/commands/profile.ts`. After the `integer` helper, add:

```typescript
/** Formats a USD amount: >=1000 -> "~$22.6K", else "$22" */
const money = (n: number): string => {
    if (!Number.isFinite(n)) return "$0";
    if (n >= 1000) return `~$${(n / 1000).toFixed(1)}K`;
    return `$${n.toFixed(0)}`;
};
```

- [ ] In `formatProfile`, replace the cost rendering on the stats line:

```typescript
    const cost = p.stats.cost_usd !== undefined ? `  ·  ${money(p.stats.cost_usd)} est` : "";
```

- [ ] Replace the per-model cost rendering in the models loop:

```typescript
        const c = m.cost_usd !== undefined ? `  ${money(m.cost_usd)}` : "";
```

- [ ] After the `if (p.taste)` block at the end of `formatProfile`, add the insights block:

```typescript
    if (p.insights) {
        const ins = p.insights;
        const deepPct = (ins.deep_session_share * 100).toFixed(0);
        lines.push("");
        lines.push("insights:");
        lines.push(
            `  ${ins.hours_total.toFixed(1)}h total  ·  longest: ${ins.longest_session_minutes}min  ·  deep (≥90min): ${deepPct}%`,
        );
        lines.push(
            `  peak hour: ${ins.peak_hour_utc.toString().padStart(2, "0")}:00 UTC  ·  max parallel: ${ins.max_parallel_sessions}  ·  spawned: ${integer(ins.subagents_spawned)}  ·  commits: ${integer(ins.commits)}`,
        );
        if (ins.tools_top.length > 0) {
            lines.push("  top tools:");
            for (const t of ins.tools_top.slice(0, 5)) {
                lines.push(`    ${t.name.padEnd(20)} ${integer(t.runs).padStart(7)} runs`);
            }
        }
    }
```

- [ ] Run typecheck to verify:

```bash
cd /Users/necmttn/Projects/ax/.claude/worktrees/ax-profiles-spec && bun run typecheck 2>&1 | grep -E "profile|community" | head -20
```

Expected: no errors in profile.ts.

### Step 5.2 - Commit

```bash
git add apps/axctl/src/cli/commands/profile.ts
git commit -m "feat(profile): money() helper + insights block in formatProfile"
```

---

## Task 6: Site validator - extend community.ts + tests

**Files:**
- Modify: `apps/site/app/lib/community.ts`
- Modify: `apps/site/app/lib/community.test.ts`

### Step 6.1 - Write failing site validator tests

- [ ] Open `apps/site/app/lib/community.test.ts`. After the existing `validateProfileV1` describe block, add:

```typescript
describe("validateProfileV1 - activity + insights sections", () => {
    const profileWithSections = {
        ...validProfile,
        activity: {
            daily: [
                { date: "2026-06-09", sessions: 31, tokens: 800_000 },
            ],
        },
        insights: {
            hours_total: 307.2,
            longest_session_minutes: 960,
            deep_session_share: 0.58,
            peak_hour_utc: 13,
            busiest_day: { date: "2026-06-09", sessions: 31 },
            max_parallel_sessions: 11,
            subagents_spawned: 420,
            commits: 1000,
            tools_top: [
                { name: "Bash", runs: 5000 },
            ],
        },
    };

    test("accepts profile with valid activity + insights", () => {
        const p = validateProfileV1(profileWithSections);
        expect((p as unknown as typeof profileWithSections).activity!.daily[0]!.sessions).toBe(31);
        expect((p as unknown as typeof profileWithSections).insights!.peak_hour_utc).toBe(13);
        expect((p as unknown as typeof profileWithSections).insights!.busiest_day.date).toBe("2026-06-09");
        expect((p as unknown as typeof profileWithSections).insights!.tools_top[0]!.name).toBe("Bash");
    });

    test("rejects non-number in tools_top.runs", () => {
        const bad = {
            ...profileWithSections,
            insights: {
                ...profileWithSections.insights,
                tools_top: [{ name: "Bash", runs: "five-thousand" }],
            },
        };
        expect(() => validateProfileV1(bad)).toThrow();
    });

    test("rejects non-string in tools_top.name", () => {
        const bad = {
            ...profileWithSections,
            insights: {
                ...profileWithSections.insights,
                tools_top: [{ name: 42, runs: 100 }],
            },
        };
        expect(() => validateProfileV1(bad)).toThrow();
    });

    test("rejects non-number hours_total", () => {
        const bad = {
            ...profileWithSections,
            insights: {
                ...profileWithSections.insights,
                hours_total: "307.2",
            },
        };
        expect(() => validateProfileV1(bad)).toThrow();
    });

    test("rejects daily row with non-number sessions", () => {
        const bad = {
            ...profileWithSections,
            activity: {
                daily: [{ date: "2026-06-09", sessions: "31", tokens: 800_000 }],
            },
        };
        expect(() => validateProfileV1(bad)).toThrow();
    });
});
```

- [ ] Run failing tests:

```bash
/tmp/run-ax-tests.sh apps/site/app/lib/community.test.ts
```

Expected: 5 new tests FAIL.

### Step 6.2 - Implement validator extensions in community.ts

- [ ] Open `apps/site/app/lib/community.ts`. Extend the `ProfileV1` TypeScript interface to include the new optional sections:

```typescript
export interface ProfileDailyRow {
    readonly date: string;
    readonly sessions: number;
    readonly tokens: number;
}
export interface ProfileToolRun {
    readonly name: string;
    readonly runs: number;
}
export interface ProfileInsights {
    readonly hours_total: number;
    readonly longest_session_minutes: number;
    readonly deep_session_share: number;
    readonly peak_hour_utc: number;
    readonly busiest_day: { readonly date: string; readonly sessions: number };
    readonly max_parallel_sessions: number;
    readonly subagents_spawned: number;
    readonly commits: number;
    readonly tools_top: readonly ProfileToolRun[];
}
```

Add these to the `ProfileV1` interface after `taste?`:

```typescript
    readonly activity?: { readonly daily: readonly ProfileDailyRow[] };
    readonly insights?: ProfileInsights;
```

- [ ] In `validateProfileV1`, add the new section validation after the `if (value.taste !== undefined)` block:

```typescript
    if (value.activity !== undefined) {
        if (!isRecord(value.activity) || !Array.isArray(value.activity.daily)) {
            throw new Error("invalid activity");
        }
        for (const d of value.activity.daily) {
            if (!isRecord(d)) throw new Error("invalid activity.daily row");
            str(d.date, "activity.daily.date");
            num(d.sessions, "activity.daily.sessions");
            num(d.tokens, "activity.daily.tokens");
        }
    }
    if (value.insights !== undefined) {
        const ins = value.insights;
        if (!isRecord(ins)) throw new Error("invalid insights");
        num(ins.hours_total, "insights.hours_total");
        num(ins.longest_session_minutes, "insights.longest_session_minutes");
        num(ins.deep_session_share, "insights.deep_session_share");
        num(ins.peak_hour_utc, "insights.peak_hour_utc");
        if (!isRecord(ins.busiest_day)) throw new Error("invalid insights.busiest_day");
        str(ins.busiest_day.date, "insights.busiest_day.date");
        num(ins.busiest_day.sessions, "insights.busiest_day.sessions");
        num(ins.max_parallel_sessions, "insights.max_parallel_sessions");
        num(ins.subagents_spawned, "insights.subagents_spawned");
        num(ins.commits, "insights.commits");
        if (!Array.isArray(ins.tools_top)) throw new Error("invalid insights.tools_top");
        for (const t of ins.tools_top) {
            if (!isRecord(t)) throw new Error("invalid tools_top row");
            str(t.name, "tools_top.name");
            num(t.runs, "tools_top.runs");
        }
    }
```

- [ ] Run tests:

```bash
/tmp/run-ax-tests.sh apps/site/app/lib/community.test.ts
```

Expected: all tests PASS.

### Step 6.3 - Commit

```bash
git add apps/site/app/lib/community.ts apps/site/app/lib/community.test.ts
git commit -m "feat(profile): extend site validator for activity + insights sections"
```

---

## Task 7: Gates + smoke test

**Files:** No new files. Read-only verification.

### Step 7.1 - Run full test suite

- [ ] Run all gated paths:

```bash
/tmp/run-ax-tests.sh apps/axctl/src/profile/ apps/axctl/src/cli/effect-cli.test.ts apps/site/app/lib/
```

Expected: All tests pass. Note the total count.

### Step 7.2 - Typecheck

- [ ] Run typecheck from worktree root:

```bash
cd /Users/necmttn/Projects/ax/.claude/worktrees/ax-profiles-spec && bun run typecheck 2>&1 | tail -20
```

Expected: No errors.

### Step 7.3 - check:no-node-fs

- [ ] Verify no node:fs usage in new/modified files:

```bash
cd /Users/necmttn/Projects/ax/.claude/worktrees/ax-profiles-spec && bun run check:no-node-fs 2>&1 | tail -10
```

Expected: passes.

### Step 7.4 - Smoke test against live DB

- [ ] Run the smoke query:

```bash
bun /Users/necmttn/Projects/ax/.claude/worktrees/ax-profiles-spec/apps/axctl/src/cli/index.ts profile show --json | jq '{activity: (.activity.daily | length), insights: .insights}'
```

Expected: JSON output with `activity` count > 0 and `insights` object with numeric fields. If DB lacks session durations, insights may be null (acceptable - note it).

### Step 7.5 - Final commit (if any loose ends)

If the smoke test revealed any issues, fix and commit:

```bash
git add -p  # stage only profile + site files
git commit -m "fix(profile): smoke test fixups"
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ `activity.daily` schema (DailyRow with date/sessions/tokens)
- ✅ `insights` schema (all 9 numeric fields + busiest_day struct + tools_top array)
- ✅ Both sections optional at profile level, all fields required within
- ✅ `fetchDailyActivityFull` - sessions from turn + tokens from session_token_usage, joined in JS
- ✅ `fetchSessionDurations` - WHERE both NOT NONE, type::string
- ✅ `fetchPeakHour` - windowed PEAK_HOUR_SQL
- ✅ `fetchSpawnedCount` - windowed SPAWNED_SQL
- ✅ `fetchCommitCount` - uses `ts` field (confirmed in schema.surql)
- ✅ `fetchTopTools` - top 10, no failures col
- ✅ `deriveInsights` - hours_total clamped, sweep-line parallelism, deep share, busiest_day ties
- ✅ Returns null when durations AND daily both empty
- ✅ `render.ts` - appended after existing 7 queries (mock order preserved)
- ✅ `render.test.ts` - mockResults extended 7→15 entries
- ✅ `formatProfile` - money() helper, insights block, top 5 tools
- ✅ `community.ts` - ProfileV1 interface + validateProfileV1 extended
- ✅ `community.test.ts` - accept + reject cases for new sections
- ✅ Gates: test suite, typecheck, check:no-node-fs, smoke

**Type consistency:**
- `DailyActivityRow` / `SessionDurationRow` / `TopToolRow` defined in `queries.ts`, imported by `insights.ts`
- `InsightsInput` / `InsightsResult` defined in `insights.ts`
- `buildProfile` spreads `insights` (null-checked) and `dailyFull` (length-checked) into decodeProfile

**Commit table note:** The `commit` table uses `ts` (datetime) - confirmed via `rg "DEFINE TABLE commit" -A 10` in schema.surql. `fetchCommitCount` uses `WHERE ts > time::now() - ${win(d)}`.
