# `@ax/lib/duckdb` - typed DuckDB FFI client (chunk w0-ffi-client)

**Code listings removed post-ship; see git history.**

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@ax/lib/duckdb` - the Effect-native, layer-testable DuckDB client (open / query
with typed row decode / exec / close, snapshot publish + open, ingest lockfile, dylib resolution)
that every later chunk of the v2-duckdb epic builds on.

**Architecture:** A thin, dependency-free FFI layer (`ffi.ts`) wraps `libduckdb`'s C API through
`bun:ffi`, using the by-value-u64-handle convention proven in `scripts/duckdb-spike/ffi/`. Pure
modules on top (`row-decode.ts`, `dylib.ts`, `lock-state.ts`) hold every decision that can be
tested without a database. Two `Context.Service` seams (`DuckDb`, `IngestLock`) expose the
capability to callers; their `Live` layers are the only place FFI and the filesystem meet, and the
dylib path is injectable so the custom static dylib from chunk `w0-dylib-ci` drops in later.

**Tech Stack:** bun ≥ 1.3 · `bun:ffi` · libduckdb v1.5.5 (official prebuilt for tests) ·
`effect@4.0.0-beta.78` (`Context.Service` / `Layer` / `Schema.TaggedErrorClass`) · `bun:test`.

**Spec:** `docs/superpowers/plans/2026-08-14-v2-duckdb-backlog.md` (chunk `w0-ffi-client`, wave 0)
plus `BRIEF.md` at the worktree root.

## Global Constraints

- Worktree ONLY: `/Users/necmttn/Projects/ax/.claude/worktrees/w0-ffi-client`. Never `cd` to or
  commit in the primary checkout.
- Tests import from `"bun:test"` - **never** vitest.
- Effect v4 beta idioms as used in this repo: `Context.Service<Tag, Shape>()("ax/Name")`,
  `Layer.effect(Tag)(effect)` / `Layer.succeed(Tag)(shape)`,
  `Schema.TaggedErrorClass<E>("Tag")("Tag", { …fields })`, `Schema.decodeUnknownEffect`.
- `packages/lib/src` uses **4-space** indentation. Match it.
- **No `node:fs` / `node:path` in any RUNTIME module under `packages/lib/src/duckdb/`.** The CI-wired
  `check:no-node-fs` gate (`scripts/check-no-node-fs.ts`, `.github/workflows/ci.yml:110`) scans
  `packages/*/src/**/*.ts` and hard-fails on them. Use `FileSystem` from `effect` (its
  `PlatformError` failures get mapped into this module's tagged errors) and `posixPath` from
  `@ax/lib/shared/path` for path math. `node:os` is NOT banned - `homedir()` / `tmpdir()` are fine.
  `*.test.ts` files are excluded from the gate, so tests may use `node:fs` freely.
  `packages/lib/src/testing/duckdb-dylib.ts` is the ONE exempt runtime-path file (it sits in the
  gate's `EXCLUDED_FILES`, being a test-only fixture called from a plain `beforeAll`).
- Gate list, all four run from the worktree with real exit codes: `bun run typecheck`,
  `bunx tsc --noEmit -p tsconfig.json`, `bun run check:no-node-fs`, `bun test <touched areas>`.
- No `BRIEF.md` / `REPORT.md` in the commit.
- ONE conventional commit at the very end of the whole chunk (the per-task "commit" step of the
  generic TDD loop is deliberately **omitted** here - the brief mandates a single commit).
- Gates, run FROM the worktree, real exit codes: `bun run typecheck` → 0;
  `bunx tsc --noEmit -p tsconfig.json` → 0; `bun test` over touched areas green.

## Locked technical decisions (verified against the real `duckdb.h` v1.5.5, do not re-litigate)

1. **Row extraction uses the row-major `duckdb_value_*` API, not the chunk API.**
   `duckdb_fetch_chunk(duckdb_result result)`, `duckdb_result_chunk_count(duckdb_result)` and
   `duckdb_result_return_type(duckdb_result)` all take the 48-byte `duckdb_result` struct **by
   value**, and `bun:ffi` cannot pass structs by value. Every `duckdb_value_*` accessor takes
   `duckdb_result *` (a pointer) and is therefore reachable. Verified present in the official
   v1.5.5 prebuilt via `nm -gU libduckdb.dylib` (`_duckdb_value_int64`, `_duckdb_value_varchar`,
   `_duckdb_value_is_null`, `_duckdb_value_uint64`, `_duckdb_value_double`,
   `_duckdb_value_boolean`, `_duckdb_row_count`). They are marked deprecated in the header but
   are still exported; Task 3 asserts their presence so a dylib built with
   `DUCKDB_API_NO_DEPRECATED` fails loudly instead of silently.
2. **Opaque handles pass by value as `u64`; out-params pass as real pointers.**
   `duckdb_database`, `duckdb_connection`, `duckdb_config`, `duckdb_prepared_statement` are
   `void *` typedefs. Argument position → `FFIType.u64` reading `BigUint64Array[0]`. Out-param
   position → `FFIType.ptr` of a `BigUint64Array(1)`. This is the gotcha the spike solved.
3. **Read-only open goes through `duckdb_open_ext` + a config with `access_mode=READ_ONLY`.**
   `duckdb_open` has no config argument.
4. **Params go through prepared statements** (`duckdb_prepare` → `duckdb_bind_*` →
   `duckdb_execute_prepared`). Bind indices are **1-based**.
5. **BLOB / nested (LIST/STRUCT/MAP/UNION/ARRAY) columns are not decoded.** `duckdb_value_blob`
   returns a struct by value (unreachable); nested types have no row-major accessor. These raise a
   typed `DuckDbUnsupportedTypeError` naming the column and type, telling the caller to project
   the column (e.g. `hex(col)`, `to_json(col)`) in SQL.
6. **Snapshot publish** = `CHECKPOINT` on the live connection → `ATTACH '<tmp>' AS ax_snapshot`
   → `COPY FROM DATABASE "<current_database()>" TO ax_snapshot` → `DETACH ax_snapshot` →
   `rename(tmp, snapshotPath)`. The tmp file is a sibling of `snapshotPath` so the rename is a
   same-filesystem atomic swap and a reader holding the old inode keeps reading.

## File Structure

All new files live under `packages/lib/src/duckdb/` except the test fixture helper.

| File | Responsibility |
|---|---|
| `packages/lib/src/duckdb/errors.ts` | Every tagged error the module can fail with. |
| `packages/lib/src/duckdb/types.ts` | `DuckDbTypeId`, `DuckDbValue`, `DuckDbRow`, `QueryResult`, `DuckDbParam`. |
| `packages/lib/src/duckdb/row-decode.ts` | PURE: type-id → accessor kind mapping + raw-value → JS-value coercion. No FFI. |
| `packages/lib/src/duckdb/ffi.ts` | `dlopen` symbol table, struct sizes, handle helpers. No Effect. |
| `packages/lib/src/duckdb/dylib.ts` | `resolveDylibPath` - source path vs `$bunfs` extract-to-content-hash with reuse. |
| `packages/lib/src/duckdb/client.ts` | `DuckDb` service + `DuckDbLive` / `DuckDbLayer(dylibPath)`. open / openSnapshot / publishSnapshot. |
| `packages/lib/src/duckdb/lock.ts` | `IngestLock` service + `IngestLockLive` / `IngestLockLayer(path)`. |
| `packages/lib/src/duckdb/lock-state.ts` | PURE: lock-file payload codec + "is this holder alive / stale?" decision. |
| `packages/lib/src/duckdb/index.ts` | Barrel re-export - the `@ax/lib/duckdb` public surface. |
| `packages/lib/src/testing/duckdb-dylib.ts` | Test fixture: resolve-or-download the official v1.5.5 dylib; report a skip reason when impossible. |

Test files sit beside their subject as `<name>.test.ts`.

---

### Task 1: Errors, types, package wiring, and the test-dylib fixture

Everything downstream imports from here, and no later task can run an e2e test without the
fixture, so these ship together.

**Files:**
- Create: `packages/lib/src/duckdb/errors.ts`
- Create: `packages/lib/src/duckdb/types.ts`
- Create: `packages/lib/src/testing/duckdb-dylib.ts`
- Create: `packages/lib/src/duckdb/errors.test.ts`
- Create: `packages/lib/src/testing/duckdb-dylib.test.ts`
- Modify: `packages/lib/package.json` (exports map)
- Modify: `.gitignore` (vendor cache)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `DuckDbOpenError`, `DuckDbQueryError`, `DuckDbDecodeError`, `DuckDbUnsupportedTypeError`,
    `DuckDbDylibError`, `IngestLockHeldError`, `IngestLockError`, `SnapshotPublishError`
  - `DuckDbTypeId` (const object + type), `DuckDbValue`, `DuckDbRow`, `QueryResult`, `DuckDbParam`
  - `resolveTestDylib(): Promise<TestDylib>` where
    `type TestDylib = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string }`

Shipped `errors.ts` (the 8 tagged errors: `DuckDbOpenError`, `DuckDbQueryError`, `DuckDbDecodeError`, `DuckDbUnsupportedTypeError`, `DuckDbDylibError`, `IngestLockHeldError`, `IngestLockError`, `SnapshotPublishError`), `types.ts` (`DuckDbTypeId` + row/param types), and the `testing/duckdb-dylib.ts` fixture (`resolveTestDylib`) that resolves-or-downloads the official v1.5.5 dylib for tests, plus the package export wiring and the vendor-cache `.gitignore` entry.

---

### Task 2: Pure row decode

The whole "typed row decode" promise lives here, and none of it needs a database. Everything this
module decides - which accessor a column type needs, how a raw accessor result becomes a JS value -
is a pure function under test.

**Files:**
- Create: `packages/lib/src/duckdb/row-decode.ts`
- Create: `packages/lib/src/duckdb/row-decode.test.ts`

**Interfaces:**
- Consumes: `DuckDbTypeId`, `DuckDbValue`, `duckDbTypeName` from Task 1's `types.ts`;
  `DuckDbUnsupportedTypeError` from Task 1's `errors.ts`.
- Produces:
  - `type AccessorKind = "boolean" | "int64" | "uint64" | "double" | "varchar"`
  - `accessorFor(typeId: number): AccessorKind | null` - `null` means unsupported.
  - `coerceValue(typeId: number, raw: boolean | bigint | number | string): DuckDbValue`
  - `unsupportedColumns(columns: ReadonlyArray<DuckDbColumn>): ReadonlyArray<DuckDbColumn>`

Shipped `row-decode.ts` (`accessorFor`, `coerceValue`, `unsupportedColumns`) - the pure type-id-to-accessor-kind mapping and raw-accessor-value-to-JS-value coercion rules, with tests covering every `DuckDbTypeId` branch including timestamp parsing and the unsupported BLOB/nested types.

---

### Task 3: The FFI symbol table

**Files:**
- Create: `packages/lib/src/duckdb/ffi.ts`
- Create: `packages/lib/src/duckdb/ffi.test.ts`

**Interfaces:**
- Consumes: the Task 1 fixture (`resolveTestDylib`, `noteSkippedDylib`).
- Produces:
  - `openLibDuckDb(dylibPath: string): LibDuckDb` where `LibDuckDb = { symbols, close }`
  - `DUCKDB_RESULT_SIZE = 64`, `DUCKDB_SUCCESS = 0`
  - `handleBuffer(): BigUint64Array` and `cstr(s: string): Buffer`
  - `readCString(p: number | bigint | null): string | null`

Shipped `ffi.ts` - the `bun:ffi` symbol table (`openLibDuckDb`, `DUCKDB_RESULT_SIZE`, `DUCKDB_SUCCESS`, `handleBuffer`, `cstr`, `readCString`) binding every symbol the client needs, including the row-major `duckdb_value_*` accessors. Tests cover symbol presence and an in-memory round trip through the bound symbols.

---

### Task 4: Dylib resolution (source vs `$bunfs`)

**Files:**
- Create: `packages/lib/src/duckdb/dylib.ts`
- Create: `packages/lib/src/duckdb/dylib.test.ts`

**Interfaces:**
- Consumes: `DuckDbDylibError` from Task 1.
- Produces:
  - `isEmbeddedPath(p: string): boolean`
  - `extractDylib(embeddedPath: string, cacheDir: string): Effect.Effect<string, DuckDbDylibError, FileSystem.FileSystem>`
    - content-hash path, reuse-if-present.
  - `resolveDylibPath(options?: ResolveDylibOptions): Effect.Effect<string, DuckDbDylibError, FileSystem.FileSystem>`
    where `interface ResolveDylibOptions { readonly assetPath?: string; readonly cacheDir?: string }`
  - `dylibCacheDir(): string`

Shipped `dylib.ts` (`isEmbeddedPath`, `extractDylib`, `resolveDylibPath`, `dylibCacheDir`) - source-path-vs-`$bunfs` resolution with content-hash extraction and reuse-if-present caching, ported onto Effect `FileSystem` per the no-`node:fs` constraint. Tests cover the `AX_DUCKDB_DYLIB` override, source-mode passthrough, extraction reuse, and the typed-error failure path.

---

### Task 5: The `DuckDb` service - open, query, exec, close

The load-bearing task. Tests run against real temp DB files through the real FFI; nothing here is
mocked.

**Files:**
- Create: `packages/lib/src/duckdb/client.ts`
- Create: `packages/lib/src/duckdb/client.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces:
  - `interface DuckDbConnection { readonly path: string; readonly readOnly: boolean; readonly query: (sql: string, params?: ReadonlyArray<DuckDbParam>) => Effect.Effect<QueryResult, DuckDbQueryError | DuckDbUnsupportedTypeError>; readonly queryAs: <S extends Schema.Top>(schema: S, sql: string, params?: ReadonlyArray<DuckDbParam>) => Effect.Effect<ReadonlyArray<S["Type"]>, DuckDbQueryError | DuckDbUnsupportedTypeError | DuckDbDecodeError, S["DecodingServices"]>; readonly exec: (sql: string, params?: ReadonlyArray<DuckDbParam>) => Effect.Effect<number, DuckDbQueryError | DuckDbUnsupportedTypeError>; readonly close: Effect.Effect<void> }`
  - `interface DuckDbService { readonly open: (path: string, options?: { readonly readOnly?: boolean }) => Effect.Effect<DuckDbConnection, DuckDbOpenError>; readonly scoped: (path: string, options?: { readonly readOnly?: boolean }) => Effect.Effect<DuckDbConnection, DuckDbOpenError, Scope.Scope> }`
  - `class DuckDb extends Context.Service<DuckDb, DuckDbService>()("ax/DuckDb")`
  - `const DuckDbLayer: (dylibPath: string) => Layer.Layer<DuckDb>`
  - `const DuckDbLive: Layer.Layer<DuckDb, DuckDbDylibError>` (resolves the dylib itself)

Shipped `client.ts` - the `DuckDb` `Context.Service` (`DuckDbLayer(dylibPath)`, `DuckDbLive`) exposing `DuckDbConnection.query` / `queryAs` / `exec` / `close`, built with `FileSystem` closed over inside the layer so every method keeps `R = never`. Tested end-to-end against real temp DB files through the real FFI - nothing here is mocked.

---

### Task 6: The ingest lockfile

**Files:**
- Create: `packages/lib/src/duckdb/lock-state.ts`
- Create: `packages/lib/src/duckdb/lock-state.test.ts`
- Create: `packages/lib/src/duckdb/lock.ts`
- Create: `packages/lib/src/duckdb/lock.test.ts`

**Interfaces:**
- Consumes: `IngestLockError`, `IngestLockHeldError` from Task 1.
- Produces:
  - `interface LockPayload { readonly pid: number; readonly started_at: string }`
  - `encodeLockPayload(p: LockPayload): string`, `decodeLockPayload(text: string): LockPayload | null`
  - `interface LockDecision { readonly kind: "free" | "held" | "stale"; readonly holder?: LockPayload }`
  - `decideLock(text: string | null, isAlive: (pid: number) => boolean, selfPid: number): LockDecision`
  - `interface IngestLockHandle { readonly path: string; readonly release: Effect.Effect<void> }`
  - `interface IngestLockService { readonly acquire: (options?: AcquireOptions) => Effect.Effect<IngestLockHandle, IngestLockHeldError | IngestLockError>; readonly holder: Effect.Effect<LockPayload | null, IngestLockError> }`
    with `interface AcquireOptions { readonly wait?: boolean; readonly timeoutMs?: number; readonly pollMs?: number }`
  - `class IngestLock extends Context.Service<IngestLock, IngestLockService>()("ax/IngestLock")`
  - `ingestLockPath(): string`, `IngestLockLayer(path: string): Layer.Layer<IngestLock>`,
    `IngestLockLive: Layer.Layer<IngestLock>`

Shipped `lock-state.ts` (`LockPayload` codec + the pure `decideLock` free/held/stale decision) and `lock.ts` (the `IngestLock` `Context.Service`, `IngestLockLayer` / `IngestLockLive`) implementing the ingest lockfile with fail-fast and wait-with-timeout acquire semantics, ported onto Effect `FileSystem` per the no-`node:fs` constraint. Tests cover the live-holder, stale-holder, corrupt-file, and self-pid branches plus real lock contention.

---

### Task 7: Snapshot publish + snapshot open

**Files:**
- Modify: `packages/lib/src/duckdb/client.ts` (add `publishSnapshot` + `openSnapshot` to the service)
- Create: `packages/lib/src/duckdb/snapshot.test.ts`

**Interfaces:**
- Consumes: `DuckDbConnection` / `DuckDbService` from Task 5, `SnapshotPublishError` from Task 1.
- Produces, added to `DuckDbService`:
  - `readonly publishSnapshot: (livePath: string, snapshotPath: string) => Effect.Effect<void, SnapshotPublishError | DuckDbOpenError>`
  - `readonly openSnapshot: (snapshotPath?: string) => Effect.Effect<DuckDbConnection, DuckDbOpenError>`
  - `snapshotPath(): string` - `AX_DUCKDB_SNAPSHOT` or `~/.ax/cache/ax-snapshot.duckdb`.

Shipped `publishSnapshot` and `openSnapshot` added to `client.ts`'s `DuckDbService` - CHECKPOINT, then ATTACH/COPY FROM DATABASE/DETACH to a sibling temp file, then an atomic rename into `snapshotPath`, plus `snapshotPath()` for the default `~/.ax/cache/ax-snapshot.duckdb` location. Tests cover the missing-livePath failure and prove a reader on the old inode keeps reading while the rename lands.

---

### Task 8: Barrel, gates, single commit

**Files:**
- Create: `packages/lib/src/duckdb/index.ts`
- Create: `packages/lib/src/duckdb/index.test.ts`

Shipped `index.ts`, the `@ax/lib/duckdb` barrel re-exporting `errors.ts`, `types.ts`, `row-decode.ts`, `dylib.ts`, `client.ts`, `lock-state.ts`, and `lock.ts` (`ffi.ts` deliberately excluded as internal FFI surface). Verified against the repo's four gates (`bun run typecheck`, `bunx tsc --noEmit`, `check:no-node-fs`, `bun test`) and landed in one conventional commit.

---

## Self-Review

**Spec coverage** (chunk `w0-ffi-client` in the backlog + BRIEF.md):

| Requirement | Task |
|---|---|
| `open(path, {readOnly})` | 5 |
| `query(sql, params?)` with typed row decode | 2 (rules) + 5 (`query`/`queryAs`) |
| `exec` | 5 |
| `close` | 5 |
| `openSnapshot()` | 7 |
| `publishSnapshot()` = CHECKPOINT + COPY FROM DATABASE → tmp → atomic rename | 7 |
| ingest lockfile `~/.ax/ingest.lock` (pid + started_at, fail-fast default, wait option) | 6 |
| `resolveDylib()` real path in source mode, `$bunfs` extract to content-hash path, reuse-if-present | 4 |
| Effect-native service, layer-testable, heavily typed | 5, 6 (`Context.Service` + injectable-path layers) |
| Start from the working spike | 3 (the by-value-u64 handle convention is carried over verbatim) |
| Dylib downloaded into a gitignored vendor cache in test setup; skip with a notice when impossible | 1 |
| Dylib path injectable for chunk w0-dylib-ci | 1 (`AX_DUCKDB_DYLIB`), 4, 5 (`DuckDbLayer(path)`) |
| unit + e2e against a real temp DB file | 3, 5, 7 |
| lock contention test (second acquire fails fast) | 6 |
| snapshot publish test: reader on the old inode keeps reading while the rename lands | 7 |

No gaps.

**Seam rule check:** nothing mocks DuckDB, the filesystem, or the lock - every e2e runs against a
real dylib, real temp `.duckdb` files, and real lock files. The only injected values are *paths*
(`AX_DUCKDB_DYLIB`, the layer's `dylibPath`, the lock path), which is configuration, not a mock.
Delete-the-mock heuristic: there is no mock to delete.

**Placeholder scan:** every code step carries real code; the two "rules the implementation must
follow" blocks (Tasks 5 step 3, 6 step 7, 7 step 3) enumerate concrete C calls, argument forms and
error branches rather than saying "handle errors".

**Type consistency:** `DuckDbColumn`/`QueryResult`/`DuckDbValue`/`DuckDbParam` are defined once in
Task 1 and used unchanged in Tasks 2, 5, 7. `accessorFor`/`coerceValue`/`unsupportedColumns`
(Task 2) are called with exactly those signatures in Task 5. `LockPayload`/`decideLock` (Task 6
`lock-state.ts`) are consumed with the same names in `lock.ts` and both test files.
