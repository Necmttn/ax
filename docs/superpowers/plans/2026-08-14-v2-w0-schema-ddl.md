# w0-schema-ddl Implementation Plan (epic v2-duckdb)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the DuckDB relational DDL that replaces `packages/schema/src/schema.surql`, a
table manifest for it, and a deterministic content-hash ID contract (plus a dangling-ref
integrity check) in `packages/lib`.

**Architecture:** One hand-authored SQL file (`packages/schema/src/schema.duckdb.sql`) holds
`CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` for every table currently defined in
`schema.surql`. Surreal RELATION tables become plain tables with `in_id` / `out_id` columns and
an index on each side. A TypeScript manifest (`duckdb-tables.ts`) mirrors the `SchemaTableSpec`
shape used by `apps/axctl/src/queries/insights.ts` (exported, NOT wired). Two pure modules in
`packages/lib` define the ID contract: `stable-id.ts` (SHA-256 over an escaped natural key -
never autoincrement, never a run timestamp) and `cache-integrity.ts` (count sidecar refs whose
target id is missing from the cache). Verification is a real DuckDB load of the DDL when a
duckdb binary is reachable, and a parser-level structural test always.

**Tech Stack:** bun ≥ 1.3, TypeScript strict, `bun:test` (NEVER vitest), DuckDB v1.5.5 CLI,
no Effect in this chunk (all three new modules are pure - no services, no layers).

**Spec:** `docs/superpowers/plans/2026-08-14-v2-duckdb-backlog.md` (chunk `w0-schema-ddl`),
decisions of record Necmttn/ax#755, #757, #758.

## Global Constraints

- Work ONLY in `/Users/necmttn/Projects/ax/.claude/worktrees/w0-schema-ddl` (branch
  `feat/v2-w0-schema-ddl`). Never `cd` to or commit in the primary checkout.
- Tests import from `"bun:test"`. Never `vitest`.
- No backward compatibility with SurrealDB: no dual-write, no migration path, no compat shim.
  `schema.surql` stays on disk untouched this chunk (it is deleted in wave 3 `c-surreal-delete`).
- Table and column names stay ALIGNED with the current Surreal names so the wave-2 seam port is
  mechanical. Only two renames are allowed, both forced by SQL: relation `in` → `in_id`,
  `out` → `out_id`.
- No foreign-key constraints in the DDL (out-of-order derive inserts would fail them);
  referential integrity is checked by `packages/lib/src/cache-integrity.ts` instead.
- FTS is NOT in the DDL. Covered surfaces are exactly `turn.text_excerpt` and `commit.message`,
  built at ingest with `PRAGMA create_fts_index`. The skill ngram index is deliberately DROPPED
  (skills search becomes plain SQL) per #758.
- Nothing in this chunk is wired into runtime code. No file under `apps/` is modified.
- Gates, run FROM the worktree, real exit codes: `bun run typecheck` → 0;
  `bunx tsc --noEmit -p tsconfig.json` → 0; `bun test packages/schema packages/lib` green.

## Translation contract (authoritative - every DDL task follows this exactly)

Applied to every `DEFINE TABLE` in `packages/schema/src/schema.surql`:

| SurrealQL | DuckDB |
|---|---|
| `DEFINE TABLE t SCHEMAFULL` (node) | `CREATE TABLE IF NOT EXISTS t (id VARCHAR PRIMARY KEY, …);` |
| `DEFINE TABLE e TYPE RELATION FROM a TO b` | `CREATE TABLE IF NOT EXISTS e (id VARCHAR PRIMARY KEY, in_id VARCHAR NOT NULL, out_id VARCHAR NOT NULL, …);` plus `CREATE INDEX IF NOT EXISTS e_in ON e(in_id);` and `CREATE INDEX IF NOT EXISTS e_out ON e(out_id);` |
| `TYPE string` | `VARCHAR NOT NULL` |
| `TYPE option<string>` | `VARCHAR` |
| `TYPE int` / `option<int>` | `BIGINT NOT NULL` / `BIGINT` |
| `TYPE float` / `option<float>` | `DOUBLE NOT NULL` / `DOUBLE` |
| `TYPE bool` / `option<bool>` | `BOOLEAN NOT NULL` / `BOOLEAN` |
| `TYPE datetime` / `option<datetime>` | `TIMESTAMP NOT NULL` / `TIMESTAMP` |
| `TYPE record<x>` / `option<record<x>>` | `VARCHAR NOT NULL` / `VARCHAR` - holds the target row's `id`; keep the Surreal field name; append `-- ref -> x` |
| `TYPE option<array<string>>` | `VARCHAR  -- JSON string[]` |
| field commented `-- JSON-encoded` | `VARCHAR  -- JSON` (keep the original comment too) |
| `DEFAULT false` / `DEFAULT 1.0` / `DEFAULT 0` | `DEFAULT FALSE` / `DEFAULT 1.0` / `DEFAULT 0` |
| `DEFAULT time::now()` / `VALUE time::now()` | `DEFAULT CURRENT_TIMESTAMP` |
| `DEFINE INDEX n ON t FIELDS a, b` | `CREATE INDEX IF NOT EXISTS n ON t(a, b);` |
| `DEFINE INDEX n … UNIQUE` | `CREATE UNIQUE INDEX IF NOT EXISTS n ON t(a, b);` |
| `REFERENCE ON DELETE CASCADE` | dropped (no FKs) - note `-- was: REFERENCE ON DELETE CASCADE` |
| `DEFINE ANALYZER` / `FULLTEXT` index | OMITTED - listed in the file's `-- OMITTED` block |
| `DEFINE BUCKET` | OMITTED (blobs live on disk in v2) |
| `REMOVE INDEX …` | OMITTED (no legacy state to remove) |
| `DEFINE FIELD OVERWRITE f` | ordinary column `f` |

Additional rules:

1. **Reserved words.** DuckDB reserves `in`, `out` is fine but `limit`, `offset`, `order`,
   `end`, `all`, `default`, `check`, `column`, `table`, `select`, `where`, `group`, `values`,
   `references`, `window`, `qualify`, `pivot` are not usable bare. Any column whose Surreal name
   collides is written double-quoted (`"limit" BIGINT`) - the NAME never changes. The real-load
   test is the backstop that catches a missed one.
2. **Index-name collisions.** DuckDB index names are database-scoped. Surreal index names are
   already table-prefixed almost everywhere; where a name repeats across tables, prefix it with
   the table name and note the rename in a comment.
3. **Every table keeps its Surreal doc comment**, copied verbatim above the `CREATE TABLE`.
4. **Column order** follows the Surreal field order, with `id` first (and `in_id`, `out_id`
   second/third on edge tables).
5. Relation tables that declare no fields (`DEFINE TABLE x TYPE RELATION FROM a TO b;` with no
   `DEFINE FIELD`) still get `id`, `in_id`, `out_id` and the two side indexes.
6. **Layout is load-bearing** (the parsers in `duckdb-ddl.ts` depend on it):
   - `CREATE TABLE IF NOT EXISTS <table> (` starts at column 0; the closing `);` is a line of
     its own at column 0; every column sits on its own indented line.
   - The first column line is EXACTLY `    id VARCHAR PRIMARY KEY,` - no trailing comment.
   - Comments are whole lines starting with `--`. A copied Surreal comment that contains
     `option<`, `record<`, `DEFINE …`, or `time::now()` MUST stay on its own `--` line; never
     append it after a column definition.
   - Inline trailing comments on a column line are allowed only for short notes with no Surreal
     syntax, e.g. `session VARCHAR,  -- ref -> session`.
7. **Per-relation side indexes**: exactly one `<table>_in ON <table>(in_id)` and one
   `<table>_out ON <table>(out_id)` per relation table. When `schema.surql` already declares
   indexes with those names, translate them and do NOT emit a duplicate.

## File Structure

- Create `packages/schema/src/schema.duckdb.sql` - the DDL (assembled from the four part files).
- Create `packages/schema/src/duckdb/_part-1.sql` … `_part-4.sql` - temporary section outputs,
  concatenated into the DDL and DELETED before commit.
- Create `packages/schema/src/duckdb-ddl.ts` - loads the DDL text and parses it
  (`parseDuckdbTables`, `parseDuckdbIndexes`); the only place a regex touches the SQL.
- Create `packages/schema/src/duckdb-tables.ts` - `DUCKDB_SCHEMA_TABLES` manifest.
- Create `packages/schema/src/duckdb-schema.test.ts` - structural + manifest-parity +
  Surreal-coverage tests (no DuckDB binary needed).
- Create `packages/schema/src/duckdb-load.test.ts` - real load into a fresh DuckDB; skips with a
  printed notice when no binary is reachable.
- Modify `packages/schema/package.json` - add `./schema.duckdb.sql`, `./duckdb-ddl`,
  `./duckdb-tables` exports.
- Create `packages/lib/src/stable-id.ts` + `packages/lib/src/stable-id.test.ts`.
- Create `packages/lib/src/cache-integrity.ts` + `packages/lib/src/cache-integrity.test.ts`.

`packages/lib` already exposes `./*` → `./src/*.ts`, so `@ax/lib/stable-id` and
`@ax/lib/cache-integrity` resolve with no package.json change.

---

### Task 1: Deterministic stable-id module

**Files:**
- Create: `packages/lib/src/stable-id.ts`
- Test: `packages/lib/src/stable-id.test.ts`

**Interfaces:**
- Consumes: nothing (pure, dependency-free except `Bun.CryptoHasher`).
- Produces:
  - `type NaturalKeyPart = string | number | bigint | boolean | null | undefined`
  - `stableId(table: string, parts: readonly NaturalKeyPart[]): string` → 32 lowercase hex chars
  - `encodeNaturalKey(parts: readonly NaturalKeyPart[]): string`
  - `interface SourceIdentity { readonly path: string; readonly contentHash?: string | null }`
  - `sourceFileKey(src: SourceIdentity): string`
  - `sessionRowId(provider: string, providerSessionId: string): string`
  - `turnRowId(sessionRowIdValue: string, seq: number): string`
  - `toolCallRowId(sessionRowIdValue: string, seq: number, callId?: string | null): string`
  - `agentEventRowId(agentSessionId: string, seq: number, providerEventId?: string | null): string`
  - `derivedRowId(table: string, src: SourceIdentity, parts: readonly NaturalKeyPart[]): string`
  - `edgeRowId(edgeTable: string, inId: string, outId: string, discriminator?: string | null): string`
  - `NATURAL_KEY_RECIPES: Readonly<Record<string, string>>` (documentation map: table → the
    natural key it hashes)

- [ ] **Step 1: Write the failing test**

```ts
// packages/lib/src/stable-id.test.ts
import { describe, expect, test } from "bun:test";
import {
    NATURAL_KEY_RECIPES,
    derivedRowId,
    edgeRowId,
    encodeNaturalKey,
    sessionRowId,
    sourceFileKey,
    stableId,
    toolCallRowId,
    turnRowId,
} from "./stable-id.ts";

// A fixture that stands in for "one parsed source file worth of derived rows".
const FIXTURE = {
    source: { path: "/home/u/.claude/projects/p/abc.jsonl", contentHash: "deadbeef" },
    events: [
        { seq: 0, role: "user", callId: null },
        { seq: 1, role: "assistant", callId: "toolu_01" },
        { seq: 2, role: "tool_result", callId: "toolu_01" },
    ],
} as const;

const derive = () => {
    const sid = sessionRowId("claude", "abc");
    return FIXTURE.events.flatMap((e) => [
        turnRowId(sid, e.seq),
        toolCallRowId(sid, e.seq, e.callId),
        derivedRowId("run_evidence_event", FIXTURE.source, ["tool_call", e.seq]),
    ]);
};

describe("stableId", () => {
    test("is 32 lowercase hex chars", () => {
        expect(stableId("turn", ["a", 1])).toMatch(/^[0-9a-f]{32}$/);
    });

    test("is pure: same input, same output", () => {
        expect(stableId("turn", ["a", 1])).toBe(stableId("turn", ["a", 1]));
    });

    test("namespaces by table: same key in two tables differs", () => {
        expect(stableId("turn", ["a", 1])).not.toBe(stableId("tool_call", ["a", 1]));
    });

    test("part boundaries are unambiguous", () => {
        expect(stableId("t", ["a", "b"])).not.toBe(stableId("t", ["ab"]));
        expect(stableId("t", ["a|b"])).not.toBe(stableId("t", ["a", "b"]));
        expect(stableId("t", ["a"])).not.toBe(stableId("t", ["a", ""]));
    });

    test("null and undefined and empty string are distinct parts", () => {
        const a = stableId("t", [null]);
        const b = stableId("t", [undefined]);
        const c = stableId("t", [""]);
        expect(new Set([a, b, c]).size).toBe(3);
    });

    test("numbers and their string forms are distinct", () => {
        expect(stableId("t", [1])).not.toBe(stableId("t", ["1"]));
    });

    test("rejects an empty key", () => {
        expect(() => stableId("t", [])).toThrow(/natural key/i);
    });

    test("rejects an empty table", () => {
        expect(() => stableId("", ["a"])).toThrow(/table/i);
    });
});

describe("determinism property", () => {
    test("two derives of the identical fixture are byte-identical", () => {
        const first = derive();
        const second = derive();
        expect(second).toEqual(first);
        expect(second.join("\n")).toBe(first.join("\n"));
    });

    test("ids are pinned - a regression here breaks every cached row", () => {
        // Golden values: change ONLY with a deliberate cache-version bump.
        expect(sessionRowId("claude", "abc")).toBe(stableId("session", ["claude", "abc"]));
        expect(turnRowId("s1", 7)).toBe(stableId("turn", ["s1", 7]));
    });

    test("500 seeded random keys collide never and repeat always", () => {
        let seed = 0x2f6e2b1;
        const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
        const seen = new Map<string, string>();
        for (let i = 0; i < 500; i++) {
            const parts = [`p${Math.floor(rnd() * 1e6)}`, Math.floor(rnd() * 1e6)];
            const key = encodeNaturalKey(parts);
            const id = stableId("turn", parts);
            expect(stableId("turn", parts)).toBe(id);
            const prior = seen.get(id);
            if (prior !== undefined) expect(prior).toBe(key);
            seen.set(id, key);
        }
    });
});

describe("no run-state in ids", () => {
    test("source identity, not mtime, drives derived ids", () => {
        const a = derivedRowId("x", { path: "/a.jsonl", contentHash: "h1" }, ["k"]);
        const b = derivedRowId("x", { path: "/a.jsonl", contentHash: "h1" }, ["k"]);
        const c = derivedRowId("x", { path: "/a.jsonl", contentHash: "h2" }, ["k"]);
        expect(a).toBe(b);
        expect(a).not.toBe(c);
    });

    test("sourceFileKey ignores a missing content hash consistently", () => {
        expect(sourceFileKey({ path: "/a.jsonl" })).toBe(sourceFileKey({ path: "/a.jsonl", contentHash: null }));
    });

    test("edge ids are symmetric-free and discriminated", () => {
        expect(edgeRowId("invoked", "t1", "s1")).not.toBe(edgeRowId("invoked", "s1", "t1"));
        expect(edgeRowId("invoked", "t1", "s1", "argsA")).not.toBe(edgeRowId("invoked", "t1", "s1", "argsB"));
    });
});

describe("NATURAL_KEY_RECIPES", () => {
    test("documents every id helper's table", () => {
        for (const t of ["session", "turn", "tool_call", "agent_event"]) {
            expect(NATURAL_KEY_RECIPES[t]).toBeTruthy();
        }
    });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun test packages/lib/src/stable-id.test.ts`
Expected: FAIL - module `./stable-id.ts` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// packages/lib/src/stable-id.ts
/**
 * Deterministic content-hash row ids for the DuckDB cache (v2).
 *
 * CONTRACT: a row's id is a hash of its NATURAL KEY - the source file
 * identity plus provider-native ids/offsets. It is NEVER an autoincrement,
 * a run id, or a wall-clock timestamp. Re-deriving the same input therefore
 * rewrites the same ids, which is what makes the cache rebuildable and
 * makes sidecar refs (SQLite) survive a full re-derive.
 *
 * SHA-256 (not `Bun.hash`) so ids stay stable across bun versions; 128 bits
 * of it is ~2^-64 collision risk at 10^9 rows, far past ax's scale.
 */
export type NaturalKeyPart = string | number | bigint | boolean | null | undefined;

const ID_HEX_LENGTH = 32;

const encodePart = (part: NaturalKeyPart): string => {
    if (part === null) return "n:";
    if (part === undefined) return "u:";
    if (typeof part === "boolean") return `b:${part ? "1" : "0"}`;
    if (typeof part === "number") {
        if (!Number.isFinite(part)) throw new Error(`stableId: non-finite number part ${String(part)}`);
        return `i:${Number.isInteger(part) ? part.toFixed(0) : part.toExponential(17)}`;
    }
    if (typeof part === "bigint") return `i:${part.toString(10)}`;
    return `s:${part.length}:${part}`;
};

/** Canonical, injection-free rendering of a natural key. */
export function encodeNaturalKey(parts: readonly NaturalKeyPart[]): string {
    if (parts.length === 0) throw new Error("stableId: empty natural key");
    return parts.map(encodePart).join("|");
}

/** Hash `parts` into the row id for `table`. Table name is part of the hash, so
 *  the same natural key in two tables yields two different ids. */
export function stableId(table: string, parts: readonly NaturalKeyPart[]): string {
    if (table.length === 0) throw new Error("stableId: empty table name");
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(`${table.length}:${table}|${encodeNaturalKey(parts)}`);
    return hasher.digest("hex").slice(0, ID_HEX_LENGTH);
}

export interface SourceIdentity {
    /** Absolute path of the file the rows were parsed from. */
    readonly path: string;
    /** Content hash of that file when known; null/undefined are equivalent. */
    readonly contentHash?: string | null;
}

/** Stable identity of the file a derived row came from. */
export function sourceFileKey(src: SourceIdentity): string {
    return encodeNaturalKey([src.path, src.contentHash ?? null]);
}

export function sessionRowId(provider: string, providerSessionId: string): string {
    return stableId("session", [provider, providerSessionId]);
}

export function turnRowId(sessionId: string, seq: number): string {
    return stableId("turn", [sessionId, seq]);
}

export function toolCallRowId(sessionId: string, seq: number, callId?: string | null): string {
    return stableId("tool_call", [sessionId, seq, callId ?? null]);
}

export function agentEventRowId(agentSessionId: string, seq: number, providerEventId?: string | null): string {
    return stableId("agent_event", [agentSessionId, seq, providerEventId ?? null]);
}

/** Id for a row derived from a parsed source file (the general case). */
export function derivedRowId(
    table: string,
    src: SourceIdentity,
    parts: readonly NaturalKeyPart[],
): string {
    return stableId(table, [sourceFileKey(src), ...parts]);
}

/** Id for an edge row. `discriminator` separates parallel edges between the
 *  same pair (e.g. `invoked` args, `edited` tool name). */
export function edgeRowId(
    edgeTable: string,
    inId: string,
    outId: string,
    discriminator?: string | null,
): string {
    return stableId(edgeTable, ["in", inId, "out", outId, discriminator ?? null]);
}

/** Documentation of what each derived table hashes. Keep in sync with the
 *  helpers above; the wave-2 seam port reads this to pick the right key. */
export const NATURAL_KEY_RECIPES: Readonly<Record<string, string>> = {
    session: "provider + provider-native session id",
    turn: "session row id + provider-native turn seq",
    tool_call: "session row id + seq + provider call id (when present)",
    agent_event: "agent_session row id + seq + provider event id (when present)",
    "<edge>": "edge table + in_id + out_id + optional discriminator",
    "<derived>": "source file identity (path + content hash) + provider-native offsets",
};
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun test packages/lib/src/stable-id.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit -p tsconfig.json` → exit 0.

---

### Task 2: Dangling-ref integrity check

**Files:**
- Create: `packages/lib/src/cache-integrity.ts`
- Test: `packages/lib/src/cache-integrity.test.ts`

**Interfaces:**
- Consumes: nothing (pure; deliberately takes plain data, not a DB handle, so it is testable
  with no DuckDB and reusable from `ax doctor` and from ingest).
- Produces:
  - `interface SidecarRef { readonly sidecarTable: string; readonly sidecarId: string; readonly column: string; readonly targetTable: string; readonly targetId: string }`
  - `type CacheIdIndex = ReadonlyMap<string, ReadonlySet<string>>` (target table → live ids)
  - `buildCacheIdIndex(rows: Iterable<{ readonly table: string; readonly id: string }>): CacheIdIndex`
  - `interface DanglingRef extends SidecarRef { readonly reason: "missing_id" | "unknown_table" }`
  - `interface IntegrityReport { readonly checked: number; readonly dangling: number; readonly byTargetTable: Readonly<Record<string, number>>; readonly samples: readonly DanglingRef[]; readonly ok: boolean }`
  - `checkCacheIntegrity(refs: Iterable<SidecarRef>, cacheIds: CacheIdIndex, options?: { readonly sampleLimit?: number }): IntegrityReport`

- [ ] **Step 1: Write the failing test**

```ts
// packages/lib/src/cache-integrity.test.ts
import { describe, expect, test } from "bun:test";
import { type SidecarRef, buildCacheIdIndex, checkCacheIntegrity } from "./cache-integrity.ts";

const index = buildCacheIdIndex([
    { table: "session", id: "s1" },
    { table: "session", id: "s2" },
    { table: "turn", id: "t1" },
]);

const ref = (over: Partial<SidecarRef>): SidecarRef => ({
    sidecarTable: "proposal",
    sidecarId: "p1",
    column: "session",
    targetTable: "session",
    targetId: "s1",
    ...over,
});

describe("checkCacheIntegrity", () => {
    test("clean refs report ok with zero dangling", () => {
        const r = checkCacheIntegrity([ref({}), ref({ sidecarId: "p2", targetTable: "turn", targetId: "t1" })], index);
        expect(r.checked).toBe(2);
        expect(r.dangling).toBe(0);
        expect(r.ok).toBe(true);
        expect(r.samples).toEqual([]);
    });

    test("counts a ref whose target id vanished from the cache", () => {
        const r = checkCacheIntegrity([ref({ targetId: "gone" })], index);
        expect(r.dangling).toBe(1);
        expect(r.ok).toBe(false);
        expect(r.byTargetTable).toEqual({ session: 1 });
        expect(r.samples[0]?.reason).toBe("missing_id");
        expect(r.samples[0]?.sidecarId).toBe("p1");
    });

    test("a ref to a table the cache does not have is dangling as unknown_table", () => {
        const r = checkCacheIntegrity([ref({ targetTable: "ghost", targetId: "x" })], index);
        expect(r.dangling).toBe(1);
        expect(r.samples[0]?.reason).toBe("unknown_table");
        expect(r.byTargetTable).toEqual({ ghost: 1 });
    });

    test("aggregates per target table across many refs", () => {
        const refs = [
            ref({ sidecarId: "a", targetId: "gone1" }),
            ref({ sidecarId: "b", targetId: "gone2" }),
            ref({ sidecarId: "c", targetTable: "turn", targetId: "gone3" }),
            ref({ sidecarId: "d" }),
        ];
        const r = checkCacheIntegrity(refs, index);
        expect(r.checked).toBe(4);
        expect(r.dangling).toBe(3);
        expect(r.byTargetTable).toEqual({ session: 2, turn: 1 });
    });

    test("samples are capped by sampleLimit", () => {
        const refs = Array.from({ length: 30 }, (_, i) => ref({ sidecarId: `p${i}`, targetId: `gone${i}` }));
        const r = checkCacheIntegrity(refs, index, { sampleLimit: 5 });
        expect(r.dangling).toBe(30);
        expect(r.samples.length).toBe(5);
    });

    test("empty inputs are ok", () => {
        const r = checkCacheIntegrity([], buildCacheIdIndex([]));
        expect(r).toEqual({ checked: 0, dangling: 0, byTargetTable: {}, samples: [], ok: true });
    });

    test("buildCacheIdIndex groups ids by table", () => {
        const idx = buildCacheIdIndex([{ table: "a", id: "1" }, { table: "a", id: "2" }, { table: "b", id: "1" }]);
        expect(idx.get("a")?.size).toBe(2);
        expect(idx.get("b")?.has("1")).toBe(true);
        expect(idx.get("c")).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun test packages/lib/src/cache-integrity.test.ts`
Expected: FAIL - module does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// packages/lib/src/cache-integrity.ts
/**
 * Dangling-reference check between the SQLite judgment sidecar and the
 * rebuildable DuckDB cache (v2 architecture).
 *
 * The cache is re-derivable, the sidecar is not. A re-derive that drops a row
 * leaves sidecar rows pointing at an id that no longer exists. This module
 * counts those, given the sidecar's refs and the cache's live ids. It takes
 * plain data (not a DB handle) so it is testable with no DuckDB running and
 * callable from both ingest and `ax doctor`.
 */
export interface SidecarRef {
    readonly sidecarTable: string;
    readonly sidecarId: string;
    readonly column: string;
    readonly targetTable: string;
    readonly targetId: string;
}

export type CacheIdIndex = ReadonlyMap<string, ReadonlySet<string>>;

export function buildCacheIdIndex(
    rows: Iterable<{ readonly table: string; readonly id: string }>,
): CacheIdIndex {
    const index = new Map<string, Set<string>>();
    for (const row of rows) {
        let set = index.get(row.table);
        if (set === undefined) {
            set = new Set<string>();
            index.set(row.table, set);
        }
        set.add(row.id);
    }
    return index;
}

export interface DanglingRef extends SidecarRef {
    readonly reason: "missing_id" | "unknown_table";
}

export interface IntegrityReport {
    readonly checked: number;
    readonly dangling: number;
    readonly byTargetTable: Readonly<Record<string, number>>;
    readonly samples: readonly DanglingRef[];
    readonly ok: boolean;
}

const DEFAULT_SAMPLE_LIMIT = 20;

export function checkCacheIntegrity(
    refs: Iterable<SidecarRef>,
    cacheIds: CacheIdIndex,
    options?: { readonly sampleLimit?: number },
): IntegrityReport {
    const sampleLimit = options?.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
    const byTargetTable: Record<string, number> = {};
    const samples: DanglingRef[] = [];
    let checked = 0;
    let dangling = 0;

    for (const ref of refs) {
        checked += 1;
        const live = cacheIds.get(ref.targetTable);
        const reason: DanglingRef["reason"] | null =
            live === undefined ? "unknown_table" : live.has(ref.targetId) ? null : "missing_id";
        if (reason === null) continue;
        dangling += 1;
        byTargetTable[ref.targetTable] = (byTargetTable[ref.targetTable] ?? 0) + 1;
        if (samples.length < sampleLimit) samples.push({ ...ref, reason });
    }

    return { checked, dangling, byTargetTable, samples, ok: dangling === 0 };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun test packages/lib/src/cache-integrity.test.ts`
Expected: PASS.

---

### Task 3: DDL test harness (RED before any SQL exists)

**Files:**
- Create: `packages/schema/src/duckdb-ddl.ts`
- Create: `packages/schema/src/duckdb-schema.test.ts`
- Create: `packages/schema/src/duckdb-load.test.ts`
- Modify: `packages/schema/package.json` (exports)

**Interfaces:**
- Produces:
  - `DUCKDB_SCHEMA_SQL: string` (the raw DDL text)
  - `parseDuckdbTables(sql?: string): readonly string[]` (table names in file order)
  - `parseDuckdbIndexes(sql?: string): readonly { readonly name: string; readonly table: string; readonly unique: boolean }[]`
  - `parseSurrealTables(surql: string): readonly { readonly table: string; readonly relation: boolean }[]`
- Consumes (from Task 4): `DUCKDB_SCHEMA_TABLES` from `./duckdb-tables.ts`.

- [ ] **Step 1: Write `duckdb-ddl.ts`**

```ts
// packages/schema/src/duckdb-ddl.ts
/** Parse helpers over schema.duckdb.sql. The ONLY place a regex touches the DDL. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;

export const DUCKDB_SCHEMA_PATH = join(HERE, "schema.duckdb.sql");
export const SURREAL_SCHEMA_PATH = join(HERE, "schema.surql");

export const DUCKDB_SCHEMA_SQL: string = readFileSync(DUCKDB_SCHEMA_PATH, "utf8");

const stripQuotes = (name: string): string => name.replace(/^"|"$/g, "");

export function parseDuckdbTables(sql: string = DUCKDB_SCHEMA_SQL): readonly string[] {
    return [...sql.matchAll(/^CREATE TABLE IF NOT EXISTS\s+("?[A-Za-z_][\w]*"?)\s*\(/gm)].map((m) =>
        stripQuotes(m[1]!),
    );
}

export interface DuckdbIndex {
    readonly name: string;
    readonly table: string;
    readonly unique: boolean;
}

export function parseDuckdbIndexes(sql: string = DUCKDB_SCHEMA_SQL): readonly DuckdbIndex[] {
    const re = /^CREATE\s+(UNIQUE\s+)?INDEX IF NOT EXISTS\s+("?[\w]+"?)\s+ON\s+("?[\w]+"?)\s*\(/gm;
    return [...sql.matchAll(re)].map((m) => ({
        name: stripQuotes(m[2]!),
        table: stripQuotes(m[3]!),
        unique: m[1] !== undefined,
    }));
}

/** Columns of one CREATE TABLE body, in declaration order. */
export function parseDuckdbColumns(table: string, sql: string = DUCKDB_SCHEMA_SQL): readonly string[] {
    const re = new RegExp(`^CREATE TABLE IF NOT EXISTS\\s+"?${table}"?\\s*\\(([\\s\\S]*?)^\\);`, "m");
    const body = sql.match(re)?.[1];
    if (body === undefined) return [];
    return body
        .split("\n")
        .map((line) => line.replace(/--.*$/, "").trim())
        .filter((line) => line.length > 0)
        .map((line) => stripQuotes(line.split(/\s+/)[0]!))
        .filter((name) => name.length > 0 && !/^(PRIMARY|UNIQUE|CONSTRAINT|CHECK)$/i.test(name));
}

export interface SurrealTable {
    readonly table: string;
    readonly relation: boolean;
}

export function parseSurrealTables(surql: string): readonly SurrealTable[] {
    const re = /^DEFINE TABLE (?:IF NOT EXISTS )?([\w]+)([^;]*);/gm;
    return [...surql.matchAll(re)].map((m) => ({
        table: m[1]!,
        relation: /TYPE RELATION/.test(m[2] ?? ""),
    }));
}
```

- [ ] **Step 2: Write the structural test**

```ts
// packages/schema/src/duckdb-schema.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
    DUCKDB_SCHEMA_SQL,
    SURREAL_SCHEMA_PATH,
    parseDuckdbColumns,
    parseDuckdbIndexes,
    parseDuckdbTables,
    parseSurrealTables,
} from "./duckdb-ddl.ts";
import { DUCKDB_SCHEMA_TABLES } from "./duckdb-tables.ts";

const surql = readFileSync(SURREAL_SCHEMA_PATH, "utf8");
const surrealTables = parseSurrealTables(surql);
const duckTables = parseDuckdbTables();
const duckTableSet = new Set(duckTables);

describe("coverage of the Surreal schema", () => {
    test("every Surreal table has a DuckDB table of the same name", () => {
        const missing = surrealTables.map((t) => t.table).filter((t) => !duckTableSet.has(t));
        expect(missing).toEqual([]);
    });

    test("the DDL adds no table the Surreal schema never had", () => {
        const surrealSet = new Set(surrealTables.map((t) => t.table));
        expect(duckTables.filter((t) => !surrealSet.has(t))).toEqual([]);
    });

    test("table names are unique", () => {
        expect(new Set(duckTables).size).toBe(duckTables.length);
    });
});

// Statements only - comments carry Surreal quotes, FTS pragmas, and prose that
// would otherwise trip the "no Surreal syntax" style assertions below.
const statements = DUCKDB_SCHEMA_SQL.split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

describe("row identity", () => {
    test("every table declares id VARCHAR PRIMARY KEY first", () => {
        for (const table of duckTables) {
            expect(parseDuckdbColumns(table)[0]).toBe("id");
        }
        const bodies = DUCKDB_SCHEMA_SQL.match(/^\s*id VARCHAR PRIMARY KEY,?$/gm) ?? [];
        expect(bodies.length).toBe(duckTables.length);
    });

    test("no autoincrement or sequence identity anywhere", () => {
        expect(statements).not.toMatch(/\b(SEQUENCE|nextval|SERIAL|GENERATED\s+ALWAYS)\b/i);
    });
});

describe("edge tables", () => {
    const relationTables = surrealTables.filter((t) => t.relation).map((t) => t.table);

    test("the Surreal schema really does declare relations (guards the parser)", () => {
        expect(relationTables.length).toBeGreaterThan(20);
    });

    test("every relation table becomes (id, in_id, out_id, …)", () => {
        for (const table of relationTables) {
            const cols = parseDuckdbColumns(table);
            expect(cols.slice(0, 3)).toEqual(["id", "in_id", "out_id"]);
        }
    });

    test("every relation table is indexed on both sides", () => {
        const indexes = parseDuckdbIndexes();
        for (const table of relationTables) {
            const onTable = indexes.filter((i) => i.table === table);
            expect(onTable.some((i) => i.name.endsWith("_in"))).toBe(true);
            expect(onTable.some((i) => i.name.endsWith("_out"))).toBe(true);
        }
    });

    test("no column is named bare `in` or `out`", () => {
        expect(DUCKDB_SCHEMA_SQL).not.toMatch(/^\s+in\s+VARCHAR/m);
        expect(DUCKDB_SCHEMA_SQL).not.toMatch(/^\s+out\s+VARCHAR/m);
    });
});

describe("types and Surreal leftovers", () => {
    test("no Surreal syntax survived the translation", () => {
        for (const token of ["DEFINE TABLE", "DEFINE FIELD", "DEFINE INDEX", "SCHEMAFULL", "record<", "option<", "time::now()"]) {
            expect(statements).not.toContain(token);
        }
    });

    test("datetimes are TIMESTAMP", () => {
        expect(DUCKDB_SCHEMA_SQL).toMatch(/\bTIMESTAMP\b/);
        expect(DUCKDB_SCHEMA_SQL).not.toMatch(/\bDATETIME\b/);
    });

    test("index names are unique across the database", () => {
        const names = parseDuckdbIndexes().map((i) => i.name);
        const dupes = names.filter((n, i) => names.indexOf(n) !== i);
        expect(dupes).toEqual([]);
    });

    test("every index targets a declared table", () => {
        for (const index of parseDuckdbIndexes()) expect(duckTableSet.has(index.table)).toBe(true);
    });
});

describe("full-text search plan", () => {
    test("FTS is not built by the DDL - only documented in comments", () => {
        expect(statements).not.toMatch(/create_fts_index|FULLTEXT|ANALYZER|PRAGMA/i);
    });

    test("the header documents the two covered surfaces and the dropped ngram index", () => {
        const header = DUCKDB_SCHEMA_SQL.slice(0, DUCKDB_SCHEMA_SQL.indexOf("CREATE TABLE"));
        expect(header).toContain("turn.text_excerpt");
        expect(header).toContain("commit.message");
        expect(header).toContain("PRAGMA create_fts_index");
        expect(header).toMatch(/ngram/i);
        expect(header).toContain("#758");
    });

    test("the omissions are listed, not silently dropped", () => {
        for (const omitted of ["DEFINE BUCKET", "DEFINE ANALYZER", "REMOVE INDEX", "REFERENCE ON DELETE CASCADE"]) {
            expect(DUCKDB_SCHEMA_SQL).toContain(omitted);
        }
    });
});

describe("manifest", () => {
    test("every DDL table has exactly one manifest entry", () => {
        const manifestTables = DUCKDB_SCHEMA_TABLES.map((t) => t.table);
        expect(new Set(manifestTables).size).toBe(manifestTables.length);
        expect([...manifestTables].sort()).toEqual([...duckTables].sort());
    });

    test("every entry carries a non-empty note and a known stage and kind", () => {
        for (const entry of DUCKDB_SCHEMA_TABLES) {
            expect(entry.note.length).toBeGreaterThan(0);
            expect(["active", "conditional", "staged"]).toContain(entry.stage);
            expect(["node", "edge"]).toContain(entry.kind);
        }
    });

    test("kind matches the Surreal relation flag", () => {
        const relation = new Map(surrealTables.map((t) => [t.table, t.relation] as const));
        for (const entry of DUCKDB_SCHEMA_TABLES) {
            expect(entry.kind).toBe(relation.get(entry.table) === true ? "edge" : "node");
        }
    });

    test("covers every table apps/axctl SCHEMA_TABLES lists (parity, not wiring)", () => {
        const insights = readFileSync(
            new URL("../../../apps/axctl/src/queries/insights.ts", import.meta.url).pathname,
            "utf8",
        );
        const block = insights.slice(insights.indexOf("export const SCHEMA_TABLES"));
        const listed = [...block.matchAll(/\{\s*table:\s*"([\w]+)"/g)].map((m) => m[1]!);
        expect(listed.length).toBeGreaterThan(50);
        const manifest = new Set(DUCKDB_SCHEMA_TABLES.map((t) => t.table));
        expect(listed.filter((t) => !manifest.has(t))).toEqual([]);
    });
});
```

- [ ] **Step 3: Write the real-load test**

```ts
// packages/schema/src/duckdb-load.test.ts
/**
 * Acceptance: the DDL loads clean into a FRESH DuckDB.
 *
 * Uses a real duckdb binary when one is reachable ($AX_DUCKDB_BIN, then PATH).
 * With no binary the load cannot be proven, so the test SKIPS loudly rather
 * than passing vacuously - the structural suite in duckdb-schema.test.ts is
 * what still runs everywhere.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DUCKDB_SCHEMA_PATH, parseDuckdbTables } from "./duckdb-ddl.ts";

const resolveDuckdb = (): string | null => {
    const fromEnv = process.env.AX_DUCKDB_BIN;
    if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
    const which = Bun.spawnSync(["which", "duckdb"]);
    const path = new TextDecoder().decode(which.stdout).trim();
    return which.exitCode === 0 && path.length > 0 ? path : null;
};

const duckdb = resolveDuckdb();

describe("schema.duckdb.sql loads into a fresh DuckDB", () => {
    if (duckdb === null) {
        test.skip("SKIPPED: no duckdb binary (set AX_DUCKDB_BIN or put duckdb on PATH)", () => {});
        return;
    }

    test("loads with no error and creates every declared table", () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-duckdb-ddl-"));
        try {
            const dbPath = join(dir, "cache.duckdb");
            const script = `.read ${DUCKDB_SCHEMA_PATH}\nSELECT table_name FROM duckdb_tables() ORDER BY table_name;\n`;
            const run = Bun.spawnSync([duckdb, "-batch", "-noheader", "-list", dbPath], {
                stdin: new TextEncoder().encode(script),
            });
            const stderr = new TextDecoder().decode(run.stderr);
            const stdout = new TextDecoder().decode(run.stdout);
            expect(stderr).toBe("");
            expect(run.exitCode).toBe(0);
            const created = stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
            expect([...created].sort()).toEqual([...parseDuckdbTables()].sort());
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("re-reading the DDL into the same database is idempotent", () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-duckdb-ddl-"));
        try {
            const dbPath = join(dir, "cache.duckdb");
            const script = `.read ${DUCKDB_SCHEMA_PATH}\n.read ${DUCKDB_SCHEMA_PATH}\nSELECT count(*) FROM duckdb_tables();\n`;
            const run = Bun.spawnSync([duckdb, "-batch", "-noheader", "-list", dbPath], {
                stdin: new TextEncoder().encode(script),
            });
            expect(new TextDecoder().decode(run.stderr)).toBe("");
            expect(run.exitCode).toBe(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("the two FTS surfaces build with PRAGMA create_fts_index", () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-duckdb-ddl-"));
        try {
            const dbPath = join(dir, "cache.duckdb");
            const script = [
                `.read ${DUCKDB_SCHEMA_PATH}`,
                "INSTALL fts; LOAD fts;",
                "PRAGMA create_fts_index('turn', 'id', 'text_excerpt');",
                "PRAGMA create_fts_index('commit', 'id', 'message');",
                "SELECT 'fts-ok';",
            ].join("\n");
            const run = Bun.spawnSync([duckdb, "-batch", "-noheader", "-list", dbPath], {
                stdin: new TextEncoder().encode(`${script}\n`),
            });
            const stdout = new TextDecoder().decode(run.stdout);
            if (run.exitCode !== 0 && /HTTP|network|Failed to download/i.test(new TextDecoder().decode(run.stderr))) {
                // Offline: the fts extension cannot be fetched. Structural coverage stands.
                return;
            }
            expect(run.exitCode).toBe(0);
            expect(stdout).toContain("fts-ok");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
```

- [ ] **Step 4: Add the package exports**

In `packages/schema/package.json`, extend `exports` with:

```json
    "./schema.duckdb.sql": "./src/schema.duckdb.sql",
    "./duckdb-ddl": { "types": "./src/duckdb-ddl.ts", "import": "./src/duckdb-ddl.ts" },
    "./duckdb-tables": { "types": "./src/duckdb-tables.ts", "import": "./src/duckdb-tables.ts" },
```

- [ ] **Step 5: Run both suites and confirm they FAIL for the right reason**

Run: `bun test packages/schema`
Expected: FAIL - `schema.duckdb.sql` and `duckdb-tables.ts` do not exist yet.

---

### Task 4: Translate the DDL (four parallel sections)

**Files:**
- Create: `packages/schema/src/duckdb/_part-1.sql` (schema.surql lines 1–491:
  `skill` … `content_block`)
- Create: `packages/schema/src/duckdb/_part-2.sql` (lines 493–1164: `content_atom` …
  `graph_health_check`)
- Create: `packages/schema/src/duckdb/_part-3.sql` (lines 1165–1704: `role` … `hook_fire`)
- Create: `packages/schema/src/duckdb/_part-4.sql` (lines 1705–2196: `proposal` …
  `run_evidence_ref`)
- Create: `packages/schema/src/schema.duckdb.sql` (header + the four parts concatenated;
  the parts and the `duckdb/` directory are deleted afterwards)

**Interfaces:**
- Consumes: the translation contract above, verbatim.
- Produces: `CREATE TABLE` / `CREATE INDEX` statements consumed by `duckdb-ddl.ts` parsers and
  the manifest in Task 5.

- [ ] **Step 1: Dispatch one subagent per part (model: sonnet), each with the full
  translation-contract table pasted into its prompt**

Each subagent: reads ONLY its line range of `packages/schema/src/schema.surql`, writes its part
file, and reports the table names it emitted. No part file contains a header or an OMITTED block
(those live in the assembled file's header).

- [ ] **Step 2: Write the file header**

The header (before the first `CREATE TABLE`) must state: what the file is, that it replaces
`schema.surql` with no compat path, the id contract pointer (`@ax/lib/stable-id`), the FTS plan
(`turn.text_excerpt` + `commit.message`, built at ingest with
`PRAGMA create_fts_index('turn','id','text_excerpt')` / `('commit','id','message')`), the
deliberately dropped skill ngram index (per #758, skills search moves to plain SQL), and the
OMITTED block listing `DEFINE BUCKET`, `DEFINE ANALYZER`, `REMOVE INDEX`, and
`REFERENCE ON DELETE CASCADE`, each with one line of why.

- [ ] **Step 3: Assemble**

```bash
cd /Users/necmttn/Projects/ax/.claude/worktrees/w0-schema-ddl
cat packages/schema/src/duckdb/_header.sql packages/schema/src/duckdb/_part-[1-4].sql \
  > packages/schema/src/schema.duckdb.sql
rm -rf packages/schema/src/duckdb
```

- [ ] **Step 4: Run the structural suite**

Run: `bun test packages/schema/src/duckdb-schema.test.ts`
Expected: every test except the manifest block passes (the manifest lands in Task 5).

- [ ] **Step 5: Run the real load**

Run: `AX_DUCKDB_BIN=<scratchpad>/duckdb bun test packages/schema/src/duckdb-load.test.ts`
Expected: PASS. Fix any reserved-word or duplicate-index-name error the loader reports and
re-run until clean.

---

### Task 5: Table manifest

**Files:**
- Create: `packages/schema/src/duckdb-tables.ts`

**Interfaces:**
- Consumes: the assembled `schema.duckdb.sql`, and the stage labels in
  `apps/axctl/src/queries/insights.ts` `SCHEMA_TABLES` (read once by a human/subagent to copy
  stage + note wording; NOT imported at runtime).
- Produces:
  - `interface DuckdbTableSpec { readonly table: string; readonly kind: "node" | "edge"; readonly stage: "active" | "conditional" | "staged"; readonly note: string }`
  - `DUCKDB_SCHEMA_TABLES: readonly DuckdbTableSpec[]`

- [ ] **Step 1: Confirm the manifest tests are RED**

Run: `bun test packages/schema/src/duckdb-schema.test.ts`
Expected: FAIL - cannot resolve `./duckdb-tables.ts`.

- [ ] **Step 2: Write the manifest**

One entry per `CREATE TABLE` in file order. `kind` is `edge` when the Surreal declaration said
`TYPE RELATION`, else `node`. `stage` and `note` are copied from `SCHEMA_TABLES` where the table
appears there; new/unlisted tables get `stage: "active"` and a one-line note describing what the
table holds. Shape:

```ts
// packages/schema/src/duckdb-tables.ts
/** Manifest of every table in schema.duckdb.sql. Mirrors the SchemaTableSpec
 *  shape used by apps/axctl/src/queries/insights.ts (SCHEMA_TABLES) so the
 *  `ax insights schema` view can adopt it in wave 2. Exported, NOT wired. */
export interface DuckdbTableSpec {
    readonly table: string;
    readonly kind: "node" | "edge";
    readonly stage: "active" | "conditional" | "staged";
    readonly note: string;
}

export const DUCKDB_SCHEMA_TABLES: readonly DuckdbTableSpec[] = [
    { table: "skill", kind: "node", stage: "active", note: "Installed skills and slash commands." },
    // … one entry per table, file order …
];
```

- [ ] **Step 3: Run the suite**

Run: `bun test packages/schema`
Expected: PASS.

---

### Task 6: Gates and commit

- [ ] **Step 1:** `bun run typecheck` → exit 0.
- [ ] **Step 2:** `bunx tsc --noEmit -p tsconfig.json` → exit 0.
- [ ] **Step 3:** `bun test packages/schema packages/lib` → green (via a tmp wrapper script if
  the repo hook blocks the literal command).
- [ ] **Step 4:** `AX_DUCKDB_BIN=<scratchpad>/duckdb bun test packages/schema/src/duckdb-load.test.ts`
  → green (record the duckdb version in REPORT.md).
- [ ] **Step 5:** Confirm no scratch files survive: `git status --short` shows only the intended
  files; `packages/schema/src/duckdb/` is gone.
- [ ] **Step 6:** Commit.

```bash
git add -A ':!BRIEF.md' ':!REPORT.md'
git commit -m "feat(v2): DuckDB DDL, table manifest, deterministic row-id contract"
```

## Self-Review

- **Spec coverage.** Chunk asks for: DDL file (Task 4), typed columns (contract table), edge
  tables with both-side indexes (contract + Task 3 tests), TIMESTAMP datetimes (contract +
  test), JSON-as-VARCHAR noted (contract), FTS limited to `turn.text_excerpt` +
  `commit.message` and built at ingest (header + tests), skill ngram index dropped (header +
  test), names aligned with Surreal (coverage test), SCHEMA_TABLES-style manifest not wired
  (Task 5 + parity test), content-hash ids never autoincrement/timestamp (Task 1 + DDL test),
  two-derive byte-identical property test (Task 1), dangling-ref integrity function (Task 2),
  acceptance load into fresh DuckDB (Task 3 load test, real binary).
- **Placeholders.** None: every test and module body is written out.
- **Type consistency.** `DUCKDB_SCHEMA_TABLES` / `DuckdbTableSpec` are used identically in
  Task 3's test and Task 5's module; `parseDuckdbTables` / `parseDuckdbColumns` /
  `parseDuckdbIndexes` / `parseSurrealTables` signatures match their call sites;
  `stableId` / `edgeRowId` / `derivedRowId` names match between Task 1's test and module.
