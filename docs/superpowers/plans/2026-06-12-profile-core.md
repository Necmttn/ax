# Profile Core (Plan 1 of 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ax profile show` renders the user's full profile JSON (stats + rig + taste) from the local SurrealDB graph - the local half of the profiles spec (`docs/superpowers/specs/2026-06-12-ax-profiles-design.md`), no network.

**Architecture:** A new `apps/axctl/src/profile/` module: typed schema (Effect Schema tagged union on pattern `category`), windowed stat queries (parameterized variants of `queries/wrapped.ts`), pure derivers (streak, taste-from-proposals, rig assembly), and a `buildProfile` orchestrator. One new CLI family `ax profile` with a `show` subcommand registered through the existing manifest system. Publish/gist/fork (Plan 2), repo CI (Plan 3), site (Plan 4) come later and consume `ProfileV1`.

**Tech Stack:** bun ≥1.3, TypeScript strict, `effect@beta` (v4 - `import { Effect, Schema } from "effect"`), SurrealDB via `SurrealClient` from `@ax/lib/db`, tests with `bun:test` + `makeMockDb`/`runWithMock` from `@ax/lib/testing/surreal`.

**Conventions that bite (read first):**

- Effect v4 beta: ALWAYS run `effect-solutions show data-modeling basics` before writing Schema/Effect code; check `.references/effect-smol/packages/effect/src` for real API signatures. Never guess.
- `bun test` may be blocked by a global hook on this machine; if so, write a tmp wrapper script that invokes `bun test` and run that (known workaround).
- No `node:fs` imports - repo has a `check:no-node-fs` CI gate. IO goes through Bun APIs at the command layer; keep derivers pure (data in, data out).
- SurrealDB 3.x: no stacked record derefs inside grouped aggregates (hangs on large edge tables). Pattern: deref-free GROUP BY, join in JS.
- Datetime fields from the SDK arrive as JS `Date`s; SQL stringifies with `type::string(...)` where strings are wanted.
- New commands must appear in BOTH `registeredCommands` and `RUNTIME_BY_COMMAND` in `apps/axctl/src/cli/index.ts` - `effect-cli.test.ts` fails otherwise.

**File structure:**

```
apps/axctl/src/profile/
├── schema.ts        # ProfileV1 + TastePattern types (Schema tagged union) - single source of truth
├── schema.test.ts
├── streak.ts        # pure: daily-activity rows -> { active_days, streak_days } (UTC)
├── streak.test.ts
├── queries.ts       # windowed fetchers: usage, daily, models+cost, skills, harnesses, proposals
├── queries.test.ts
├── taste.ts         # pure: proposal rows -> TastePattern[]
├── taste.test.ts
├── rig.ts           # pure: skill rows + invocation counts + hook files + rules text -> rig
├── rig.test.ts
├── render.ts        # buildProfile orchestrator (Effect; queries + pure derivers -> ProfileV1)
└── render.test.ts
apps/axctl/src/cli/commands/profile.ts   # ax profile show
Modify: apps/axctl/src/cli/index.ts      # register command + runtime manifest
```

---

### Task 1: Profile schema (`ProfileV1`, `TastePattern`)

**Files:**
- Create: `apps/axctl/src/profile/schema.ts`
- Test: `apps/axctl/src/profile/schema.test.ts`

- [ ] **Step 1: Consult Effect data-modeling guide**

Run: `effect-solutions show data-modeling`
Confirm the v4 Schema API for: `Schema.Struct`, `Schema.Literal`, `Schema.Union`, `Schema.Array`, `Schema.optional`/optional fields, and `Schema.decodeUnknownSync` (or v4 equivalent). If names differ from this plan, follow the guide - the plan's intent is a discriminated union on `category`.

- [ ] **Step 2: Write the failing test**

```ts
// apps/axctl/src/profile/schema.test.ts
import { describe, expect, test } from "bun:test";
import {
    PATTERN_CATEGORIES,
    decodeProfile,
    type ProfileV1,
} from "./schema.ts";

const validProfile = {
    v: 1,
    github: "necmttn",
    generated_at: "2026-06-12T19:04:00Z",
    window_days: 30,
    stats: {
        sessions: 142,
        active_days: 26,
        streak_days: 12,
        tokens: { prompt: 31_000_000, completion: 7_000_000, total: 38_000_000 },
        cost_usd: 214.3,
        models: [{ name: "fable", share: 0.58, cost_usd: 124 }],
        harnesses: ["claude-code", "codex"],
    },
    rig: {
        skills: [{ name: "tdd", source: "superpowers", runs_30d: 88 }],
        hooks: ["enforce-worktree", "route-dispatch"],
        routing_table: true,
        rules: { count: 14 },
    },
    taste: {
        patterns: [
            {
                category: "failure-mode",
                name: "edit-loop-thrash",
                summary: "3+ edits to same file -> stop, re-read requirements",
                evidence: {
                    sessions: 12,
                    confidence: 0.8,
                    last_reinforced: "2026-06-10",
                    trend: "rising",
                },
                links: [
                    { rel: "recovered-by", ref: "problem-solving-strategy/full-file-reread" },
                ],
            },
            {
                category: "stack-choice",
                slot: "state-management",
                name: "effect-atom",
                over: ["redux", "zustand"],
                context: "react apps",
                evidence: { sessions: 23, confidence: 0.9, last_reinforced: "2026-06-11", trend: "stable" },
            },
        ],
    },
};

describe("decodeProfile", () => {
    test("accepts a full valid profile", () => {
        const profile: ProfileV1 = decodeProfile(validProfile);
        expect(profile.github).toBe("necmttn");
        expect(profile.taste!.patterns).toHaveLength(2);
    });

    test("cost_usd is optional (--no-cost)", () => {
        const { cost_usd: _omit, ...stats } = validProfile.stats;
        const profile = decodeProfile({ ...validProfile, stats });
        expect(profile.stats.cost_usd).toBeUndefined();
    });

    test("taste section is optional", () => {
        const { taste: _omit, ...rest } = validProfile;
        const profile = decodeProfile(rest);
        expect(profile.taste).toBeUndefined();
    });

    test("rejects unknown pattern category", () => {
        const bad = {
            ...validProfile,
            taste: {
                patterns: [
                    { category: "vibes", name: "x", summary: "y", evidence: { sessions: 1, confidence: 0.5 } },
                ],
            },
        };
        expect(() => decodeProfile(bad)).toThrow();
    });

    test("stack-choice requires slot; prose categories require summary", () => {
        const noSlot = {
            ...validProfile,
            taste: { patterns: [{ category: "stack-choice", name: "x", evidence: { sessions: 1, confidence: 0.5 } }] },
        };
        expect(() => decodeProfile(noSlot)).toThrow();
        const noSummary = {
            ...validProfile,
            taste: { patterns: [{ category: "workflow", name: "x", evidence: { sessions: 1, confidence: 0.5 } }] },
        };
        expect(() => decodeProfile(noSummary)).toThrow();
    });

    test("category enum is exactly the spec set", () => {
        expect([...PATTERN_CATEGORIES].sort()).toEqual([
            "debugging",
            "design-aesthetic",
            "failure-mode",
            "problem-solving-strategy",
            "stack-choice",
            "workflow",
        ]);
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test apps/axctl/src/profile/schema.test.ts`
Expected: FAIL - `Cannot find module './schema.ts'`

- [ ] **Step 4: Write the schema**

```ts
// apps/axctl/src/profile/schema.ts
/**
 * ProfileV1 - the canonical ax profile artifact (spec:
 * docs/superpowers/specs/2026-06-12-ax-profiles-design.md §1).
 * Single source of truth for renderer (this plan), gist publish (Plan 2),
 * registry CI (Plan 3), and site (Plan 4). Aggregates only - never
 * transcript content, project names, or paths.
 */
import { Schema } from "effect";

export const PATTERN_CATEGORIES = [
    "design-aesthetic",
    "problem-solving-strategy",
    "debugging",
    "failure-mode",
    "workflow",
    "stack-choice",
] as const;
export type PatternCategory = (typeof PATTERN_CATEGORIES)[number];

const Trend = Schema.Literals(["rising", "stable", "falling", "stale"]);

export const Evidence = Schema.Struct({
    sessions: Schema.Number,
    confidence: Schema.Number,
    last_reinforced: Schema.optional(Schema.String),
    trend: Schema.optional(Trend),
});

const PatternLink = Schema.Struct({
    rel: Schema.Literals(["recovered-by", "pairs-with", "conflicts-with"]),
    ref: Schema.String,
});

/** Prose patterns: every category except stack-choice; summary required. */
const ProsePattern = Schema.Struct({
    category: Schema.Literals([
        "design-aesthetic",
        "problem-solving-strategy",
        "debugging",
        "failure-mode",
        "workflow",
    ]),
    name: Schema.String,
    summary: Schema.String,
    evidence: Evidence,
    links: Schema.optional(Schema.Array(PatternLink)),
});

/** stack-choice: X-vs-Y tool preference; slot required, no summary. */
const StackChoicePattern = Schema.Struct({
    category: Schema.Literal("stack-choice"),
    slot: Schema.String,
    name: Schema.String,
    over: Schema.optional(Schema.Array(Schema.String)),
    context: Schema.optional(Schema.String),
    evidence: Evidence,
    links: Schema.optional(Schema.Array(PatternLink)),
});

export const TastePattern = Schema.Union([ProsePattern, StackChoicePattern]);
export type TastePattern = typeof TastePattern.Type;

const ModelShare = Schema.Struct({
    name: Schema.String,
    share: Schema.Number,
    cost_usd: Schema.optional(Schema.Number),
});

const Stats = Schema.Struct({
    sessions: Schema.Number,
    active_days: Schema.Number,
    streak_days: Schema.Number,
    tokens: Schema.Struct({
        prompt: Schema.Number,
        completion: Schema.Number,
        total: Schema.Number,
    }),
    cost_usd: Schema.optional(Schema.Number),
    models: Schema.Array(ModelShare),
    harnesses: Schema.Array(Schema.String),
});

const Rig = Schema.Struct({
    skills: Schema.Array(
        Schema.Struct({
            name: Schema.String,
            source: Schema.String,
            runs_30d: Schema.Number,
        }),
    ),
    hooks: Schema.Array(Schema.String),
    routing_table: Schema.Boolean,
    rules: Schema.optional(
        Schema.Struct({
            count: Schema.Number,
            topics: Schema.optional(Schema.Array(Schema.String)),
        }),
    ),
});

export const ProfileV1 = Schema.Struct({
    v: Schema.Literal(1),
    github: Schema.String,
    generated_at: Schema.String,
    window_days: Schema.Number,
    stats: Stats,
    rig: Rig,
    taste: Schema.optional(Schema.Struct({ patterns: Schema.Array(TastePattern) })),
});
export type ProfileV1 = typeof ProfileV1.Type;

export const decodeProfile = (input: unknown): ProfileV1 =>
    Schema.decodeUnknownSync(ProfileV1)(input);
```

NOTE: if v4 Schema names differ (`Schema.Literals` vs `Schema.Literal(...members)`, optional-field helper), adapt to what `effect-solutions show data-modeling` and `.references/effect-smol/packages/effect/src/schema/Schema.ts` actually export. The test, not this listing, is the contract.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test apps/axctl/src/profile/schema.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Typecheck and commit**

```bash
bun run typecheck
git add apps/axctl/src/profile/schema.ts apps/axctl/src/profile/schema.test.ts
git commit -m "feat(profile): ProfileV1 schema with tagged taste-pattern union"
```

---

### Task 2: Streak calculator (pure)

**Files:**
- Create: `apps/axctl/src/profile/streak.ts`
- Test: `apps/axctl/src/profile/streak.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/axctl/src/profile/streak.test.ts
import { describe, expect, test } from "bun:test";
import { computeStreak } from "./streak.ts";

// Dates are "YYYY-MM-DD" UTC day keys, as produced by
// time::format(ts, "%Y-%m-%d") in SurrealQL (UTC per spec decision).
describe("computeStreak", () => {
    test("counts consecutive days ending today", () => {
        const r = computeStreak(["2026-06-10", "2026-06-11", "2026-06-12"], "2026-06-12");
        expect(r).toEqual({ active_days: 3, streak_days: 3 });
    });

    test("streak survives when today has no activity yet (grace = yesterday)", () => {
        const r = computeStreak(["2026-06-09", "2026-06-10", "2026-06-11"], "2026-06-12");
        expect(r.streak_days).toBe(3);
    });

    test("gap older than yesterday breaks the streak", () => {
        const r = computeStreak(["2026-06-01", "2026-06-02", "2026-06-10"], "2026-06-12");
        expect(r).toEqual({ active_days: 3, streak_days: 0 });
    });

    test("gap inside the run stops the count", () => {
        const r = computeStreak(["2026-06-08", "2026-06-10", "2026-06-11", "2026-06-12"], "2026-06-12");
        expect(r.streak_days).toBe(3);
    });

    test("empty input", () => {
        expect(computeStreak([], "2026-06-12")).toEqual({ active_days: 0, streak_days: 0 });
    });

    test("duplicate dates are deduped", () => {
        const r = computeStreak(["2026-06-12", "2026-06-12"], "2026-06-12");
        expect(r).toEqual({ active_days: 1, streak_days: 1 });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/profile/streak.test.ts`
Expected: FAIL - module not found

- [ ] **Step 3: Implement**

```ts
// apps/axctl/src/profile/streak.ts
/**
 * Streak math over UTC day keys ("YYYY-MM-DD"). `today` is injected (no
 * Date.now() in pure code) - callers pass the current UTC day. A streak is
 * the run of consecutive days ending today or yesterday (grace: today's
 * sessions may not exist yet when the profile renders in the morning).
 */
export interface StreakResult {
    readonly active_days: number;
    readonly streak_days: number;
}

const DAY_MS = 86_400_000;

const toUtcMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);

export function computeStreak(days: ReadonlyArray<string>, today: string): StreakResult {
    const unique = [...new Set(days)].sort();
    if (unique.length === 0) return { active_days: 0, streak_days: 0 };

    const todayMs = toUtcMs(today);
    const lastMs = toUtcMs(unique[unique.length - 1]!);
    // Anchor must be today or yesterday, else streak is dead.
    if (todayMs - lastMs > DAY_MS) return { active_days: unique.length, streak_days: 0 };

    let streak = 1;
    for (let i = unique.length - 1; i > 0; i--) {
        const gap = toUtcMs(unique[i]!) - toUtcMs(unique[i - 1]!);
        if (gap !== DAY_MS) break;
        streak++;
    }
    return { active_days: unique.length, streak_days: streak };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/profile/streak.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/profile/streak.ts apps/axctl/src/profile/streak.test.ts
git commit -m "feat(profile): UTC streak calculator"
```

---

### Task 3: Windowed profile queries

**Files:**
- Create: `apps/axctl/src/profile/queries.ts`
- Test: `apps/axctl/src/profile/queries.test.ts`
- Reference (read, don't modify): `apps/axctl/src/queries/wrapped.ts`, `apps/axctl/src/queries/cost-analytics.ts`

These are windowed (`--window=N` days) variants of the 365d-hardcoded SQL in `queries/wrapped.ts`, following the `Effect.fn` + `SurrealClient` fetcher shape from `queries/cost-analytics.ts:56-79`. Skill source attribution joins the `skill` table (`name`, `scope`) in JS - never `out.scope` derefs inside grouped aggregates (SurrealDB 3.x hang risk).

- [ ] **Step 1: Write the failing test**

```ts
// apps/axctl/src/profile/queries.test.ts
import { describe, expect, test } from "bun:test";
import { makeMockDb, runWithMock } from "@ax/lib/testing/surreal";
import {
    fetchAcceptedProposals,
    fetchDailyActivity,
    fetchHarnesses,
    fetchSkillInvocations,
    fetchSkillScopes,
    fetchTokenTotals,
} from "./queries.ts";

describe("fetchTokenTotals", () => {
    test("sums tokens and sessions over the window", async () => {
        const db = makeMockDb([[[{ prompt_tokens: 100, completion_tokens: 40, sessions: 3 }]]]);
        const r = await runWithMock(db, fetchTokenTotals({ windowDays: 30 }));
        expect(r).toEqual({ prompt_tokens: 100, completion_tokens: 40, sessions: 3 });
        expect(db.captured[0]).toContain("time::now() - 30d");
        expect(db.captured[0]).toContain("session_token_usage");
    });

    test("empty window -> zeros", async () => {
        const db = makeMockDb([[[]]]);
        const r = await runWithMock(db, fetchTokenTotals({ windowDays: 30 }));
        expect(r).toEqual({ prompt_tokens: 0, completion_tokens: 0, sessions: 0 });
    });
});

describe("fetchDailyActivity", () => {
    test("returns day keys", async () => {
        const db = makeMockDb([[[{ date: "2026-06-11" }, { date: "2026-06-12" }]]]);
        const r = await runWithMock(db, fetchDailyActivity({ windowDays: 30 }));
        expect(r).toEqual(["2026-06-11", "2026-06-12"]);
        expect(db.captured[0]).toContain('time::format(ts, "%Y-%m-%d")');
    });
});

describe("fetchHarnesses", () => {
    test("returns distinct sources", async () => {
        const db = makeMockDb([[[{ source: "claude" }, { source: "codex" }]]]);
        const r = await runWithMock(db, fetchHarnesses({ windowDays: 30 }));
        expect(r).toEqual(["claude", "codex"]);
        expect(db.captured[0]).toContain("GROUP BY source");
    });
});

describe("fetchSkillInvocations", () => {
    test("returns name+count rows, window applied", async () => {
        const db = makeMockDb([[[{ skill: "tdd", count: 88 }]]]);
        const r = await runWithMock(db, fetchSkillInvocations({ windowDays: 30 }));
        expect(r).toEqual([{ skill: "tdd", count: 88 }]);
        expect(db.captured[0]).toContain("FROM invoked");
        expect(db.captured[0]).toContain("time::now() - 30d");
    });
});

describe("fetchSkillScopes", () => {
    test("maps name -> scope, tombstones filtered in SQL", async () => {
        const db = makeMockDb([[[
            { name: "tdd", scope: "plugin:superpowers" },
            { name: "my-local", scope: "user" },
        ]]]);
        const r = await runWithMock(db, fetchSkillScopes());
        expect(r.get("tdd")).toBe("plugin:superpowers");
        expect(db.captured[0]).toContain("deleted_at IS NONE");
    });
});

describe("fetchAcceptedProposals", () => {
    test("returns accepted proposals with fields the taste deriver needs", async () => {
        const db = makeMockDb([[[
            {
                form: "guidance",
                title: "Stop edit loops early",
                hypothesis: "3+ edits same file means requirements drift",
                confidence: "high",
                frequency: 12,
                updated_at: "2026-06-10T00:00:00Z",
                created_at: "2026-06-01T00:00:00Z",
            },
        ]]]);
        const r = await runWithMock(db, fetchAcceptedProposals());
        expect(r[0]!.title).toBe("Stop edit loops early");
        expect(db.captured[0]).toContain("status = 'accepted'");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/profile/queries.test.ts`
Expected: FAIL - module not found

- [ ] **Step 3: Implement**

```ts
// apps/axctl/src/profile/queries.ts
/**
 * Windowed stat queries for the profile renderer. These are parameterized
 * variants of queries/wrapped.ts (which hardcodes 365d). All deref-free in
 * grouped aggregates (SurrealDB 3.x hang rule); joins happen in JS.
 * Read-only tables: session_token_usage, turn, session, invoked, skill,
 * proposal.
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";

const win = (d: number) => `${Math.max(1, Math.trunc(d))}d`;

// --- token totals -----------------------------------------------------------

export interface TokenTotals {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly sessions: number;
}

const TOKEN_TOTALS_SQL = (d: number) => `
SELECT
    math::sum(prompt_tokens ?? 0) AS prompt_tokens,
    math::sum(completion_tokens ?? 0) AS completion_tokens,
    count() AS sessions
FROM session_token_usage
WHERE ts > time::now() - ${win(d)}
GROUP ALL;`;

export const fetchTokenTotals = Effect.fn("profile.fetchTokenTotals")(
    function* (opts: { readonly windowDays: number }) {
        const db = yield* SurrealClient;
        const rows = yield* db
            .query<[Array<Record<string, unknown>>]>(TOKEN_TOTALS_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        const row = rows[0] ?? {};
        return {
            prompt_tokens: Number(row.prompt_tokens ?? 0),
            completion_tokens: Number(row.completion_tokens ?? 0),
            sessions: Number(row.sessions ?? 0),
        } satisfies TokenTotals;
    },
);

// --- daily activity (streak input) -----------------------------------------

const DAILY_ACTIVITY_SQL = (d: number) => `
SELECT time::format(ts, "%Y-%m-%d") AS date
FROM turn
WHERE ts > time::now() - ${win(d)} AND ts IS NOT NONE
GROUP BY date
ORDER BY date ASC;`;

export const fetchDailyActivity = Effect.fn("profile.fetchDailyActivity")(
    function* (opts: { readonly windowDays: number }) {
        const db = yield* SurrealClient;
        const rows = yield* db
            .query<[Array<Record<string, unknown>>]>(DAILY_ACTIVITY_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        return rows.map((r) => String(r.date)).filter((d) => d !== "undefined");
    },
);

// --- harnesses --------------------------------------------------------------

const HARNESSES_SQL = (d: number) => `
SELECT source, count() AS count
FROM session
WHERE started_at > time::now() - ${win(d)} AND source IS NOT NONE
GROUP BY source
ORDER BY count DESC;`;

export const fetchHarnesses = Effect.fn("profile.fetchHarnesses")(
    function* (opts: { readonly windowDays: number }) {
        const db = yield* SurrealClient;
        const rows = yield* db
            .query<[Array<Record<string, unknown>>]>(HARNESSES_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        return rows.map((r) => String(r.source));
    },
);

// --- skill invocations + scopes ---------------------------------------------

export interface SkillInvocationRow {
    readonly skill: string;
    readonly count: number;
}

const SKILL_INVOCATIONS_SQL = (d: number) => `
SELECT out.name AS skill, count() AS count
FROM invoked
WHERE ts > time::now() - ${win(d)} AND out.name IS NOT NONE
GROUP BY skill
ORDER BY count DESC
LIMIT 100;`;

export const fetchSkillInvocations = Effect.fn("profile.fetchSkillInvocations")(
    function* (opts: { readonly windowDays: number }) {
        const db = yield* SurrealClient;
        const rows = yield* db
            .query<[Array<Record<string, unknown>>]>(SKILL_INVOCATIONS_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        return rows.map((r) => ({
            skill: String(r.skill),
            count: Number(r.count ?? 0),
        })) satisfies SkillInvocationRow[];
    },
);

const SKILL_SCOPES_SQL = `
SELECT name, scope FROM skill WHERE deleted_at IS NONE;`;

export const fetchSkillScopes = Effect.fn("profile.fetchSkillScopes")(
    function* () {
        const db = yield* SurrealClient;
        const rows = yield* db
            .query<[Array<Record<string, unknown>>]>(SKILL_SCOPES_SQL)
            .pipe(Effect.map((r) => r?.[0] ?? []));
        return new Map(rows.map((r) => [String(r.name), String(r.scope)]));
    },
);

// --- accepted proposals (taste input) ---------------------------------------

export interface ProposalRow {
    readonly form: string;
    readonly title: string;
    readonly hypothesis: string;
    readonly confidence: string;
    readonly frequency: number;
    readonly updated_at: string | null;
    readonly created_at: string | null;
}

const ACCEPTED_PROPOSALS_SQL = `
SELECT form, title, hypothesis, confidence, frequency,
       type::string(updated_at) AS updated_at,
       type::string(created_at) AS created_at
FROM proposal
WHERE status = 'accepted'
ORDER BY frequency DESC
LIMIT 100;`;

export const fetchAcceptedProposals = Effect.fn("profile.fetchAcceptedProposals")(
    function* () {
        const db = yield* SurrealClient;
        const rows = yield* db
            .query<[Array<Record<string, unknown>>]>(ACCEPTED_PROPOSALS_SQL)
            .pipe(Effect.map((r) => r?.[0] ?? []));
        return rows.map((r) => ({
            form: String(r.form ?? ""),
            title: String(r.title ?? ""),
            hypothesis: String(r.hypothesis ?? ""),
            confidence: String(r.confidence ?? ""),
            frequency: Number(r.frequency ?? 0),
            updated_at: r.updated_at == null ? null : String(r.updated_at),
            created_at: r.created_at == null ? null : String(r.created_at),
        })) satisfies ProposalRow[];
    },
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/profile/queries.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/profile/queries.ts apps/axctl/src/profile/queries.test.ts
git commit -m "feat(profile): windowed stat queries for the profile renderer"
```

---

### Task 4: Taste deriver (pure)

**Files:**
- Create: `apps/axctl/src/profile/taste.ts`
- Test: `apps/axctl/src/profile/taste.test.ts`

Maps accepted `proposal` rows to `TastePattern`s. Earned confidence: proposal `confidence` strings parse to numbers (`high`→0.9, `medium`→0.7, `low`→0.5, numeric strings pass through). Category from a `form` lookup with `workflow` default. v1 derives prose patterns only - `stack-choice` derivation needs dep/import signals that don't exist yet (spec defers it; schema already supports it).

- [ ] **Step 1: Write the failing test**

```ts
// apps/axctl/src/profile/taste.test.ts
import { describe, expect, test } from "bun:test";
import { deriveTastePatterns, parseConfidence, slugify } from "./taste.ts";
import type { ProposalRow } from "./queries.ts";

const row = (over: Partial<ProposalRow>): ProposalRow => ({
    form: "guidance",
    title: "Stop edit loops early",
    hypothesis: "3+ edits to same file means requirements drift",
    confidence: "high",
    frequency: 12,
    updated_at: "2026-06-10T08:00:00Z",
    created_at: "2026-06-01T08:00:00Z",
    ...over,
});

describe("parseConfidence", () => {
    test("maps labels", () => {
        expect(parseConfidence("high")).toBe(0.9);
        expect(parseConfidence("medium")).toBe(0.7);
        expect(parseConfidence("low")).toBe(0.5);
    });
    test("numeric strings pass through clamped to [0,1]", () => {
        expect(parseConfidence("0.85")).toBe(0.85);
        expect(parseConfidence("7")).toBe(1);
    });
    test("garbage -> 0.5", () => {
        expect(parseConfidence("???")).toBe(0.5);
    });
});

describe("slugify", () => {
    test("kebab-cases titles", () => {
        expect(slugify("Stop edit loops early!")).toBe("stop-edit-loops-early");
    });
});

describe("deriveTastePatterns", () => {
    test("maps a proposal to an evidence-grounded pattern", () => {
        const [p] = deriveTastePatterns([row({})]);
        expect(p).toEqual({
            category: "workflow",
            name: "stop-edit-loops-early",
            summary: "3+ edits to same file means requirements drift",
            evidence: {
                sessions: 12,
                confidence: 0.9,
                last_reinforced: "2026-06-10",
                trend: "stable",
            },
        });
    });

    test("falls back to created_at when updated_at missing", () => {
        const [p] = deriveTastePatterns([row({ updated_at: null })]);
        expect(p!.evidence.last_reinforced).toBe("2026-06-01");
    });

    test("drops rows without hypothesis (no derived pattern without evidence/summary)", () => {
        expect(deriveTastePatterns([row({ hypothesis: "" })])).toHaveLength(0);
    });

    test("dedupes by derived name, keeping the higher-frequency row", () => {
        const out = deriveTastePatterns([
            row({ frequency: 3 }),
            row({ frequency: 9 }),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0]!.evidence.sessions).toBe(9);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/profile/taste.test.ts`
Expected: FAIL - module not found

- [ ] **Step 3: Implement**

```ts
// apps/axctl/src/profile/taste.ts
/**
 * Derive taste patterns from accepted improve proposals (the v1 taste
 * source per spec §1: "entries derive from existing ax improve proposals /
 * classifier output where present, section omitted otherwise").
 * Earned confidence: values come from real proposal records, never invented.
 * stack-choice derivation is deferred (needs dep/import signals).
 */
import type { ProposalRow } from "./queries.ts";
import type { TastePattern } from "./schema.ts";

const CONFIDENCE_LABELS: Record<string, number> = {
    high: 0.9,
    medium: 0.7,
    low: 0.5,
};

export function parseConfidence(raw: string): number {
    const label = CONFIDENCE_LABELS[raw.trim().toLowerCase()];
    if (label !== undefined) return label;
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n)) return Math.min(1, Math.max(0, n));
    return 0.5;
}

export function slugify(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

/** form -> category; deliberately small, extend as forms appear. */
const FORM_TO_CATEGORY: Record<string, TastePattern["category"]> = {
    guidance: "workflow",
    hook: "workflow",
    skill: "workflow",
    debugging: "debugging",
};

const dayOf = (iso: string): string => iso.slice(0, 10);

export function deriveTastePatterns(rows: ReadonlyArray<ProposalRow>): TastePattern[] {
    const byName = new Map<string, { row: ProposalRow; pattern: TastePattern }>();
    for (const row of rows) {
        if (row.hypothesis.trim() === "" || row.title.trim() === "") continue;
        const name = slugify(row.title);
        if (name === "") continue;
        const existing = byName.get(name);
        if (existing && existing.row.frequency >= row.frequency) continue;
        const reinforced = row.updated_at ?? row.created_at;
        byName.set(name, {
            row,
            pattern: {
                category: FORM_TO_CATEGORY[row.form] ?? "workflow",
                name,
                summary: row.hypothesis,
                evidence: {
                    sessions: row.frequency,
                    confidence: parseConfidence(row.confidence),
                    ...(reinforced ? { last_reinforced: dayOf(reinforced) } : {}),
                    trend: "stable",
                },
            },
        });
    }
    return [...byName.values()].map((v) => v.pattern);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/profile/taste.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/profile/taste.ts apps/axctl/src/profile/taste.test.ts
git commit -m "feat(profile): derive taste patterns from accepted proposals"
```

---

### Task 5: Rig assembly (pure)

**Files:**
- Create: `apps/axctl/src/profile/rig.ts`
- Test: `apps/axctl/src/profile/rig.test.ts`

Pure: takes skill invocation rows + scope map + hook file names + optional rules markdown. Skill `source`: scope `plugin:<id>` → `<id>`, `user`/`agents-shared`/`project` → `local`. Hooks: `.ts` basenames, `routing-table.json` etc. excluded by the caller's glob. Rules: count of `- ` list items in CLAUDE.md text (documented approximation; topics deferred).

- [ ] **Step 1: Write the failing test**

```ts
// apps/axctl/src/profile/rig.test.ts
import { describe, expect, test } from "bun:test";
import { countRules, deriveRig, skillSource } from "./rig.ts";

describe("skillSource", () => {
    test("plugin scope -> plugin id", () => {
        expect(skillSource("plugin:superpowers")).toBe("superpowers");
    });
    test("user/project/agents-shared -> local", () => {
        expect(skillSource("user")).toBe("local");
        expect(skillSource("project")).toBe("local");
        expect(skillSource("agents-shared")).toBe("local");
    });
    test("unknown scope passes through", () => {
        expect(skillSource("weird")).toBe("weird");
    });
});

describe("countRules", () => {
    test("counts markdown list items", () => {
        expect(countRules("# T\n- one\n- two\n  - nested\ntext\n* star")).toBe(4);
    });
    test("empty/whitespace -> 0", () => {
        expect(countRules("")).toBe(0);
    });
});

describe("deriveRig", () => {
    test("assembles skills with source, hooks, routing flag, rules", () => {
        const rig = deriveRig({
            invocations: [
                { skill: "tdd", count: 88 },
                { skill: "my-local", count: 3 },
            ],
            scopes: new Map([
                ["tdd", "plugin:superpowers"],
                ["my-local", "user"],
            ]),
            hookFiles: ["enforce-worktree.ts", "route-dispatch.ts"],
            hasRoutingTable: true,
            rulesMarkdown: "- a\n- b",
        });
        expect(rig).toEqual({
            skills: [
                { name: "tdd", source: "superpowers", runs_30d: 88 },
                { name: "my-local", source: "local", runs_30d: 3 },
            ],
            hooks: ["enforce-worktree", "route-dispatch"],
            routing_table: true,
            rules: { count: 2 },
        });
    });

    test("unknown skill scope -> local; no rules markdown -> rules omitted", () => {
        const rig = deriveRig({
            invocations: [{ skill: "ghost", count: 1 }],
            scopes: new Map(),
            hookFiles: [],
            hasRoutingTable: false,
            rulesMarkdown: null,
        });
        expect(rig.skills[0]!.source).toBe("local");
        expect(rig.rules).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/profile/rig.test.ts`
Expected: FAIL - module not found

- [ ] **Step 3: Implement**

```ts
// apps/axctl/src/profile/rig.ts
/**
 * Rig assembly: the user's installed agent setup (skills, hooks, routing
 * table, rules) from already-fetched inputs. Pure - all IO (hook dir glob,
 * CLAUDE.md read) happens at the command layer. rules.count is a documented
 * approximation: markdown list items in the global CLAUDE.md; topics are a
 * v2 classifier job (spec §1).
 */
import type { SkillInvocationRow } from "./queries.ts";

export function skillSource(scope: string): string {
    if (scope.startsWith("plugin:")) return scope.slice("plugin:".length);
    if (scope === "user" || scope === "project" || scope === "agents-shared") return "local";
    return scope;
}

export function countRules(markdown: string): number {
    return markdown.split("\n").filter((line) => /^\s*[-*]\s+\S/.test(line)).length;
}

export interface RigInputs {
    readonly invocations: ReadonlyArray<SkillInvocationRow>;
    readonly scopes: ReadonlyMap<string, string>;
    readonly hookFiles: ReadonlyArray<string>;
    readonly hasRoutingTable: boolean;
    readonly rulesMarkdown: string | null;
}

export interface Rig {
    readonly skills: ReadonlyArray<{ name: string; source: string; runs_30d: number }>;
    readonly hooks: ReadonlyArray<string>;
    readonly routing_table: boolean;
    readonly rules?: { readonly count: number };
}

export function deriveRig(inputs: RigInputs): Rig {
    const skills = inputs.invocations.map((row) => ({
        name: row.skill,
        source: skillSource(inputs.scopes.get(row.skill) ?? "user"),
        runs_30d: row.count,
    }));
    const hooks = inputs.hookFiles
        .filter((f) => f.endsWith(".ts"))
        .map((f) => f.replace(/\.ts$/, ""))
        .sort();
    const rulesCount = inputs.rulesMarkdown === null ? 0 : countRules(inputs.rulesMarkdown);
    return {
        skills,
        hooks,
        routing_table: inputs.hasRoutingTable,
        ...(inputs.rulesMarkdown !== null && rulesCount > 0 ? { rules: { count: rulesCount } } : {}),
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/profile/rig.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/profile/rig.ts apps/axctl/src/profile/rig.test.ts
git commit -m "feat(profile): pure rig assembly (skills/hooks/routing/rules)"
```

---

### Task 6: `buildProfile` orchestrator

**Files:**
- Create: `apps/axctl/src/profile/render.ts`
- Test: `apps/axctl/src/profile/render.test.ts`
- Reference: `apps/axctl/src/queries/cost-analytics.ts` (`fetchCostModels`)

Composes the queries (Task 3) + `fetchCostModels` + pure derivers (Tasks 2/4/5) into a decoded `ProfileV1`. Environment inputs (github login, today, hook files, rules text, routing-table existence) are injected as a plain argument - IO stays in the command (Task 7).

- [ ] **Step 1: Write the failing test**

```ts
// apps/axctl/src/profile/render.test.ts
import { describe, expect, test } from "bun:test";
import { makeMockDb, runWithMock } from "@ax/lib/testing/surreal";
import { buildProfile } from "./render.ts";

// Mock result order MUST match the query order in buildProfile:
// 1 tokenTotals  2 dailyActivity  3 harnesses  4 skillInvocations
// 5 skillScopes  6 acceptedProposals  7 costModels
const mockResults = [
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
];

const env = {
    github: "necmttn",
    generatedAt: "2026-06-12T19:00:00Z",
    today: "2026-06-12",
    hookFiles: ["enforce-worktree.ts"],
    hasRoutingTable: true,
    rulesMarkdown: "- rule one\n- rule two",
};

describe("buildProfile", () => {
    test("assembles a valid ProfileV1", async () => {
        const db = makeMockDb(mockResults);
        const p = await runWithMock(db, buildProfile({ windowDays: 30, includeCost: true, env }));

        expect(p.v).toBe(1);
        expect(p.github).toBe("necmttn");
        expect(p.window_days).toBe(30);
        expect(p.stats.sessions).toBe(142);
        expect(p.stats.tokens.total).toBe(38_000_000);
        expect(p.stats.streak_days).toBe(2);
        expect(p.stats.cost_usd).toBe(200);
        expect(p.stats.models).toEqual([
            { name: "fable", share: 0.75, cost_usd: 150 },
            { name: "haiku", share: 0.25, cost_usd: 50 },
        ]);
        expect(p.stats.harnesses).toEqual(["claude", "codex"]);
        expect(p.rig.skills).toEqual([{ name: "tdd", source: "superpowers", runs_30d: 88 }]);
        expect(p.rig.rules).toEqual({ count: 2 });
        expect(p.taste!.patterns[0]!.name).toBe("stop-edit-loops-early");
    });

    test("includeCost=false strips cost everywhere; share falls back to sessions", async () => {
        const db = makeMockDb(mockResults);
        const p = await runWithMock(db, buildProfile({ windowDays: 30, includeCost: false, env }));
        expect(p.stats.cost_usd).toBeUndefined();
        expect(p.stats.models[0]).toEqual({ name: "fable", share: 100 / 142 });
    });

    test("no proposals -> taste omitted", async () => {
        const noProposals = mockResults.map((r, i) => (i === 5 ? [[]] : r));
        const db = makeMockDb(noProposals);
        const p = await runWithMock(db, buildProfile({ windowDays: 30, includeCost: true, env }));
        expect(p.taste).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/profile/render.test.ts`
Expected: FAIL - module not found

- [ ] **Step 3: Implement**

```ts
// apps/axctl/src/profile/render.ts
/**
 * buildProfile - compose windowed queries + pure derivers into a decoded
 * ProfileV1. Privacy invariants live HERE, not at the edge: cost only when
 * includeCost; aggregates only (nothing in this module touches transcript
 * content, project names, or paths). Environment (github login, today,
 * hook files, rules text) is injected so the Effect needs only SurrealClient.
 */
import { Effect } from "effect";
import { fetchCostModels } from "../queries/cost-analytics.ts";
import {
    fetchAcceptedProposals,
    fetchDailyActivity,
    fetchHarnesses,
    fetchSkillInvocations,
    fetchSkillScopes,
    fetchTokenTotals,
} from "./queries.ts";
import { deriveRig } from "./rig.ts";
import { computeStreak } from "./streak.ts";
import { deriveTastePatterns } from "./taste.ts";
import { decodeProfile, type ProfileV1 } from "./schema.ts";

export interface ProfileEnv {
    readonly github: string;
    readonly generatedAt: string;
    readonly today: string;
    readonly hookFiles: ReadonlyArray<string>;
    readonly hasRoutingTable: boolean;
    readonly rulesMarkdown: string | null;
}

export const buildProfile = Effect.fn("profile.buildProfile")(
    function* (opts: {
        readonly windowDays: number;
        readonly includeCost: boolean;
        readonly env: ProfileEnv;
    }) {
        const { windowDays, includeCost, env } = opts;

        // Sequential on purpose: makeMockDb replays results in call order,
        // and the local DB answers these in milliseconds anyway.
        const totals = yield* fetchTokenTotals({ windowDays });
        const daily = yield* fetchDailyActivity({ windowDays });
        const harnesses = yield* fetchHarnesses({ windowDays });
        const invocations = yield* fetchSkillInvocations({ windowDays });
        const scopes = yield* fetchSkillScopes();
        const proposals = yield* fetchAcceptedProposals();
        const cost = yield* fetchCostModels({ sinceDays: windowDays });

        const streak = computeStreak(daily, env.today);

        const totalSessions = cost.rows.reduce((s, r) => s + r.sessions, 0);
        const models = cost.rows.map((r) => {
            const share = includeCost
                ? cost.total_cost_usd > 0 ? r.cost_usd / cost.total_cost_usd : 0
                : totalSessions > 0 ? r.sessions / totalSessions : 0;
            return {
                name: r.model,
                share,
                ...(includeCost ? { cost_usd: r.cost_usd } : {}),
            };
        });

        const patterns = deriveTastePatterns(proposals);

        const profile: ProfileV1 = decodeProfile({
            v: 1,
            github: env.github,
            generated_at: env.generatedAt,
            window_days: windowDays,
            stats: {
                sessions: totals.sessions,
                active_days: streak.active_days,
                streak_days: streak.streak_days,
                tokens: {
                    prompt: totals.prompt_tokens,
                    completion: totals.completion_tokens,
                    total: totals.prompt_tokens + totals.completion_tokens,
                },
                ...(includeCost ? { cost_usd: cost.total_cost_usd } : {}),
                models,
                harnesses,
            },
            rig: deriveRig({
                invocations,
                scopes,
                hookFiles: env.hookFiles,
                hasRoutingTable: env.hasRoutingTable,
                rulesMarkdown: env.rulesMarkdown,
            }),
            ...(patterns.length > 0 ? { taste: { patterns } } : {}),
        });
        return profile;
    },
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/profile/render.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the whole profile suite + typecheck, commit**

```bash
bun test apps/axctl/src/profile/
bun run typecheck
git add apps/axctl/src/profile/render.ts apps/axctl/src/profile/render.test.ts
git commit -m "feat(profile): buildProfile orchestrator composing queries and derivers"
```

---

### Task 7: `ax profile show` command + registration

**Files:**
- Create: `apps/axctl/src/cli/commands/profile.ts`
- Modify: `apps/axctl/src/cli/index.ts` (three spots: import, `RUNTIME_BY_COMMAND`, `registeredCommands`)
- Reference: `apps/axctl/src/cli/commands/ax-cost.ts` (the pattern), `apps/axctl/src/cli/commands/shared.ts` (`jsonFlag`, `fail`)

- [ ] **Step 1: Check the registration gate test**

Read `apps/axctl/src/cli/effect-cli.test.ts` for what it asserts about `RUNTIME_BY_COMMAND` / registered commands, so Step 4's wiring satisfies it. Also read `apps/axctl/src/cli/commands/shared.ts` to confirm `jsonFlag` and `fail` signatures match usage below.

- [ ] **Step 2: Write the command**

```ts
// apps/axctl/src/cli/commands/profile.ts
/**
 * `ax profile show` - render the local profile (ProfileV1) from the graph.
 * Local-only preview; publish (gist + fork registration) lands in a later
 * plan. Mirrors the commands/ax-cost.ts pattern: read-only, `db` runtime.
 */
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { prettyPrint } from "@ax/lib/json";
import { buildProfile, type ProfileEnv } from "../../profile/render.ts";
import type { ProfileV1 } from "../../profile/schema.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { fail, jsonFlag } from "./shared.ts";

// ---------------------------------------------------------------------------
// Environment gathering (the only IO in this file)
// ---------------------------------------------------------------------------

const HOOKS_DIR = `${process.env.HOME}/.ax/hooks`;
const RULES_FILE = `${process.env.HOME}/.claude/CLAUDE.md`;
const ROUTING_TABLE = `${process.env.HOME}/.ax/hooks/routing-table.json`;

/** GitHub login via `gh api user`; falls back to $USER with a notice. */
const resolveGithubLogin = Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
        try: async () => {
            const proc = Bun.spawn(["gh", "api", "user", "--jq", ".login"], {
                stdout: "pipe",
                stderr: "ignore",
            });
            const out = await new Response(proc.stdout).text();
            return (await proc.exited) === 0 ? out.trim() : null;
        },
        catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null));
    if (result && result !== "") return result;
    return process.env.USER ?? "unknown";
});

const gatherEnv = Effect.gen(function* () {
    const hookFiles = yield* Effect.tryPromise({
        try: () => Array.fromAsync(new Bun.Glob("*.ts").scan({ cwd: HOOKS_DIR })),
        catch: () => [] as string[],
    }).pipe(Effect.orElseSucceed(() => [] as string[]));

    const rulesMarkdown = yield* Effect.tryPromise({
        try: async () => {
            const file = Bun.file(RULES_FILE);
            return (await file.exists()) ? await file.text() : null;
        },
        catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null));

    const hasRoutingTable = yield* Effect.tryPromise({
        try: () => Bun.file(ROUTING_TABLE).exists(),
        catch: () => false,
    }).pipe(Effect.orElseSucceed(() => false));

    const github = yield* resolveGithubLogin;
    const now = new Date();
    return {
        github,
        generatedAt: now.toISOString(),
        today: now.toISOString().slice(0, 10),
        hookFiles,
        hasRoutingTable,
        rulesMarkdown,
    } satisfies ProfileEnv;
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const integer = (n: number): string =>
    Number.isFinite(n) ? Math.trunc(n).toLocaleString("en-US") : "0";

export function formatProfile(p: ProfileV1): string {
    const lines: string[] = [];
    lines.push(`ax profile - @${p.github}  (last ${p.window_days}d)`);
    lines.push("");
    const cost = p.stats.cost_usd !== undefined ? `  ·  $${p.stats.cost_usd.toFixed(2)} est` : "";
    lines.push(
        `${integer(p.stats.sessions)} sessions  ·  ${integer(p.stats.tokens.total)} tokens${cost}`,
    );
    lines.push(
        `${p.stats.active_days} active days  ·  ${p.stats.streak_days}-day streak  ·  harnesses: ${p.stats.harnesses.join(", ")}`,
    );
    lines.push("");
    lines.push("models:");
    for (const m of p.stats.models) {
        const c = m.cost_usd !== undefined ? `  $${m.cost_usd.toFixed(2)}` : "";
        lines.push(`  ${m.name.padEnd(28)} ${(m.share * 100).toFixed(0).padStart(3)}%${c}`);
    }
    lines.push("");
    lines.push(`rig: ${p.rig.skills.length} skills · ${p.rig.hooks.length} hooks · routing_table: ${p.rig.routing_table}${p.rig.rules ? ` · ${p.rig.rules.count} rules` : ""}`);
    for (const s of p.rig.skills.slice(0, 10)) {
        lines.push(`  ${s.name.padEnd(28)} ${integer(s.runs_30d).padStart(6)} runs  (${s.source})`);
    }
    if (p.taste) {
        lines.push("");
        lines.push(`taste: ${p.taste.patterns.length} patterns`);
        for (const t of p.taste.patterns.slice(0, 10)) {
            const label = t.category === "stack-choice"
                ? `${t.slot}: ${t.name}`
                : `${t.category}/${t.name}`;
            lines.push(`  ${label}  (confidence ${t.evidence.confidence}, ${t.evidence.sessions} sessions)`);
        }
    }
    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// ax profile show [--window=30] [--no-cost] [--json]
// ---------------------------------------------------------------------------

const profileShowCommand = Command.make(
    "show",
    {
        window: Flag.integer("window").pipe(Flag.withDefault(30)),
        noCost: Flag.boolean("no-cost").pipe(Flag.withDefault(false)),
        json: jsonFlag,
    },
    ({ window, noCost, json }) => {
        if (!Number.isInteger(window) || window <= 0) {
            fail(`ax profile show: --window must be a positive integer (got "${window}")`);
        }
        return Effect.gen(function* () {
            const env = yield* gatherEnv;
            const profile = yield* buildProfile({
                windowDays: window,
                includeCost: !noCost,
                env,
            });
            console.log(json ? prettyPrint(profile) : formatProfile(profile));
        });
    },
).pipe(
    Command.withDescription(
        "Render your local ax profile (stats + rig + taste). " +
        "--window=N days (default 30)  --no-cost  --json",
    ),
);

export const profileCommand = Command.make("profile").pipe(
    Command.withDescription(
        "Your ax profile: stats, rig, and taste rendered from the local graph",
    ),
    Command.withSubcommands([profileShowCommand]),
);

export const axProfileRuntime: RuntimeManifest = {
    profile: "db",
};
```

NOTE: confirm `Flag.boolean` exists in `effect/unstable/cli` (check how other commands define boolean flags, e.g. `jsonFlag` in `shared.ts`) - mirror whatever `jsonFlag` does for `--no-cost`.

- [ ] **Step 3: Register in `apps/axctl/src/cli/index.ts`**

Three edits, mirroring how `ax-cost.ts` is wired (`index.ts:18`, `:76`, `:112`):

```ts
// with the other command imports (near line 18):
import { profileCommand, axProfileRuntime } from "./commands/profile.ts";

// inside RUNTIME_BY_COMMAND (near line 76):
    ...axProfileRuntime,

// inside registeredCommands (near line 112, in the common-verbs block):
    profileCommand,
```

- [ ] **Step 4: Run the CLI gate test**

Run: `bun test apps/axctl/src/cli/effect-cli.test.ts`
Expected: PASS - registration complete in both places. If it fails, read the assertion message; it names the missing manifest entry.

- [ ] **Step 5: Smoke-test against the real DB**

```bash
bun apps/axctl/src/cli/index.ts profile show
bun apps/axctl/src/cli/index.ts profile show --json | head -40
bun apps/axctl/src/cli/index.ts profile show --no-cost --window=7
```

Expected: human-readable profile with real numbers; `--json` output decodes (it already passed through `decodeProfile`); `--no-cost` output contains no `$`.

- [ ] **Step 6: Full check + commit**

```bash
bun test apps/axctl/src/profile/ apps/axctl/src/cli/effect-cli.test.ts
bun run typecheck
git add apps/axctl/src/cli/commands/profile.ts apps/axctl/src/cli/index.ts
git commit -m "feat(cli): ax profile show - local profile renderer"
```

---

### Task 8: Document the command

**Files:**
- Modify: `CLAUDE.md` (repo root - command list section)

- [ ] **Step 1: Add a section after "Cost analytics"**

```markdown
### Profile

`ax profile show [--window=N] [--no-cost] [--json]` - render your local ax
profile (ProfileV1: stats + rig + taste patterns) from the graph. Local-only
preview; publish/gist/leaderboard land in later plans
(docs/superpowers/specs/2026-06-12-ax-profiles-design.md).
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: ax profile show in command reference"
```

---

## Self-review (run after writing, before handoff)

1. **Spec coverage (Plan-1 slice only):** schema §1 incl. taste union + stack-choice + rig.rules → Task 1; streak (UTC decision) → Task 2; queries → Task 3; earned-confidence taste derivation → Task 4; rig → Task 5; privacy invariants (cost toggle, aggregates-only) → Task 6; `ax profile show` → Task 7. Publish/unpublish/contribute, repo CI, site = Plans 2–4 by design.
2. **Placeholder scan:** no TBDs; the two NOTE blocks are explicit verify-against-reality instructions (v4 beta API names), each with a concrete place to look.
3. **Type consistency:** `ProfileEnv` fields match between render.ts and profile.ts; `SkillInvocationRow` shared via queries.ts; `decodeProfile` is the single decode entry; mock result order documented in render.test.ts matches buildProfile's query order.
