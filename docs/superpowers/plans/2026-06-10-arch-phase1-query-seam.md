# Phase 1: Query Layer Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every read query the CLI/TUI/dashboard/MCP needs lives in `apps/axctl/src/queries/` as a module exporting (a) the SQL (exported for tests), (b) typed params/row/result types, (c) pure row mappers, and (d) an executable Effect seam (`fetch*()` or `defineQuery` object). Surfaces become adapters: parse args → call fetch → format. This phase kills the SKILL_DETAIL_SQL duplication, extracts the two worst inline CLI offenders (`cmdStats`, `cmdUnused`), and closes the test gap on the genuinely SQL-string-only modules.

**Architecture:** Bun-workspace monorepo. Query modules in `apps/axctl/src/queries/*.ts`, shared seam helpers in `packages/lib/src/shared/query.ts` (`defineQuery`/`defineSingleQuery`) and `packages/lib/src/shared/graph-query.ts` (`runQuery`/`runSingleQuery`). DB access only via the `SurrealClient` Effect service (`@ax/lib/db`). CLI command bodies in `apps/axctl/src/cli/index.ts` keep flag parsing + `console.log` formatting only.

**Tech Stack:** bun ≥1.3, TypeScript strict, Effect v4 beta (`effect@beta`), SurrealDB 3 via `surrealdb` SDK wrapped in `SurrealClient`, tests with `bun:test` colocated as `*.test.ts`.

---

## Verified audit (read 2026-06-10, supersedes the prior review's stale claims)

The prior review claimed "8 of 26 query modules export SQL strings only". Re-verified against the worktree:

| Module | Actual status | Action this phase |
|---|---|---|
| `queries/skill-detail.ts` | SQL string only; duplicate older variant in `tui/queries.ts:22-44`; the fetch (`fetchSkillDetail`) lives in `dashboard/triage.ts:497-535` | Tasks 1–2: unify SQL, move fetch + mappers into the module, test |
| `queries/skill-summary.ts` | SQL strings only, **has** colocated test; two orchestrating consumers with *different* merge logic (`tui/hooks/useSkills.ts`, `dashboard/triage.ts` `buildSkillRows`) | Defer consolidation to Phase 2 (CLI/dashboard restructure); noted in Follow-ups |
| `queries/episode-timeline.ts` | SQL builder fns only, **no test**; fetch (`fetchEpisodeTimeline`) already exists in `dashboard/episode-timeline.ts` | Task 5: add colocated SQL-shape test; fetch relocation deferred to Phase 2 |
| `queries/hooks.ts` | Already conforms: exports `queryHookSummary`/`queryHookInvocations`/`queryHookSession` Effect functions + typed rows | None (no test gap blocking; consumers live: `cli/index.ts`, `hooks/config.ts`, `ingest/provider-parity.ts`) |
| `queries/project.ts`, `queries/recall.ts`, `queries/session-view.ts`, `queries/skill-graph.ts`, `queries/tool-failures.ts` | Already conform via `defineQuery`/`defineSingleQuery` objects (executable with `runQuery`/`runSingleQuery`); orchestrating `fetch*` wrappers live in `dashboard/*` | None this phase; colocated tests noted in Follow-ups |
| **Dead modules** | None found - all 26 modules have live importers | Nothing to delete |

CLI inline offenders confirmed: `cmdStats` (`cli/index.ts:1073-1193`, inline ~22-line SQL + transform + print), `cmdUnused` (`cli/index.ts:1213-1344`, 4 inline SQL strings + anti-join merge + print). Other hand-rolled `FROM invoked` sites (`cmdSearch` ~812, `cmdTaste` ~1004, `cmdRecent` ~1201, ~1548) are out of scope → Follow-ups.

---

## Query-module contract (codified from the best existing modules)

Derived from `queries/project.ts` + `queries/session-detail.ts` (defineQuery style), `dashboard/skills-weighted.ts` + `dashboard/recall.ts` (fetch-orchestrator style), and `queries/feedback-cases.test.ts` / `dashboard/skills-weighted.test.ts` (test style). Every query module under `apps/axctl/src/queries/` MUST:

1. **Export the SQL.** `UPPER_SNAKE_SQL` string constants for fixed statements; `someSql(params): string` builder functions when a clause must be spliced (validate spliced values - see `checkedLimit` in `queries/graph-health.ts`). String/number/date params go through SurrealDB `$param` bindings; record ids and `Nd` interval literals are spliced after validation (record-id bindings are unreliable in this codebase - see `graph-query.ts` header comment).
2. **Export types.** A `Params` interface, row/result interfaces (`readonly` fields), no `any`.
3. **Export pure mappers** (`mapXRow(raw: unknown): T | null` shape, like `mapSessionShareTurnRow`) so transforms are unit-testable without a DB. Field extraction uses `@ax/lib/shared/row-fields` helpers (`stringField`, `dateField`, `numericField`, `recordIdString`, `isRecord`).
4. **Export an executable seam**, one of:
   - single-statement read → `defineQuery`/`defineSingleQuery` object (from `@ax/lib/shared/query`), executed by callers via `runQuery`/`runSingleQuery` (from `@ax/lib/shared/graph-query`); or
   - multi-statement / merged read → `fetchX(params): Effect.Effect<Result, DbError, SurrealClient>` written with `Effect.gen`, `const db = yield* SurrealClient`, parallel statements via `Effect.all([...], { concurrency: N })`.
5. **Keep `DbError` in the error channel** of `fetch*` functions. The CLI adapter handles it with `catchDbErrorAndExit("axctl <cmd>")` (`cli/output.ts`); the dashboard catches at the HTTP boundary. (`runQuery`/`runSingleQuery` are intentionally defensive and degrade to `[]`/`null` - that policy lives in `graph-query.ts`, not in query modules.)
6. **No formatting / no `console.log`** in query modules. Formatting stays in `cli/*-format.ts` or the CLI command body.
7. **Colocated test** `queries/<name>.test.ts` with three layers: (a) SQL-shape assertions (`expect(SQL).toContain(...)`), (b) pure mapper tests with literal fixtures, (c) fetch tests using a mock `SurrealClientShape` provided with `Effect.provideService(SurrealClient, mockDb)` - copy the `makeMockDb` helper pattern from `dashboard/skills-weighted.test.ts:23-49`.

**Test invocation note for the executor:** run tests with the project's standard `bun test <path>` (bun:test). A global hook may block `bun test` invocations in this environment; if blocked, write a tmp wrapper script (e.g. `printf '#!/bin/sh\nexec bun test "$@"\n' > /tmp/run-tests.sh && chmod +x /tmp/run-tests.sh && /tmp/run-tests.sh <path>`) per the project's known workaround. Typecheck with `bun run typecheck` from the repo root.

**Branch note:** worktree may be on `main` and edit hooks block `main`. Before Task 1: `git checkout -b arch/phase1-query-seam`.

---

## Task 1: Unify SKILL_DETAIL_SQL - canonical SQL gains `daily`, TUI duplicate dies

The canonical `queries/skill-detail.ts` SQL has `corrections`/`proposals`/`paired` + `turn_has_error` but lacks the `daily` 30-day bucket list the TUI needs. The TUI duplicate (`tui/queries.ts:22-44`) has `daily` but lacks the rest. Make the canonical SQL the superset, then re-export it from `tui/queries.ts` (the same back-compat re-export pattern that file already uses for the skill-summary constants). `tui/hooks/useSkillDetail.ts` keeps importing from `../queries.ts` - zero TUI render changes; its `SkillDetailRecord` cast keeps working because the payload is a superset (extra keys `corrections`/`proposals`/`paired`/`turn_has_error` are ignored by structural typing).

**Files:**
- Create: `apps/axctl/src/queries/skill-detail.test.ts`
- Modify: `apps/axctl/src/queries/skill-detail.ts` (whole file is currently lines 1–59; SQL gains a `daily` block)
- Modify: `apps/axctl/src/tui/queries.ts` (delete lines 15–44, the duplicate `SKILL_DETAIL_SQL`; add re-export)

**Steps:**

- [ ] Write the failing test `apps/axctl/src/queries/skill-detail.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { SKILL_DETAIL_SQL } from "./skill-detail.ts";
import { SKILL_DETAIL_SQL as TUI_SKILL_DETAIL_SQL } from "../tui/queries.ts";

describe("SKILL_DETAIL_SQL", () => {
    test("binds the skill by $name", () => {
        expect(SKILL_DETAIL_SQL).toContain("WHERE name = $name");
    });

    test("includes the TUI daily buckets (last 30 days, ascending)", () => {
        expect(SKILL_DETAIL_SQL).toContain("daily:");
        expect(SKILL_DETAIL_SQL).toMatch(
            /daily:\s*\(\s*SELECT ts FROM invoked\s*WHERE out = \$s\.id AND ts > time::now\(\) - 30d\s*ORDER BY ts ASC\s*\)/,
        );
    });

    test("includes the dashboard evidence blocks", () => {
        expect(SKILL_DETAIL_SQL).toContain("corrections:");
        expect(SKILL_DETAIL_SQL).toContain("proposals:");
        expect(SKILL_DETAIL_SQL).toContain("paired:");
        expect(SKILL_DETAIL_SQL).toContain("turn_has_error");
    });

    test("TUI re-exports the canonical SQL (no fork)", () => {
        expect(TUI_SKILL_DETAIL_SQL).toBe(SKILL_DETAIL_SQL);
    });
});
```

- [ ] Run `bun test apps/axctl/src/queries/skill-detail.test.ts` - expect FAIL (no `daily:` in canonical SQL; TUI string differs).
- [ ] In `apps/axctl/src/queries/skill-detail.ts`, insert the `daily` block into `SKILL_DETAIL_SQL` between the `recent` block (ends line 23 `),`) and the `corrections` block (starts line 24):

```sql
    daily: (
        SELECT ts FROM invoked
        WHERE out = $s.id AND ts > time::now() - 30d
        ORDER BY ts ASC
    ),
```

  Also update the module docstring (lines 1–6) to mention it now also powers the TUI DetailPane sparkline:

```ts
/**
 * Per-skill detail payload powering the TUI DetailPane (incl. the 30-day
 * `daily` sparkline buckets), the web dashboard's "click recommendation
 * reason → see evidence" expand panel, and `GET /api/skills/:name/detail`.
 *
 * Bindings: $name (skill name).
 */
```

- [ ] In `apps/axctl/src/tui/queries.ts`, delete lines 15–44 (the doc comment + duplicate `export const SKILL_DETAIL_SQL = ...`) and replace with a re-export, so the whole file becomes:

```ts
/**
 * SurrealQL query strings used by the TUI dashboard.
 *
 * All SQL now lives in `src/queries/` so every surface shares one variant.
 * Re-exported here for backward compatibility with the TUI hooks.
 */

export {
    PRODUCED_BY_SESSION_SQL,
    SKILL_LAST_PROJECT_SQL,
    SKILL_SUMMARY_PROPOSED_ONLY_SQL,
    SKILL_SUMMARY_SQL,
} from "../queries/skill-summary.ts";

export { SKILL_DETAIL_SQL } from "../queries/skill-detail.ts";
```

- [ ] Run `bun test apps/axctl/src/queries/skill-detail.test.ts` - expect PASS (4 tests).
- [ ] Run `bun run typecheck` - expect clean (`tui/hooks/useSkillDetail.ts` import path is unchanged).
- [ ] Commit:

```
refactor(queries): make skill-detail SQL canonical, TUI re-exports it

The TUI carried an older fork of SKILL_DETAIL_SQL (daily buckets, no
evidence blocks). Canonical SQL now includes daily, so tui/queries.ts
re-exports instead of forking. Adds the first skill-detail test.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Task 2: Move `fetchSkillDetail` + mappers into `queries/skill-detail.ts`

`fetchSkillDetail` and its row mappers (`parseRecent`/`parsePair`/`parseProposal`/`tsField`, `dashboard/triage.ts:454-535`) are the query's execution half but live in a dashboard file; `dashboard/server.ts` imports them from there. Move them into the query module, rename mappers to the `map*Row` convention, and promote the duplicated `numericField` helper into `@ax/lib/shared/row-fields`.

**Files:**
- Modify: `packages/lib/src/shared/row-fields.ts` (add `numericField` after `numberField`, ~line 45)
- Modify: `packages/lib/src/shared/row-fields.test.ts` (add `numericField` describe block)
- Modify: `apps/axctl/src/queries/skill-detail.ts` (add imports, mappers, `fetchSkillDetail`)
- Modify: `apps/axctl/src/queries/skill-detail.test.ts` (add mapper + fetch tests)
- Modify: `apps/axctl/src/dashboard/triage.ts` (remove lines 454–535: `tsField`, `parseRecent`, `parsePair`, `parseProposal`, `fetchSkillDetail`; trim imports)
- Modify: `apps/axctl/src/dashboard/server.ts` (import `fetchSkillDetail` from the query module instead of `./triage.ts`, lines 11–19 + new import)

**Steps:**

- [ ] Add failing tests to `packages/lib/src/shared/row-fields.test.ts` (append, matching the file's existing `describe`/`test` style):

```ts
describe("numericField", () => {
    test("coerces numeric-ish values, defaults to 0", () => {
        expect(numericField({ n: 3 }, "n")).toBe(3);
        expect(numericField({ n: "3" }, "n")).toBe(3);
        expect(numericField({}, "n")).toBe(0);
        expect(numericField({ n: Number.NEGATIVE_INFINITY }, "n")).toBe(0);
        expect(numericField({ n: "junk" }, "n")).toBe(0);
    });
});
```

  and add `numericField` to the import list on line 2 of that test file.

- [ ] Run `bun test packages/lib/src/shared/row-fields.test.ts` - expect FAIL (no export).
- [ ] Add to `packages/lib/src/shared/row-fields.ts` after `numberField` (line 45):

```ts
/** Number at `key` coerced from any numeric-ish value (string counts, Date
 *  no); non-finite or missing → `0`. Use for aggregate counts where a
 *  missing column means zero. */
export const numericField = (
    row: Record<string, unknown>,
    key: string,
): number => {
    const v = Number(row[key] ?? 0);
    return Number.isFinite(v) ? v : 0;
};
```

- [ ] Run `bun test packages/lib/src/shared/row-fields.test.ts` - expect PASS.
- [ ] Add failing tests to `apps/axctl/src/queries/skill-detail.test.ts` (append new describes; extend the import from `./skill-detail.ts` with `fetchSkillDetail, mapSkillPairRow, mapSkillProposalRow, mapSkillRecentRow`; add the mock-db helper imports):

```ts
import { Effect } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";

/** Mock SurrealClientShape returning canned responses per query() call,
 *  copied from dashboard/skills-weighted.test.ts. */
function makeMockDb(responses: Array<unknown>): SurrealClientShape {
    let callIndex = 0;
    return {
        query: <T extends unknown[] = unknown[]>(
            _sql: string,
            _bindings?: Record<string, unknown>,
        ): Effect.Effect<T, DbError> => {
            const resp = responses[callIndex] ?? [[]];
            callIndex++;
            return Effect.succeed(resp as unknown as T);
        },
        upsert: () => Effect.void,
        relate: () => Effect.void,
        putFile: () => Effect.void,
        getFile: () => Effect.succeed(""),
        raw: {} as never,
    } as unknown as SurrealClientShape;
}

const runWithMock = <A>(
    db: SurrealClientShape,
    effect: Effect.Effect<A, unknown, SurrealClient>,
): Promise<A> =>
    Effect.runPromise(effect.pipe(Effect.provideService(SurrealClient, db)));

describe("skill-detail row mappers", () => {
    test("mapSkillRecentRow keeps ts/project and optional turn_has_error", () => {
        expect(
            mapSkillRecentRow({
                ts: "2026-06-01T00:00:00.000Z",
                project: "-Users-necmttn-Projects-ax",
                turn_has_error: true,
            }),
        ).toEqual({
            ts: "2026-06-01T00:00:00.000Z",
            project: "-Users-necmttn-Projects-ax",
            turn_has_error: true,
        });
        expect(mapSkillRecentRow({ project: "x" })).toBeNull(); // no ts
        expect(mapSkillRecentRow(null)).toBeNull();
    });

    test("mapSkillPairRow requires a partner", () => {
        expect(
            mapSkillPairRow({ partner: "tdd", count: 4, last_seen: "2026-06-01T00:00:00.000Z" }),
        ).toEqual({ partner: "tdd", count: 4, last_seen: "2026-06-01T00:00:00.000Z" });
        expect(mapSkillPairRow({ count: 4 })).toBeNull();
    });

    test("mapSkillProposalRow requires ts", () => {
        expect(
            mapSkillProposalRow({ ts: "2026-06-01T00:00:00.000Z", project: null, context_excerpt: "..." }),
        ).toEqual({ ts: "2026-06-01T00:00:00.000Z", project: null, context_excerpt: "..." });
        expect(mapSkillProposalRow({ project: "x" })).toBeNull();
    });
});

describe("fetchSkillDetail", () => {
    test("parses the RETURN block (last non-null statement result)", async () => {
        // db.query returns one entry per statement: LET → null, RETURN → payload.
        const payload = {
            skill: { name: "tdd", scope: "plugin", description: "d", dir_path: "/tmp/tdd" },
            invocations: { total: 12, d7: 2, d30: 9, last: "2026-06-09T00:00:00.000Z" },
            recent: [{ ts: "2026-06-09T00:00:00.000Z", project: "p", turn_has_error: false }],
            corrections: [],
            proposals: [{ ts: "2026-06-01T00:00:00.000Z", project: "p", context_excerpt: "e" }],
            paired: [{ partner: "caveman", count: 3, last_seen: "2026-06-08T00:00:00.000Z" }],
        };
        const db = makeMockDb([[null, payload]]);
        const result = await runWithMock(db, fetchSkillDetail("tdd"));

        expect(result.name).toBe("tdd");
        expect(result.scope).toBe("plugin");
        expect(result.invocations).toEqual({
            total: 12, d7: 2, d30: 9, last: "2026-06-09T00:00:00.000Z",
        });
        expect(result.recent).toHaveLength(1);
        expect(result.proposals).toHaveLength(1);
        expect(result.paired[0]!.partner).toBe("caveman");
    });

    test("degrades to empty payload when the skill row is missing", async () => {
        const db = makeMockDb([[null, { skill: null, invocations: {}, recent: [], corrections: [], proposals: [], paired: [] }]]);
        const result = await runWithMock(db, fetchSkillDetail("ghost"));
        expect(result.scope).toBeNull();
        expect(result.invocations.total).toBe(0);
        expect(result.recent).toEqual([]);
    });
});
```

- [ ] Run `bun test apps/axctl/src/queries/skill-detail.test.ts` - expect FAIL (no such exports).
- [ ] Rewrite `apps/axctl/src/queries/skill-detail.ts`: keep `SKILL_DETAIL_SQL` exactly as Task 1 left it, add imports at the top and the fetch section below the SQL. The mapper bodies are moved **verbatim** from `dashboard/triage.ts:454-495` (renamed `parseRecent` → `mapSkillRecentRow`, `parsePair` → `mapSkillPairRow`, `parseProposal` → `mapSkillProposalRow`), and `fetchSkillDetail` is moved verbatim from `triage.ts:497-535` with the mapper renames applied. Full module skeleton:

```ts
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { dateField, numericField, stringField } from "@ax/lib/shared/row-fields";
import type {
    SkillDetailPayload,
    SkillPair,
    SkillProposalEvidence,
    SkillRecentInvocation,
} from "@ax/lib/shared/dashboard-types";

export const SKILL_DETAIL_SQL = `...unchanged from Task 1...`;

/** Empty-string fallback so mapper guards can test truthiness. */
const tsField = (raw: Record<string, unknown>, key: string): string =>
    dateField(raw, key) ?? "";

export const mapSkillRecentRow = (raw: unknown): SkillRecentInvocation | null => {
    if (!raw || typeof raw !== "object") return null;
    const row = raw as Record<string, unknown>;
    const ts = tsField(row, "ts");
    if (!ts) return null;
    return {
        ts,
        project: stringField(row, "project"),
        ...(typeof row.turn_has_error === "boolean"
            ? { turn_has_error: row.turn_has_error }
            : {}),
    };
};

export const mapSkillPairRow = (raw: unknown): SkillPair | null => {
    if (!raw || typeof raw !== "object") return null;
    const row = raw as Record<string, unknown>;
    const partner = stringField(row, "partner");
    if (!partner) return null;
    return {
        partner,
        count: numericField(row, "count"),
        last_seen: dateField(row, "last_seen"),
    };
};

export const mapSkillProposalRow = (raw: unknown): SkillProposalEvidence | null => {
    if (!raw || typeof raw !== "object") return null;
    const row = raw as Record<string, unknown>;
    const ts = tsField(row, "ts");
    if (!ts) return null;
    return {
        ts,
        project: stringField(row, "project"),
        context_excerpt: stringField(row, "context_excerpt"),
    };
};

export const fetchSkillDetail = (
    name: string,
): Effect.Effect<SkillDetailPayload, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const result = yield* db.query<unknown[]>(SKILL_DETAIL_SQL, { name });
        // RETURN { ... } gives us [block] where block is the object.
        const payload = Array.isArray(result)
            ? ([...result].reverse().find((r) => r != null) as Record<string, unknown> | undefined)
            : (result as Record<string, unknown> | undefined);
        const skill = (payload?.skill ?? null) as Record<string, unknown> | null;
        const invocations = (payload?.invocations ?? {}) as Record<string, unknown>;
        const recent = Array.isArray(payload?.recent) ? payload.recent : [];
        const corrections = Array.isArray(payload?.corrections) ? payload.corrections : [];
        const proposals = Array.isArray(payload?.proposals) ? payload.proposals : [];
        const paired = Array.isArray(payload?.paired) ? payload.paired : [];
        return {
            name,
            scope: skill ? stringField(skill, "scope") : null,
            description: skill ? stringField(skill, "description") : null,
            dir_path: skill ? stringField(skill, "dir_path") : null,
            invocations: {
                total: numericField(invocations, "total"),
                d7: numericField(invocations, "d7"),
                d30: numericField(invocations, "d30"),
                last: dateField(invocations, "last"),
            },
            recent: recent.map(mapSkillRecentRow).filter((r): r is SkillRecentInvocation => r !== null),
            corrections: corrections
                .map(mapSkillRecentRow)
                .filter((r): r is SkillRecentInvocation => r !== null),
            proposals: proposals
                .map(mapSkillProposalRow)
                .filter((r): r is SkillProposalEvidence => r !== null),
            paired: paired
                .map(mapSkillPairRow)
                .filter((r): r is SkillPair => r !== null),
        };
    });
```

  (`SkillDetailPayload` stays in `@ax/lib/shared/dashboard-types` - it's the wire type the web SPA also consumes. We deliberately do NOT add `daily` to it; the dashboard ignores the extra SQL field and the TUI parses the raw payload itself.)

- [ ] In `apps/axctl/src/dashboard/triage.ts`: delete lines 454–535 (`tsField`, `parseRecent`, `parsePair`, `parseProposal`, `fetchSkillDetail`). Remove `SKILL_DETAIL_SQL` from the imports (line 11, delete the whole `import { SKILL_DETAIL_SQL } from "../queries/skill-detail.ts";` line). Remove `SkillDetailPayload`, `SkillPair`, `SkillProposalEvidence`, `SkillRecentInvocation` from the type import block (lines 13–23) **after** confirming they have no other uses: `rg -n "SkillDetailPayload|SkillPair|SkillProposalEvidence|SkillRecentInvocation" apps/axctl/src/dashboard/triage.ts` must return only the import lines. Keep the local `numericField`/`stringField`/`dateField` (lines 33–60) - still used by `buildSkillRows`/`parseDecisionRow`.
- [ ] In `apps/axctl/src/dashboard/server.ts`: remove `fetchSkillDetail,` from the `./triage.ts` import block (lines 11–19) and add below it:

```ts
import { fetchSkillDetail } from "../queries/skill-detail.ts";
```

- [ ] Run `bun test apps/axctl/src/queries/skill-detail.test.ts` - expect PASS.
- [ ] Run `bun run typecheck` - expect clean (catches any missed triage references).
- [ ] Commit:

```
refactor(queries): move fetchSkillDetail into queries/skill-detail

Execution half of the skill-detail query moves out of dashboard/triage
next to its SQL; mappers exported as mapSkill*Row for tests. numericField
promoted to @ax/lib/shared/row-fields.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Task 3: Extract `cmdStats` inline SQL → `queries/skill-stats.ts` + `fetchSkillStats()`

`cmdStats` (`cli/index.ts:1073-1193`) hand-rolls a third skill-stats SQL variant (adds `d90` + 50 recent sessions) plus a dedupe/prettify transform plus printing, all in one `Effect.gen`. Extract SQL + types + transform + fetch into a query module; the command body keeps the existence guard, the SKILL.md body read, and `prettyPrint` output. **Output fidelity:** `prettyPrint` is `JSON.stringify(value, null, 2)`; mapping datetimes to ISO strings via `dateField` produces the same printed text the raw `DateTime` objects produced via `toJSON()`.

**Files:**
- Create: `apps/axctl/src/queries/skill-stats.ts`
- Create: `apps/axctl/src/queries/skill-stats.test.ts`
- Modify: `apps/axctl/src/cli/index.ts` (`cmdStats`, lines 1073–1193, plus one import)

**Steps:**

- [ ] Write the failing test `apps/axctl/src/queries/skill-stats.test.ts` (reuse the same `makeMockDb`/`runWithMock` helpers as in `skill-detail.test.ts` - copy them in; they are 30 lines and the project keeps test helpers colocated rather than shared):

```ts
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import {
    SKILL_STATS_SQL,
    dedupeRecentSessions,
    fetchSkillStats,
} from "./skill-stats.ts";

function makeMockDb(responses: Array<unknown>): SurrealClientShape {
    let callIndex = 0;
    return {
        query: <T extends unknown[] = unknown[]>(
            _sql: string,
            _bindings?: Record<string, unknown>,
        ): Effect.Effect<T, DbError> => {
            const resp = responses[callIndex] ?? [[]];
            callIndex++;
            return Effect.succeed(resp as unknown as T);
        },
        upsert: () => Effect.void,
        relate: () => Effect.void,
        putFile: () => Effect.void,
        getFile: () => Effect.succeed(""),
        raw: {} as never,
    } as unknown as SurrealClientShape;
}

const runWithMock = <A>(
    db: SurrealClientShape,
    effect: Effect.Effect<A, unknown, SurrealClient>,
): Promise<A> =>
    Effect.runPromise(effect.pipe(Effect.provideService(SurrealClient, db)));

describe("SKILL_STATS_SQL", () => {
    test("binds by $name and covers 7/30/90d windows", () => {
        expect(SKILL_STATS_SQL).toContain("WHERE name = $name");
        expect(SKILL_STATS_SQL).toContain("time::now() - 7d");
        expect(SKILL_STATS_SQL).toContain("time::now() - 30d");
        expect(SKILL_STATS_SQL).toContain("time::now() - 90d");
    });

    test("recent sessions are ordered server-side and bounded", () => {
        expect(SKILL_STATS_SQL).toContain("ORDER BY ts DESC");
        expect(SKILL_STATS_SQL).toContain("LIMIT 50");
        expect(SKILL_STATS_SQL).toContain("in.session AS session_id");
        expect(SKILL_STATS_SQL).toContain("in.session.cwd AS cwd");
    });
});

describe("dedupeRecentSessions", () => {
    test("dedupes by session id and caps at 5", () => {
        const rows = Array.from({ length: 8 }, (_, i) => ({
            session_id: `session:s${i % 6}`, // s0..s5, s0/s1 repeat
            project_slug: "-Users-necmttn-Projects-ax",
            cwd: null,
            ts: `2026-06-0${(i % 6) + 1}T00:00:00.000Z`,
        }));
        const clean = dedupeRecentSessions(rows);
        expect(clean).toHaveLength(5);
        expect(new Set(clean.map((c) => c.ts)).size).toBe(5);
    });

    test("prefers cwd basename over project slug", () => {
        const clean = dedupeRecentSessions([
            {
                session_id: "session:a",
                project_slug: "-Users-necmttn-Projects-ax",
                cwd: "/Users/necmttn/Projects/ax",
                ts: "2026-06-01T00:00:00.000Z",
            },
        ]);
        expect(clean[0]!.project).toBe("ax");
    });

    test("unwraps array-valued cwd/slug projections", () => {
        const clean = dedupeRecentSessions([
            {
                session_id: "session:a",
                project_slug: ["-Users-necmttn-Projects-ax"],
                cwd: ["/Users/necmttn/Projects/ax"],
                ts: "2026-06-01T00:00:00.000Z",
            },
        ]);
        expect(clean[0]!.project).toBe("ax");
    });
});

describe("fetchSkillStats", () => {
    test("parses payload from the last non-null statement result", async () => {
        const payload = {
            skill: { name: "tdd", scope: "plugin", dir_path: "/tmp/tdd" },
            invocations: { total: 100, d7: 3, d30: 20, d90: 60, last: "2026-06-09T00:00:00.000Z" },
            recent_sessions: [
                { session_id: "session:a", project_slug: "-p-ax", cwd: "/p/ax", ts: "2026-06-09T00:00:00.000Z" },
                { session_id: "session:a", project_slug: "-p-ax", cwd: "/p/ax", ts: "2026-06-08T00:00:00.000Z" },
            ],
        };
        const db = makeMockDb([[null, payload]]);
        const result = await runWithMock(db, fetchSkillStats("tdd"));

        expect(result.skill?.name).toBe("tdd");
        expect(result.invocations).toEqual({
            total: 100, d7: 3, d30: 20, d90: 60, last: "2026-06-09T00:00:00.000Z",
        });
        expect(result.recent_sessions).toEqual([
            { project: "ax", ts: "2026-06-09T00:00:00.000Z" },
        ]);
    });

    test("missing skill yields null skill and zeroed invocations", async () => {
        const db = makeMockDb([[null, { skill: null, invocations: {}, recent_sessions: [] }]]);
        const result = await runWithMock(db, fetchSkillStats("ghost"));
        expect(result.skill).toBeNull();
        expect(result.invocations.total).toBe(0);
        expect(result.recent_sessions).toEqual([]);
    });
});
```

- [ ] Run `bun test apps/axctl/src/queries/skill-stats.test.ts` - expect FAIL (module doesn't exist).
- [ ] Create `apps/axctl/src/queries/skill-stats.ts`. SQL is the **verbatim** inline string from `cli/index.ts:1095-1117`; `dedupeRecentSessions` is the verbatim transform from `cli/index.ts:1129-1157` reshaped into a pure function (ts mapped to ISO string via `dateField`):

```ts
/**
 * `ax skills stats <name>`: one-skill stats payload - invocation counts at
 * 7/30/90 days + the 5 most recent distinct sessions. The CLI formats and
 * prints; this module owns the SQL, the types, and the dedupe transform.
 *
 * Issue #43 history: recent_sessions are ordered by ts DESC server-side,
 * include the session id so we can de-dup in TS, and capture cwd so we can
 * render a human-friendly project label rather than the raw Claude slug.
 *
 * Bindings: $name (skill name).
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { dateField, numericField } from "@ax/lib/shared/row-fields";
import { prettifyProjectSlug } from "@ax/lib/shared/project-slug";

export const SKILL_STATS_SQL = `
LET $s = (SELECT * FROM skill WHERE name = $name)[0];
RETURN {
    skill: $s,
    invocations: {
        total: array::len((SELECT * FROM invoked WHERE out = $s.id)),
        d7:    array::len((SELECT * FROM invoked WHERE out = $s.id AND ts > time::now() - 7d)),
        d30:   array::len((SELECT * FROM invoked WHERE out = $s.id AND ts > time::now() - 30d)),
        d90:   array::len((SELECT * FROM invoked WHERE out = $s.id AND ts > time::now() - 90d)),
        last:  (SELECT ts FROM invoked WHERE out = $s.id ORDER BY ts DESC LIMIT 1)[0].ts,
    },
    recent_sessions: (
        SELECT
            in.session AS session_id,
            in.session.project AS project_slug,
            in.session.cwd AS cwd,
            ts
        FROM invoked
        WHERE out = $s.id
        ORDER BY ts DESC
        LIMIT 50
    )
};`;

export interface SkillStatsInvocations {
    readonly total: number;
    readonly d7: number;
    readonly d30: number;
    readonly d90: number;
    readonly last: string | null;
}

export interface SkillStatsRecentSession {
    readonly project: string;
    readonly ts: string | null;
}

export interface SkillStatsPayload {
    /** Full raw skill row (`$s`) - the CLI prettyPrints it verbatim, so we
     *  keep every column rather than projecting. */
    readonly skill: Record<string, unknown> | null;
    readonly invocations: SkillStatsInvocations;
    readonly recent_sessions: ReadonlyArray<SkillStatsRecentSession>;
}

/**
 * Dedupe + cap to the most recent `cap` distinct sessions, then prettify the
 * project label (cwd basename when available, else the prettified slug).
 * cwd/project_slug may come back as arrays (per-edge projection) - take the
 * first scalar for display purposes.
 */
export const dedupeRecentSessions = (
    rows: ReadonlyArray<Record<string, unknown>>,
    cap = 5,
): SkillStatsRecentSession[] => {
    const seen = new Set<string>();
    const clean: SkillStatsRecentSession[] = [];
    for (const row of rows) {
        const sid = String(row.session_id ?? "");
        if (sid && seen.has(sid)) continue;
        if (sid) seen.add(sid);
        const cwdRaw = Array.isArray(row.cwd) ? row.cwd[0] : row.cwd;
        const slugRaw = Array.isArray(row.project_slug)
            ? row.project_slug[0]
            : row.project_slug;
        let project: string;
        if (typeof cwdRaw === "string" && cwdRaw.length > 0) {
            // Mirrors path.basename without pulling node:path here.
            const parts = cwdRaw.split("/").filter((p) => p.length > 0);
            project = parts.length > 0 ? parts[parts.length - 1] : cwdRaw;
        } else {
            project = prettifyProjectSlug(slugRaw);
        }
        clean.push({ project, ts: dateField(row, "ts") });
        if (clean.length >= cap) break;
    }
    return clean;
};

export const fetchSkillStats = (
    name: string,
): Effect.Effect<SkillStatsPayload, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const result = yield* db.query<unknown[]>(SKILL_STATS_SQL, { name });
        // LET → null, RETURN → payload: take the last non-null statement result.
        const payload = (Array.isArray(result)
            ? [...result].reverse().find((r) => r != null)
            : result) as Record<string, unknown> | undefined;
        const skill = (payload?.skill ?? null) as Record<string, unknown> | null;
        const invocations = (payload?.invocations ?? {}) as Record<string, unknown>;
        const recentRaw = Array.isArray(payload?.recent_sessions)
            ? (payload.recent_sessions as Array<Record<string, unknown>>)
            : [];
        return {
            skill,
            invocations: {
                total: numericField(invocations, "total"),
                d7: numericField(invocations, "d7"),
                d30: numericField(invocations, "d30"),
                d90: numericField(invocations, "d90"),
                last: dateField(invocations, "last"),
            },
            recent_sessions: dedupeRecentSessions(recentRaw),
        };
    });
```

  (If `bun run typecheck` flags `parts[parts.length - 1]` under `noUncheckedIndexedAccess`, append `?? cwdRaw`; the original CLI line compiled without it in the same workspace config, so it should be fine as-is.)

- [ ] Run `bun test apps/axctl/src/queries/skill-stats.test.ts` - expect PASS.
- [ ] In `apps/axctl/src/cli/index.ts`, add the import next to the other `../queries/` imports (around line 85, by `INSIGHT_VIEWS`):

```ts
import { fetchSkillStats } from "../queries/skill-stats.ts";
```

  Then replace `cmdStats` (lines 1073–1193) with the slim adapter - the existence guard, the lazily-read SKILL.md body excerpt (verbatim from lines 1159–1191), and the final print survive; the inline SQL (1095–1117) and the dedupe block (1128–1157) are deleted:

```ts
const cmdStats = (args: string[]) =>
    Effect.gen(function* () {
        const name = args.filter((a) => !a.startsWith("--"))[0];
        if (!name) {
            console.error("axctl skills stats: missing skill name");
            process.exit(1);
        }
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exists = yield* skillExists(name);
        if (!exists) {
            const hint = name.length > 20 ? name.slice(0, 20) : name;
            console.error(
                `axctl: no skill named "${name}". try: axctl skills search "${hint}"`,
            );
            process.exit(2);
        }
        const payload = yield* fetchSkillStats(name);

        // Read body lazily from disk via dir_path (DB no longer stores body -
        // multi-file skills + cache-staleness make on-disk the canonical source).
        const dirPath = payload.skill?.dir_path;
        // Issue #36: codex-side tools are recorded with a synthetic dir_path
        // sentinel. They have no SKILL.md, so skip the disk read entirely
        // instead of letting Effect.promise(...) crash with ENOENT.
        if (
            typeof dirPath === "string" &&
            dirPath.length > 0 &&
            dirPath !== "(synthetic)"
        ) {
            const body = yield* fs
                .readFileString(path.join(dirPath, "SKILL.md"))
                .pipe(orAbsent<string | null>(null));
            if (body !== null) {
                const m = body.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
                const trimmed = (m?.[1] ?? body).trim();
                if (trimmed.length > 0) {
                    const excerpt =
                        trimmed.length > 500 ? trimmed.slice(0, 500) + "…" : trimmed;
                    console.log("--- body excerpt ---");
                    console.log(excerpt);
                    console.log("--- end body ---\n");
                }
            }
        }
        console.log(prettyPrint(payload));
    });
```

  Note: the old `const db = yield* SurrealClient;` line is gone (the fetch resolves the service itself; `skillExists` already pulls its own). Keep the longer comments from `1159-1176` if you prefer - they're shown abridged above only for the orAbsent rationale; copy the originals verbatim.

- [ ] Run `bun run typecheck` - expect clean.
- [ ] Smoke (optional, needs a running local DB): `bun apps/axctl/src/cli/index.ts skills stats tdd` and eyeball that the JSON shape still has `skill` / `invocations{total,d7,d30,d90,last}` / `recent_sessions[{project,ts}]`.
- [ ] Commit:

```
refactor(cli): extract skills-stats query into queries/skill-stats

cmdStats becomes guard + fetchSkillStats + body excerpt + prettyPrint.
SQL, payload types, and the session-dedupe transform now live in the
query module with colocated tests.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Task 4: Extract `cmdUnused` orchestration → `queries/unused-skills.ts` + `fetchUnusedSkills()`

`cmdUnused` (`cli/index.ts:1213-1344`) runs 4 inline queries (recent-active GROUP BY, bulk summary, skill rows, never-invoked rows), anti-joins in TS, sorts, then prints with agent-scope filtering. The DB orchestration + merge move to the query module; flag parsing, `loadAgentScopeMap` (disk read), agent-scope filtering, and printing stay in the CLI.

**Files:**
- Create: `apps/axctl/src/queries/unused-skills.ts`
- Create: `apps/axctl/src/queries/unused-skills.test.ts`
- Modify: `apps/axctl/src/cli/index.ts` (`cmdUnused`, lines 1213–1344, plus one import)

**Steps:**

- [ ] Write the failing test `apps/axctl/src/queries/unused-skills.test.ts` (same colocated `makeMockDb`/`runWithMock` helpers as Task 3 - copy them in):

```ts
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import {
    UNUSED_RECENT_SQL,
    UNUSED_SUMMARY_SQL,
    UNUSED_SKILL_ROWS_SQL,
    UNUSED_NEVER_INVOKED_SQL,
    normalizeLastUsed,
    mergeUnusedRows,
    fetchUnusedSkills,
} from "./unused-skills.ts";

function makeMockDb(responses: Array<unknown>): SurrealClientShape {
    let callIndex = 0;
    return {
        query: <T extends unknown[] = unknown[]>(
            _sql: string,
            _bindings?: Record<string, unknown>,
        ): Effect.Effect<T, DbError> => {
            const resp = responses[callIndex] ?? [[]];
            callIndex++;
            return Effect.succeed(resp as unknown as T);
        },
        upsert: () => Effect.void,
        relate: () => Effect.void,
        putFile: () => Effect.void,
        getFile: () => Effect.succeed(""),
        raw: {} as never,
    } as unknown as SurrealClientShape;
}

const runWithMock = <A>(
    db: SurrealClientShape,
    effect: Effect.Effect<A, unknown, SurrealClient>,
): Promise<A> =>
    Effect.runPromise(effect.pipe(Effect.provideService(SurrealClient, db)));

describe("unused-skills SQL", () => {
    test("recent scan splices a validated day window and groups by out", () => {
        const sql = UNUSED_RECENT_SQL(7);
        expect(sql).toContain("time::now() - 7d");
        expect(sql).toContain("GROUP BY out");
        expect(sql).toContain("FROM invoked");
    });

    test("recent scan rejects non-positive / non-integer day windows", () => {
        expect(() => UNUSED_RECENT_SQL(0)).toThrow(RangeError);
        expect(() => UNUSED_RECENT_SQL(-3)).toThrow(RangeError);
        expect(() => UNUSED_RECENT_SQL(1.5)).toThrow(RangeError);
    });

    test("summary aggregates over the edge table only (issue #34)", () => {
        expect(UNUSED_SUMMARY_SQL).toContain("GROUP BY out");
        expect(UNUSED_SUMMARY_SQL).not.toContain("out.name");
    });

    test("never-invoked scan excludes tombstoned skills", () => {
        expect(UNUSED_NEVER_INVOKED_SQL).toContain("array::len(<-invoked) = 0");
        expect(UNUSED_NEVER_INVOKED_SQL).toContain("deleted_at IS NONE");
    });

    test("skill rows query is a cheap projection", () => {
        expect(UNUSED_SKILL_ROWS_SQL).toContain("SELECT id, name, scope FROM skill");
    });
});

describe("normalizeLastUsed", () => {
    test("null / -Infinity (empty math::max group) → null", () => {
        expect(normalizeLastUsed(null)).toBeNull();
        expect(normalizeLastUsed(undefined)).toBeNull();
        expect(normalizeLastUsed(Number.NEGATIVE_INFINITY)).toBeNull();
    });
    test("string passthrough, Date → ISO", () => {
        expect(normalizeLastUsed("2026-06-01T00:00:00.000Z")).toBe("2026-06-01T00:00:00.000Z");
        expect(normalizeLastUsed(new Date("2026-06-01T00:00:00.000Z"))).toBe("2026-06-01T00:00:00.000Z");
    });
    test("toJSON objects (SurrealDB DateTime) → ISO", () => {
        expect(normalizeLastUsed({ toJSON: () => "2026-06-01T00:00:00.000Z" })).toBe(
            "2026-06-01T00:00:00.000Z",
        );
    });
});

describe("mergeUnusedRows", () => {
    const skills = [
        { id: "skill:a", name: "alpha", scope: "user" },
        { id: "skill:b", name: "beta", scope: "plugin" },
        { id: "skill:c", name: "gamma", scope: "user" },
    ];

    test("anti-joins recent-active skills out and sorts by total then name", () => {
        const rows = mergeUnusedRows({
            recent: [{ skill_id: "skill:a" }],
            summary: [
                { skill_id: "skill:a", total_inv: 50, last_used: "2026-06-09T00:00:00.000Z" },
                { skill_id: "skill:b", total_inv: 9, last_used: "2026-04-01T00:00:00.000Z" },
                { skill_id: "skill:c", total_inv: 2, last_used: "2026-03-01T00:00:00.000Z" },
            ],
            skills,
            neverInvoked: [],
        });
        expect(rows.map((r) => r.name)).toEqual(["gamma", "beta"]);
        expect(rows[0]!.last_used).toBe("2026-03-01T00:00:00.000Z");
    });

    test("drops orphan invocation groups whose skill row is missing", () => {
        const rows = mergeUnusedRows({
            recent: [],
            summary: [{ skill_id: "skill:ghost", total_inv: 4, last_used: null }],
            skills,
            neverInvoked: [],
        });
        expect(rows).toEqual([]);
    });

    test("appends never-invoked skills with zero totals and null last_used", () => {
        const rows = mergeUnusedRows({
            recent: [],
            summary: [],
            skills,
            neverInvoked: [{ name: "delta", scope: "user" }],
        });
        expect(rows).toEqual([
            { name: "delta", scope: "user", total_inv: 0, last_used: null },
        ]);
    });
});

describe("fetchUnusedSkills", () => {
    test("runs the 4 scans and merges", async () => {
        const db = makeMockDb([
            [[{ skill_id: "skill:a", recent: 3 }]],                                            // recent
            [[
                { skill_id: "skill:a", total_inv: 50, last_used: "2026-06-09T00:00:00.000Z" },
                { skill_id: "skill:b", total_inv: 9, last_used: "2026-04-01T00:00:00.000Z" },
            ]],                                                                                 // summary
            [[
                { id: "skill:a", name: "alpha", scope: "user" },
                { id: "skill:b", name: "beta", scope: "plugin" },
            ]],                                                                                 // skill rows
            [[{ name: "delta", scope: "user" }]],                                               // never invoked
        ]);
        const rows = await runWithMock(db, fetchUnusedSkills({ days: 7 }));
        expect(rows.map((r) => r.name)).toEqual(["delta", "beta"]);
        expect(rows[0]).toEqual({ name: "delta", scope: "user", total_inv: 0, last_used: null });
    });
});
```

- [ ] Run `bun test apps/axctl/src/queries/unused-skills.test.ts` - expect FAIL (module doesn't exist).
- [ ] Create `apps/axctl/src/queries/unused-skills.ts`. SQL strings are **verbatim** from `cli/index.ts:1230-1252` (with the perf comments preserved in the docblocks):

```ts
/**
 * `ax skills unused`: skills with no invocations inside a recency window.
 *
 * PERF (issue #31): an earlier form ran a correlated subquery per skill
 * (`SELECT count() FROM invoked WHERE out = $parent.id AND ts > N`). On the
 * largest skill (~500k invoked edges) the index walk took ~1.5s × 137 skills.
 * Now we (a) compute the recent-active set in one full-scan GROUP BY over
 * `invoked`, (b) compute total_inv + last_used in bulk, (c) anti-join in TS.
 * Net round-trip: ~2 cheap queries.
 *
 * Issue #34: `out.name AS name` over a GROUP BY scan returns the per-edge
 * name array (~500k entries for codex:exec_command); String() of that is a
 * 17 MB single line. So we aggregate over the edge table only and look up
 * skill rows by id in a separate cheap query, merging in TS.
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";

const checkedDays = (days: number): number => {
    if (!Number.isInteger(days) || days <= 0) {
        throw new RangeError(`days must be a positive integer (got ${days})`);
    }
    return days;
};

/** Skills with ≥1 invocation inside the window - the "still active" set. */
export const UNUSED_RECENT_SQL = (days: number): string => `
SELECT out AS skill_id, count() AS recent
FROM invoked
WHERE ts > time::now() - ${checkedDays(days)}d
GROUP BY out;`;

/** Bulk per-skill totals + last_used over the whole edge table. */
export const UNUSED_SUMMARY_SQL = `
SELECT
    out AS skill_id,
    count() AS total_inv,
    math::max(ts) AS last_used
FROM invoked
GROUP BY out;`;

/** Cheap id → (name, scope) lookup, merged in TS. */
export const UNUSED_SKILL_ROWS_SQL = `SELECT id, name, scope FROM skill;`;

/** Skills with literally zero invocations don't show up in the GROUP BY
 *  scan; pull them straight from the skill table so the "never used" rows
 *  still appear. */
export const UNUSED_NEVER_INVOKED_SQL = `
SELECT name, scope FROM skill WHERE array::len(<-invoked) = 0 AND deleted_at IS NONE;`;

export interface UnusedSkillRow {
    readonly name: string;
    readonly scope: string;
    readonly total_inv: number;
    /** ISO timestamp of last use; `null` = never used. */
    readonly last_used: string | null;
}

/**
 * SurrealDB's math::max returns -Infinity for empty groups; normalise that
 * (and null/undefined) to `null`. Datetimes arrive as string, Date, or a
 * DateTime-like `{toJSON}` object depending on path.
 */
export const normalizeLastUsed = (v: unknown): string | null => {
    if (v == null) return null;
    if (typeof v === "number" && !Number.isFinite(v)) return null;
    if (typeof v === "string") return v;
    if (v instanceof Date) return v.toISOString();
    if (typeof v === "object" && "toJSON" in v) {
        const j = (v as { toJSON: () => unknown }).toJSON();
        if (typeof j === "string" && j.length > 0) return j;
    }
    return String(v);
};

export interface UnusedScanRows {
    readonly recent: ReadonlyArray<Record<string, unknown>>;
    readonly summary: ReadonlyArray<Record<string, unknown>>;
    readonly skills: ReadonlyArray<Record<string, unknown>>;
    readonly neverInvoked: ReadonlyArray<Record<string, unknown>>;
}

/** Anti-join the recent-active set out of the bulk summary, drop orphan
 *  invocation groups (no skill row - matches the original FROM-skill
 *  behaviour), append never-invoked skills, sort by total then name. */
export const mergeUnusedRows = (input: UnusedScanRows): UnusedSkillRow[] => {
    const recentIds = new Set<string>(
        input.recent.map((r) => String(r.skill_id ?? "")),
    );
    const skillById = new Map<string, { name: string; scope: string }>();
    for (const s of input.skills) {
        skillById.set(String(s.id ?? ""), {
            name: String(s.name ?? ""),
            scope: String(s.scope ?? ""),
        });
    }
    const unused: UnusedSkillRow[] = [];
    for (const r of input.summary) {
        const id = String(r.skill_id ?? "");
        if (recentIds.has(id)) continue;
        const meta = skillById.get(id);
        if (!meta || !meta.name) continue;
        unused.push({
            name: meta.name,
            scope: meta.scope,
            total_inv: Number(r.total_inv ?? 0),
            last_used: normalizeLastUsed(r.last_used),
        });
    }
    for (const r of input.neverInvoked) {
        unused.push({
            name: String(r.name ?? ""),
            scope: String(r.scope ?? ""),
            total_inv: 0,
            last_used: null,
        });
    }
    unused.sort(
        (a, b) => a.total_inv - b.total_inv || a.name.localeCompare(b.name),
    );
    return unused;
};

export interface UnusedSkillsParams {
    readonly days: number;
}

export const fetchUnusedSkills = (
    params: UnusedSkillsParams,
): Effect.Effect<ReadonlyArray<UnusedSkillRow>, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const [recentRes, summaryRes, skillRes, noInvRes] = yield* Effect.all(
            [
                db.query<[Array<Record<string, unknown>>]>(UNUSED_RECENT_SQL(params.days)),
                db.query<[Array<Record<string, unknown>>]>(UNUSED_SUMMARY_SQL),
                db.query<[Array<Record<string, unknown>>]>(UNUSED_SKILL_ROWS_SQL),
                db.query<[Array<Record<string, unknown>>]>(UNUSED_NEVER_INVOKED_SQL),
            ],
            { concurrency: 4 },
        );
        return mergeUnusedRows({
            recent: recentRes?.[0] ?? [],
            summary: summaryRes?.[0] ?? [],
            skills: skillRes?.[0] ?? [],
            neverInvoked: noInvRes?.[0] ?? [],
        });
    });
```

- [ ] Run `bun test apps/axctl/src/queries/unused-skills.test.ts` - expect PASS.
- [ ] In `apps/axctl/src/cli/index.ts`, add the import next to the Task 3 one:

```ts
import { fetchUnusedSkills } from "../queries/unused-skills.ts";
```

  Replace `cmdUnused` (lines 1213–1344) with the slim adapter (agent-scope semantics and exact output strings preserved; `last_used: null` prints as `never` exactly as the old `fmtTs` did):

```ts
const cmdUnused = (args: string[]) =>
    Effect.gen(function* () {
        const days = parsePositiveIntFlag("unused", "days", args, 7);
        const includeScoped = args.includes("--include-scoped");
        // Skills declared in a subagent's `skills:` frontmatter load only when
        // that agent is spawned - they're not global dead weight. Recover the
        // skill → agent(s) map from disk so they can be hidden/tagged here.
        const agentScope = yield* loadAgentScopeMap();
        const unused = yield* fetchUnusedSkills({ days });
        let hiddenScoped = 0;
        for (const r of unused) {
            const last = r.last_used ?? "never";
            const agents = agentScope.get(r.name);
            if (agents && agents.length > 0) {
                // Agent-scoped: not global dead weight. Hide unless asked,
                // and when shown, tag with the owning agent(s) instead of scope.
                if (!includeScoped) {
                    hiddenScoped++;
                    continue;
                }
                console.log(
                    `${r.name}  [agent:${agents.join(",")}]  total=${fmtCount(r.total_inv)}  last=${last}`,
                );
                continue;
            }
            console.log(
                `${r.name}  [${r.scope}]  total=${fmtCount(r.total_inv)}  last=${last}`,
            );
        }
        const shown = unused.length - (includeScoped ? 0 : hiddenScoped);
        console.log(`\n${shown} skills unused in last ${days} days.`);
        if (hiddenScoped > 0 && !includeScoped) {
            console.log(
                `${hiddenScoped} agent-scoped skills hidden (load only inside a subagent); --include-scoped to show.`,
            );
        }
    });
```

- [ ] Run `bun run typecheck` - expect clean.
- [ ] Smoke (optional, needs local DB): `bun apps/axctl/src/cli/index.ts skills unused --days=7` - same row format as before.
- [ ] Commit:

```
refactor(cli): extract unused-skills scan into queries/unused-skills

cmdUnused becomes flags + loadAgentScopeMap + fetchUnusedSkills + print.
The 4-scan anti-join (perf notes #31/#34 preserved) and last_used
normalisation move to the query module with merge-logic tests.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Task 5: Close the test gap on `queries/episode-timeline.ts`

The only remaining SQL-only module with a live consumer (`dashboard/episode-timeline.ts` `fetchEpisodeTimeline`) and **no colocated test**. Its builders splice a caller-validated record-id literal - lock the shape and bounds. Relocating `fetchEpisodeTimeline` itself is deferred to Phase 2 (it is a 200-line orchestrator with dashboard-DTO mapping; moving it buys nothing until the dashboard adapter layer is restructured).

**Files:**
- Create: `apps/axctl/src/queries/episode-timeline.test.ts`

**Steps:**

- [ ] Write the test:

```ts
import { describe, expect, test } from "bun:test";
import {
    EPISODE_PARENT_SQL,
    EPISODE_CHILDREN_SQL,
    EPISODE_PARENT_INVOCATIONS_SQL,
    EPISODE_CHILD_INVOCATIONS_SQL,
} from "./episode-timeline.ts";

const PARENT = "session:⟨019e0ad4-c977-7e36-a8b5-0a1b2c3d4e5f⟩";

describe("episode-timeline SQL builders", () => {
    test("parent select interpolates the validated record ref", () => {
        const sql = EPISODE_PARENT_SQL(PARENT);
        expect(sql).toContain(`FROM ${PARENT};`);
        expect(sql).toContain("started_at");
        expect(sql).toContain("ended_at");
    });

    test("children scan is bounded and ordered by spawn time", () => {
        const sql = EPISODE_CHILDREN_SQL(PARENT);
        expect(sql).toContain(`WHERE in = ${PARENT}`);
        expect(sql).toContain("ORDER BY out.started_at ASC");
        expect(sql).toContain("LIMIT 500");
    });

    test("parent invocations walk the in.session index and bound the scan", () => {
        const sql = EPISODE_PARENT_INVOCATIONS_SQL(PARENT);
        expect(sql).toContain(`WHERE in.session = ${PARENT}`);
        expect(sql).toContain("out.name IS NOT NONE");
        expect(sql).toContain("LIMIT 5000");
    });

    test("child invocations take a pre-materialised id array literal (no IN-subquery)", () => {
        const literal = `[${PARENT}]`;
        const sql = EPISODE_CHILD_INVOCATIONS_SQL(literal);
        expect(sql).toContain(`WHERE in.session IN ${literal}`);
        expect(sql).not.toContain("SELECT out FROM spawned"); // no subquery regression
        expect(sql).toContain("LIMIT 20000");
    });
});
```

- [ ] Run `bun test apps/axctl/src/queries/episode-timeline.test.ts` - expect PASS immediately (these are characterisation tests for existing SQL; no implementation change). If any assertion fails, the SQL drifted from what was read on 2026-06-10 - fix the **test** to match the current SQL, not the SQL.
- [ ] Commit:

```
test(queries): characterise episode-timeline SQL builders

Locks record-ref interpolation, index-walk predicates, and scan bounds
for the last untested SQL-only query module with a live consumer.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Task 6: Final verification sweep

**Files:** none new; fixes only if verification fails.

**Steps:**

- [ ] `bun run typecheck` from the repo root - expect clean.
- [ ] `bun test apps/axctl/src/queries` - all query-module tests pass (including the pre-existing ones: feedback-cases, graph-health, insights, insights-enrich, session-detail, session-turn-content, skill-summary, workflow, wrapped).
- [ ] `bun test packages/lib/src/shared/row-fields.test.ts` - passes.
- [ ] `bun test apps/axctl/src/dashboard/skills-weighted.test.ts apps/axctl/src/dashboard/session-view.test.ts` - dashboard consumers unaffected.
- [ ] `rg -n "SKILL_DETAIL_SQL = \`" apps/axctl/src` - exactly **one** definition (`queries/skill-detail.ts`).
- [ ] `rg -n "fetchSkillDetail" apps/axctl/src` - defined once in `queries/skill-detail.ts`; imported by `dashboard/server.ts` only (plus tests).
- [ ] If anything failed and required a fix, commit:

```
fix(queries): post-extraction verification fixes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Out of scope this phase (Follow-ups for Phase 2)

- **`cli/index.ts` decomposition** (~5,870 LOC): remaining hand-rolled queries - `cmdSearch` (~line 812, skill name match counts), `cmdTaste` (~line 1004, leaderboard variant), `cmdRecent` (~line 1199, recent invocations), `skillExists` (~line 1062), and the `FROM invoked` site near line 1548. Extract per the contract above when the CLI is restructured.
- **`queries/skill-summary.ts` consolidation**: two consumers (`tui/hooks/useSkills.ts`, `dashboard/triage.ts` `buildSkillRows`) run the same 4 SQL constants through *different* merge/score pipelines. Unify into one `fetchSkillSummary` when the TUI's client-side hook strategy is revisited (the TUI provides `SurrealClientShape` directly via `Effect.provideService(SurrealClient, client)` - same mechanism the tests use, so this is mechanical once the result shapes are reconciled).
- **Relocate `fetchEpisodeTimeline`** from `dashboard/episode-timeline.ts` into `queries/episode-timeline.ts` (with its DTO mappers) during the dashboard adapter restructure.
- **Colocated tests** for the already-conforming `defineQuery` modules: `project.ts`, `recall.ts`, `session-view.ts` (its test currently lives at `dashboard/session-view.test.ts`), `skill-graph.ts`, `tool-failures.ts`, `hooks.ts`.
- **`SkillDetailPayload.daily`**: if the web dashboard ever wants the sparkline, add `readonly daily: ReadonlyArray<{ readonly ts: string }>` to `@ax/lib/shared/dashboard-types` and map it in `fetchSkillDetail`; the SQL already returns it after Task 1.
