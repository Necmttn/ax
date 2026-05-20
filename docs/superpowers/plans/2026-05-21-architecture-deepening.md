# Architecture Deepening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deepen six shallow seams in `ax` - one SurrealQL literal seam, one statement-executor seam, a dependency-graph ingest pipeline, a paired query+mapper read seam, and converge the hook write path onto the ingest write path.

**Architecture:** Six phases run in dependency order. Phase 0 records vocabulary + decisions. Phase 1 promotes the SurrealQL literal toolkit (currently forked in `evidence-writers.ts`) into one `surql.ts` module. Phase 2 extracts the chunked statement executor. Phase 3 replaces the 140-line CLI `if`-dispatch with a declarative dependency-graph pipeline. Phase 4 pairs each `src/queries/*` SQL template with a typed row-mapper so dashboard reads never touch `Record<string,unknown>`. Phase 5 routes hook telemetry writes through the same statement-builder + executor path as ingest.

**Tech Stack:** Bun ≥ 1.3, TypeScript (strict), Effect 4.0 beta, SurrealDB 3.0, `bun:test`.

**Done bar (every candidate):** `bun test` green + typecheck clean. Atomic commit per task.

**Test runner note:** see `memory/test_runner.md` - a global hook blocks `bun test`. Bypass with a tmp wrapper script when running the suite.

---

## File Structure

**New files:**
- `src/ingest/pipeline.ts` - Ingest Pipeline: stage descriptors, dependency-graph scheduler.
- `src/ingest/pipeline.test.ts` - scheduler tests (pure, no DB).
- `src/lib/shared/statement-exec.ts` - chunked statement executor seam.
- `src/lib/shared/statement-exec.test.ts`
- `src/lib/shared/row-fields.ts` - shared typed row-field extractors for the read seam.
- `src/lib/shared/row-fields.test.ts`
- `src/queries/query.ts` - `Query<Params,Row,T>` type + `defineQuery` helper.
- `docs/adr/0005-converge-hook-writes-onto-ingest-statement-path.md`

**Heavily modified:**
- `src/lib/shared/surql.ts` - gains the full literal toolkit + universal `surrealValue` encoder.
- `src/ingest/evidence-writers.ts` - deletes its literal fork + its private chunker.
- `src/cli/index.ts` - `cmdIngest` becomes a pipeline invocation; legacy flags warn.
- `src/lib/telemetry-base.ts` - `writeTelemetryRow` builds a statement instead of `db.upsert`.
- `src/queries/*.ts` (18 files) - each exports a typed `Query` object.
- `src/dashboard/*.ts` (~15 files) - drop per-file row-mappers, consume typed queries.

---

## Phase 0 - Vocabulary & Decisions

### Task 0.1: Add domain terms to CONTEXT.md

**Files:**
- Modify: `CONTEXT.md` (Language section + Relationships section)

- [ ] **Step 1: Add two terms to the Language section**

Insert after the **Derivation Engine** entry (around line 49):

```markdown
**Ingest Stage**:
One named unit of the ingest run - skills, commands, claude, codex, subagents,
spawned, git, signals, outcomes, session-health, closure, learning-registry, or
harness. A stage declares the other stages it depends on.
_Avoid_: step, job

**Ingest Pipeline**:
The dependency-ordered execution of all selected **Ingest Stages**. The pipeline
owns ordering, parallelism, and per-stage error events; it does not own stage
logic. The derive-* stages remain the **Derivation Engine** subset.
_Avoid_: ingest script, runner
```

- [ ] **Step 2: Add relationships**

Append to the Relationships section:

```markdown
- An **Ingest Stage** declares its dependency **Ingest Stages**; the **Ingest Pipeline** computes execution order and parallelism from that graph rather than a hardcoded list.
- The **Ingest Pipeline** runs independent stages concurrently; `claude` and `codex` have no dependency between them and run in parallel.
- `--stages=` and `--derive-only` select a subgraph of the **Ingest Pipeline**; legacy `--X-only` flags are deprecated aliases.
```

- [ ] **Step 3: Commit**

```bash
git add CONTEXT.md
git commit -m "docs(context): add Ingest Stage + Ingest Pipeline terms"
```

### Task 0.2: ADR for the hook-write convergence

**Files:**
- Create: `docs/adr/0005-converge-hook-writes-onto-ingest-statement-path.md`

- [ ] **Step 1: Write the ADR**

```markdown
# Converge hook writes onto the ingest statement path

`axctl` has two graph-write paths: ingest builds SurrealQL `UPSERT`/`RELATE`
statements and executes them in chunks; hooks call `db.upsert()` one row at a
time via `writeTelemetryRow`. ADR-0004 makes Harness Hook Events first-class
Local Evidence, so the hook path is load-bearing, not incidental.

Two write paths means new telemetry tables have no canonical pattern. We
converge: `writeTelemetryRow` builds an `UPSERT` statement using the shared
`surql.ts` literal toolkit and runs it through the shared statement executor -
the same seam ingest uses. `db.upsert` / `db.relate` remain on `SurrealClient`
as escape hatches but are no longer the telemetry write path.

Consequence: one write path, one place escaping/record-id rules live, and hook
evidence rows are built and tested the same way as ingest evidence rows.
```

- [ ] **Step 2: Commit**

```bash
git add docs/adr/0005-converge-hook-writes-onto-ingest-statement-path.md
git commit -m "docs(adr): 0005 converge hook writes onto ingest statement path"
```

---

## Phase 1 - SurrealQL Literal Seam (#2)

`evidence-writers.ts:69-121` forks a literal toolkit (`recordRef`, `escapeRecordKey`, `sqlDate`, `sqlObject`, `sqlSet`, `sqlOption*`, `sqlJsonOption`). `surql.ts` only has `surrealString`/`surrealJson`/`surrealJsonOption`. This phase promotes the full toolkit into `surql.ts` and routes every caller through it.

**Semantic constraint (load-bearing):** `evidence-writers.ts` `encodeJsonText` passes a value that is *already a string* through unchanged; `surql.ts` `surrealJson` re-stringifies. These produce different DB content. The pass-through variant must survive as a distinctly named helper - `surrealJsonText`. Do NOT collapse it into `surrealJson`.

### Task 1.1: Expand surql.ts with the literal toolkit

**Files:**
- Modify: `src/lib/shared/surql.ts`
- Test: `src/lib/shared/surql.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/lib/shared/surql.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import {
    recordRef,
    surrealRecordKey,
    surrealDate,
    surrealObject,
    surrealSet,
    surrealOptionString,
    surrealOptionInt,
    surrealOptionDate,
    surrealOptionRecord,
    surrealJsonText,
    surrealJsonTextOption,
    surrealValue,
} from "./surql.ts";

describe("recordRef", () => {
    test("wraps key in backticks", () => {
        expect(recordRef("session", "abc")).toBe("session:`abc`");
    });
    test("escapes backticks and control chars in the key", () => {
        expect(recordRef("t", "a`b\nc")).toBe("t:`a\\`b\\nc`");
    });
});

describe("surrealRecordKey", () => {
    test("escapes backslash, backtick, newline, return, tab", () => {
        expect(surrealRecordKey("a\\b`c\nd\re\tf")).toBe("a\\\\b\\`c\\nd\\re\\tf");
    });
});

describe("surrealDate", () => {
    test("emits a d-prefixed JSON ISO string", () => {
        expect(surrealDate(new Date("2026-01-02T03:04:05.000Z"))).toBe(
            'd"2026-01-02T03:04:05.000Z"',
        );
    });
    test("accepts a pre-formed ISO string", () => {
        expect(surrealDate("2026-01-02T03:04:05.000Z")).toBe(
            'd"2026-01-02T03:04:05.000Z"',
        );
    });
});

describe("surrealObject / surrealSet", () => {
    test("surrealObject joins name:value pairs in braces", () => {
        expect(surrealObject([["a", "1"], ["b", '"x"']])).toBe('{ a: 1, b: "x" }');
    });
    test("surrealSet joins name = value pairs", () => {
        expect(surrealSet([["a", "1"], ["b", '"x"']])).toBe('a = 1, b = "x"');
    });
});

describe("option helpers", () => {
    test("surrealOptionString → NONE for nullish", () => {
        expect(surrealOptionString(null)).toBe("NONE");
        expect(surrealOptionString(undefined)).toBe("NONE");
        expect(surrealOptionString("x")).toBe('"x"');
    });
    test("surrealOptionInt truncates and NONE for non-finite", () => {
        expect(surrealOptionInt(3.9)).toBe("3");
        expect(surrealOptionInt(null)).toBe("NONE");
        expect(surrealOptionInt(Number.NaN)).toBe("NONE");
    });
    test("surrealOptionDate → NONE for nullish", () => {
        expect(surrealOptionDate(null)).toBe("NONE");
    });
    test("surrealOptionRecord → NONE for nullish key", () => {
        expect(surrealOptionRecord("session", null)).toBe("NONE");
        expect(surrealOptionRecord("session", "k")).toBe("session:`k`");
    });
});

describe("surrealJsonText (pass-through semantics)", () => {
    test("a string value is NOT re-stringified", () => {
        // pre-encoded JSON text stays as-is, then gets quoted once
        expect(surrealJsonText('{"a":1}')).toBe('"{\\"a\\":1}"');
    });
    test("a non-string value is JSON-encoded once", () => {
        expect(surrealJsonText({ a: 1 })).toBe('"{\\"a\\":1}"');
    });
    test("surrealJsonTextOption → NONE for nullish", () => {
        expect(surrealJsonTextOption(null)).toBe("NONE");
        expect(surrealJsonTextOption(undefined)).toBe("NONE");
    });
});

describe("surrealValue (universal encoder)", () => {
    test("string → quoted literal", () => {
        expect(surrealValue("x")).toBe('"x"');
    });
    test("finite number → bare literal", () => {
        expect(surrealValue(3)).toBe("3");
    });
    test("boolean → true/false", () => {
        expect(surrealValue(true)).toBe("true");
    });
    test("null/undefined → NONE", () => {
        expect(surrealValue(null)).toBe("NONE");
        expect(surrealValue(undefined)).toBe("NONE");
    });
    test("Date → surrealDate literal", () => {
        expect(surrealValue(new Date("2026-01-02T03:04:05.000Z"))).toBe(
            'd"2026-01-02T03:04:05.000Z"',
        );
    });
    test("array → bracketed list of encoded values", () => {
        expect(surrealValue([1, "a"])).toBe('[1, "a"]');
    });
    test("plain object → surrealJson literal", () => {
        expect(surrealValue({ a: 1 })).toBe('"{\\"a\\":1}"');
    });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `bun test src/lib/shared/surql.test.ts`
Expected: FAIL - `recordRef` etc. not exported.

- [ ] **Step 3: Add the toolkit to surql.ts**

Append to `src/lib/shared/surql.ts`:

```typescript
/**
 * Escape a string for safe use inside a backtick-quoted SurrealQL record key.
 * Mirrors the escaping `evidence-writers.ts` used before this seam existed.
 */
export const surrealRecordKey = (key: string): string =>
    key
        .replace(/\\/g, "\\\\")
        .replace(/`/g, "\\`")
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t");

/** A SurrealQL record reference: `table:`key``. The single way to splice a
 *  record id built from an arbitrary key string into a statement. */
export const recordRef = (table: string, key: string): string =>
    `${table}:\`${surrealRecordKey(key)}\``;

/** A SurrealQL datetime literal (`d"ISO"`). Accepts a Date or a pre-formed
 *  ISO string. */
export const surrealDate = (value: Date | string): string => {
    const iso = value instanceof Date ? value.toISOString() : value;
    return `d${JSON.stringify(iso)}`;
};

/** `{ name: value, ... }` - values must already be SurrealQL literals. */
export const surrealObject = (
    fields: readonly (readonly [string, string])[],
): string => `{ ${fields.map(([n, v]) => `${n}: ${v}`).join(", ")} }`;

/** `name = value, ...` - values must already be SurrealQL literals. */
export const surrealSet = (
    fields: readonly (readonly [string, string])[],
): string => fields.map(([n, v]) => `${n} = ${v}`).join(", ");

/** `surrealString` or the SurrealQL keyword `NONE` for nullish input. */
export const surrealOptionString = (value: string | null | undefined): string =>
    value === null || value === undefined ? "NONE" : surrealString(value);

/** A truncated integer literal, or `NONE` for nullish / non-finite input. */
export const surrealOptionInt = (value: number | null | undefined): string =>
    value === null || value === undefined || !Number.isFinite(value)
        ? "NONE"
        : Math.trunc(value).toString(10);

/** A datetime literal, or `NONE` for nullish input. */
export const surrealOptionDate = (
    value: Date | string | null | undefined,
): string =>
    value === null || value === undefined ? "NONE" : surrealDate(value);

/** A record reference, or `NONE` for a nullish key. */
export const surrealOptionRecord = (
    table: string,
    key: string | null | undefined,
): string =>
    key === null || key === undefined ? "NONE" : recordRef(table, key);

/**
 * A SurrealQL literal for a column that stores JSON *text*. A value that is
 * already a string is treated as pre-encoded JSON and embedded verbatim (then
 * quoted once); any other value is `JSON.stringify`-d exactly once.
 *
 * This is DELIBERATELY different from `surrealJson`, which always
 * re-stringifies. Collapsing the two double-encodes pre-encoded columns. See
 * the JSON-text columns written by `evidence-writers.ts` (`input_json`,
 * `items`, `raw`).
 */
export const surrealJsonText = (value: unknown): string =>
    surrealString(typeof value === "string" ? value : JSON.stringify(value) ?? "null");

/** Like `surrealJsonText`, but nullish input yields the keyword `NONE`. */
export const surrealJsonTextOption = (value: unknown): string =>
    value === null || value === undefined ? "NONE" : surrealJsonText(value);

/**
 * Universal value encoder: turn any JS value into a SurrealQL literal.
 *
 *  - string  → quoted string literal
 *  - finite number → bare numeric literal
 *  - boolean → `true` / `false`
 *  - null / undefined → `NONE`
 *  - Date → datetime literal
 *  - array → `[...]` of encoded elements
 *  - object → `surrealJson` literal (JSON-text column)
 *
 * Used by the telemetry write path, where rows are heterogeneous and a typed
 * per-field builder would be overkill. Record references must be encoded by
 * the caller via `recordRef` before reaching here - a `RecordId` instance is
 * encoded through its `toString()` only as a last resort.
 */
export const surrealValue = (value: unknown): string => {
    if (value === null || value === undefined) return "NONE";
    if (typeof value === "string") return surrealString(value);
    if (typeof value === "number") {
        return Number.isFinite(value) ? value.toString(10) : "NONE";
    }
    if (typeof value === "boolean") return value ? "true" : "false";
    if (value instanceof Date) return surrealDate(value);
    if (Array.isArray(value)) {
        return `[${value.map((v) => surrealValue(v)).join(", ")}]`;
    }
    return surrealJson(value);
};
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `bun test src/lib/shared/surql.test.ts`
Expected: PASS - all cases green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared/surql.ts src/lib/shared/surql.test.ts
git commit -m "feat(surql): promote literal toolkit + universal value encoder"
```

### Task 1.2: Route evidence-writers.ts through surql.ts

**Files:**
- Modify: `src/ingest/evidence-writers.ts:69-121`
- Test: `src/ingest/evidence-writers.test.ts` (existing - must stay green)

- [ ] **Step 1: Replace the literal fork with imports**

In `src/ingest/evidence-writers.ts`, change the import on line 6 to:

```typescript
import {
    surrealString,
    surrealDate,
    surrealObject,
    surrealSet,
    surrealOptionString,
    surrealOptionInt,
    surrealOptionDate,
    surrealOptionRecord,
    surrealJsonText,
    surrealJsonTextOption,
    recordRef,
} from "../lib/shared/surql.ts";
```

Delete lines 69-121 (the `sqlString`/`sqlOptionString`/`sqlOptionInt`/`sqlDate`/`sqlOptionDate`/`escapeRecordKey`/`recordRef`/`sqlOptionRecord`/`encodeJsonText`/`sqlJsonString`/`sqlJsonOption`/`sqlObject`/`sqlSet` block). Keep `export const recordRef` consumers working - `recordRef` is now imported and re-exported:

```typescript
export { recordRef } from "../lib/shared/surql.ts";
```

Then rename the in-file call sites with a verbatim mechanical mapping:
- `sqlString` → `surrealString`
- `sqlOptionString` → `surrealOptionString`
- `sqlOptionInt` → `surrealOptionInt`
- `sqlDate` → `surrealDate`
- `sqlOptionDate` → `surrealOptionDate`
- `sqlOptionRecord` → `surrealOptionRecord`
- `sqlObject` → `surrealObject`
- `sqlSet` → `surrealSet`
- `sqlJsonString` → `surrealJsonText`
- `sqlJsonOption` → `surrealJsonTextOption`

`encodeJsonText` is now internal to `surrealJsonText` - its only callers were `sqlJsonString`/`sqlJsonOption`.

- [ ] **Step 2: Run evidence-writers tests, verify green**

Run: `bun test src/ingest/evidence-writers.test.ts`
Expected: PASS - output statements byte-identical to before (the helpers were copied, not changed).

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit` (or the project's `typecheck` script)
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/ingest/evidence-writers.ts
git commit -m "refactor(ingest): route evidence-writers literals through surql seam"
```

### Task 1.3: Route remaining ingest literal forks through surql.ts

**Files (each may hold a private literal helper - replace with surql imports):**
- Modify: `src/ingest/codex.ts`, `src/ingest/closure.ts`, `src/ingest/derive-signals.ts`, `src/ingest/git.ts`, `src/ingest/harness.ts`, `src/ingest/learning-registry.ts`, `src/ingest/legacy-self-improve.ts`, `src/ingest/outcomes.ts`, `src/ingest/session-health.ts`, `src/ingest/claude-insights.ts`, `src/self-improve/guidance.ts`, `src/context/file-context.ts`, `src/dashboard/telemetry.ts`

- [ ] **Step 1: For each file, find any private SurrealQL-literal helper**

In each file grep for local `const sql`/`sqlOption`/`escapeRecord`/`recordRef`/`sqlObject` definitions. For each one found, delete it and import the matching `surreal*` helper from `../lib/shared/surql.ts` (or `../../lib/shared/surql.ts` for `dashboard/`). Use the same mechanical name map as Task 1.2. If a file's helper has behaviour `surql.ts` does not cover, STOP and report - do not invent a divergent helper.

- [ ] **Step 2: Run the per-file test after each file**

Run: `bun test src/ingest/<file>.test.ts` for each modified file that has a test.
Expected: PASS for each.

- [ ] **Step 3: Full suite + typecheck**

Run: `bun test` then `bunx tsc --noEmit`
Expected: green.

- [ ] **Step 4: Commit (one commit per file, or one per 3-4 files if trivial)**

```bash
git add src/ingest/<file>.ts
git commit -m "refactor(ingest): route <file> literals through surql seam"
```

---

## Phase 2 - Statement Executor Seam (#6)

`evidence-writers.ts:326-344` owns `queryStatements` - chunked execution at 250 statements/query. Other stages reimplement this. Promote it to a shared module.

### Task 2.1: Create statement-exec.ts

**Files:**
- Create: `src/lib/shared/statement-exec.ts`
- Test: `src/lib/shared/statement-exec.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { executeStatements } from "./statement-exec.ts";
import { SurrealClient, type SurrealClientShape } from "../db.ts";

/** In-memory recorder adapter - the second adapter that makes this a real seam. */
const recordingClient = (): { calls: string[]; layer: SurrealClientShape } => {
    const calls: string[] = [];
    const layer = {
        query: (sql: string) => {
            calls.push(sql);
            return Effect.succeed([] as unknown[]);
        },
        upsert: () => Effect.succeed(undefined),
        relate: () => Effect.succeed(undefined),
        putFile: () => Effect.succeed(undefined),
        getFile: () => Effect.succeed(""),
        raw: {} as never,
    } satisfies SurrealClientShape;
    return { calls, layer };
};

const run = (eff: Effect.Effect<unknown, unknown, SurrealClient>, layer: SurrealClientShape) =>
    Effect.runPromise(eff.pipe(Effect.provideService(SurrealClient, layer)));

describe("executeStatements", () => {
    test("no statements → no query call", async () => {
        const { calls, layer } = recordingClient();
        await run(executeStatements([]), layer);
        expect(calls).toEqual([]);
    });

    test("statements within one chunk → a single joined query", async () => {
        const { calls, layer } = recordingClient();
        await run(executeStatements(["A;", "B;"]), layer);
        expect(calls).toEqual(["A;B;"]);
    });

    test("chunkSize splits into multiple queries", async () => {
        const { calls, layer } = recordingClient();
        await run(executeStatements(["A;", "B;", "C;"], { chunkSize: 2 }), layer);
        expect(calls).toEqual(["A;B;", "C;"]);
    });

    test("default chunk size is 250", async () => {
        const { calls, layer } = recordingClient();
        const stmts = Array.from({ length: 251 }, (_, i) => `S${i};`);
        await run(executeStatements(stmts), layer);
        expect(calls.length).toBe(2);
    });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `bun test src/lib/shared/statement-exec.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement statement-exec.ts**

```typescript
/**
 * statement-exec: the shared seam for executing a batch of SurrealQL
 * statements. Statements are joined and sent in chunks because a single
 * `db.query()` with thousands of statements blows past SurrealDB's parser
 * limits and balloons memory.
 *
 * This is the EXECUTE counterpart to `surql.ts` (which formats literals) and
 * `graph-query.ts` (which runs typed reads). Every ingest stage that builds
 * `UPSERT`/`RELATE`/`CREATE` statement arrays routes them through here, so
 * chunking + concurrency policy lives in exactly one place.
 */

import { Effect } from "effect";
import { SurrealClient, type SurrealClientShape } from "../db.ts";
import type { DbError } from "../errors.ts";

/** Default statements per `db.query()` call. Matches the long-standing
 *  evidence-writers value; safely under SurrealDB's parser limits. */
export const DEFAULT_CHUNK_SIZE = 250;

export interface ExecuteOptions {
    /** Statements per `db.query()` call. Defaults to {@link DEFAULT_CHUNK_SIZE}. */
    readonly chunkSize?: number;
}

/** Execute pre-built statements against an already-resolved client. Use when
 *  the caller already holds a `SurrealClientShape` (e.g. inside a larger
 *  `Effect.gen` that resolved `SurrealClient` once). */
export const executeStatementsWith = (
    db: SurrealClientShape,
    statements: readonly string[],
    options?: ExecuteOptions,
): Effect.Effect<void, DbError> =>
    Effect.gen(function* () {
        if (statements.length === 0) return;
        const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;
        for (let i = 0; i < statements.length; i += chunkSize) {
            yield* db.query(statements.slice(i, i + chunkSize).join(""));
        }
    });

/** Execute pre-built statements, resolving `SurrealClient` from context. */
export const executeStatements = (
    statements: readonly string[],
    options?: ExecuteOptions,
): Effect.Effect<void, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        yield* executeStatementsWith(db, statements, options);
    });
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test src/lib/shared/statement-exec.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared/statement-exec.ts src/lib/shared/statement-exec.test.ts
git commit -m "feat(db): extract chunked statement executor seam"
```

### Task 2.2: Adopt executeStatements in evidence-writers.ts

**Files:**
- Modify: `src/ingest/evidence-writers.ts:8,326-344`

- [ ] **Step 1: Replace the private chunker**

Delete the `STATEMENT_CHUNK_SIZE` const (line 8), and delete `queryStatementsWithClient` + `queryStatements` (lines 326-344). Add import:

```typescript
import { executeStatements, executeStatementsWith } from "../lib/shared/statement-exec.ts";
```

Rename call sites: `queryStatements(` → `executeStatements(` and `queryStatementsWithClient(db, ` → `executeStatementsWith(db, `.

- [ ] **Step 2: Run evidence-writers tests + typecheck**

Run: `bun test src/ingest/evidence-writers.test.ts && bunx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 3: Commit**

```bash
git add src/ingest/evidence-writers.ts
git commit -m "refactor(ingest): evidence-writers uses shared statement executor"
```

### Task 2.3: Adopt executeStatements in other ad-hoc chunkers

**Files:**
- Modify: any ingest stage with an inline `for (… += CHUNK …) db.query(…join…)` loop - at minimum check `src/ingest/transcripts.ts`, `src/ingest/codex.ts`, `src/ingest/derive-signals.ts`, `src/ingest/closure.ts`, `src/ingest/session-health.ts`, `src/ingest/git.ts`.

- [ ] **Step 1: Find inline chunk loops**

Run: `rg -n "CHUNK|chunkSize|slice\(i, i ?\+" src/ingest --type ts`
For each genuine "join statements + chunk + query" loop, replace with `executeStatements(stmts)` / `executeStatementsWith(db, stmts)`. Leave alone any loop that is not statement-batching (e.g. paging reads).

- [ ] **Step 2: Per-file test after each change**

Run: `bun test src/ingest/<file>.test.ts`
Expected: PASS.

- [ ] **Step 3: Full suite + typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: green.

- [ ] **Step 4: Commit (one per file)**

```bash
git add src/ingest/<file>.ts
git commit -m "refactor(ingest): <file> uses shared statement executor"
```

---

## Phase 3 - Dependency-Graph Ingest Pipeline (#1)

`cli/index.ts:396-537` wires 13 stages with hardcoded `if (sel.has(...))` blocks; ordering is comments. Replace with a declarative dependency graph: each stage declares `deps`; the scheduler runs any stage whose deps are done, parallelising independent stages. `claude` + `codex` have no dependency between them → run concurrently.

### Task 3.1: Define the stage descriptor + scheduler

**Files:**
- Create: `src/ingest/pipeline.ts`
- Test: `src/ingest/pipeline.test.ts`

- [ ] **Step 1: Write failing scheduler tests**

```typescript
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { runPipeline, topoLayers, type StageSpec } from "./pipeline.ts";

/** Minimal specs - `run` records the order it executed in. */
const spec = (key: string, deps: string[]): StageSpec => ({
    key,
    deps,
    run: () => Effect.succeed(undefined),
});

describe("topoLayers", () => {
    test("independent stages land in the same layer", () => {
        const layers = topoLayers([spec("a", []), spec("b", [])]);
        expect(layers.length).toBe(1);
        expect(new Set(layers[0])).toEqual(new Set(["a", "b"]));
    });

    test("a dependency pushes a stage to a later layer", () => {
        const layers = topoLayers([spec("a", []), spec("b", ["a"])]);
        expect(layers).toEqual([["a"], ["b"]]);
    });

    test("claude + codex parallel, subagents after both", () => {
        const layers = topoLayers([
            spec("claude", []),
            spec("codex", []),
            spec("subagents", ["claude", "codex"]),
        ]);
        expect(new Set(layers[0])).toEqual(new Set(["claude", "codex"]));
        expect(layers[1]).toEqual(["subagents"]);
    });

    test("a cycle throws", () => {
        expect(() => topoLayers([spec("a", ["b"]), spec("b", ["a"])])).toThrow(
            /cycle/i,
        );
    });

    test("a dep on an unselected stage throws", () => {
        expect(() => topoLayers([spec("b", ["a"])])).toThrow(/unknown dep/i);
    });
});

describe("runPipeline", () => {
    test("runs every selected stage exactly once, deps before dependents", async () => {
        const order: string[] = [];
        const mk = (key: string, deps: string[]): StageSpec => ({
            key,
            deps,
            run: () => Effect.sync(() => { order.push(key); }),
        });
        await Effect.runPromise(
            runPipeline([mk("a", []), mk("b", ["a"]), mk("c", ["a"])]),
        );
        expect(order[0]).toBe("a");
        expect(new Set(order)).toEqual(new Set(["a", "b", "c"]));
        expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
        expect(order.indexOf("a")).toBeLessThan(order.indexOf("c"));
    });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `bun test src/ingest/pipeline.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement pipeline.ts**

```typescript
/**
 * Ingest Pipeline: dependency-graph scheduler for Ingest Stages.
 *
 * Each stage declares the stages it depends on. `topoLayers` turns the graph
 * into ordered layers - every stage in a layer is independent of the others in
 * that layer, so the runner executes a layer concurrently. The pipeline owns
 * ordering + parallelism; stage logic stays in the stage modules.
 *
 * Replaces the hardcoded `if (sel.has(...))` dispatch in cli/index.ts. Adding a
 * stage is one `StageSpec`; `claude`/`codex` run in parallel because neither
 * lists the other as a dep; `subagents` lists both, so it lands in a later
 * layer automatically.
 */

import { Effect } from "effect";
import type { DbError } from "../lib/errors.ts";

/** A single Ingest Stage. `run` is the stage's Effect; `deps` are the keys of
 *  stages that must complete before this one starts. */
export interface StageSpec {
    readonly key: string;
    readonly deps: readonly string[];
    readonly run: () => Effect.Effect<unknown, DbError, never>;
}

/** Max stages run concurrently within one layer. Caps DB write pressure even
 *  if a layer is wide. */
export const LAYER_CONCURRENCY = 2;

/**
 * Compute execution layers via Kahn's algorithm. Layer N contains every stage
 * whose deps are all satisfied by layers < N. Throws on a dependency cycle or
 * a dep on a stage that is not in `specs`.
 */
export const topoLayers = (specs: readonly StageSpec[]): string[][] => {
    const byKey = new Map(specs.map((s) => [s.key, s]));
    for (const s of specs) {
        for (const d of s.deps) {
            if (!byKey.has(d)) {
                throw new Error(
                    `ingest pipeline: stage "${s.key}" has unknown dep "${d}"`,
                );
            }
        }
    }
    const done = new Set<string>();
    const layers: string[][] = [];
    let remaining = [...specs];
    while (remaining.length > 0) {
        const ready = remaining.filter((s) => s.deps.every((d) => done.has(d)));
        if (ready.length === 0) {
            throw new Error(
                `ingest pipeline: dependency cycle among ${remaining
                    .map((s) => s.key)
                    .join(", ")}`,
            );
        }
        layers.push(ready.map((s) => s.key));
        for (const s of ready) done.add(s.key);
        remaining = remaining.filter((s) => !done.has(s.key));
    }
    return layers;
};

/**
 * Run the selected stages in dependency order. Stages within a layer run
 * concurrently (capped at {@link LAYER_CONCURRENCY}); layers run sequentially.
 * The first failing stage fails the pipeline.
 */
export const runPipeline = (
    specs: readonly StageSpec[],
): Effect.Effect<void, DbError, never> =>
    Effect.gen(function* () {
        const byKey = new Map(specs.map((s) => [s.key, s]));
        for (const layer of topoLayers(specs)) {
            yield* Effect.all(
                layer.map((key) => byKey.get(key)!.run()),
                { concurrency: LAYER_CONCURRENCY, discard: true },
            );
        }
    });
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test src/ingest/pipeline.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/pipeline.ts src/ingest/pipeline.test.ts
git commit -m "feat(ingest): dependency-graph pipeline scheduler"
```

### Task 3.2: Build the stage registry

**Files:**
- Modify: `src/ingest/pipeline.ts` (add the registry)
- Modify: `src/ingest/pipeline.test.ts` (registry shape test)

- [ ] **Step 1: Write a failing registry test**

Append to `pipeline.test.ts`:

```typescript
import { INGEST_STAGE_DEPS, deriveOnlyKeys } from "./pipeline.ts";

describe("INGEST_STAGE_DEPS", () => {
    test("has all 13 canonical stages", () => {
        expect(Object.keys(INGEST_STAGE_DEPS).sort()).toEqual(
            [
                "claude", "closure", "codex", "commands", "git", "harness",
                "learning-registry", "outcomes", "session-health", "signals",
                "skills", "spawned", "subagents",
            ].sort(),
        );
    });
    test("subagents depends on claude + codex", () => {
        expect(new Set(INGEST_STAGE_DEPS.subagents)).toEqual(
            new Set(["claude", "codex"]),
        );
    });
    test("deriveOnlyKeys are the DB-only re-derive stages", () => {
        expect(new Set(deriveOnlyKeys())).toEqual(
            new Set([
                "signals", "outcomes", "session-health",
                "closure", "learning-registry",
            ]),
        );
    });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `bun test src/ingest/pipeline.test.ts`
Expected: FAIL - `INGEST_STAGE_DEPS` not exported.

- [ ] **Step 3: Add the registry to pipeline.ts**

```typescript
/** Canonical Ingest Stage keys → the stages they depend on.
 *
 * Dependency rationale:
 *  - `skills`/`commands` seed skill + command rows; transcript stages link
 *    `invoked` edges to them, so they must precede `claude`/`codex`.
 *  - `claude`/`codex` parse raw transcripts; independent of each other.
 *  - `subagents` derives parent↔child links - needs both transcript stages.
 *  - `spawned` derives spawn edges from transcript rows.
 *  - `git` is independent of transcripts.
 *  - the derive-* stages re-read already-ingested turn/session rows.
 *  - `harness` (doctor) reads everything; runs last.
 */
export const INGEST_STAGE_DEPS: Record<string, readonly string[]> = {
    skills: [],
    commands: [],
    claude: ["skills", "commands"],
    codex: ["skills", "commands"],
    subagents: ["claude", "codex"],
    spawned: ["claude", "codex"],
    git: [],
    signals: ["claude", "codex", "subagents", "spawned", "git"],
    outcomes: ["signals"],
    "session-health": ["signals"],
    closure: ["signals"],
    "learning-registry": ["signals"],
    harness: ["outcomes", "session-health", "closure", "learning-registry"],
};

export type IngestStageKey = keyof typeof INGEST_STAGE_DEPS;

/** Stages that re-derive purely from already-ingested DB rows - the
 *  `--derive-only` set. Defined as "no dep on a transcript/git parse stage". */
export const deriveOnlyKeys = (): IngestStageKey[] =>
    ["signals", "outcomes", "session-health", "closure", "learning-registry"];
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test src/ingest/pipeline.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/pipeline.ts src/ingest/pipeline.test.ts
git commit -m "feat(ingest): canonical stage dependency registry"
```

### Task 3.3: Stage selection - subgraph closure

**Files:**
- Modify: `src/ingest/pipeline.ts`
- Modify: `src/ingest/pipeline.test.ts`

When the user passes `--stages=signals`, the derive stage needs its deps present in the DB but should NOT re-run a 15-minute transcript parse. The selection must include only the explicitly requested keys (deps are assumed already ingested) - matching today's `resolveIngestStages` behaviour. So selection is: the requested set, validated, with NO automatic dep expansion. `topoLayers` is then called on just the selected specs, and a dep on an unselected stage is dropped from the graph (not an error) - because for `--stages=` the dep rows already exist.

- [ ] **Step 1: Write failing selection test**

Append to `pipeline.test.ts`:

```typescript
import { selectStages } from "./pipeline.ts";

describe("selectStages", () => {
    test("explicit keys: only those stages, deps NOT auto-added", () => {
        const sel = selectStages(["signals"]);
        expect(sel).toEqual(["signals"]);
    });
    test("unknown key throws with the valid list", () => {
        expect(() => selectStages(["bogus"])).toThrow(/bogus/);
    });
    test("topoLayers tolerates a dep outside the selection", () => {
        // signals depends on claude/codex/etc - none selected - still schedules
        const layers = topoLayers([
            { key: "signals", deps: ["claude"], run: () => Effect.succeed(undefined) },
        ]);
        expect(layers).toEqual([["signals"]]);
    });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `bun test src/ingest/pipeline.test.ts`
Expected: FAIL - `selectStages` missing; `topoLayers` throws on the external dep.

- [ ] **Step 3: Update pipeline.ts**

Add `selectStages`, and change `topoLayers` to DROP deps not present in `specs` rather than throw:

```typescript
const ALL_STAGE_KEYS = Object.keys(INGEST_STAGE_DEPS) as IngestStageKey[];

/** Validate + return the requested stage keys verbatim. Deps are NOT expanded:
 *  for `--stages=signals` the dep rows are assumed already ingested. Throws on
 *  an unknown key. */
export const selectStages = (keys: readonly string[]): IngestStageKey[] => {
    const bad = keys.filter((k) => !ALL_STAGE_KEYS.includes(k as IngestStageKey));
    if (bad.length > 0) {
        throw new Error(
            `ingest pipeline: unknown stage(s): ${bad.join(", ")}\n` +
                `  valid stages: ${ALL_STAGE_KEYS.join(", ")}`,
        );
    }
    return keys as IngestStageKey[];
};
```

In `topoLayers`, replace the unknown-dep throw with a filter: a dep not in `byKey` is treated as already-satisfied (drop it from the readiness check).

```typescript
// inside topoLayers, replace the unknown-dep validation loop with:
const inGraph = (d: string): boolean => byKey.has(d);
// ... and in the readiness filter:
const ready = remaining.filter((s) =>
    s.deps.filter(inGraph).every((d) => done.has(d)),
);
```

Update the Task 3.1 `topoLayers` "unknown dep throws" test: that behaviour is now intentionally removed - change that test to assert the external dep is tolerated (as in Step 1 here). Keep the cycle test.

- [ ] **Step 4: Run, verify pass**

Run: `bun test src/ingest/pipeline.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/pipeline.ts src/ingest/pipeline.test.ts
git commit -m "feat(ingest): stage subgraph selection tolerant of external deps"
```

### Task 3.4: Wire cmdIngest to the pipeline

**Files:**
- Modify: `src/cli/index.ts:262-537`

- [ ] **Step 1: Replace the stage machinery**

Delete `INGEST_STAGE_KEYS`, `DERIVE_ONLY_KEYS`, `STAGE_PROGRESS`, `ingestStages`, and the body of `resolveIngestStages` that builds raw sets. Keep `resolveIngestStages` as a thin wrapper that returns `IngestStageKey[]` via `selectStages` / `deriveOnlyKeys`.

Build the `StageSpec[]` inside `cmdIngest`. Each spec's `run` wraps the existing stage Effect in `telemetryStage` (unchanged) so per-stage error events still fire:

```typescript
import { runPipeline, INGEST_STAGE_DEPS, type StageSpec, type IngestStageKey } from "../ingest/pipeline.ts";

// inside cmdIngest, after `sel` (IngestStageKey[]) is resolved:
const stageRun: Record<IngestStageKey, () => Effect.Effect<unknown, DbError, SurrealClient | AgentctlConfig | ProcessService>> = {
    skills: () => telemetryStage(db, runId, "skills", "upsert", ingestSkills(), progress),
    commands: () => telemetryStage(db, runId, "commands", "upsert", ingestCommands(), progress),
    claude: () => telemetryStage(db, runId, "claude", "transcripts", ingestTranscripts({ sinceDays, onProgress: progressUpdater(progress, "claude", "transcripts") }), progress),
    codex: () => telemetryStage(db, runId, "codex", "sessions", ingestCodex({ sinceDays, onProgress: progressUpdater(progress, "codex", "sessions") }), progress),
    subagents: () => telemetryStage(db, runId, "claude", "subagents", deriveClaudeSubagents({ onProgress: progressUpdater(progress, "claude", "subagents") }), progress),
    spawned: () => telemetryStage(db, runId, "signals", "spawned", deriveSpawned(), progress),
    git: () => telemetryStage(db, runId, "git", "history", ingestGit({ sinceDays, onProgress: progressUpdater(progress, "git", "history") }), progress),
    signals: () => telemetryStage(db, runId, "signals", "derive", deriveSignals({ sinceDays, onProgress: progressUpdater(progress, "signals", "derive") }), progress),
    outcomes: () => telemetryStage(db, runId, "outcomes", "derive", deriveOutcomes({ sinceDays }), progress),
    "session-health": () => telemetryStage(db, runId, "session-health", "derive", deriveSessionHealth({ sinceDays }), progress),
    closure: () => telemetryStage(db, runId, "closure", "derive", deriveClosure(), progress),
    "learning-registry": () => telemetryStage(db, runId, "learning-registry", "derive", deriveLearningRegistry(), progress),
    harness: () => telemetryStage(db, runId, "harness", "doctor", ingestHarness(), progress),
};

const specs: StageSpec[] = sel.map((key) => ({
    key,
    deps: INGEST_STAGE_DEPS[key],
    run: stageRun[key],
}));
```

Replace the entire `const program = Effect.gen(...)` stage body (lines 396-520) with `yield* runPipeline(specs)`. Keep the `.pipe(Effect.tap(...finish...), Effect.catch(...), Effect.provideService(...), Effect.ensuring(...))` wrapper.

`ingestStages(args)` (used to build the progress reporter's stage list) becomes: `selectStages-derived keys → STAGE_PROGRESS lookup`. Keep a `STAGE_PROGRESS` map for the progress reporter only - it is display metadata, not control flow.

- [ ] **Step 2: Deprecate legacy flags**

In `resolveIngestStages`, when a legacy `--X-only` flag is matched, print once to stderr before returning:

```typescript
console.error(
    `axctl ingest: --${flag} is deprecated; use --stages=${set.join(",")} or --derive-only`,
);
```

Keep the flags functional this release.

- [ ] **Step 3: Run ingest tests + typecheck**

Run: `bun test src/cli/ && bunx tsc --noEmit`
Expected: green. If `effect-cli.test.ts` or `install.test.ts` reference the removed exports, update them to the new API.

- [ ] **Step 4: Smoke-run the pipeline against a scratch DB**

Run: `bun run src/cli/index.ts ingest --stages=skills,commands` (or the project's `axctl` binary). Expected: completes, exit 0, stage progress shown.

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts src/cli/*.test.ts
git commit -m "refactor(ingest): cmdIngest runs the dependency-graph pipeline"
```

---

## Phase 4 - Paired Query+Mapper Read Seam (#4 + #3)

`src/queries/*` holds 18 raw-SQL templates; `src/dashboard/*` files manually map untyped rows, each redefining `stringField`/`dateField`/`recordIdString`. This phase: (a) one shared row-field module, (b) each query exported as a typed `Query` object pairing SQL with a row-mapper.

### Task 4.1: Shared row-field extractors

**Files:**
- Create: `src/lib/shared/row-fields.ts`
- Test: `src/lib/shared/row-fields.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import { isRecord, stringField, dateField, numberField, recordIdString } from "./row-fields.ts";

describe("isRecord", () => {
    test("true for plain object, false for array/null", () => {
        expect(isRecord({})).toBe(true);
        expect(isRecord([])).toBe(false);
        expect(isRecord(null)).toBe(false);
    });
});

describe("stringField", () => {
    test("returns non-empty string, else null", () => {
        expect(stringField({ a: "x" }, "a")).toBe("x");
        expect(stringField({ a: "" }, "a")).toBe(null);
        expect(stringField({ a: 3 }, "a")).toBe(null);
    });
});

describe("dateField", () => {
    test("ISO string passthrough", () => {
        expect(dateField({ t: "2026-01-01T00:00:00.000Z" }, "t")).toBe(
            "2026-01-01T00:00:00.000Z",
        );
    });
    test("Date → ISO", () => {
        expect(dateField({ t: new Date("2026-01-01T00:00:00.000Z") }, "t")).toBe(
            "2026-01-01T00:00:00.000Z",
        );
    });
    test("missing → null", () => {
        expect(dateField({}, "t")).toBe(null);
    });
});

describe("numberField", () => {
    test("finite number passthrough, else null", () => {
        expect(numberField({ n: 3 }, "n")).toBe(3);
        expect(numberField({ n: "3" }, "n")).toBe(null);
    });
});

describe("recordIdString", () => {
    test("string passthrough", () => {
        expect(recordIdString("session:abc")).toBe("session:abc");
    });
    test("RecordId-like object → toString", () => {
        expect(recordIdString({ toString: () => "session:x" })).toBe("session:x");
    });
    test("null → null", () => {
        expect(recordIdString(null)).toBe(null);
    });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `bun test src/lib/shared/row-fields.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement row-fields.ts**

Lift the canonical implementations verbatim from `src/dashboard/recall.ts:13-39` and add `numberField`:

```typescript
/**
 * row-fields: shared typed extractors for SurrealDB result rows.
 *
 * SurrealDB hands back `Record<string, unknown>`; a missing column reads as
 * `undefined`, datetimes arrive as `Date` or ISO string depending on path, and
 * record ids as strings or `RecordId`-like objects. Every dashboard read used
 * to redefine these same guards. They live here once.
 */

export const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

/** Non-empty string at `key`, else `null`. */
export const stringField = (
    row: Record<string, unknown>,
    key: string,
): string | null => {
    const v = row[key];
    return typeof v === "string" && v.length > 0 ? v : null;
};

/** ISO datetime string at `key` (accepts Date or string or `{toJSON}`), else
 *  `null`. */
export const dateField = (
    row: Record<string, unknown>,
    key: string,
): string | null => {
    const v = row[key];
    if (typeof v === "string" && v.length > 0) return v;
    if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
    if (v && typeof v === "object" && "toJSON" in v) {
        const j = (v as { toJSON: () => unknown }).toJSON();
        if (typeof j === "string" && j.length > 0) return j;
    }
    return null;
};

/** Finite number at `key`, else `null`. */
export const numberField = (
    row: Record<string, unknown>,
    key: string,
): number | null => {
    const v = row[key];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
};

/** A record id rendered as a string - accepts a string or a `RecordId`-like
 *  object with a meaningful `toString`. */
export const recordIdString = (v: unknown): string | null => {
    if (typeof v === "string" && v.length > 0) return v;
    if (v && typeof v === "object" && "toString" in v) {
        const s = String(v);
        return s.length > 0 ? s : null;
    }
    return null;
};
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test src/lib/shared/row-fields.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared/row-fields.ts src/lib/shared/row-fields.test.ts
git commit -m "feat(shared): shared typed row-field extractors"
```

### Task 4.2: Define the Query type

**Files:**
- Create: `src/queries/query.ts`
- Test: `src/queries/query.test.ts`

A `Query<Params, Row, T>` pairs a SQL builder with a row-mapper. The dashboard caller passes params, gets typed `T[]` (or `T | null`) - never `Record<string,unknown>`.

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import { defineQuery, defineSingleQuery } from "./query.ts";

const hits = defineQuery({
    name: "demo.hits",
    sql: () => "SELECT * FROM x;",
    mapRow: (row) => ({ id: String(row.id ?? "") }),
});

describe("defineQuery", () => {
    test("carries name, sql, and a row-mapper", () => {
        expect(hits.name).toBe("demo.hits");
        expect(hits.sql({})).toBe("SELECT * FROM x;");
        expect(hits.mapRow({ id: 7 })).toEqual({ id: "7" });
    });
});

describe("defineSingleQuery", () => {
    test("flag marks it single-row", () => {
        const one = defineSingleQuery({
            name: "demo.one",
            sql: () => "SELECT * FROM x LIMIT 1;",
            mapRow: (row) => ({ id: String(row.id ?? "") }),
        });
        expect(one.single).toBe(true);
    });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `bun test src/queries/query.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement query.ts**

```typescript
/**
 * query: the typed read seam. A `Query` pairs a SurrealQL builder with a
 * row-mapper, so a dashboard caller hands over params and receives typed
 * domain records - it never touches `Record<string, unknown>` or restates
 * field-extraction guards.
 *
 * This is the structural half of the read seam; `graph-query.ts` is the
 * execution half (`runQuery` / `runSingleQuery` resolve `SurrealClient`, apply
 * the mapper, and own the defensive error policy).
 */

/** A multi-row query: params → SQL, plus a per-row mapper to a domain type. */
export interface Query<Params, Row, T> {
    readonly name: string;
    readonly single?: false;
    /** Build the SurrealQL statement. May read `params` to splice clauses. */
    readonly sql: (params: Params) => string;
    /** Optional `$param` bindings passed to `db.query`. */
    readonly bindings?: (params: Params) => Record<string, unknown>;
    /** Map one raw result row to the domain type. */
    readonly mapRow: (row: Row, index: number) => T;
}

/** A single-row query - `runSingleQuery` returns `T | null`. */
export interface SingleQuery<Params, Row, T>
    extends Omit<Query<Params, Row, T>, "single"> {
    readonly single: true;
}

export const defineQuery = <Params, Row extends Record<string, unknown>, T>(
    q: Omit<Query<Params, Row, T>, "single">,
): Query<Params, Row, T> => ({ ...q, single: false });

export const defineSingleQuery = <
    Params,
    Row extends Record<string, unknown>,
    T,
>(
    q: Omit<SingleQuery<Params, Row, T>, "single">,
): SingleQuery<Params, Row, T> => ({ ...q, single: true });
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test src/queries/query.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/queries/query.ts src/queries/query.test.ts
git commit -m "feat(queries): typed Query+mapper pairing"
```

### Task 4.3: Add runQuery executors to graph-query.ts

**Files:**
- Modify: `src/lib/shared/graph-query.ts`
- Test: `src/lib/shared/graph-query.test.ts` (create if absent)

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { runQuery, runSingleQuery } from "./graph-query.ts";
import { defineQuery, defineSingleQuery } from "../../queries/query.ts";
import { SurrealClient, type SurrealClientShape } from "../db.ts";

const clientReturning = (rows: unknown[]): SurrealClientShape => ({
    query: () => Effect.succeed([rows] as unknown[]),
    upsert: () => Effect.succeed(undefined),
    relate: () => Effect.succeed(undefined),
    putFile: () => Effect.succeed(undefined),
    getFile: () => Effect.succeed(""),
    raw: {} as never,
});

const run = (eff: Effect.Effect<unknown, unknown, SurrealClient>, c: SurrealClientShape) =>
    Effect.runPromise(eff.pipe(Effect.provideService(SurrealClient, c)));

const demo = defineQuery({
    name: "demo",
    sql: () => "SELECT * FROM x;",
    mapRow: (row) => String(row.id ?? ""),
});

describe("runQuery", () => {
    test("maps every row", async () => {
        const out = await run(runQuery(demo, {}), clientReturning([{ id: 1 }, { id: 2 }]));
        expect(out).toEqual(["1", "2"]);
    });
    test("DB error degrades to []", async () => {
        const failing: SurrealClientShape = {
            ...clientReturning([]),
            query: () => Effect.fail({ _tag: "DbError", message: "boom" } as never),
        };
        const out = await run(runQuery(demo, {}), failing);
        expect(out).toEqual([]);
    });
});

describe("runSingleQuery", () => {
    test("returns mapped first row or null", async () => {
        const one = defineSingleQuery({
            name: "demo1",
            sql: () => "SELECT * FROM x LIMIT 1;",
            mapRow: (row) => String(row.id ?? ""),
        });
        expect(await run(runSingleQuery(one, {}), clientReturning([{ id: 9 }]))).toBe("9");
        expect(await run(runSingleQuery(one, {}), clientReturning([]))).toBe(null);
    });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `bun test src/lib/shared/graph-query.test.ts`
Expected: FAIL - `runQuery` not exported.

- [ ] **Step 3: Add runQuery / runSingleQuery to graph-query.ts**

Append to `src/lib/shared/graph-query.ts`:

```typescript
import type { Query, SingleQuery } from "../../queries/query.ts";

/**
 * Execute a {@link Query}: build SQL + bindings from params, run, map rows.
 * Defensive - a DB failure logs `query.name` and degrades to `[]`, matching
 * the `queryMany` policy. Mapper exceptions are NOT caught.
 */
export const runQuery = <Params, Row, T>(
    query: Query<Params, Row, T>,
    params: Params,
): Effect.Effect<ReadonlyArray<T>, never, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const [rows] = yield* db.query<[Row[]]>(
            query.sql(params),
            query.bindings?.(params),
        );
        return (rows ?? []).map((row, i) => query.mapRow(row, i));
    }).pipe(
        Effect.catch((err: DbError) =>
            Effect.sync(() => {
                console.error(`axctl ${query.name} failed:`, err);
                return [] as ReadonlyArray<T>;
            }),
        ),
    );

/**
 * Execute a {@link SingleQuery}: returns the mapped first row or `null`.
 * Same defensive policy as {@link runQuery}.
 */
export const runSingleQuery = <Params, Row, T>(
    query: SingleQuery<Params, Row, T>,
    params: Params,
): Effect.Effect<T | null, never, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const [rows] = yield* db.query<[Row[]]>(
            query.sql(params),
            query.bindings?.(params),
        );
        const row = rows?.[0];
        return row === undefined ? null : query.mapRow(row, 0);
    }).pipe(
        Effect.catch((err: DbError) =>
            Effect.sync(() => {
                console.error(`axctl ${query.name} failed:`, err);
                return null as T | null;
            }),
        ),
    );
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test src/lib/shared/graph-query.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared/graph-query.ts src/lib/shared/graph-query.test.ts
git commit -m "feat(queries): runQuery executors over the typed Query seam"
```

### Task 4.4: Migrate the recall read path (reference migration)

This task is the worked example. Tasks 4.5+ repeat the pattern for the other query+dashboard pairs.

**Files:**
- Modify: `src/queries/recall.ts`, `src/dashboard/recall.ts`
- Test: `src/dashboard/recall.test.ts` (existing - must stay green)

- [ ] **Step 1: Convert recall.ts queries to typed Query objects**

In `src/queries/recall.ts`, keep the SQL builders but export typed `Query` objects. Define the row types and mappers (lift the mapper logic from `dashboard/recall.ts:125-141`):

```typescript
import { defineQuery, defineSingleQuery } from "./query.ts";
import { isRecord, stringField, dateField, recordIdString } from "../lib/shared/row-fields.ts";
import { toBareSessionId } from "../lib/shared/session-id.ts";
import type { RecallHit } from "../lib/shared/dashboard-types.ts";

export interface RecallTurnsParams {
    readonly q: string;
    readonly project: string | null;
    readonly since: string | null;
    readonly offset: number;
    readonly limit: number;
    readonly sessionFilterClause: string;
}

const truncate = (s: string, n: number): string =>
    s.length <= n ? s : `${s.slice(0, n - 1)}…`;

export const recallTurnsQuery = defineQuery<
    RecallTurnsParams,
    Record<string, unknown>,
    RecallHit | null
>({
    name: "recall.turns",
    sql: (p) => RECALL_TURNS_SQL(p.sessionFilterClause),
    bindings: (p) => ({
        q: p.q, project: p.project, since: p.since,
        offset: p.offset, limit: p.limit,
    }),
    mapRow: (raw) => {
        if (!isRecord(raw)) return null;
        const session = recordIdString(raw.session);
        if (!session) return null;
        const text = stringField(raw, "text_excerpt") ?? "";
        return {
            turn_id: recordIdString(raw.id) ?? "",
            session_id: toBareSessionId(session),
            project: stringField(raw, "project"),
            source: stringField(raw, "source"),
            role: stringField(raw, "role"),
            ts: dateField(raw, "ts"),
            snippet: truncate(text, 240),
        };
    },
});
```

(`RECALL_TURNS_SQL`, `RECALL_COUNT_SQL`, `RECALL_SESSIONS_FOR_SKILL_SQL` stay as the underlying string builders. The count + skill-session queries can stay as plain exported SQL since `fetchRecall` needs their raw shapes - only `recallTurnsQuery` becomes a typed `Query` here.)

- [ ] **Step 2: Update dashboard/recall.ts to consume the typed query**

In `src/dashboard/recall.ts`: delete the local `stringField`/`dateField`/`recordIdString`/`isRecord`/`truncate` (lines 13-42). Replace the page-rows block (lines 125-141) with `runQuery(recallTurnsQuery, params)` and filter out `null`s:

```typescript
import { runQuery } from "../lib/shared/graph-query.ts";
import { recallTurnsQuery } from "../queries/recall.ts";
// ...
const mapped = yield* runQuery(recallTurnsQuery, {
    q, project: baseBindings.project as string | null,
    since: baseBindings.since as string | null,
    offset, limit, sessionFilterClause,
});
const hits: RecallHit[] = mapped.filter((h): h is RecallHit => h !== null);
```

Keep the count query + skill-session materialisation as-is (they use `db.query` directly - acceptable, they are not row-mapping hotspots).

- [ ] **Step 3: Run recall tests + typecheck**

Run: `bun test src/dashboard/recall.test.ts src/queries/recall.test.ts && bunx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/queries/recall.ts src/dashboard/recall.ts
git commit -m "refactor(dashboard): recall read path uses typed Query+mapper seam"
```

### Task 4.5: Migrate remaining query+dashboard pairs

Repeat the Task 4.4 pattern for each remaining pair. One commit per pair. After each, run that pair's test + `bunx tsc --noEmit`.

**Pairs (query file ↔ dashboard consumer):**
- [ ] `queries/session-detail.ts` ↔ `dashboard/session-detail.ts` (also drop its private rid validator - use `interpolateRid`)
- [ ] `queries/episode-timeline.ts` ↔ `dashboard/episode-timeline.ts`
- [ ] `queries/skill-graph.ts` ↔ `dashboard/skill-graph.ts`
- [ ] `queries/skill-detail.ts` ↔ dashboard skill-detail consumer
- [ ] `queries/skill-summary.ts` ↔ consumer
- [ ] `queries/tool-failures.ts` ↔ `dashboard/tool-failures.ts`
- [ ] `queries/workflow.ts` ↔ `dashboard/workflow.ts`
- [ ] `queries/wrapped.ts` ↔ `dashboard/wrapped.ts`
- [ ] `queries/insights.ts` ↔ consumer
- [ ] `queries/graph-health.ts` ↔ consumer
- [ ] `queries/feedback-cases.ts` ↔ `dashboard/triage.ts`
- [ ] `queries/hooks.ts` ↔ consumer
- [ ] `queries/project.ts` ↔ `dashboard/project.ts`
- [ ] `queries/recall.ts` count/skill queries - leave as raw SQL (documented exception)

For each: define row types + `Query`/`SingleQuery` objects in the `queries/` file, move the row-mapping out of the dashboard file, delete that file's private `stringField`/`dateField`/`recordIdString` copies, call `runQuery`/`runSingleQuery`.

Per-pair commit message: `refactor(dashboard): <name> read path uses typed Query+mapper seam`.

- [ ] **Final step: full suite + typecheck + dashboard smoke**

Run: `bun test && bunx tsc --noEmit`
Then start the dashboard server and load the recall + a session-detail page; confirm no console errors.
Expected: green; pages render.

---

## Phase 5 - Converge Hook Writes onto the Statement Path (#5)

`writeTelemetryRow` (`telemetry-base.ts:35-48`) calls `db.upsert` per row. Converge it onto the statement-builder + executor path: build an `UPSERT` statement with `surql.ts` literals (`surrealValue` handles heterogeneous telemetry fields), run via `executeStatements`.

### Task 5.1: Build the telemetry-row statement builder

**Files:**
- Modify: `src/lib/telemetry-base.ts`
- Test: `src/lib/telemetry-base.test.ts` (create if absent)

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import { buildTelemetryRowStatement } from "./telemetry-base.ts";

describe("buildTelemetryRowStatement", () => {
    test("emits an UPSERT with a record ref for the row id", () => {
        const stmt = buildTelemetryRowStatement("hook_fire", {
            id: "abc",
            ts: new Date("2026-01-01T00:00:00.000Z"),
            kind: "hook_fire",
            file_path: "/x",
            harness: "claude",
            ok: true,
            latency_ms: 5,
        });
        expect(stmt.startsWith("UPSERT hook_fire:`abc` CONTENT {")).toBe(true);
        expect(stmt.endsWith("};")).toBe(true);
        expect(stmt).toContain('harness: "claude"');
        expect(stmt).toContain("ok: true");
        expect(stmt).toContain("latency_ms: 5");
        expect(stmt).toContain('ts: d"2026-01-01T00:00:00.000Z"');
    });

    test("a session string field becomes a record ref, not a quoted string", () => {
        const stmt = buildTelemetryRowStatement("hook_fire", {
            id: "abc",
            ts: new Date("2026-01-01T00:00:00.000Z"),
            kind: "hook_fire",
            session: "session:s1",
            file_path: "/x",
            harness: "claude",
            ok: true,
            latency_ms: 5,
        });
        expect(stmt).toContain("session: session:`s1`");
    });

    test("omits id from the CONTENT body", () => {
        const stmt = buildTelemetryRowStatement("t", {
            id: "k", ts: new Date(0), kind: "k", file_path: "",
            harness: "unknown", ok: false, latency_ms: 0,
        });
        expect(stmt).not.toContain("id:");
    });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `bun test src/lib/telemetry-base.test.ts`
Expected: FAIL - `buildTelemetryRowStatement` not exported.

- [ ] **Step 3: Implement the builder + reroute writeTelemetryRow**

In `telemetry-base.ts`, add the builder and change `writeTelemetryRow` to use it. Keep `deterministicId`. `session`/`file` are stored as record refs (`recordRef`) when they parse as `table:id`; everything else goes through `surrealValue`.

```typescript
import { Effect } from "effect";
import { createHash } from "node:crypto";
import { SurrealClient } from "./db.ts";
import type { DbError } from "./errors.ts";
import { recordRef, surrealObject, surrealValue } from "./shared/surql.ts";
import { executeStatements } from "./shared/statement-exec.ts";

// ... TelemetryHarness, TelemetryBaseRow, deterministicId unchanged ...

/** Turn a stored `table:id` ref string into a `recordRef` literal, or `null`
 *  if it does not parse. Strips the SurrealDB `⟨⟩` id delimiters. */
const refLiteral = (value: string | undefined): string | null => {
    if (!value) return null;
    const idx = value.indexOf(":");
    if (idx < 0) return null;
    const table = value.slice(0, idx);
    const id = value.slice(idx + 1).replace(/^⟨|⟩$/g, "");
    if (!table || !id) return null;
    return recordRef(table, id);
};

/**
 * Build the `UPSERT` statement for one telemetry row. `id` becomes the record
 * key; `session`/`file` become record refs; every other field is encoded by
 * `surrealValue`. This is the hook-side counterpart to the typed statement
 * builders in `evidence-writers.ts` - same seam, same escaping.
 */
export const buildTelemetryRowStatement = <T extends TelemetryBaseRow>(
    table: string,
    row: T,
): string => {
    const { id, session, file, ...rest } = row;
    const fields: Array<[string, string]> = [];
    const sessionRef = refLiteral(session);
    if (sessionRef) fields.push(["session", sessionRef]);
    const fileRef = refLiteral(file);
    if (fileRef) fields.push(["file", fileRef]);
    for (const [k, v] of Object.entries(rest)) {
        fields.push([k, surrealValue(v)]);
    }
    return `UPSERT ${recordRef(table, id)} CONTENT ${surrealObject(fields)};`;
};

export const writeTelemetryRow = <T extends TelemetryBaseRow>(
    table: string,
    row: T,
): Effect.Effect<void, DbError, SurrealClient> =>
    executeStatements([buildTelemetryRowStatement(table, row)]);
```

Note: a `RecordId` value inside `rest` (e.g. `HookFireRow.top_prior_sessions` is `readonly RecordId[]`) is handled by `surrealValue` arrays → each element falls to the object branch → `surrealJson`. That changes `top_prior_sessions` from native record refs to JSON text. If native refs must be preserved, the row should hand `top_prior_sessions` as pre-built `recordRef` strings; adjust `recordHookFire` accordingly in Step 4.

- [ ] **Step 4: Reconcile RecordId fields in hook rows**

In `src/hooks/telemetry.ts`, `HookFireRow.top_prior_sessions` is `readonly RecordId[]`. To keep them as native record references, change the type to `readonly string[]` and build them with `recordRef` from `surql.ts` (parse via the same `table:id` split). Verify `axctl hook log` still resolves them. If the column is only ever read back as JSON anyway, leave as-is and accept JSON-text storage - decide by checking how `queries/hooks.ts` reads `top_prior_sessions`.

- [ ] **Step 5: Run hook tests + typecheck**

Run: `bun test src/hooks/ src/lib/telemetry-base.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/telemetry-base.ts src/lib/telemetry-base.test.ts src/hooks/telemetry.ts
git commit -m "refactor(hooks): converge telemetry writes onto the statement path"
```

### Task 5.2: Verify hook fire end-to-end against a scratch DB

**Files:** none - verification only.

- [ ] **Step 1: Trigger a hook fire and confirm the row lands**

Run the file-context hook (or its test harness) so `recordHookFire` writes a `hook_fire` row, then:
Run: `bun run src/cli/index.ts hook log` (or the project's `axctl hook log`).
Expected: the fired row appears with `injected_titles`, `top_prior_sessions`, `latency_ms` intact.

- [ ] **Step 2: Confirm no regression in the hook telemetry suite**

Run: `bun test src/hooks/telemetry.test.ts`
Expected: PASS.

---

## Phase 6 - Final Verification

### Task 6.1: Whole-suite + clean ingest run

- [ ] **Step 1: Full test suite**

Run: `bun test`
Expected: all green.

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 3: Full ingest smoke run against a scratch DB**

Run: `bun run src/cli/index.ts ingest` (full pipeline, scratch DB).
Expected: exit 0; every stage reports progress; `claude` + `codex` visibly overlap; subagents/derive stages run after.

- [ ] **Step 4: `--derive-only` + a legacy flag**

Run: `bun run src/cli/index.ts ingest --derive-only`
Expected: only the 5 derive stages run.
Run: `bun run src/cli/index.ts ingest --claude-only`
Expected: runs, plus a deprecation warning on stderr.

- [ ] **Step 5: Final commit if any verification fixes were needed**

```bash
git add -A
git commit -m "chore: architecture deepening - final verification fixes"
```

---

## Self-Review Notes

- **Spec coverage:** #2 → Phase 1; #6 → Phase 2; #1 → Phase 3; #4+#3 → Phase 4; #5 → Phase 5; CONTEXT/ADR side effects → Phase 0. All six candidates covered.
- **Semantic landmine:** `surrealJsonText` (pass-through) kept distinct from `surrealJson` - Phase 1 Task 1.1 tests both behaviours explicitly.
- **Type consistency:** `executeStatements`/`executeStatementsWith`, `StageSpec`/`topoLayers`/`runPipeline`/`selectStages`, `Query`/`SingleQuery`/`defineQuery`/`runQuery`, `buildTelemetryRowStatement` - names used consistently across phases.
- **Open risk:** Phase 5 Task 5.1 Step 4 - `RecordId[]` fields in telemetry rows. The plan flags the decision (native ref vs JSON text) and ties it to how `queries/hooks.ts` reads the column. Executor must check, not guess.
- **Open risk:** Phase 4 is the widest (~33 files). Tasks 4.4 is the worked reference; 4.5 enumerates every remaining pair. If a `queries/` file has no clean dashboard consumer, leave it as raw SQL and note it (like the recall count query).
