# ax dojo (core loop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `ax dojo` (budget envelope + prioritized agenda CLI) and the `ax:dojo` installable skill (thin loop driver), per the approved spec `docs/superpowers/specs/2026-06-13-ax-dojo-design.md`.

**Architecture:** New `apps/axctl/src/dojo/` module. Pure, fully-tested core (budget math, brief classification, item mapping, agenda assembly, rendering) + thin Effect glue that calls existing exported queries (`listProposals`, `fetchSessionChurnSummary`, `fetchTuneProposals`, quota's `getQuota`). One new CLI command (`runtime: db`), one new SKILL.md in `skills/dojo/`.

**Tech Stack:** bun ≥1.3, TypeScript strict, Effect v4 beta (`effect/unstable/cli` Command/Flag), bun:test, SurrealDB via existing `SurrealClient` service.

**Scope decomposition (from spec):** This plan = core loop only. Deferred to follow-up plans: (a) hook latency ledger (`ax hooks bench` / backtest timing), (b) sparring mechanism (`--spar` executes; this plan only emits the agenda item + skill playbook text), (c) MCP `dojo_agenda` tool, (d) cron/launchd trigger.

**Conventions for the engineer:**
- Run all commands from the repo root (`/Users/necmttn/Projects/ax/.claude/worktrees/ax-dojo-spec` if executing in the spec worktree; otherwise your own worktree off main with the spec commits).
- Test runner is **bun:test** (`bun test <path>`). A global hook may block bare `bun test` invocations; if so, wrap in a tmp script (see memory: project uses bun:test).
- Mirror import paths from neighboring files when in doubt - e.g. the exact `SurrealClient`/`DbError` imports used by `apps/axctl/src/improve/list.ts`, and the query-helper style used by `apps/axctl/src/improve/actions.ts:534`.
- Em-dashes in repo docs get normalized to `-` by tooling; don't fight it.

---

## File structure

```
apps/axctl/src/dojo/
├── schema.ts          # DojoItem, BudgetEnvelope, DojoAgenda types + KIND_PRIORITY
├── budget.ts          # computeBudgetEnvelope (pure)
├── budget.test.ts
├── briefs.ts          # classifyBriefFile (pure) + scanTaskDir (FileSystem glue)
├── briefs.test.ts
├── items.ts           # pure row→DojoItem mappers for every DB source
├── items.test.ts
├── agenda.ts          # assembleAgenda (pure) + collectAgenda (Effect glue)
├── agenda.test.ts
├── format.ts          # renderAgenda (pure)
├── format.test.ts
└── paths.ts           # dojo state dirs (~/.ax/dojo/{outbox,reports})
    paths.test.ts
apps/axctl/src/improve/verdict-pending.ts   # listPendingVerdicts query (+ test)
apps/axctl/src/cli/commands/dojo.ts          # CLI command + RuntimeManifest
apps/axctl/src/cli/index.ts                  # register (modify)
skills/dojo/SKILL.md                         # the ax:dojo skill
docs/cli.md, apps/site/public/llms.txt, CLAUDE.md, README.md  # docs gate
```

---

### Task 1: dojo schema + kind priority

**Files:**
- Create: `apps/axctl/src/dojo/schema.ts`
- Test: `apps/axctl/src/dojo/schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/axctl/src/dojo/schema.test.ts
import { describe, expect, test } from "bun:test";
import { compareByPriority, KIND_PRIORITY } from "./schema.ts";

describe("KIND_PRIORITY", () => {
    test("orders kinds per spec (cheap + high-signal first)", () => {
        expect(KIND_PRIORITY).toEqual([
            "verdict_pending",
            "brief_unfilled",
            "routing_backtest",
            "proposal_mint",
            "experiment",
            "upstream_draft",
            "spar",
            "explore",
        ]);
    });

    test("compareByPriority sorts items by kind order, stable within kind", () => {
        const items = [
            { id: "b", kind: "experiment" },
            { id: "a", kind: "verdict_pending" },
            { id: "c", kind: "verdict_pending" },
        ] as const;
        const sorted = [...items].sort(compareByPriority);
        expect(sorted.map((i) => i.id)).toEqual(["a", "c", "b"]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/dojo/schema.test.ts`
Expected: FAIL - `Cannot find module './schema.ts'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/axctl/src/dojo/schema.ts
/**
 * ax dojo - agenda types. Spec: docs/superpowers/specs/2026-06-13-ax-dojo-design.md
 */

export type DojoCostClass = "s" | "m" | "l" | "xl";

export type DojoItemKind =
    | "verdict_pending"
    | "brief_unfilled"
    | "routing_backtest"
    | "proposal_mint"
    | "experiment"
    | "upstream_draft"
    | "spar"
    | "explore";

export const KIND_PRIORITY: readonly DojoItemKind[] = [
    "verdict_pending",
    "brief_unfilled",
    "routing_backtest",
    "proposal_mint",
    "experiment",
    "upstream_draft",
    "spar",
    "explore",
];

export interface DojoItem {
    readonly id: string;
    readonly kind: DojoItemKind;
    readonly title: string;
    /** exact CLI invocations the executing agent runs for this item */
    readonly commands: readonly string[];
    /** observable completion criterion - what makes this item vanish from the next agenda */
    readonly success: string;
    readonly cost_class: DojoCostClass;
}

export type BindingWindow = "five_hour" | "seven_day";

export interface BudgetEnvelope {
    readonly has_surplus: boolean;
    /** spendable percentage points of the binding window after reserve */
    readonly spendable_pct: number;
    readonly binding_window: BindingWindow | null;
    readonly window_remaining_pct: number;
    readonly reserve_pct: number;
    /** ISO datetime - earliest window reset, or the --until override */
    readonly deadline: string;
    readonly source: "quota" | "override" | "forced" | "unavailable";
}

export interface DojoAgenda {
    readonly v: 1;
    readonly generated_at: string;
    readonly budget: BudgetEnvelope;
    readonly items: readonly DojoItem[];
}

export const compareByPriority = (
    a: Pick<DojoItem, "kind">,
    b: Pick<DojoItem, "kind">,
): number => KIND_PRIORITY.indexOf(a.kind) - KIND_PRIORITY.indexOf(b.kind);
```

Note: `Array.prototype.sort` is stable in Bun/V8, which the test relies on.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/dojo/schema.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/dojo/schema.ts apps/axctl/src/dojo/schema.test.ts
git commit -m "feat(dojo): agenda schema + kind priority"
```

---

### Task 2: budget envelope (pure)

**Files:**
- Create: `apps/axctl/src/dojo/budget.ts`
- Test: `apps/axctl/src/dojo/budget.test.ts`

The quota snapshot shape comes from `apps/axctl/src/quota/schema.ts`: `QuotaSnapshot` with nullable `five_hour` / `seven_day` windows, each `{ utilization: number; resets_at: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/axctl/src/dojo/budget.test.ts
import { describe, expect, test } from "bun:test";
import type { QuotaSnapshot } from "../quota/schema.ts";
import { computeBudgetEnvelope } from "./budget.ts";

const NOW_MS = Date.parse("2026-06-13T10:00:00.000Z");

const snapshot = (fiveHourUtil: number, sevenDayUtil: number): QuotaSnapshot => ({
    v: 1,
    fetched_at: "2026-06-13T09:59:00.000Z",
    five_hour: { utilization: fiveHourUtil, resets_at: "2026-06-13T12:00:00.000Z" },
    seven_day: { utilization: sevenDayUtil, resets_at: "2026-06-15T00:00:00.000Z" },
    seven_day_opus: null,
    seven_day_sonnet: null,
    extra_usage: null,
});

describe("computeBudgetEnvelope", () => {
    test("binding window is the one with least remaining; reserve subtracted", () => {
        const env = computeBudgetEnvelope(snapshot(40, 70), {}, NOW_MS);
        expect(env.binding_window).toBe("seven_day");
        expect(env.window_remaining_pct).toBe(30);
        expect(env.reserve_pct).toBe(15);
        expect(env.spendable_pct).toBe(15);
        expect(env.has_surplus).toBe(true);
        expect(env.deadline).toBe("2026-06-13T12:00:00.000Z"); // earliest reset
        expect(env.source).toBe("quota");
    });

    test("no surplus when remaining <= reserve", () => {
        const env = computeBudgetEnvelope(snapshot(95, 50), {}, NOW_MS);
        expect(env.binding_window).toBe("five_hour");
        expect(env.spendable_pct).toBe(0);
        expect(env.has_surplus).toBe(false);
    });

    test("--budget override caps spendable but never exceeds remaining", () => {
        const env = computeBudgetEnvelope(snapshot(40, 70), { budgetPctOverride: 50 }, NOW_MS);
        expect(env.spendable_pct).toBe(30); // min(50, remaining 30)
        expect(env.source).toBe("override");
    });

    test("--until override replaces the deadline", () => {
        const env = computeBudgetEnvelope(
            snapshot(40, 70),
            { untilIso: "2026-06-13T11:30:00.000Z" },
            NOW_MS,
        );
        expect(env.deadline).toBe("2026-06-13T11:30:00.000Z");
    });

    test("force grants a floor budget when there is no surplus", () => {
        const env = computeBudgetEnvelope(snapshot(99, 99), { force: true }, NOW_MS);
        expect(env.has_surplus).toBe(true);
        expect(env.spendable_pct).toBe(1); // whatever actually remains
        expect(env.source).toBe("forced");
    });

    test("null snapshot (no token / fetch failed): unavailable, no surplus unless forced", () => {
        const env = computeBudgetEnvelope(null, {}, NOW_MS);
        expect(env.has_surplus).toBe(false);
        expect(env.source).toBe("unavailable");
        expect(env.binding_window).toBeNull();
        const forced = computeBudgetEnvelope(null, { force: true }, NOW_MS);
        expect(forced.has_surplus).toBe(true);
        expect(forced.source).toBe("forced");
    });

    test("missing windows are skipped; lone five_hour window binds", () => {
        const snap: QuotaSnapshot = { ...snapshot(80, 0), seven_day: null };
        const env = computeBudgetEnvelope(snap, {}, NOW_MS);
        expect(env.binding_window).toBe("five_hour");
        expect(env.window_remaining_pct).toBe(20);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/dojo/budget.test.ts`
Expected: FAIL - `Cannot find module './budget.ts'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/axctl/src/dojo/budget.ts
import type { QuotaSnapshot } from "../quota/schema.ts";
import type { BindingWindow, BudgetEnvelope } from "./schema.ts";

export const DEFAULT_RESERVE_PCT = 15;

export interface BudgetOptions {
    /** keep this many percentage points untouched (default 15) */
    readonly reservePct?: number;
    /** --budget=N : spend at most N points, replaces reserve math */
    readonly budgetPctOverride?: number | null;
    /** --until resolved to ISO by the CLI layer */
    readonly untilIso?: string | null;
    /** --force : dojo with no surplus */
    readonly force?: boolean;
}

export const computeBudgetEnvelope = (
    snapshot: QuotaSnapshot | null,
    opts: BudgetOptions,
    nowMs: number,
): BudgetEnvelope => {
    const reserve = opts.reservePct ?? DEFAULT_RESERVE_PCT;

    const windows: Array<{ name: BindingWindow; remaining: number; resetsAt: string }> = [];
    if (snapshot?.five_hour) {
        windows.push({
            name: "five_hour",
            remaining: Math.max(0, 100 - snapshot.five_hour.utilization),
            resetsAt: snapshot.five_hour.resets_at,
        });
    }
    if (snapshot?.seven_day) {
        windows.push({
            name: "seven_day",
            remaining: Math.max(0, 100 - snapshot.seven_day.utilization),
            resetsAt: snapshot.seven_day.resets_at,
        });
    }

    if (windows.length === 0) {
        return {
            has_surplus: opts.force === true,
            spendable_pct: 0,
            binding_window: null,
            window_remaining_pct: 0,
            reserve_pct: reserve,
            deadline: opts.untilIso ?? new Date(nowMs).toISOString(),
            source: opts.force === true ? "forced" : "unavailable",
        };
    }

    const binding = windows.reduce((min, w) => (w.remaining < min.remaining ? w : min));
    const earliestReset = windows.reduce((min, w) =>
        Date.parse(w.resetsAt) < Date.parse(min.resetsAt) ? w : min,
    ).resetsAt;

    const fromReserve = Math.max(0, binding.remaining - reserve);
    const overridden = opts.budgetPctOverride != null
        ? Math.min(opts.budgetPctOverride, binding.remaining)
        : null;
    let spendable = overridden ?? fromReserve;
    let source: BudgetEnvelope["source"] = overridden != null ? "override" : "quota";

    if (spendable <= 0 && opts.force === true) {
        spendable = Math.max(1, binding.remaining);
        source = "forced";
    }

    return {
        has_surplus: spendable > 0,
        spendable_pct: spendable,
        binding_window: binding.name,
        window_remaining_pct: binding.remaining,
        reserve_pct: reserve,
        deadline: opts.untilIso ?? earliestReset,
        source,
    };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/dojo/budget.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/dojo/budget.ts apps/axctl/src/dojo/budget.test.ts
git commit -m "feat(dojo): budget envelope from quota snapshot"
```

---

### Task 3: dojo state paths

**Files:**
- Create: `apps/axctl/src/dojo/paths.ts`
- Test: `apps/axctl/src/dojo/paths.test.ts`

Follow the parameterized-base pattern of `packages/lib/src/runtime-state.ts:28` (default from env/home, injectable for tests). Dojo state lives in `~/.ax/dojo/` (same family as `~/.ax/quota-cache.json` and `~/.ax/hooks/`).

- [ ] **Step 1: Write the failing test**

```ts
// apps/axctl/src/dojo/paths.test.ts
import { describe, expect, test } from "bun:test";
import { dojoOutboxDir, dojoReportPath, dojoReportsDir } from "./paths.ts";

describe("dojo paths", () => {
    test("derive from an injectable base dir", () => {
        expect(dojoOutboxDir("/tmp/axhome/.ax/dojo")).toBe("/tmp/axhome/.ax/dojo/outbox");
        expect(dojoReportsDir("/tmp/axhome/.ax/dojo")).toBe("/tmp/axhome/.ax/dojo/reports");
        expect(dojoReportPath("2026-06-13", "/tmp/axhome/.ax/dojo")).toBe(
            "/tmp/axhome/.ax/dojo/reports/2026-06-13.md",
        );
    });

    test("default base ends with /.ax/dojo", () => {
        expect(dojoOutboxDir()).toMatch(/\/\.ax\/dojo\/outbox$/);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/dojo/paths.test.ts`
Expected: FAIL - `Cannot find module './paths.ts'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/axctl/src/dojo/paths.ts
import { homedir } from "node:os";
import * as path from "node:path";

export const defaultDojoDir = (): string => path.join(homedir(), ".ax", "dojo");

export const dojoOutboxDir = (base: string = defaultDojoDir()): string =>
    path.join(base, "outbox");

export const dojoReportsDir = (base: string = defaultDojoDir()): string =>
    path.join(base, "reports");

/** date is YYYY-MM-DD */
export const dojoReportPath = (date: string, base: string = defaultDojoDir()): string =>
    path.join(dojoReportsDir(base), `${date}.md`);
```

NOTE: if the repo's `check:no-node-fs` gate complains about `node:os`/`node:path` in this location, mirror how `apps/axctl/src/quota/cache.ts:13` (`defaultQuotaCachePath`) builds `~/.ax/...` paths and follow that exact import style instead.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/dojo/paths.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/dojo/paths.ts apps/axctl/src/dojo/paths.test.ts
git commit -m "feat(dojo): state dir path helpers (~/.ax/dojo)"
```

---

### Task 4: brief classification (pure) + task-dir scan

**Files:**
- Create: `apps/axctl/src/dojo/briefs.ts`
- Test: `apps/axctl/src/dojo/briefs.test.ts`

Brief conventions (verified in repo):
- `classify-*.md` (skills classify) - *unfilled* while frontmatter `primary_role:` is empty/absent (`apps/axctl/src/cli/skills-lint.ts:73`); filled briefs are consumed+deleted by `ax skills lint`.
- `routing-tune-*.md` - present until `ax routing tune --apply=...` consumes the decision; presence = open item.
- anything else (`<dedupe_sig>.md` from `ax improve accept`) - presence = un-reconciled scaffold; `ax improve lint` deletes it when the marker lands.

- [ ] **Step 1: Write the failing test**

```ts
// apps/axctl/src/dojo/briefs.test.ts
import { describe, expect, test } from "bun:test";
import { classifyBriefFile } from "./briefs.ts";

describe("classifyBriefFile", () => {
    test("classify brief without primary_role is an unfilled item", () => {
        const item = classifyBriefFile("classify-superpowers__tdd.md", "---\nax_classify: superpowers:tdd\nprimary_role:\n---\n");
        expect(item).not.toBeNull();
        expect(item?.kind).toBe("brief_unfilled");
        expect(item?.id).toBe("brief:classify-superpowers__tdd.md");
        expect(item?.commands).toEqual([
            "$EDITOR .ax/tasks/classify-superpowers__tdd.md  # fill primary_role + rationale",
            "ax skills lint",
        ]);
    });

    test("classify brief WITH primary_role filled returns null (nothing to do)", () => {
        const item = classifyBriefFile(
            "classify-superpowers__tdd.md",
            "---\nax_classify: superpowers:tdd\nprimary_role: verifier\n---\n",
        );
        expect(item).toBeNull();
    });

    test("routing-tune brief is an open routing_backtest item", () => {
        const item = classifyBriefFile("routing-tune-2026-06-10.md", "| id | pattern |\n");
        expect(item?.kind).toBe("routing_backtest");
        expect(item?.commands).toContain("ax routing tune --apply=<ids from brief> --days=30");
    });

    test("improve accept brief is an unfilled item pointing at improve lint", () => {
        const item = classifyBriefFile("a1b2c3d4.md", "---\nax_id: a1b2c3d4\n---\n");
        expect(item?.kind).toBe("brief_unfilled");
        expect(item?.commands).toEqual([
            "$EDITOR .ax/tasks/a1b2c3d4.md  # act on the brief in the target files",
            "ax improve lint",
        ]);
    });

    test("non-markdown files return null", () => {
        expect(classifyBriefFile(".DS_Store", "")).toBeNull();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/dojo/briefs.test.ts`
Expected: FAIL - `Cannot find module './briefs.ts'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/axctl/src/dojo/briefs.ts
import * as path from "node:path";
import { Effect } from "effect";
import { FileSystem } from "effect/platform/FileSystem";
import type { DojoItem } from "./schema.ts";

const FILLED_PRIMARY_ROLE = /^primary_role:\s*\S+/m;

/** Pure: filename + content -> open agenda item, or null when nothing to do. */
export const classifyBriefFile = (name: string, content: string): DojoItem | null => {
    if (!name.endsWith(".md")) return null;
    if (name.startsWith("classify-")) {
        if (FILLED_PRIMARY_ROLE.test(content)) return null; // filled, skills lint will sweep it
        return {
            id: `brief:${name}`,
            kind: "brief_unfilled",
            title: `Fill skills-classify brief ${name}`,
            commands: [
                `$EDITOR .ax/tasks/${name}  # fill primary_role + rationale`,
                "ax skills lint",
            ],
            success: "brief consumed by ax skills lint (file deleted, plays_role edges written)",
            cost_class: "s",
        };
    }
    if (name.startsWith("routing-tune-")) {
        return {
            id: `brief:${name}`,
            kind: "routing_backtest",
            title: `Backtest + apply routing-tune brief ${name}`,
            commands: [
                `$EDITOR .ax/tasks/${name}  # review judgment-flagged classes, backtest vs history`,
                "ax routing tune --apply=<ids from brief> --days=30",
            ],
            success: "selected classes applied to ~/.ax/hooks/routing-table.json; brief resolved",
            cost_class: "m",
        };
    }
    return {
        id: `brief:${name}`,
        kind: "brief_unfilled",
        title: `Act on improve brief ${name}`,
        commands: [
            `$EDITOR .ax/tasks/${name}  # act on the brief in the target files`,
            "ax improve lint",
        ],
        success: "marker landed in target file; ax improve lint deletes the brief",
        cost_class: "m",
    };
};

/** Effect glue: scan the task dir (AX_TASK_DIR ?? $PWD/.ax/tasks) into items. */
export const scanTaskDir = (
    taskDir: string,
): Effect.Effect<DojoItem[], never, FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem;
        const exists = yield* fs.exists(taskDir).pipe(Effect.orElseSucceed(() => false));
        if (!exists) return [];
        const names = yield* fs.readDirectory(taskDir).pipe(Effect.orElseSucceed(() => []));
        const items: DojoItem[] = [];
        for (const name of names) {
            const content = yield* fs
                .readFileString(path.join(taskDir, name))
                .pipe(Effect.orElseSucceed(() => ""));
            const item = classifyBriefFile(name, content);
            if (item) items.push(item);
        }
        return items;
    });

export const defaultTaskDir = (): string =>
    process.env.AX_TASK_DIR ?? path.join(process.cwd(), ".ax", "tasks");
```

NOTE: mirror the exact `FileSystem` import path used elsewhere in the repo (e.g. `apps/axctl/src/improve/lint.ts` imports it for the same purpose) - Effect v4 beta moves platform modules around; copy, don't guess.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/dojo/briefs.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/dojo/briefs.ts apps/axctl/src/dojo/briefs.test.ts
git commit -m "feat(dojo): task-dir brief scan -> agenda items"
```

---

### Task 5: pending-verdict query

**Files:**
- Create: `apps/axctl/src/improve/verdict-pending.ts`
- Test: `apps/axctl/src/improve/verdict-pending.test.ts`

There is no exported "list pending verdicts" today (the `ax improve verdict` CLI handler at `apps/axctl/src/cli/commands/improve.ts:387` does it inline). Add a small exported query next to its siblings. Model the query on `apps/axctl/src/improve/actions.ts:534` and the service/test style on `apps/axctl/src/improve/list.ts` + `apps/axctl/src/improve/show.test.ts` (which shows how `SurrealClient` is faked in tests - copy that harness).

- [ ] **Step 1: Write the failing test**

```ts
// apps/axctl/src/improve/verdict-pending.test.ts
// Copy the fake-SurrealClient harness from apps/axctl/src/improve/show.test.ts verbatim,
// then:
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { listPendingVerdicts } from "./verdict-pending.ts";

describe("listPendingVerdicts", () => {
    test("returns experiments lacking locked_verdict with their proposal title", async () => {
        const client = fakeClient([
            [
                { id: "experiment:aaa", title: "Stop using bare bun test", status: "scaffolded" },
                { id: "experiment:bbb", title: "Guard worktree merges", status: "task_emitted" },
            ],
        ]);
        const rows = await Effect.runPromise(
            listPendingVerdicts().pipe(Effect.provide(client.layer)),
        );
        expect(rows).toEqual([
            { id: "experiment:aaa", title: "Stop using bare bun test", status: "scaffolded" },
            { id: "experiment:bbb", title: "Guard worktree merges", status: "task_emitted" },
        ]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/improve/verdict-pending.test.ts`
Expected: FAIL - `Cannot find module './verdict-pending.ts'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/axctl/src/improve/verdict-pending.ts
// Imports: copy the SurrealClient/DbError import lines from ./list.ts exactly.
import { Effect } from "effect";
import { /* SurrealClient, DbError - as in list.ts */ } from "@ax/lib/db";

export interface PendingVerdictRow {
    readonly id: string;
    readonly title: string;
    readonly status: string;
}

const QUERY = `
SELECT type::string(id) AS id,
       proposal.title AS title,
       status
FROM experiment
WHERE locked_verdict IS NONE AND status != 'retired'
ORDER BY scaffolded_at ASC
LIMIT 20;
`;

export const listPendingVerdicts = (): Effect.Effect<
    PendingVerdictRow[],
    DbError,
    SurrealClient
> =>
    Effect.gen(function* () {
        const client = yield* SurrealClient;
        const rows = yield* client.query<PendingVerdictRow[]>(QUERY); // match list.ts's query call shape
        return rows ?? [];
    });
```

The exact `client.query` call shape MUST be copied from `apps/axctl/src/improve/list.ts:30`'s implementation - same generic, same result unwrapping. If `proposal.title` deref misbehaves on your SurrealDB 3.0.x (see repo memory on record-deref bugs), fall back to two queries (ids first, then titles) - the table is small.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/improve/verdict-pending.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/improve/verdict-pending.ts apps/axctl/src/improve/verdict-pending.test.ts
git commit -m "feat(improve): listPendingVerdicts query for dojo agenda"
```

---

### Task 6: DB row -> item mappers (pure)

**Files:**
- Create: `apps/axctl/src/dojo/items.ts`
- Test: `apps/axctl/src/dojo/items.test.ts`

Pure mappers from existing query outputs to `DojoItem`s. Inputs (all verified exports):
- `PendingVerdictRow` (Task 5)
- `TuneProposal` from `apps/axctl/src/queries/routing-tune.ts:136` (`fetchTuneProposals`) - fields: `id`, `pattern`, `suggest`, `count`, `total_cost_usd`, `judgment`
- `SessionChurnRow` from `apps/axctl/src/metrics/session-churn.ts:32` - fields used: `session`, `taskLabel`, `repairLinesAdded`, `episodes`, `passedEpisodes`, `topCheck`
- open-proposal count from `listProposals` (`apps/axctl/src/improve/list.ts:30`)

- [ ] **Step 1: Write the failing test**

```ts
// apps/axctl/src/dojo/items.test.ts
import { describe, expect, test } from "bun:test";
import {
    churnHotspotItems,
    exploreItem,
    pendingVerdictItems,
    proposalMintItem,
    routingBacktestItems,
    sparItem,
} from "./items.ts";

describe("item mappers", () => {
    test("pending verdicts -> verdict_pending items with improve verdict commands", () => {
        const items = pendingVerdictItems([
            { id: "experiment:aaa", title: "Stop bare bun test", status: "scaffolded" },
        ]);
        expect(items).toEqual([
            {
                id: "verdict:experiment:aaa",
                kind: "verdict_pending",
                title: "Lock verdict: Stop bare bun test",
                commands: ["ax improve verdict aaa", "ax improve verdict aaa --set <verdict>"],
                success: "experiment.locked_verdict set",
                cost_class: "s",
            },
        ]);
    });

    test("judgment-flagged tune proposals -> routing_backtest items; non-judgment skipped", () => {
        const items = routingBacktestItems(
            [
                { id: "rt1", pattern: "^review", suggest: "sonnet", count: 5, total_cost_usd: 4.2, judgment: true },
                { id: "rt2", pattern: "^fmt", suggest: "sonnet", count: 3, total_cost_usd: 0.4, judgment: false },
            ],
            30,
        );
        expect(items).toHaveLength(1);
        expect(items[0]?.id).toBe("routing:rt1");
        expect(items[0]?.commands).toEqual([
            "ax routing tune --days=30 --emit-brief",
            "ax routing tune --apply=rt1 --days=30",
        ]);
    });

    test("churn hotspots: only sessions with failed episodes, top 2, cost l", () => {
        const row = (session: string, episodes: number, passed: number, repair: number) => ({
            session,
            source: "claude",
            taskLabel: `task ${session}`,
            landedLinesAdded: 0, landedLinesRemoved: 0,
            editLinesAdded: 0, editLinesRemoved: 0,
            repairLinesAdded: repair, repairLinesRemoved: 0,
            editEvents: 0, verificationFailures: episodes, verificationPasses: passed,
            episodes, passedEpisodes: passed, topCheck: "typecheck",
        });
        const items = churnHotspotItems([
            row("s1", 4, 1, 500),
            row("s2", 0, 0, 0),   // clean - skipped
            row("s3", 6, 2, 900),
            row("s4", 2, 1, 100),
        ]);
        expect(items.map((i) => i.id)).toEqual(["experiment:s3", "experiment:s1"]); // by repair desc, top 2
        expect(items[0]?.kind).toBe("experiment");
        expect(items[0]?.cost_class).toBe("l");
    });

    test("proposal mint emitted only when open proposals are scarce", () => {
        expect(proposalMintItem(0)).not.toBeNull();
        expect(proposalMintItem(2)).not.toBeNull();
        expect(proposalMintItem(3)).toBeNull();
    });

    test("spar + explore singletons", () => {
        expect(sparItem().kind).toBe("spar");
        expect(sparItem().cost_class).toBe("xl");
        expect(exploreItem().kind).toBe("explore");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/dojo/items.test.ts`
Expected: FAIL - `Cannot find module './items.ts'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/axctl/src/dojo/items.ts
import type { PendingVerdictRow } from "../improve/verdict-pending.ts";
import type { SessionChurnRow } from "../metrics/session-churn.ts";
import type { TuneProposal } from "../queries/routing-tune.ts";
import type { DojoItem } from "./schema.ts";

const shortId = (recordId: string): string => recordId.split(":").pop() ?? recordId;

export const pendingVerdictItems = (rows: readonly PendingVerdictRow[]): DojoItem[] =>
    rows.map((r) => ({
        id: `verdict:${r.id}`,
        kind: "verdict_pending",
        title: `Lock verdict: ${r.title}`,
        commands: [
            `ax improve verdict ${shortId(r.id)}`,
            `ax improve verdict ${shortId(r.id)} --set <verdict>`,
        ],
        success: "experiment.locked_verdict set",
        cost_class: "s",
    }));

export const routingBacktestItems = (
    proposals: readonly TuneProposal[],
    days: number,
): DojoItem[] =>
    proposals
        .filter((p) => p.judgment)
        .map((p) => ({
            id: `routing:${p.id}`,
            kind: "routing_backtest",
            title: `Backtest routing class ${p.pattern} (${p.count} dispatches, $${p.total_cost_usd.toFixed(2)})`,
            commands: [
                `ax routing tune --days=${days} --emit-brief`,
                `ax routing tune --apply=${p.id} --days=${days}`,
            ],
            success: "class applied to routing table (origin: user) or rejected with rationale",
            cost_class: "m",
        }));

export const MINT_THRESHOLD = 3;

export const proposalMintItem = (openProposalCount: number): DojoItem | null =>
    openProposalCount >= MINT_THRESHOLD
        ? null
        : {
            id: "mint:improve-recommend",
            kind: "proposal_mint",
            title: "Mint new improvement proposals (open pool is low)",
            commands: ["ax improve recommend", "ax improve accept <id>"],
            success: "new open proposals exist; accepted ones emitted .ax/tasks briefs",
            cost_class: "m",
        };

export const churnHotspotItems = (rows: readonly SessionChurnRow[]): DojoItem[] =>
    rows
        .filter((r) => r.episodes > r.passedEpisodes || r.repairLinesAdded > 200)
        .sort((a, b) => b.repairLinesAdded - a.repairLinesAdded)
        .slice(0, 2)
        .map((r) => ({
            id: `experiment:${r.session}`,
            kind: "experiment",
            title: `Worktree experiment: reduce ${r.topCheck} churn (${r.taskLabel})`,
            commands: [
                `ax sessions show ${r.session}`,
                "git worktree add .claude/worktrees/dojo-experiment -b dojo/experiment",
                "ax improve recommend  # package the result as a proposal",
            ],
            success: "experiment branch + evidence captured as an improve proposal",
            cost_class: "l",
        }));

export const sparItem = (): DojoItem => ({
    id: "spar:campaign",
    kind: "spar",
    title: "Sparring: one task, one delta, scored (see skill playbook)",
    commands: [
        "ax sessions here --days=30  # pick a landed task as baseline",
        "git worktree add .claude/worktrees/dojo-spar <parent-sha>",
    ],
    success: "spar report appended to the dojo report; goal package updated",
    cost_class: "xl",
});

export const exploreItem = (): DojoItem => ({
    id: "explore:retro-meta",
    kind: "explore",
    title: "Agenda dry - free investigation (retro-meta style)",
    commands: ["ax recall <hunch> --scope=all", "ax sessions churn --since=30"],
    success: "at least one new outbox draft, proposal, or goal package",
    cost_class: "l",
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/dojo/items.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/dojo/items.ts apps/axctl/src/dojo/items.test.ts
git commit -m "feat(dojo): pure row->item mappers for all agenda sources"
```

---

### Task 7: agenda assembly (pure core + Effect glue)

**Files:**
- Create: `apps/axctl/src/dojo/agenda.ts`
- Test: `apps/axctl/src/dojo/agenda.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/axctl/src/dojo/agenda.test.ts
import { describe, expect, test } from "bun:test";
import type { BudgetEnvelope, DojoItem } from "./schema.ts";
import { assembleAgenda } from "./agenda.ts";

const budget: BudgetEnvelope = {
    has_surplus: true, spendable_pct: 20, binding_window: "five_hour",
    window_remaining_pct: 35, reserve_pct: 15,
    deadline: "2026-06-13T12:00:00.000Z", source: "quota",
};

const item = (id: string, kind: DojoItem["kind"]): DojoItem => ({
    id, kind, title: id, commands: ["true"], success: "done", cost_class: "s",
});

describe("assembleAgenda", () => {
    test("sorts by kind priority and stamps generated_at", () => {
        const agenda = assembleAgenda(
            budget,
            [item("e1", "experiment"), item("v1", "verdict_pending"), item("b1", "brief_unfilled")],
            { nowMs: Date.parse("2026-06-13T10:00:00.000Z"), spar: false },
        );
        expect(agenda.v).toBe(1);
        expect(agenda.generated_at).toBe("2026-06-13T10:00:00.000Z");
        expect(agenda.items.map((i) => i.id)).toEqual(["v1", "b1", "e1"]);
    });

    test("appends explore when otherwise empty", () => {
        const agenda = assembleAgenda(budget, [], { nowMs: 0, spar: false });
        expect(agenda.items).toHaveLength(1);
        expect(agenda.items[0]?.kind).toBe("explore");
    });

    test("spar included only when requested AND spendable >= 30", () => {
        const none = assembleAgenda(budget, [item("v1", "verdict_pending")], { nowMs: 0, spar: true });
        expect(none.items.some((i) => i.kind === "spar")).toBe(false); // spendable 20 < 30
        const fat = assembleAgenda(
            { ...budget, spendable_pct: 40 },
            [item("v1", "verdict_pending")],
            { nowMs: 0, spar: true },
        );
        expect(fat.items.some((i) => i.kind === "spar")).toBe(true);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/dojo/agenda.test.ts`
Expected: FAIL - `Cannot find module './agenda.ts'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/axctl/src/dojo/agenda.ts
import { Effect } from "effect";
import { listPendingVerdicts } from "../improve/verdict-pending.ts";
import { listProposals } from "../improve/list.ts";
import { fetchSessionChurnSummary } from "../metrics/session-churn.ts";
import { fetchTuneProposals } from "../queries/routing-tune.ts";
import { defaultTaskDir, scanTaskDir } from "./briefs.ts";
import {
    churnHotspotItems, exploreItem, pendingVerdictItems,
    proposalMintItem, routingBacktestItems, sparItem,
} from "./items.ts";
import type { BudgetEnvelope, DojoAgenda, DojoItem } from "./schema.ts";
import { compareByPriority } from "./schema.ts";

export const SPAR_MIN_SPENDABLE_PCT = 30;

export interface AssembleOptions {
    readonly nowMs: number;
    readonly spar: boolean;
}

/** Pure: budget + flat item list -> ordered agenda. */
export const assembleAgenda = (
    budget: BudgetEnvelope,
    items: readonly DojoItem[],
    opts: AssembleOptions,
): DojoAgenda => {
    const sorted = [...items].sort(compareByPriority);
    if (opts.spar && budget.spendable_pct >= SPAR_MIN_SPENDABLE_PCT) sorted.push(sparItem());
    if (sorted.length === 0) sorted.push(exploreItem());
    return {
        v: 1,
        generated_at: new Date(opts.nowMs).toISOString(),
        budget,
        items: sorted,
    };
};

export interface CollectOptions {
    readonly nowMs: number;
    readonly days: number; // lookback for churn + routing tune
    readonly spar: boolean;
    readonly taskDir?: string;
}

/**
 * Effect glue: run every source, tolerate individual source failures
 * (a broken source must not kill the whole agenda - log to stderr, emit []).
 * Requirements: SurrealClient + FileSystem (+ whatever fetchTuneProposals needs:
 * it takes the loaded RoutingTable - load it via the same helper
 * `ax routing show` uses, see apps/axctl/src/queries/routing-tune.ts imports).
 */
export const collectAgendaItems = (opts: CollectOptions) =>
    Effect.gen(function* () {
        const soft = <A>(label: string, eff: Effect.Effect<A, unknown, never>, empty: A) =>
            eff.pipe(
                Effect.catchAll((e) =>
                    Effect.sync(() => {
                        console.error(`dojo: source ${label} failed: ${String(e)}`);
                        return empty;
                    }),
                ),
            );
        // NOTE to engineer: provide the actual environments at the call site (CLI task 9);
        // the per-source `soft` wrapper pattern stays as shown.
        const verdicts = yield* soft("verdicts", listPendingVerdicts() as never, []);
        const briefs = yield* soft("briefs", scanTaskDir(opts.taskDir ?? defaultTaskDir()) as never, []);
        const churn = yield* soft("churn", fetchSessionChurnSummary({ sinceDays: opts.days } as never) as never, null);
        const open = yield* soft("proposals", listProposals({ status: "open" } as never) as never, []);
        const tune = yield* soft("routing", fetchTuneProposals({ sinceDays: opts.days, table: /* load routing table as routing-show does */ undefined as never }) as never, []);

        const items: DojoItem[] = [
            ...pendingVerdictItems(verdicts as never),
            ...(briefs as DojoItem[]),
            ...routingBacktestItems(tune as never, opts.days),
            ...churnHotspotItems(((churn as never) ?? { rows: [] }).rows ?? []),
        ];
        const mint = proposalMintItem((open as unknown[]).length);
        if (mint) items.push(mint);
        return items;
    });
```

The `as never` casts above mark the seams the engineer must resolve against the real signatures (exact input shapes of `fetchSessionChurnSummary` / `fetchTuneProposals` / `listProposals` - read each function's input type and call it properly; the routing table loads via the same loader `ax routing show` uses in `apps/axctl/src/cli/commands/ax-routing.ts`). The pure `assembleAgenda` and the `soft` failure-isolation pattern are the tested contract; `collectAgendaItems` is glue verified by typecheck + the CLI smoke test in Task 9.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/dojo/agenda.test.ts`
Expected: PASS (3 tests). Then `bun run typecheck` to force resolving the glue seams properly - do not leave `as never` casts in committed code.

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/dojo/agenda.ts apps/axctl/src/dojo/agenda.test.ts
git commit -m "feat(dojo): agenda assembly - priority sort, spar gate, explore fallback"
```

---

### Task 8: text rendering

**Files:**
- Create: `apps/axctl/src/dojo/format.ts`
- Test: `apps/axctl/src/dojo/format.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/axctl/src/dojo/format.test.ts
import { describe, expect, test } from "bun:test";
import type { DojoAgenda } from "./schema.ts";
import { renderAgenda } from "./format.ts";

const agenda: DojoAgenda = {
    v: 1,
    generated_at: "2026-06-13T10:00:00.000Z",
    budget: {
        has_surplus: true, spendable_pct: 20, binding_window: "five_hour",
        window_remaining_pct: 35, reserve_pct: 15,
        deadline: "2026-06-13T12:00:00.000Z", source: "quota",
    },
    items: [
        {
            id: "verdict:experiment:aaa", kind: "verdict_pending",
            title: "Lock verdict: Stop bare bun test",
            commands: ["ax improve verdict aaa"], success: "locked", cost_class: "s",
        },
    ],
};

describe("renderAgenda", () => {
    test("renders budget line + item rows", () => {
        const out = renderAgenda(agenda);
        expect(out).toContain("budget: 20% spendable (5h window, 35% left, 15% reserve)");
        expect(out).toContain("deadline 2026-06-13T12:00");
        expect(out).toContain("1. [verdict_pending/s] Lock verdict: Stop bare bun test");
        expect(out).toContain("   $ ax improve verdict aaa");
    });

    test("no-surplus agenda warns about --force", () => {
        const out = renderAgenda({
            ...agenda,
            budget: { ...agenda.budget, has_surplus: false, spendable_pct: 0 },
        });
        expect(out).toContain("no surplus");
        expect(out).toContain("--force");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/dojo/format.test.ts`
Expected: FAIL - `Cannot find module './format.ts'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/axctl/src/dojo/format.ts
import type { DojoAgenda } from "./schema.ts";

const windowLabel = (w: DojoAgenda["budget"]["binding_window"]): string =>
    w === "five_hour" ? "5h window" : w === "seven_day" ? "7d window" : "no window";

export const renderAgenda = (agenda: DojoAgenda): string => {
    const b = agenda.budget;
    const lines: string[] = [];
    lines.push(
        `budget: ${b.spendable_pct}% spendable (${windowLabel(b.binding_window)}, ` +
        `${b.window_remaining_pct}% left, ${b.reserve_pct}% reserve) - ` +
        `deadline ${b.deadline.slice(0, 16)} [${b.source}]`,
    );
    if (!b.has_surplus) {
        lines.push("no surplus in the current window - dojo will not start without --force");
    }
    lines.push("");
    agenda.items.forEach((item, i) => {
        lines.push(`${i + 1}. [${item.kind}/${item.cost_class}] ${item.title}`);
        for (const cmd of item.commands) lines.push(`   $ ${cmd}`);
        lines.push(`   done when: ${item.success}`);
    });
    return lines.join("\n");
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/dojo/format.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/dojo/format.ts apps/axctl/src/dojo/format.test.ts
git commit -m "feat(dojo): text agenda renderer"
```

---

### Task 9: CLI command + registration

**Files:**
- Create: `apps/axctl/src/cli/commands/dojo.ts`
- Modify: `apps/axctl/src/cli/index.ts` (two spots: `RUNTIME_BY_COMMAND` spread around line 68-95; `registeredCommands` around line 103-149)

Model on `apps/axctl/src/cli/commands/quota.ts` (flags/handler) and `ax-routing.ts` (db runtime). Dojo needs **db runtime** (verdicts/churn/proposals) AND the QuotaEnv layer (budget) - provide `QuotaEnvLive` inside the handler like quota.ts does, the db layer comes from the manifest.

- [ ] **Step 1: Write the command**

```ts
// apps/axctl/src/cli/commands/dojo.ts
/**
 * `ax dojo` - budget envelope + prioritized training agenda for the
 * ax:dojo skill loop. Spec: docs/superpowers/specs/2026-06-13-ax-dojo-design.md
 *
 *   ax dojo            human agenda
 *   ax dojo --json     DojoAgenda JSON (consumed by the skill each lap)
 */
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { prettyPrint } from "@ax/lib/json";
import { assembleAgenda, collectAgendaItems } from "../../dojo/agenda.ts";
import { computeBudgetEnvelope } from "../../dojo/budget.ts";
import { renderAgenda } from "../../dojo/format.ts";
import { defaultQuotaCachePath } from "../../quota/cache.ts";
import { QuotaEnvLive } from "../../quota/quota-env.ts";
import { getQuota } from "../../quota/quota.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { jsonFlag } from "./shared.ts";

/** "HH:MM" today (or tomorrow when already past) -> ISO */
export const untilToIso = (until: string, nowMs: number): string | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(until);
    if (!m) return null;
    const d = new Date(nowMs);
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
    return d.toISOString();
};

export const dojoCommand = Command.make(
    "dojo",
    {
        json: jsonFlag,
        budget: Flag.integer("budget").pipe(Flag.withDefault(0)), // 0 = unset
        until: Flag.string("until").pipe(Flag.withDefault("")),
        force: Flag.boolean("force").pipe(Flag.withDefault(false)),
        spar: Flag.boolean("spar").pipe(Flag.withDefault(false)),
        days: Flag.integer("days").pipe(Flag.withDefault(30)),
    },
    ({ json, budget, until, force, spar, days }) => {
        const nowMs = Date.now();
        return Effect.gen(function* () {
            const quota = yield* getQuota({
                cachePath: defaultQuotaCachePath(),
                maxAgeSeconds: 60,
                nowMs,
            }).pipe(
                Effect.map((r) => r.snapshot),
                Effect.catchAll(() => Effect.succeed(null)), // budget degrades, agenda still renders
            );
            const envelope = computeBudgetEnvelope(
                quota,
                {
                    budgetPctOverride: budget > 0 ? budget : null,
                    untilIso: until ? untilToIso(until, nowMs) : null,
                    force,
                },
                nowMs,
            );
            const items = yield* collectAgendaItems({ nowMs, days, spar });
            const agenda = assembleAgenda(envelope, items, { nowMs, spar });
            console.log(json ? prettyPrint(agenda) : renderAgenda(agenda));
        }).pipe(Effect.provide(QuotaEnvLive));
    },
).pipe(
    Command.withDescription(
        "Training agenda: quota budget envelope + prioritized self-improvement work items (consumed by the ax:dojo skill loop)",
    ),
);

export const dojoRuntime: RuntimeManifest = {
    dojo: "db",
};
```

- [ ] **Step 2: Register in cli/index.ts**

In `apps/axctl/src/cli/index.ts`:
1. Import: `import { dojoCommand, dojoRuntime } from "./commands/dojo.ts";`
2. Spread `...dojoRuntime,` into `RUNTIME_BY_COMMAND` alongside the other manifests.
3. Add `dojoCommand` to `registeredCommands` (place after `quota` in the visible order).

- [ ] **Step 3: Verify with the existing CLI exhaustiveness test + smoke run**

Run: `bun test apps/axctl/src/cli/effect-cli.test.ts`
Expected: PASS - the "every registered top-level command declares its runtime" test now covers dojo.

Run: `bun apps/axctl/src/cli/index.ts dojo --json` (DB running; `scripts/db-start.sh` if not)
Expected: JSON with `"v": 1`, a `budget` object, an `items` array (possibly just the explore fallback on a clean graph). Exit 0.

Run: `bun apps/axctl/src/cli/index.ts dojo`
Expected: human agenda; budget line first.

- [ ] **Step 4: Add untilToIso unit test**

Append to `apps/axctl/src/dojo/format.test.ts` or create `apps/axctl/src/cli/commands/dojo.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { untilToIso } from "./dojo.ts";

describe("untilToIso", () => {
    const NOW = Date.parse("2026-06-13T10:00:00.000Z");
    test("future time today", () => {
        expect(untilToIso("23:30", NOW)).toMatch(/T\d{2}:30:00/);
    });
    test("past time rolls to tomorrow", () => {
        const iso = untilToIso("01:00", NOW)!;
        expect(Date.parse(iso)).toBeGreaterThan(NOW);
    });
    test("garbage returns null", () => {
        expect(untilToIso("late", NOW)).toBeNull();
    });
});
```

Run: `bun test apps/axctl/src/cli/commands/dojo.test.ts` - Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/cli/commands/dojo.ts apps/axctl/src/cli/commands/dojo.test.ts apps/axctl/src/cli/index.ts
git commit -m "feat(cli): ax dojo - budget envelope + training agenda"
```

---

### Task 10: docs gate (README/cli.md + llms.txt + CLAUDE.md)

**Files:**
- Modify: `docs/cli.md` (add under the command list, near quota)
- Modify: `apps/site/public/llms.txt` (REQUIRED - `check:cli-reference` fails without it)
- Modify: `CLAUDE.md` (new section after "### Plan quota")

- [ ] **Step 1: docs/cli.md**

Add (match surrounding format):

```
axctl dojo [--json|--spar|--budget=N|--until=HH:MM|--force]   # training agenda: quota budget envelope + prioritized self-improvement items for the ax:dojo skill loop
```

- [ ] **Step 2: apps/site/public/llms.txt**

Add (match surrounding format):

```
- `ax dojo [--json] [--spar] [--budget=N] [--until=HH:MM] [--force] [--days=N]` - training agenda for surplus-quota self-improvement: budget envelope (5h/7d window remaining minus reserve, deadline = window reset) + prioritized items (pending verdicts, unfilled briefs, routing backtests, proposal minting, churn experiments, optional sparring). Consumed lap-by-lap by the ax:dojo skill.
```

- [ ] **Step 3: CLAUDE.md**

Add after the "### Plan quota" section:

```markdown
### Dojo

`ax dojo [--json] [--spar] [--budget=N] [--until=HH:MM] [--force] [--days=N]` -
training agenda for the ax:dojo skill loop (burn surplus plan quota on
self-improvement). Composes a budget envelope from the quota module (binding
window remaining minus 15% reserve, deadline = earliest window reset) with a
derived, self-clearing item list: pending verdicts, unfilled .ax/tasks briefs,
judgment-flagged routing backtests, proposal minting (when open pool < 3),
churn-hotspot experiments, opt-in spar (needs --spar AND >=30% spendable),
explore fallback. Items vanish once the underlying system records the work
(verdict locked / brief consumed / proposal created). State dirs:
`~/.ax/dojo/outbox/` (upstream issue drafts, publish on review) and
`~/.ax/dojo/reports/<date>.md`. Module: `apps/axctl/src/dojo/`. Spec:
docs/superpowers/specs/2026-06-13-ax-dojo-design.md.
```

- [ ] **Step 4: Run the gate**

Run: `bun run check:cli-reference`
Expected: exits 0, no missing-subcommand output.

- [ ] **Step 5: Commit**

```bash
git add docs/cli.md apps/site/public/llms.txt CLAUDE.md
git commit -m "docs: ax dojo command reference + CLAUDE.md section"
```

---

### Task 11: the ax:dojo skill

**Files:**
- Create: `skills/dojo/SKILL.md`

Frontmatter format per `skills/retro/SKILL.md` (name + description with explicit triggers + explicit do-NOT-fire guidance).

- [ ] **Step 1: Write the skill**

```markdown
---
name: dojo
description: Surplus-quota training loop over the ax graph - the agent burns the remaining 5h/7d plan-quota window on self-improvement: locking pending verdicts, filling briefs, backtesting routing classes, minting proposals, running worktree experiments, and drafting upstream issue reports. Triggers when the user says "/dojo", "enter the dojo", "dojo time", "train overnight", "burn my surplus quota", "dream mode" (legacy name), or invokes /loop /dojo. Requires ax (axctl) on PATH and the local SurrealDB running. Do NOT auto-trigger on unrelated work or when the user merely mentions quotas.
---

# ax:dojo - overnight training loop

You are entering a budget-bounded self-improvement loop. The brain is
`ax dojo --json`; you are the thin driver. Spec for humans:
docs/superpowers/specs/2026-06-13-ax-dojo-design.md (in the Necmttn/ax repo).

## Entry

1. Run `ax dojo --json`. If it fails with a connection error, tell the user
   to run `scripts/db-start.sh` (or `ax doctor`) and STOP.
2. If `budget.has_surplus` is false: report the envelope and STOP unless the
   user re-invokes with `--force` (then pass `--force` on every lap).
3. On Claude Code: enter loop mode now - invoke the `/loop` skill with
   `/dojo` as the recurring prompt (dynamic mode, self-paced). Each wakeup
   re-runs this skill from the top; that is expected and correct.
   On Codex (no /loop): run as ONE long turn - do not end the turn until a
   stop condition below is met.

## The lap

1. `ax dojo --json` -> agenda.
2. STOP conditions (write the report, then stop):
   - `budget.has_surplus` is false (and not forced)
   - now >= `budget.deadline`
   - `items` is empty
3. Otherwise: take `items[0]`, follow its playbook below, then go to 1.
   Completed work self-clears: the item vanishes from the next agenda
   because the underlying system recorded it (verdict locked, brief
   consumed, proposal created). If the same item survives 2 laps untouched,
   skip it and note why in the report.

## Playbooks by kind

- **verdict_pending** - `ax improve verdict <id>` to see the suggested
  verdict + checkpoint evidence; confirm with `--set <verdict>` only when
  the evidence supports it. Distinguish "pattern resolved" from "artifact
  never fired" before locking no_longer_needed.
- **brief_unfilled** - open the `.ax/tasks/*.md` brief, do what it says in
  the target files, then run the reconciler it names (`ax skills lint` /
  `ax improve lint`).
- **routing_backtest** - judgment-flagged routing classes: backtest the
  pattern against dispatch history (`ax dispatches --candidates`), check
  false-positive risk, then `ax routing tune --apply=<ids> --days=<window>`
  or reject with a written rationale in the report.
- **proposal_mint** - `ax improve recommend`; accept the grounded ones
  (`ax improve accept <id>`) so briefs exist for the next lap.
- **experiment** - heavy item. Work ONLY in a fresh worktree
  (`git worktree add .claude/worktrees/dojo-<slug> -b dojo/<slug>`).
  Reproduce the churn pattern, attempt the fix/hook/skill, capture evidence.
  If it will not finish inside this budget: package it as a goal file
  (objective + checkpoint index + gates) under docs/superpowers/goals/ so
  the NEXT dojo session resumes it. Output = an improve proposal; merging
  the proposal is what activates anything. NEVER merge, never touch main.
- **New hooks specifically** - author via @ax/hooks-sdk, validate with
  `ax hooks backtest <file>`, and put BOTH sides in the proposal: cases it
  would have caught AND the latency ledger (per-fire cost, est fires/day,
  cumulative installed-chain overhead). Reject your own hook when overhead
  outweighs benefit.
- **spar** - only present when invoked with --spar and surplus is large.
  One task, one delta, scored: pick a landed task (`ax sessions here`),
  pin a worktree at the parent SHA, re-run it with exactly ONE change
  (skill on/off, hook on/off, prompt, thinking level, model via subagent
  override), score against the historical baseline using graph metrics
  (tokens, turns, churn, landed). Append the comparison receipt to the
  report. Track multi-night campaigns as goal files.
- **explore** - free investigation, retro-meta style: follow a hunch
  through `ax recall` / `ax sessions churn`, and convert anything real
  into a proposal or outbox draft.
- **Upstream findings (any lap)** - an ax bug or improvement found while
  training goes to `~/.ax/dojo/outbox/<slug>.md` as a complete issue draft
  (title, body, repro, session refs). NEVER publish from the dojo - the
  user reviews and publishes in the morning (ax-repo skill / gh).

## Exit - the morning report

Write `~/.ax/dojo/reports/<YYYY-MM-DD>.md` (create dirs if missing):
- budget: envelope at start, spendable consumed (re-run `ax quota` and diff)
- per lap: item, what happened, evidence refs
- proposals created/advanced, briefs filled, verdicts locked
- outbox drafts awaiting review (list paths)
- skipped/stuck items and why
Then tell the user the report path and the top 3 things awaiting their
review. Done.

## Hard rails

- worktrees only; never write on main; never merge anything
- proposals are the only activation path
- outbox only; nothing leaves the machine
- respect the deadline even mid-item: checkpoint, report, stop
```

- [ ] **Step 2: Verify skill list consistency**

Check whether any manifest/registry lists the installable skills (e.g. a `skills` index in `package.json`, README section listing `npx skills add Necmttn/ax` contents, or `apps/site` content). Search: `rg -l "ax-extract-workflow" --type md README.md docs/ apps/site/` and add `dojo` wherever sibling skills are enumerated.

- [ ] **Step 3: Commit**

```bash
git add skills/dojo/SKILL.md
git commit -m "feat(skills): ax:dojo - surplus-quota training loop skill"
```

---

### Task 12: full verification + PR

- [ ] **Step 1: Full test suite**

Run: `bun test`
Expected: all pass (if a global hook blocks bare `bun test`, use the tmp-wrapper workaround from project memory).

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: clean. Specifically confirm no `as never` seams survive in `apps/axctl/src/dojo/agenda.ts`.

- [ ] **Step 3: Docs gate + smoke**

Run: `bun run check:cli-reference` - Expected: exit 0.
Run: `bun apps/axctl/src/cli/index.ts dojo` - Expected: human agenda renders against the live local graph.
Run: `bun apps/axctl/src/cli/index.ts dojo --json | jq .budget` - Expected: envelope object with `spendable_pct`.

- [ ] **Step 4: PR**

```bash
git push -u origin feat/ax-dojo-spec
gh pr create --title "feat: ax dojo - surplus-quota training loop (agenda CLI + skill)" --body "$(cat <<'EOF'
## Summary
- `ax dojo [--json]`: budget envelope (quota window remaining - reserve, deadline = reset) + prioritized self-clearing agenda (verdicts, briefs, routing backtests, proposal minting, churn experiments, opt-in spar, explore fallback)
- `skills/dojo/SKILL.md`: thin loop driver - /dojo composes /loop on Claude Code, single long turn on Codex; proposal-gated autonomy, outbox-only upstream drafts, morning report
- spec: docs/superpowers/specs/2026-06-13-ax-dojo-design.md

## Deferred (follow-up plans)
hook latency bench, spar execution mechanics, MCP dojo_agenda tool, cron trigger

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR opens; CI green (bun test + typecheck + check:cli-reference).
