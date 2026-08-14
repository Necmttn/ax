# w1-seam-design Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the one typed seam every v2 reader and writer goes through, prove it by porting
`ax recall` end-to-end onto DuckDB, and partition the remaining ~168 SurrealDB files into wave-2
chunks.

**Architecture:** Reads open the PUBLISHED SNAPSHOT read-only through `CacheRead`; writes only ever
happen inside ingest through `CacheWrite`, which REFUSES to open unless this process holds the ingest
lock. One merged ingest lock (`@ax/lib/ingest-lock`) replaces the two that exist today. One atomic
staged-rename primitive replaces three copies. The DDL file becomes the single source of schema truth
(table manifest, recipe coverage, banned types) instead of three hand-maintained mirrors.

**Tech Stack:** bun ≥1.3, TypeScript strict, `effect@4.0.0-beta.78` (`Context.Service` + curried
`Layer.effect`), DuckDB v1.5.5 via `bun:ffi` (`@ax/lib/duckdb`), `bun:test`.

**Spec:** `BRIEF.md` (this worktree) + `docs/superpowers/plans/2026-08-14-v2-duckdb-backlog.md`.

## Global Constraints

- DuckDB **v1.5.5**. A real dylib is required for every e2e test; build with
  `bash scripts/build-duckdb.sh` (cached at `DUCKDB_DIST_DIR`) or export `AX_DUCKDB_DYLIB`.
  **A loudly-skipped suite is a gate failure for this chunk** - the new seam + vertical suites must
  actually run.
- `EXPLAIN` is **not** an index oracle (#786). Justify index/query choices by wall-clock only.
- `packages/lib/src/**` is runtime code: `node:fs` / `node:path` are BANNED (`bun run check:no-node-fs`).
  Use `FileSystem.FileSystem` + `posixPath` (`@ax/lib/shared/path`). `node:os#homedir` is allowed.
- No backward compatibility: the SurrealDB recall path is DELETED, not dual-run.
- Natural keys must be append-stable; a table whose writer this chunk wires moves OUT of `RECIPE_TODO`
  with a concrete `NATURAL_KEY_RECIPES` entry.
- Never commit `BRIEF.md` / `REPORT.md` (`git add -A ':!BRIEF.md' ':!REPORT.md'`).
- Banned DDL column types (FFI-undecodable): `UUID, ENUM, BIT, TIMESTAMP_S, TIMESTAMP_MS,
  TIMESTAMP_NS, TIMESTAMP_TZ, TIMESTAMPTZ, TIME_TZ, TIMETZ`, and native `LIST` (`T[]`).

---

## Decisions of record (locked before Task 1)

**D1 - the lock is the write capability.** `CacheWrite` cannot be opened unless
`ingestLockHeldHere(lockPath)` is true. The merged lock keeps a process-wide `Map` of canonical lock
path → acquire token (it needs one anyway, to tell a genuine second in-process acquirer from a
crashed-run leftover), so the seam can ask it. This turns "writes only under the lock" from a comment
into a machine-checked invariant with a test that bites.

**D2 - the merged lock lives in `packages/lib/src/ingest-lock.ts`.** The live module
(`apps/axctl/src/ingest/ingest-lock.ts`, 3 callers) wins the CALL SURFACE; the duckdb module
(`packages/lib/src/duckdb/lock.ts` + `lock-state.ts`, 0 production callers) contributes the per-acquire
token, the `proc_started_at` pid-reuse fingerprint, canonical-path keying, and the per-path acquire
mutex. It must live in `packages/lib` because the seam (also `packages/lib`) depends on it and
`packages/lib` cannot import `apps/*`. Both duckdb-side lock modules are DELETED.

**D3 - one lock path: `cfg.paths.dataDir/ingest.lock`.** `ingestLockPath()` and `AX_INGEST_LOCK` are
deleted with the duckdb lock module. The live callers already pass `cfg.paths.dataDir`.

**D4 - the seam sets `SET TimeZone='UTC'` on every connection it opens.** The DDL's UTC contract says
all TIMESTAMP columns store UTC, and several columns are `DEFAULT CURRENT_TIMESTAMP`. DuckDB's
`CURRENT_TIMESTAMP` is TIMESTAMPTZ and casting it into a naive TIMESTAMP column uses the SESSION time
zone - so on a non-UTC box the DDL default and every seam-stamped column would silently store LOCAL
time. Pinning the connection's TimeZone is the only place that can be fixed once for every reader and
writer. Pinned by a test asserting a stamped write reads back as UTC.

**D5 - read laziness, success-only memoization.** `CacheReadLayer` must be safe to put in any
long-lived layer (`ax serve`, `ax mcp`) on a box with no dylib and no snapshot yet, so nothing is
opened at layer-build time. The dylib + snapshot open on FIRST QUERY, memoized on SUCCESS ONLY: a
long-lived daemon that queried before the first ingest must pick the snapshot up afterwards, so
caching the failure would be wrong.

**D6 - `ax recall` gets its own `"cache"` command runtime.** The ported command is routed WITHOUT
`AppLayer`, so it gets the throwing no-DB `SurrealClient` proxy. Any un-ported code path inside the
vertical fails loudly instead of silently reading the old engine. This is the acceptance signal that
the vertical really is ported, and it is the template wave 2 follows.

**D7 - skills recall is plain SQL, not FTS.** Locked upstream by #758 and by the DDL header: only
`turn.text_excerpt` and `commit.message` get `PRAGMA create_fts_index`. Skills move to `ILIKE`.

---

## File Structure

**Created**

| File | Responsibility |
| --- | --- |
| `packages/lib/src/staged-rename.ts` | The ONE atomic publish primitive: stage at a unique sibling temp path, rename into place, remove the temp on any failure. |
| `packages/lib/src/ingest-lock.ts` | The ONE ingest lock: live call surface (`ingestLockOptions`, `withIngestLock`, `IngestLockOutcome`) + token / `proc_started_at` / canonical keying / per-path mutex, and `ingestLockHeldHere` for D1. |
| `packages/lib/src/duckdb/seam.ts` | `CacheRead` + `CacheWrite` service definitions, layers, and the errors that make the two sides legible. |
| `packages/lib/src/duckdb/columns.ts` | The row-decode CONTRACT as schemas: `TimestampColumn`, `JsonArrayColumn`, `JsonObjectColumn`, `TextColumn`, re-exported `NumberFromBigIntColumn`. |
| `packages/lib/src/duckdb/fts.ts` | `FTS_TARGETS` + `buildFtsIndexes` - the ingest-time `PRAGMA create_fts_index` pass and the `matchBm25` SQL fragment readers use. |
| `packages/lib/src/duckdb/internal.ts` | Test-only exports pulled off the public barrel. |
| `packages/schema/src/parse-duckdb-schema.ts` | `parseDuckdbTables` / `parseDuckdbColumnDefs` - the DDL parser the manifest, recipe coverage, and parity test all read. |
| `apps/axctl/src/queries/recall-sql.ts` | The DuckDB SQL + row schemas for the recall vertical. |

**Modified**

| File | Change |
| --- | --- |
| `packages/lib/src/atomic-write.ts` | Reimplemented on `stageAndRename`. |
| `packages/lib/src/duckdb/dylib.ts` | `extractDylib` uses `stageAndRename`; one env knob. |
| `packages/lib/src/duckdb/client.ts` | `publishSnapshot` uses `stageAndRename`; add `makeDuckDb` (scoped service constructor) and re-express the layers on it. |
| `packages/lib/src/duckdb/index.ts` | Barrel trimmed to the seam's public surface. |
| `packages/lib/src/testing/duckdb-dylib.ts` | Prefer the custom-built artifact; one env knob. |
| `packages/schema/src/duckdb-tables.ts` | Manifest DERIVED from the DDL, not hand-mirrored. |
| `packages/lib/src/stable-id.ts` | `RECIPE_TODO` derived from the DDL; `skill`/`turn`/`commit`/`session` recipes concrete. |
| `packages/schema/src/duckdb-parity.test.ts` | `BANNED_TYPE_TOKENS` derived from `accessorFor`. |
| `apps/axctl/src/queries/recall.ts` | Ported to `CacheRead`. |
| `apps/axctl/src/dashboard/recall.ts` | `fetchRecall` requires `CacheRead`, not `SurrealClient`. |
| `apps/axctl/src/cli/commands/recall.ts` | Ported pickers + `"cache"` runtime. |
| `apps/axctl/src/cli/index.ts`, `commands/manifest.ts` | New `"cache"` `CommandRuntime` + `withCache`. |
| `apps/axctl/src/mcp/tools.ts`, `apps/axctl/src/dashboard/contract/insights.ts` | Provide `CacheRead`. |
| `apps/axctl/src/{cli/commands/ingest,share/recover,dashboard/ingest-workflow}.ts` | Import the merged lock. |
| `docs/superpowers/plans/2026-08-14-v2-duckdb-backlog.md` | Wave-2 FOG note replaced by the partition list. |

**Deleted**

`packages/lib/src/duckdb/lock.ts`, `lock-state.ts`, `lock.test.ts`, `lock-state.test.ts`,
`apps/axctl/src/ingest/ingest-lock.ts` (+ its test, rewritten against the merged module).

---

### Task 1: One atomic publish primitive

**Files:** Create `packages/lib/src/staged-rename.ts`, `packages/lib/src/staged-rename.test.ts`;
modify `atomic-write.ts`, `duckdb/dylib.ts`, `duckdb/client.ts`.

**Interfaces - Produces:**

```ts
export interface StagedRenameOptions<E, R> {
    readonly stage: (tmpPath: string) => Effect.Effect<void, E, R>;
    readonly beforeRename?: Effect.Effect<void, E, R>;
    readonly afterRename?: Effect.Effect<void, never, R>;
}
export const stageAndRename: <E, R>(
    target: string,
    options: StagedRenameOptions<E, R>,
) => Effect.Effect<void, E | PlatformError, R | FileSystem.FileSystem>;
```

Contract: creates `dirname(target)` recursively; the temp path is
`${target}.${process.pid}.${crypto.randomUUID()}.tmp` (pid alone is NOT unique within a process - two
fibers staging the same target shared one path, the bug already fixed once in `dylib.ts`); removes a
pre-existing temp path before staging; runs `stage(tmp)`, then `beforeRename`, then
`fs.rename(tmp, target)`, then `afterRename`; `Effect.ensuring` removes the temp on every exit path.

- [ ] **Step 1: Write the failing tests** in `staged-rename.test.ts` (real temp dirs, no mocks):
  `publishes the staged bytes at the target`; `leaves the target untouched when stage fails`;
  `removes the temp file when stage fails`; `two concurrent calls on the same target both publish
  without either observing a partial file`; `creates a missing parent directory`;
  `runs afterRename only after the rename lands`.
- [ ] **Step 2:** `bun test packages/lib/src/staged-rename.test.ts` → FAIL (module not found).
- [ ] **Step 3:** Implement `staged-rename.ts`.
- [ ] **Step 4:** `bun test packages/lib/src/staged-rename.test.ts` → PASS.
- [ ] **Step 5:** Refit the three copies. `atomic-write.ts`: `stage` writes the text, `beforeRename`
  copies the prior file to `<path>.bak`, validation still runs BEFORE anything touches disk.
  `dylib.ts` `extractDylib`: `stage` writes the bytes, `afterRename` chmods 0400. `client.ts`
  `publishSnapshot`: `stage` runs CHECKPOINT/ATTACH/COPY/DETACH into the temp path - keep the
  same-file guard, the `options.from` guard, and R14 verbatim; only the temp-path + rename mechanics
  move.
- [ ] **Step 6:** `bun test packages/lib packages/schema` → PASS (existing atomic-write, dylib, and
  snapshot suites are the regression net; they must pass UNCHANGED).
- [ ] **Step 7:** Commit `refactor(v2): one staged-rename primitive for three atomic publishers`.

### Task 2: Derived schema truth

**Files:** Create `packages/schema/src/parse-duckdb-schema.ts` (+ test); modify `duckdb-tables.ts`,
`duckdb-parity.test.ts`, `packages/lib/src/stable-id.ts`, `packages/schema/src/duckdb-recipe-coverage.test.ts`.

**Interfaces - Produces:**

```ts
export interface DuckdbColumnDef { readonly name: string; readonly type: string }
export const parseDuckdbTables: (sql: string) => ReadonlyArray<string>;
export const parseDuckdbColumnDefs: (tableBody: string) => ReadonlyArray<DuckdbColumnDef>;
export const DUCKDB_TABLE_NAMES: ReadonlySet<string>; // parsed from the committed DDL
```

- [ ] **Step 1:** Move the parsers out of `duckdb-parity.test.ts` into `parse-duckdb-schema.ts`
  unchanged, and write `parse-duckdb-schema.test.ts` asserting they find every table (count matches
  the parity test's `EXPECTED_TABLES_COMPARED`) and strip the `"commit"` quoting.
- [ ] **Step 2:** Run it → FAIL (module not found).
- [ ] **Step 3:** Implement; re-point `duckdb-parity.test.ts` at the shared parsers.
- [ ] **Step 4:** `bun test packages/schema` → PASS.
- [ ] **Step 5:** `duckdb-tables.ts`: keep the hand-written `stage`/`note` metadata (that is real
  editorial content the DDL does not carry) but DERIVE the table LIST from `DUCKDB_TABLE_NAMES`, and
  make the existing manifest test assert set equality in both directions, so a table added to the DDL
  without a manifest entry fails the build.
- [ ] **Step 6:** `stable-id.ts`: replace the hand-listed `RECIPE_TODO` literal with
  `DUCKDB_TABLE_NAMES` minus `Object.keys(NATURAL_KEY_RECIPES)`, computed once. Keep the exported
  name and `ReadonlySet<string>` type so callers are unaffected.
- [ ] **Step 7:** `duckdb-parity.test.ts`: derive `BANNED_TYPE_TOKENS` from `row-decode.ts` -
  a type token is banned when `accessorFor(DuckDbTypeId[token]) === null`, plus the SQL spelling
  aliases (`TIMESTAMPTZ`, `TIMETZ`) mapped to their `DuckDbTypeId` name. Keep the `checked > 1000`
  sanity floor.
- [ ] **Step 8:** `bun test packages/schema packages/lib` → PASS; `bunx tsc --noEmit -p tsconfig.json` → 0.
- [ ] **Step 9:** Commit `refactor(v2): derive table manifest, recipe coverage and banned types from the DDL`.

### Task 3: One duckdb provisioning path

**Files:** modify `packages/lib/src/testing/duckdb-dylib.ts`, `packages/lib/src/duckdb/dylib.ts`,
`scripts/bench/run.ts`, `packages/schema/src/duckdb-load.test.ts`, `scripts/build-duckdb.test.ts`.

Today there are two dylib resolvers (`resolveDylibPath` runtime, `resolveTestDylib` test) and THREE
CLI-binary resolvers behind TWO env names (`AX_DUCKDB_BIN`, `AX_DUCKDB_SHELL`).

- [ ] **Step 1:** Write the failing test in `testing/duckdb-dylib.test.ts`: `prefers the custom-built
  artifact over the vendored download` - given a `DUCKDB_DIST_DIR`-shaped directory containing
  `libduckdb.dylib`, `resolveTestDylib()` returns THAT path even when a vendor copy exists.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Insert the custom-build lookup into `resolveTestDylib` between the
  `AX_DUCKDB_DYLIB` override and the vendor cache: `${DUCKDB_DIST_DIR ?? <repoRoot>/dist/duckdb}/<libFileName()>`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Collapse `AX_DUCKDB_SHELL` into `AX_DUCKDB_BIN` (one name for "the duckdb CLI
  binary"): update `scripts/build-duckdb.test.ts`, and add a one-line resolver
  `duckdbBinPath()` in `scripts/bench/duckdb-bin.ts` shared by `scripts/bench/run.ts` and
  `packages/schema/src/duckdb-load.test.ts`, preferring the custom build then `AX_DUCKDB_BIN` then PATH.
- [ ] **Step 6:** `bun test packages/lib/src/testing packages/schema scripts` → PASS.
- [ ] **Step 7:** Commit `refactor(v2): one duckdb provisioning path, one binary env knob`.

### Task 4: One ingest lock

**Files:** Create `packages/lib/src/ingest-lock.ts` (+ `.test.ts`); delete
`packages/lib/src/duckdb/{lock,lock-state,lock.test,lock-state.test}.ts` and
`apps/axctl/src/ingest/ingest-lock.ts` (+ test); modify the three callers and `duckdb/index.ts`.

**Interfaces - Produces:** (call surface unchanged from the live module)

```ts
export const INGEST_LOCK_STALE_GRACE_MS: number;
export interface IngestLockInfo { readonly pid: number; readonly startedAt: number; readonly command: string }
export type IngestLockOutcome<A, A2> =
    | { readonly _tag: "completed"; readonly value: A }
    | { readonly _tag: "busy"; readonly value: A2 }
    | { readonly _tag: "timeout" };
export const ingestLockOptions: (path: Path.Path, dataDir: string, command: string, timeoutSeconds: number)
    => { readonly lockPath: string; readonly command: string; readonly staleMs: number };
export const withIngestLock: <A, E, R, A2, E2, R2, R3 = never>(opts: {...}, work: Effect.Effect<A, E, R>)
    => Effect.Effect<IngestLockOutcome<A, A2>, E | E2, R | R2 | R3 | FileSystem.FileSystem | Path.Path>;
/** D1: does THIS process currently hold the lock at `lockPath`? Canonical-path keyed. */
export const ingestLockHeldHere: (lockPath: string) => Effect.Effect<boolean, never, FileSystem.FileSystem>;
/** Pure, exported for tests. */
export const encodeLockPayload: (p: LockPayload) => string;
export const decodeLockPayload: (text: string) => LockPayload | null;
```

Absorbed from the duckdb module, and NOTHING else (the steal-token protocol does not come across -
see the residuals below): per-acquire random `token`; `procStartedAt` fingerprint from
`ps -o lstart=` (best-effort, `null` degrades to pid-only liveness); canonical-path keying of all
process-local state; a per-canonical-path acquire `Semaphore` so the create→register window cannot
interleave in-process; release removes the file ONLY when the bytes on disk are still byte-identical
to what this handle wrote.

Added on top of the live module's simpler steal: **confirm-then-remove** - re-read the file and steal
only when its bytes still equal the text just classified stale. Ten lines, and it removes the common
interleave where a racer deletes a freshly-installed LIVE lock.

Two residuals stay, documented in the module header, both #789 (flock-class):
1. The steal removes BY PATH and does not prove the file it removes is the file it classified; a
   descheduled racer can still delete a lock installed after its own read.
2. Staleness is a `staleMs` TIMEOUT heuristic, not a proof: a process merely SUSPENDED past the
   window can have its lock stolen.
Only an OS advisory lock held across the takeover closes either.

- [ ] **Step 1: Write the failing tests** in `packages/lib/src/ingest-lock.test.ts` against a REAL
  temp lock file: `decodeLockPayload` rejects pid ≤ 0 and non-integer pids; a second acquire while
  held runs `onBusy`; a dead-pid lock is stolen; a lock whose `procStartedAt` no longer matches a
  LIVE pid is stolen (pid reuse); a late release from a superseded handle does NOT delete the
  successor's lock; `ingestLockHeldHere` is true inside `work` and false after; two spellings of the
  same path (`./x/ingest.lock` vs the absolute path) are ONE lock; the confirm-then-remove path
  leaves a freshly-installed live lock alone; timeout leaves the lock in place and returns
  `{_tag:"timeout"}`; interrupt leaves the lock in place.
- [ ] **Step 2:** Run → FAIL (module not found).
- [ ] **Step 3:** Implement `ingest-lock.ts` - start from the live module verbatim, then layer in the
  four absorbed mechanisms. Header documents the invariants + the two residuals ONLY; the
  review-archaeology narration from `duckdb/lock.ts` does not come across.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Delete the four duckdb lock files and the old `apps/axctl/src/ingest/ingest-lock.ts`
  (+ its test, ported into the new suite). Re-point the three callers
  (`cli/commands/ingest.ts`, `share/recover.ts`, `dashboard/ingest-workflow.ts`) at
  `@ax/lib/ingest-lock` - import line only, no call-site changes. Drop the lock exports from
  `duckdb/index.ts`.
- [ ] **Step 6:** `bun test packages/lib apps/axctl/src/ingest apps/axctl/src/dashboard` → PASS;
  `bunx tsc --noEmit -p tsconfig.json` → 0.
- [ ] **Step 7:** Commit `refactor(v2): one ingest lock - merge the duckdb protocol into the live module`.

### Task 5: The read seam

**Files:** Create `packages/lib/src/duckdb/columns.ts` (+ test), `packages/lib/src/duckdb/seam.ts`
(+ `seam-read.test.ts`); modify `client.ts` (add `makeDuckDb`).

**Interfaces - Produces:**

```ts
// columns.ts - the row-decode contract, stated once.
export const TimestampColumn: Schema.Codec<Date, ...>;              // TIMESTAMP -> Date (UTC, ms grain)
export const TextColumn: Schema.Codec<string, ...>;
export const JsonArrayColumn: <S extends Schema.Top>(item: S) => Schema.Codec<ReadonlyArray<S["Type"]>, ...>;
export const JsonObjectColumn: <S extends Schema.Top>(shape: S) => Schema.Codec<S["Type"], ...>;
export { NumberFromBigIntColumn } from "./bigint-column.ts";

// seam.ts
export class CacheUnavailableError extends Schema.TaggedError<...>()("CacheUnavailableError",
    { snapshotPath: Schema.String, message: Schema.String }) {}
export type CacheReadError = CacheUnavailableError | DuckDbQueryError
    | DuckDbUnsupportedTypeError | DuckDbDecodeError;
export interface CacheReadService {
    readonly rows: <S extends Schema.Top>(schema: S, sql: string, params?: ReadonlyArray<DuckDbParam>)
        => Effect.Effect<ReadonlyArray<S["Type"]>, CacheReadError, S["DecodingServices"]>;
    readonly first: <S extends Schema.Top>(schema: S, sql: string, params?: ReadonlyArray<DuckDbParam>)
        => Effect.Effect<Option.Option<S["Type"]>, CacheReadError, S["DecodingServices"]>;
    readonly raw: (sql: string, params?: ReadonlyArray<DuckDbParam>)
        => Effect.Effect<QueryResult, CacheReadError>;
    readonly snapshotPath: string;
}
export class CacheRead extends Context.Service<CacheRead, CacheReadService>()("ax/CacheRead") {}
export const CacheReadLayer: (options?: { readonly snapshotPath?: string; readonly assetPath?: string | null })
    => Layer.Layer<CacheRead>;
export const CacheReadLive: Layer.Layer<CacheRead>;
```

`JsonArrayColumn` / `JsonObjectColumn` exist because the DDL stores every array and object as
JSON-in-VARCHAR (see the DDL header's ARRAYS + FFI CLIENT COMPATIBILITY sections). Parsing is
ON DEMAND at the field, so a caller that does not select the column pays nothing, and a malformed
value is a typed decode failure naming the column rather than a `JSON.parse` throw.

- [ ] **Step 1: Write the failing tests.** `columns.test.ts` (pure, no DB): a `Date` passes
  `TimestampColumn`; the raw-text fallback a bad TIMESTAMP produces FAILS it loudly; `JsonArrayColumn`
  parses `'["a","b"]'`, fails on `'{"a":1}'`, fails on malformed JSON with the column text in the
  message; `JsonObjectColumn` round-trips. `seam-read.test.ts` (REAL DuckDB, via `duckdbTestSetup`):
  `rows` decodes a two-column result through a schema; `first` returns `none` on an empty result;
  a missing snapshot fails with `CacheUnavailableError` naming the path AND telling the user to run
  `ax ingest`; the connection reports `SELECT current_setting('TimeZone')` = `UTC` (D4); querying
  twice opens the database only ONCE (memoized); a query that FAILED because the snapshot was absent
  succeeds after the snapshot appears (success-only memoization, D5); the layer builds and can be
  torn down WITHOUT ever opening a database when no query runs (D5).
- [ ] **Step 2:** Run both → FAIL.
- [ ] **Step 3:** Implement `columns.ts`, then `makeDuckDb` in `client.ts` (scoped constructor:
  resolve dylib → `openLibDuckDb` → `Effect.addFinalizer(lib.close)` → `makeService(lib, fs)`), then
  re-express `layerFromLib`/`DuckDbLiveWith`/`DuckDbLayer` on top of it so there is ONE construction
  path, then `seam.ts`'s read half.
- [ ] **Step 4:** Run both → PASS.
- [ ] **Step 5:** Commit `feat(v2): CacheRead - the read seam over the published snapshot`.

### Task 6: The write seam

**Files:** modify `packages/lib/src/duckdb/seam.ts`; create `seam-write.test.ts`.

**Interfaces - Produces:**

```ts
export class CacheWriteUnlockedError extends Schema.TaggedError<...>()("CacheWriteUnlockedError",
    { livePath: Schema.String, lockPath: Schema.String, message: Schema.String }) {}
export type CacheWriteError = CacheWriteUnlockedError | CacheUnavailableError | DuckDbOpenError
    | DuckDbQueryError | DuckDbUnsupportedTypeError | DuckDbDecodeError | SnapshotPublishError;
export interface CacheWriteService extends CacheReadService {
    readonly exec: (sql: string, params?: ReadonlyArray<DuckDbParam>) => Effect.Effect<number, CacheWriteError>;
    /** INSERT OR REPLACE, stamping the SEMANTICS columns the DDL cannot express. */
    readonly put: (table: string, row: Readonly<Record<string, DuckDbParam>>) => Effect.Effect<void, CacheWriteError>;
    readonly putMany: (table: string, rows: ReadonlyArray<Readonly<Record<string, DuckDbParam>>>)
        => Effect.Effect<void, CacheWriteError>;
    readonly publish: Effect.Effect<void, CacheWriteError>;
}
/** Columns the DDL cannot express: Surreal `VALUE time::now()` overwrote these on EVERY
 *  write, insert or update alike. `put`/`putMany` stamp them unconditionally. */
export const WRITE_STAMPED_COLUMNS: Readonly<Record<string, string>>;
    // { skill: "ingested_at", skill_revision: "ts", agent_def: "ingested_at" }
export const withCacheWrite: <A, E, R>(
    options: { readonly livePath: string; readonly lockPath: string; readonly snapshotPath?: string;
               readonly assetPath?: string | null; readonly schemaSql?: string },
    body: (write: CacheWriteService) => Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | CacheWriteError, R | FileSystem.FileSystem>;
```

`withCacheWrite` is the ONLY way to get a `CacheWriteService`. It (1) refuses with
`CacheWriteUnlockedError` unless `ingestLockHeldHere(lockPath)` (D1), (2) opens `livePath` read-write,
(3) applies `schemaSql` (defaults to `DUCKDB_SCHEMA_SQL`, idempotent `IF NOT EXISTS`), (4) `SET
TimeZone='UTC'` (D4), (5) runs `body`, (6) publishes the snapshot THROUGH THAT CONNECTION
(`options.from`, RULING R14) **only when `body` succeeded**, (7) closes on every path via
`Effect.acquireUseRelease`.

- [ ] **Step 1: Write the failing tests** (REAL DuckDB): `refuses to open when the ingest lock is not
  held, naming both paths`; `opens when the lock IS held`; `applies the DDL so a bare live path
  becomes a full schema`; `put stamps skill.ingested_at even when the caller passes its own value`;
  `put stamps skill_revision.ts and agent_def.ingested_at`; `put does NOT stamp a table outside
  WRITE_STAMPED_COLUMNS`; `a stamped column reads back as UTC on a non-UTC TZ env` (set `process.env.TZ`
  and restore it in the same test); `publishes the snapshot on success`; `does NOT publish when body
  fails, and the previous snapshot is byte-identical afterwards`; `a reader holding the old snapshot
  keeps reading it across a publish`; `putMany with an empty array is a no-op`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. `put` builds `INSERT OR REPLACE INTO "<table>" (cols…) VALUES (?,…)` with
  the stamped column emitted as the literal `CURRENT_TIMESTAMP` rather than a bound parameter, so it
  is the database's clock and matches the DDL's own `DEFAULT CURRENT_TIMESTAMP` semantics. Identifiers
  are validated against `/^[a-z_][a-z0-9_]*$/i` and quoted (`commit` is a keyword) - a table or column
  name failing that is a typed refusal, never interpolated.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(v2): CacheWrite - lock-gated writes with the DDL's unexpressible semantics`.

### Task 7: FTS index build

**Files:** Create `packages/lib/src/duckdb/fts.ts` (+ `fts.test.ts`).

**Interfaces - Produces:**

```ts
export interface FtsTarget { readonly table: string; readonly idColumn: string; readonly textColumn: string }
export const FTS_TARGETS: ReadonlyArray<FtsTarget>; // turn.text_excerpt, commit.message - the WHOLE covered set
export const buildFtsIndexes: (write: CacheWriteService, targets?: ReadonlyArray<FtsTarget>)
    => Effect.Effect<void, CacheWriteError>;
/** `fts_main_<table>.match_bm25(<alias>.<idColumn>, ?)` - the score expression readers select. */
export const matchBm25Sql: (target: FtsTarget, alias: string) => string;
```

`buildFtsIndexes` issues `LOAD fts` once, then
`PRAGMA create_fts_index('<table>', '<id>', '<text>', overwrite = 1)` per target. `INSTALL` is NOT
issued: the shipped dylib links fts statically and the air-gap smoke in `scripts/build-duckdb.sh`
proves `LOAD fts` alone works.

- [ ] **Step 1: Write the failing test** (REAL DuckDB): build a `turn` table with three rows, run
  `buildFtsIndexes`, and assert `matchBm25Sql` scores the row containing the query term non-null and
  the others null; assert re-running `buildFtsIndexes` over the same table SUCCEEDS (overwrite=1);
  assert an FTS build over an EMPTY table succeeds and matches nothing.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS. Record the wall-clock of the build over the mini fixture in REPORT.md
  (the standing rule: no plan-output justifications).
- [ ] **Step 5:** Commit `feat(v2): ingest-time FTS index build for turn.text_excerpt and commit.message`.

### Task 8: Port the `ax recall` vertical

**Files:** Create `apps/axctl/src/queries/recall-sql.ts`; modify `apps/axctl/src/queries/recall.ts`,
`apps/axctl/src/dashboard/recall.ts`, `apps/axctl/src/cli/commands/recall.ts`,
`apps/axctl/src/cli/commands/manifest.ts`, `apps/axctl/src/cli/index.ts`,
`apps/axctl/src/mcp/tools.ts`, `apps/axctl/src/dashboard/contract/insights.ts`; rewrite
`apps/axctl/src/dashboard/recall.test.ts` and `recall.commit.test.ts` against a REAL DuckDB.

The public shapes do NOT change: `RecallParams`, `RecallResponse`, `RecallHit`, `RecallCommitHit`,
`RecallSkillHit`, `normalizeRecallParams`, `resolveRecallSources`, `RECALL_PAGINATION`,
`emptyRecallResponse`, `buildRecallNext`. Only `fetchRecall`'s requirement changes from
`SurrealClient` to `CacheRead`.

Surreal → DuckDB translation, stated once:

| Surreal | DuckDB |
| --- | --- |
| `text_excerpt @@ $q` | `fts_main_turn.match_bm25(t.id, ?) IS NOT NULL` |
| `session.project` (record deref) | `JOIN session s ON s.id = t.session`, select `s.project` |
| `message @1@ $q` + `search::score(1)` | `fts_main_commit.match_bm25(c.id, ?)` |
| `search::highlight(...)` | no DuckDB equivalent - snippet is the raw column, truncated in JS (turns already did exactly this; commits/skills now match) |
| `name @1@ $q OR description @2@ $q` | `name ILIKE ? OR description ILIKE ?` (D7), score = 2 for a name hit, 1 for description-only |
| `AND session IN [session:a, …]` (inlined record literals) | a bound `IN` list - `?` per id, no interpolation |
| `START $offset LIMIT $limit` | `LIMIT ? OFFSET ?` |
| `count() … GROUP ALL` | `SELECT count(*) AS total` |

The record-literal interpolation the Surreal path was forced into (bindings cannot carry record-id
arrays) DISAPPEARS: every filter is a bound parameter in DuckDB. That deletes an injection surface,
and the tests assert it (no `'` in any generated SQL).

- [ ] **Step 1: Write the failing tests.** A shared fixture builder
  `apps/axctl/src/dashboard/recall-fixture.ts` creates a temp live DB through `withCacheWrite`, writes
  a handful of `session`/`turn`/`commit`/`skill`/`invoked`/`has_content` rows via `put`, runs
  `buildFtsIndexes`, publishes, and hands back a `CacheRead` layer over the published snapshot. Then:
  turns search matches on a real term and misses on a nonsense term; `--project` filters; `--since`
  filters; `scope=here` filters by repository; `--skill` filters to sessions that invoked it;
  `--type` filters through `has_content`; commits search matches on message text; skills search
  matches name AND description and ranks a name hit above a description-only hit; multi-source fan-out
  returns all three and `total_count` is the SUM; an empty query short-circuits with ZERO queries
  issued; pagination `offset`/`limit` walks the result set without overlap; `truncated` is true only
  when more rows exist.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `recall-sql.ts` + the ported `recall.ts` / `fetchRecall`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Port the CLI: add `"cache"` to `CommandRuntime`, a `withCache` provider in
  `cli/index.ts` (AxConfig + platform + `CacheReadLive` + the throwing no-DB SurrealClient proxy),
  set `recallRuntime = { recall: "cache" }`, and port `resolveProject` / `resolveSkill` /
  `resolvePwdRepository` to `CacheRead`. Update `mcp/tools.ts` and
  `dashboard/contract/insights.ts` to provide `CacheReadLive`.
- [ ] **Step 6:** `bun test apps/axctl` → PASS; `bun run typecheck` → 0;
  `bunx tsc --noEmit -p tsconfig.json` → 0; `bun run check:no-node-fs` → exit 0.
- [ ] **Step 7:** Move `session`, `turn`, `commit`, `skill`, `invoked`, `has_content` OUT of
  `RECIPE_TODO` with concrete `NATURAL_KEY_RECIPES` entries (the fixture is a real writer for them).
- [ ] **Step 8:** Run `ax recall` against a REAL temp cache and paste the output into REPORT.md.
- [ ] **Step 9:** Commit `feat(v2): port ax recall to the DuckDB seam - the wave-2 template`.

### Task 9: Trim the barrel

**Files:** modify `packages/lib/src/duckdb/index.ts`, create `packages/lib/src/duckdb/internal.ts`,
update the tests that import test-only symbols.

- [ ] **Step 1:** Update `index.test.ts`'s closed-set assertion to the INTENDED surface: the seam
  (`CacheRead`, `CacheWrite`, layers, errors, column codecs, FTS), `DuckDb`/`DuckDbLive*`,
  `snapshotPath`, the error classes, and the types. Run → FAIL.
- [ ] **Step 2:** Create `internal.ts` re-exporting `openDatabase`, `readResult`, `makeConnection`,
  `bindableBigInt`, `layerFromLib` with a header saying it is test-only and not a supported surface;
  add `"./duckdb/internal"` to `packages/lib/package.json` exports; re-point `client.test.ts` and
  `ffi.test.ts` at it; trim `index.ts`.
- [ ] **Step 3:** `bun test packages/lib` → PASS; `bunx tsc --noEmit -p tsconfig.json` → 0.
- [ ] **Step 4:** Commit `refactor(v2): trim the duckdb barrel to the seam's public surface`.

### Task 10: The wave-2 partition list

**Files:** modify `docs/superpowers/plans/2026-08-14-v2-duckdb-backlog.md`.

- [ ] **Step 1:** Replace the "Wave 2 - seam ports (FOG …)" paragraph with 3–5 named chunks, each
  carrying an EXPLICIT file list (every file, no "and N more"), a file/line count, its dependency on
  Task 8's template, and its acceptance criteria.
- [ ] **Step 2:** Commit `docs(v2): wave-2 partition list from the w1 seam`.

### Task 11: Gates + report

- [ ] **Step 1:** `bun run typecheck` → 0 errors.
- [ ] **Step 2:** `bunx tsc --noEmit -p tsconfig.json` → 0 errors.
- [ ] **Step 3:** `bun test packages/lib packages/schema apps/axctl/src/queries` → green, with the new
  seam/vertical suites RUNNING (not skipped).
- [ ] **Step 4:** `bun run check:no-node-fs` → exit 0.
- [ ] **Step 5:** `bun scripts/bench/gen-mini-fixture.ts .bench-fixture && AX_BENCH_FIXTURE=.bench-fixture bun scripts/bench/run.ts` → passes.
- [ ] **Step 6:** Write `REPORT.md` (name: `mbp/w1-seam-design`) with real command output, the
  partition summary, and concerns. Append the DONE line to `/tmp/fleet-v2-duckdb.signals`.
