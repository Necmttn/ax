# w0-schema-ddl Implementation Plan (epic v2-duckdb)

**Code listings removed post-ship; see git history.**

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

Shipped `stable-id.ts` (`stableId`, `encodeNaturalKey`, `sourceFileKey`, `sessionRowId`, `turnRowId`, `toolCallRowId`, `agentEventRowId`, `derivedRowId`, `edgeRowId`, `NATURAL_KEY_RECIPES`) - the SHA-256-over-escaped-natural-key contract that replaces autoincrement/timestamp ids, with tests proving determinism and two-derive byte-identical stability.

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

Shipped `cache-integrity.ts` (`buildCacheIdIndex`, `checkCacheIntegrity`, `SidecarRef`, `DanglingRef`, `IntegrityReport`) - a pure dangling-ref checker over plain data (no DB handle), reusable from `ax doctor` and from ingest, with tests covering the missing-id and unknown-table cases.

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

Shipped `duckdb-ddl.ts` (`DUCKDB_SCHEMA_SQL`, `parseDuckdbTables`, `parseDuckdbIndexes`, `parseDuckdbColumns`, `parseSurrealTables` - the only place a regex touches the DDL), `duckdb-schema.test.ts` (structural + manifest-parity + Surreal-coverage tests, no DuckDB binary needed), and `duckdb-load.test.ts` (a real load into a fresh DuckDB that skips with a printed notice when no binary is reachable), plus the `package.json` export wiring - all written RED, before `schema.duckdb.sql` or `duckdb-tables.ts` existed.

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

Assembled `packages/schema/src/schema.duckdb.sql` by dispatching one subagent per `schema.surql` line range against the translation contract above, each part reporting the table names it emitted; concatenated the parts behind a header covering the id contract, the FTS plan, and the OMITTED block, then deleted the temporary part files and `duckdb/` directory. Verified against the Task 3 structural suite and a real DuckDB load.

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

Shipped `duckdb-tables.ts` - `DUCKDB_SCHEMA_TABLES`, one `DuckdbTableSpec` entry per `CREATE TABLE` in file order, `kind` derived from whether the Surreal declaration was a `TYPE RELATION`, `stage`/`note` copied from `apps/axctl/src/queries/insights.ts`'s `SCHEMA_TABLES` where the table appears there.

---

### Task 6: Gates and commit

Ran the four repo gates (`bun run typecheck`, `bunx tsc --noEmit -p tsconfig.json`, `bun test packages/schema packages/lib`, and a real DuckDB load via `AX_DUCKDB_BIN=<scratchpad>/duckdb bun test packages/schema/src/duckdb-load.test.ts`) to green, confirmed no scratch files survived (`packages/schema/src/duckdb/` gone), and landed the DDL, table manifest, and id contract in one conventional commit.

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
