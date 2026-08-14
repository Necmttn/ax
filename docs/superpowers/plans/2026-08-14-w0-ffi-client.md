# `@ax/lib/duckdb` - typed DuckDB FFI client (chunk w0-ffi-client)

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

- [ ] **Step 1: Add the vendor cache to `.gitignore`**

Append to `.gitignore`:

```gitignore
# DuckDB dylib cache used by @ax/lib/duckdb tests (downloaded, never committed)
vendor/duckdb/
```

- [ ] **Step 2: Wire the package exports**

In `packages/lib/package.json`, add these two entries to `"exports"` immediately after
`"./shared/team-fetch"` (keep the trailing `"./*"` glob last):

```json
    "./duckdb": "./src/duckdb/index.ts",
    "./testing/duckdb-dylib": "./src/testing/duckdb-dylib.ts",
```

- [ ] **Step 3: Write the failing error/type test**

Create `packages/lib/src/duckdb/errors.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
    DuckDbDecodeError,
    DuckDbDylibError,
    DuckDbOpenError,
    DuckDbQueryError,
    DuckDbUnsupportedTypeError,
    IngestLockHeldError,
    SnapshotPublishError,
} from "./errors.ts";

describe("duckdb errors", () => {
    test("each error carries its discriminating tag", () => {
        expect(new DuckDbOpenError({ path: "/tmp/x.db", readOnly: true, message: "boom" })._tag)
            .toBe("DuckDbOpenError");
        expect(new DuckDbQueryError({ sql: "SELECT 1", message: "boom" })._tag)
            .toBe("DuckDbQueryError");
        expect(new DuckDbDecodeError({ sql: "SELECT 1", message: "bad row" })._tag)
            .toBe("DuckDbDecodeError");
        expect(new DuckDbUnsupportedTypeError({ column: "payload", typeId: 18 })._tag)
            .toBe("DuckDbUnsupportedTypeError");
        expect(new DuckDbDylibError({ message: "not found" })._tag).toBe("DuckDbDylibError");
        expect(
            new IngestLockHeldError({
                path: "/tmp/ingest.lock",
                pid: 42,
                startedAt: "2026-08-14T00:00:00.000Z",
            })._tag,
        ).toBe("IngestLockHeldError");
        expect(new SnapshotPublishError({ snapshotPath: "/tmp/s.db", message: "boom" })._tag)
            .toBe("SnapshotPublishError");
    });

    test("the unsupported-type error names the column and how to work around it", () => {
        const err = new DuckDbUnsupportedTypeError({ column: "payload", typeId: 18 });
        expect(err.message).toContain("payload");
        expect(err.message).toContain("BLOB");
    });
});
```

- [ ] **Step 4: Run it and watch it fail**

Run: `bun test packages/lib/src/duckdb/errors.test.ts`
Expected: FAIL - `Cannot find module './errors.ts'`.

- [ ] **Step 5: Write `types.ts`**

Create `packages/lib/src/duckdb/types.ts`:

```ts
/**
 * `duckdb_type` enum values from duckdb.h (v1.5.5). Only the ids this client
 * can decode are named; anything else surfaces as a raw number in
 * `DuckDbUnsupportedTypeError`.
 */
export const DuckDbTypeId = {
    INVALID: 0,
    BOOLEAN: 1,
    TINYINT: 2,
    SMALLINT: 3,
    INTEGER: 4,
    BIGINT: 5,
    UTINYINT: 6,
    USMALLINT: 7,
    UINTEGER: 8,
    UBIGINT: 9,
    FLOAT: 10,
    DOUBLE: 11,
    TIMESTAMP: 12,
    DATE: 13,
    TIME: 14,
    INTERVAL: 15,
    HUGEINT: 16,
    VARCHAR: 17,
    BLOB: 18,
    DECIMAL: 19,
    TIMESTAMP_S: 20,
    TIMESTAMP_MS: 21,
    TIMESTAMP_NS: 22,
    ENUM: 23,
    LIST: 24,
    STRUCT: 25,
    MAP: 26,
    UUID: 27,
    UNION: 28,
    BIT: 29,
    TIME_TZ: 30,
    TIMESTAMP_TZ: 31,
    UHUGEINT: 32,
    ARRAY: 33,
    SQLNULL: 36,
} as const;

export type DuckDbTypeId = (typeof DuckDbTypeId)[keyof typeof DuckDbTypeId];

/** Human name for a duckdb type id, for error messages. */
export const duckDbTypeName = (id: number): string =>
    Object.entries(DuckDbTypeId).find(([, v]) => v === id)?.[0] ?? `TYPE_${id}`;

/** Every JS value a decoded cell can take. */
export type DuckDbValue = string | number | bigint | boolean | Date | null;

export type DuckDbRow = Readonly<Record<string, DuckDbValue>>;

export interface DuckDbColumn {
    readonly name: string;
    readonly typeId: number;
}

export interface QueryResult {
    readonly columns: ReadonlyArray<DuckDbColumn>;
    readonly rows: ReadonlyArray<DuckDbRow>;
    /** Rows changed by a DML statement; 0 for SELECTs. */
    readonly rowsChanged: number;
}

/** Values accepted as prepared-statement parameters. */
export type DuckDbParam = string | number | bigint | boolean | Date | null | undefined;
```

- [ ] **Step 6: Write `errors.ts`**

Create `packages/lib/src/duckdb/errors.ts`:

```ts
import { Schema } from "effect";
import { duckDbTypeName } from "./types.ts";

/** `duckdb_open` / `duckdb_open_ext` / `duckdb_connect` failure. */
export class DuckDbOpenError extends Schema.TaggedErrorClass<DuckDbOpenError>(
    "DuckDbOpenError",
)("DuckDbOpenError", {
    path: Schema.String,
    readOnly: Schema.Boolean,
    message: Schema.String,
}) {}

/** A statement failed to prepare, bind, or execute. `sql` is a short excerpt. */
export class DuckDbQueryError extends Schema.TaggedErrorClass<DuckDbQueryError>(
    "DuckDbQueryError",
)("DuckDbQueryError", {
    sql: Schema.String,
    message: Schema.String,
}) {}

/** Rows came back fine but did not match the caller's schema. */
export class DuckDbDecodeError extends Schema.TaggedErrorClass<DuckDbDecodeError>(
    "DuckDbDecodeError",
)("DuckDbDecodeError", {
    sql: Schema.String,
    message: Schema.String,
}) {}

/**
 * A result column has a type this client cannot read through the row-major
 * `duckdb_value_*` API (BLOB and the nested types have no pointer-based
 * accessor). Project the column in SQL instead - `hex(col)` / `to_json(col)`.
 */
export class DuckDbUnsupportedTypeError extends Schema.TaggedErrorClass<DuckDbUnsupportedTypeError>(
    "DuckDbUnsupportedTypeError",
)("DuckDbUnsupportedTypeError", {
    column: Schema.String,
    typeId: Schema.Number,
}) {
    override get message(): string {
        const name = duckDbTypeName(this.typeId);
        return `column "${this.column}" has type ${name}, which this client cannot decode; project it in SQL instead (e.g. hex(${this.column}) for BLOB, to_json(${this.column}) for nested types)`;
    }
}

/** The libduckdb shared library could not be located, extracted, or opened. */
export class DuckDbDylibError extends Schema.TaggedErrorClass<DuckDbDylibError>(
    "DuckDbDylibError",
)("DuckDbDylibError", {
    message: Schema.String,
}) {}

/** Another process holds the ingest lock. Carries who, so the CLI can say so. */
export class IngestLockHeldError extends Schema.TaggedErrorClass<IngestLockHeldError>(
    "IngestLockHeldError",
)("IngestLockHeldError", {
    path: Schema.String,
    pid: Schema.Number,
    startedAt: Schema.String,
}) {}

/** The lock file itself could not be read/written (permissions, bad dir, ...). */
export class IngestLockError extends Schema.TaggedErrorClass<IngestLockError>(
    "IngestLockError",
)("IngestLockError", {
    path: Schema.String,
    message: Schema.String,
}) {}

/** Snapshot publication failed before the atomic rename landed. */
export class SnapshotPublishError extends Schema.TaggedErrorClass<SnapshotPublishError>(
    "SnapshotPublishError",
)("SnapshotPublishError", {
    snapshotPath: Schema.String,
    message: Schema.String,
}) {}
```

- [ ] **Step 7: Run the error test to green**

Run: `bun test packages/lib/src/duckdb/errors.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 8: Write the failing fixture test**

Create `packages/lib/src/testing/duckdb-dylib.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolveTestDylib } from "./duckdb-dylib.ts";

describe("resolveTestDylib", () => {
    test("either resolves to a real file on disk or explains why it cannot", async () => {
        const found = await resolveTestDylib();
        if (found.ok) {
            expect(existsSync(found.path)).toBe(true);
        } else {
            expect(found.reason.length).toBeGreaterThan(0);
        }
    });

    test("honours AX_DUCKDB_DYLIB when it points at an existing file", async () => {
        const first = await resolveTestDylib();
        if (!first.ok) return; // nothing on disk to point at; covered by the test above
        const prev = process.env.AX_DUCKDB_DYLIB;
        process.env.AX_DUCKDB_DYLIB = first.path;
        try {
            const second = await resolveTestDylib();
            expect(second).toEqual({ ok: true, path: first.path });
        } finally {
            if (prev === undefined) delete process.env.AX_DUCKDB_DYLIB;
            else process.env.AX_DUCKDB_DYLIB = prev;
        }
    });
});
```

- [ ] **Step 9: Run it and watch it fail**

Run: `bun test packages/lib/src/testing/duckdb-dylib.test.ts`
Expected: FAIL - `Cannot find module './duckdb-dylib.ts'`.

- [ ] **Step 10: Write the fixture helper**

Create `packages/lib/src/testing/duckdb-dylib.ts`:

```ts
/**
 * Test-only resolution of a libduckdb shared library.
 *
 * Order: `AX_DUCKDB_DYLIB` (the injection point the custom static dylib from
 * chunk w0-dylib-ci will use) -> the gitignored `vendor/duckdb/<version>/`
 * cache -> a one-time download of the official prebuilt release. When the
 * download is impossible (offline CI, unsupported platform) this returns a
 * REASON rather than throwing, so suites can skip with a notice instead of
 * failing red for an environment problem.
 */
import { existsSync, mkdirSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";

export const DUCKDB_VERSION = "v1.5.5";

export type TestDylib =
    | { readonly ok: true; readonly path: string }
    | { readonly ok: false; readonly reason: string };

/** Repo root, found by walking up from this file to the dir holding `turbo.json`. */
const repoRoot = (): string => {
    let dir = dirname(new URL(import.meta.url).pathname);
    for (let i = 0; i < 10; i += 1) {
        if (existsSync(join(dir, "turbo.json"))) return dir;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return process.cwd();
};

const libFileName = (): string => (platform() === "darwin" ? "libduckdb.dylib" : "libduckdb.so");

/** Official release asset for this platform, or null when unsupported. */
const releaseAsset = (): string | null => {
    if (platform() === "darwin") return "libduckdb-osx-universal.zip";
    if (platform() === "linux") {
        return arch() === "arm64" ? "libduckdb-linux-arm64.zip" : "libduckdb-linux-amd64.zip";
    }
    return null;
};

export const vendorDir = (): string => join(repoRoot(), "vendor", "duckdb", DUCKDB_VERSION);

export const resolveTestDylib = async (): Promise<TestDylib> => {
    const injected = process.env.AX_DUCKDB_DYLIB?.trim();
    if (injected) {
        return existsSync(injected)
            ? { ok: true, path: injected }
            : { ok: false, reason: `AX_DUCKDB_DYLIB points at a missing file: ${injected}` };
    }

    const cached = join(vendorDir(), libFileName());
    if (existsSync(cached)) return { ok: true, path: cached };

    const asset = releaseAsset();
    if (asset === null) {
        return { ok: false, reason: `no official libduckdb build for ${platform()}/${arch()}` };
    }

    const url = `https://github.com/duckdb/duckdb/releases/download/${DUCKDB_VERSION}/${asset}`;
    try {
        mkdirSync(vendorDir(), { recursive: true });
        const zipPath = join(vendorDir(), asset);
        const response = await fetch(url);
        if (!response.ok) {
            return { ok: false, reason: `download failed: ${url} -> HTTP ${response.status}` };
        }
        await Bun.write(zipPath, await response.arrayBuffer());
        const unzip = Bun.spawnSync(["unzip", "-o", "-q", zipPath, "-d", vendorDir()], {
            stdout: "ignore",
            stderr: "pipe",
        });
        if (unzip.exitCode !== 0) {
            return { ok: false, reason: `unzip failed: ${unzip.stderr.toString().trim()}` };
        }
        if (!existsSync(cached)) {
            return { ok: false, reason: `archive ${asset} did not contain ${libFileName()}` };
        }
        return { ok: true, path: cached };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: `download failed: ${url} -> ${message}` };
    }
};

/** Prints a uniform notice so a skipped suite is visible in test output. */
export const noteSkippedDylib = (suite: string, reason: string): void => {
    console.warn(`[skip] ${suite}: no libduckdb available (${reason})`);
};
```

- [ ] **Step 11: Run the fixture test to green**

Run: `bun test packages/lib/src/testing/duckdb-dylib.test.ts`
Expected: PASS (2 tests). A `vendor/duckdb/v1.5.5/libduckdb.dylib` already staged in this
worktree makes it instant; on a clean machine the first run downloads ~36MB.

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

- [ ] **Step 1: Write the failing test**

Create `packages/lib/src/duckdb/row-decode.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { accessorFor, coerceValue, unsupportedColumns } from "./row-decode.ts";
import { DuckDbTypeId } from "./types.ts";

describe("accessorFor", () => {
    test("maps each integer width to the widest safe row-major accessor", () => {
        for (const id of [
            DuckDbTypeId.TINYINT,
            DuckDbTypeId.SMALLINT,
            DuckDbTypeId.INTEGER,
            DuckDbTypeId.BIGINT,
        ]) {
            expect(accessorFor(id)).toBe("int64");
        }
        for (const id of [
            DuckDbTypeId.UTINYINT,
            DuckDbTypeId.USMALLINT,
            DuckDbTypeId.UINTEGER,
            DuckDbTypeId.UBIGINT,
        ]) {
            expect(accessorFor(id)).toBe("uint64");
        }
    });

    test("maps booleans, floats and text", () => {
        expect(accessorFor(DuckDbTypeId.BOOLEAN)).toBe("boolean");
        expect(accessorFor(DuckDbTypeId.FLOAT)).toBe("double");
        expect(accessorFor(DuckDbTypeId.DOUBLE)).toBe("double");
        expect(accessorFor(DuckDbTypeId.VARCHAR)).toBe("varchar");
    });

    test("reads temporal, uuid, decimal and hugeint columns as text", () => {
        for (const id of [
            DuckDbTypeId.DATE,
            DuckDbTypeId.TIME,
            DuckDbTypeId.TIMESTAMP,
            DuckDbTypeId.TIMESTAMP_S,
            DuckDbTypeId.TIMESTAMP_MS,
            DuckDbTypeId.TIMESTAMP_NS,
            DuckDbTypeId.TIMESTAMP_TZ,
            DuckDbTypeId.UUID,
            DuckDbTypeId.DECIMAL,
            DuckDbTypeId.HUGEINT,
            DuckDbTypeId.ENUM,
            DuckDbTypeId.INTERVAL,
        ]) {
            expect(accessorFor(id)).toBe("varchar");
        }
    });

    test("refuses BLOB and the nested types", () => {
        for (const id of [
            DuckDbTypeId.BLOB,
            DuckDbTypeId.LIST,
            DuckDbTypeId.STRUCT,
            DuckDbTypeId.MAP,
            DuckDbTypeId.UNION,
            DuckDbTypeId.ARRAY,
        ]) {
            expect(accessorFor(id)).toBeNull();
        }
    });
});

describe("coerceValue", () => {
    test("narrows small integers to number and keeps BIGINT as bigint", () => {
        expect(coerceValue(DuckDbTypeId.INTEGER, 7n)).toBe(7);
        expect(coerceValue(DuckDbTypeId.SMALLINT, -3n)).toBe(-3);
        expect(coerceValue(DuckDbTypeId.BIGINT, 9007199254740993n)).toBe(9007199254740993n);
    });

    test("keeps BIGINT values inside the safe range as bigint for a stable row type", () => {
        expect(coerceValue(DuckDbTypeId.BIGINT, 5n)).toBe(5n);
        expect(coerceValue(DuckDbTypeId.UBIGINT, 5n)).toBe(5n);
    });

    test("passes booleans, doubles and strings through", () => {
        expect(coerceValue(DuckDbTypeId.BOOLEAN, true)).toBe(true);
        expect(coerceValue(DuckDbTypeId.DOUBLE, 1.5)).toBe(1.5);
        expect(coerceValue(DuckDbTypeId.VARCHAR, "hi")).toBe("hi");
    });

    test("turns timestamp text into a Date and leaves DATE/TIME as text", () => {
        const ts = coerceValue(DuckDbTypeId.TIMESTAMP, "2026-08-14 10:11:12.5");
        expect(ts).toBeInstanceOf(Date);
        expect((ts as Date).toISOString()).toBe("2026-08-14T10:11:12.500Z");
        expect(coerceValue(DuckDbTypeId.DATE, "2026-08-14")).toBe("2026-08-14");
        expect(coerceValue(DuckDbTypeId.TIME, "10:11:12")).toBe("10:11:12");
    });

    test("parses a TZ timestamp without double-applying the offset", () => {
        const ts = coerceValue(DuckDbTypeId.TIMESTAMP_TZ, "2026-08-14 10:11:12+02");
        expect((ts as Date).toISOString()).toBe("2026-08-14T08:11:12.000Z");
    });

    test("leaves an unparseable timestamp as its original text rather than an Invalid Date", () => {
        expect(coerceValue(DuckDbTypeId.TIMESTAMP, "infinity")).toBe("infinity");
    });
});

describe("unsupportedColumns", () => {
    test("returns only the columns with no row-major accessor", () => {
        const columns = [
            { name: "id", typeId: DuckDbTypeId.BIGINT },
            { name: "payload", typeId: DuckDbTypeId.BLOB },
            { name: "tags", typeId: DuckDbTypeId.LIST },
        ];
        expect(unsupportedColumns(columns).map((c) => c.name)).toEqual(["payload", "tags"]);
    });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test packages/lib/src/duckdb/row-decode.test.ts`
Expected: FAIL - `Cannot find module './row-decode.ts'`.

- [ ] **Step 3: Write the implementation**

Create `packages/lib/src/duckdb/row-decode.ts`:

```ts
/**
 * Pure decode rules for the row-major `duckdb_value_*` accessors.
 *
 * `bun:ffi` cannot pass structs by value, which rules out `duckdb_fetch_chunk`
 * (it takes the 48-byte `duckdb_result` by value), so every cell is read
 * through a pointer-based `duckdb_value_*` accessor. This module holds the two
 * decisions that follow from that - WHICH accessor a column type needs, and how
 * the raw accessor result becomes a JS value - so both are testable without a
 * database.
 */
import { DuckDbTypeId, type DuckDbColumn, type DuckDbValue } from "./types.ts";

export type AccessorKind = "boolean" | "int64" | "uint64" | "double" | "varchar";

const INT64_TYPES: ReadonlySet<number> = new Set([
    DuckDbTypeId.TINYINT,
    DuckDbTypeId.SMALLINT,
    DuckDbTypeId.INTEGER,
    DuckDbTypeId.BIGINT,
]);

const UINT64_TYPES: ReadonlySet<number> = new Set([
    DuckDbTypeId.UTINYINT,
    DuckDbTypeId.USMALLINT,
    DuckDbTypeId.UINTEGER,
    DuckDbTypeId.UBIGINT,
]);

const DOUBLE_TYPES: ReadonlySet<number> = new Set([DuckDbTypeId.FLOAT, DuckDbTypeId.DOUBLE]);

/**
 * Types with no fixed-width row-major accessor that DuckDB will still render
 * faithfully as text: temporals, uuid, decimal, 128-bit ints, enums, intervals,
 * bit strings. Reading them as VARCHAR is lossless for our purposes and keeps
 * the FFI surface small.
 */
const VARCHAR_TYPES: ReadonlySet<number> = new Set([
    DuckDbTypeId.VARCHAR,
    DuckDbTypeId.DATE,
    DuckDbTypeId.TIME,
    DuckDbTypeId.TIME_TZ,
    DuckDbTypeId.TIMESTAMP,
    DuckDbTypeId.TIMESTAMP_S,
    DuckDbTypeId.TIMESTAMP_MS,
    DuckDbTypeId.TIMESTAMP_NS,
    DuckDbTypeId.TIMESTAMP_TZ,
    DuckDbTypeId.INTERVAL,
    DuckDbTypeId.HUGEINT,
    DuckDbTypeId.UHUGEINT,
    DuckDbTypeId.DECIMAL,
    DuckDbTypeId.UUID,
    DuckDbTypeId.ENUM,
    DuckDbTypeId.BIT,
    DuckDbTypeId.SQLNULL,
]);

/** Which `duckdb_value_*` accessor reads this column, or null when none can. */
export const accessorFor = (typeId: number): AccessorKind | null => {
    if (typeId === DuckDbTypeId.BOOLEAN) return "boolean";
    if (INT64_TYPES.has(typeId)) return "int64";
    if (UINT64_TYPES.has(typeId)) return "uint64";
    if (DOUBLE_TYPES.has(typeId)) return "double";
    if (VARCHAR_TYPES.has(typeId)) return "varchar";
    return null;
};

/** Types read as text but handed back as a Date. */
const TIMESTAMP_TYPES: ReadonlySet<number> = new Set([
    DuckDbTypeId.TIMESTAMP,
    DuckDbTypeId.TIMESTAMP_S,
    DuckDbTypeId.TIMESTAMP_MS,
    DuckDbTypeId.TIMESTAMP_NS,
    DuckDbTypeId.TIMESTAMP_TZ,
]);

/**
 * DuckDB prints timestamps as `YYYY-MM-DD HH:MM:SS[.ffffff][+HH[:MM]]`.
 * `TIMESTAMP` is offset-free and means UTC here, so it gets a `Z`;
 * `TIMESTAMP WITH TIME ZONE` already carries an offset, which must be kept
 * (appending `Z` on top of it would shift the instant twice).
 */
const parseTimestamp = (text: string): Date | string => {
    const hasOffset = /(?:[+-]\d{2}(?::?\d{2})?|Z)$/.test(text);
    const iso = text.replace(" ", "T") + (hasOffset ? "" : "Z");
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? text : date;
};

/** Raw accessor output -> the JS value callers see. */
export const coerceValue = (
    typeId: number,
    raw: boolean | bigint | number | string,
): DuckDbValue => {
    if (typeof raw === "string") {
        return TIMESTAMP_TYPES.has(typeId) ? parseTimestamp(raw) : raw;
    }
    if (typeof raw === "bigint") {
        // 64-bit columns stay bigint so a row's TS type never depends on the
        // magnitude of the value it happens to hold. Narrower widths cannot
        // overflow a JS number, so they come back as number.
        if (typeId === DuckDbTypeId.BIGINT || typeId === DuckDbTypeId.UBIGINT) return raw;
        return Number(raw);
    }
    return raw;
};

/** Result columns this client cannot decode. */
export const unsupportedColumns = (
    columns: ReadonlyArray<DuckDbColumn>,
): ReadonlyArray<DuckDbColumn> => columns.filter((c) => accessorFor(c.typeId) === null);
```

- [ ] **Step 4: Run the test to green**

Run: `bun test packages/lib/src/duckdb/row-decode.test.ts`
Expected: PASS (9 tests).

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

- [ ] **Step 1: Write the failing test**

Create `packages/lib/src/duckdb/ffi.test.ts`:

```ts
import { beforeAll, describe, expect, test } from "bun:test";
import { noteSkippedDylib, resolveTestDylib } from "../testing/duckdb-dylib.ts";
import { cstr, DUCKDB_RESULT_SIZE, DUCKDB_SUCCESS, handleBuffer, openLibDuckDb, readCString } from "./ffi.ts";
import { ptr } from "bun:ffi";

let dylib: string | null = null;
let skipReason = "";

beforeAll(async () => {
    const found = await resolveTestDylib();
    if (found.ok) dylib = found.path;
    else {
        skipReason = found.reason;
        noteSkippedDylib("duckdb ffi", found.reason);
    }
});

describe("openLibDuckDb", () => {
    test("binds every symbol the client needs, including the row-major value accessors", () => {
        if (dylib === null) return expect(skipReason.length).toBeGreaterThan(0);
        const lib = openLibDuckDb(dylib);
        try {
            for (const name of [
                "duckdb_open_ext",
                "duckdb_close",
                "duckdb_connect",
                "duckdb_disconnect",
                "duckdb_query",
                "duckdb_prepare",
                "duckdb_bind_varchar",
                "duckdb_bind_int64",
                "duckdb_bind_double",
                "duckdb_bind_boolean",
                "duckdb_bind_null",
                "duckdb_execute_prepared",
                "duckdb_destroy_prepare",
                "duckdb_prepare_error",
                "duckdb_destroy_result",
                "duckdb_result_error",
                "duckdb_row_count",
                "duckdb_rows_changed",
                "duckdb_column_count",
                "duckdb_column_name",
                "duckdb_column_type",
                "duckdb_value_boolean",
                "duckdb_value_int64",
                "duckdb_value_uint64",
                "duckdb_value_double",
                "duckdb_value_varchar",
                "duckdb_value_is_null",
                "duckdb_free",
                "duckdb_create_config",
                "duckdb_set_config",
                "duckdb_destroy_config",
            ]) {
                expect(typeof (lib.symbols as Record<string, unknown>)[name]).toBe("function");
            }
        } finally {
            lib.close();
        }
    });

    test("runs an in-memory round trip through the bound symbols", () => {
        if (dylib === null) return expect(skipReason.length).toBeGreaterThan(0);
        const lib = openLibDuckDb(dylib);
        const db = handleBuffer();
        const conn = handleBuffer();
        try {
            expect(lib.symbols.duckdb_open_ext(cstr(":memory:"), ptr(db), 0n, null)).toBe(DUCKDB_SUCCESS);
            expect(lib.symbols.duckdb_connect(db[0]!, ptr(conn))).toBe(DUCKDB_SUCCESS);
            const result = new Uint8Array(DUCKDB_RESULT_SIZE);
            expect(lib.symbols.duckdb_query(conn[0]!, cstr("SELECT 41 + 1 AS answer"), ptr(result)))
                .toBe(DUCKDB_SUCCESS);
            expect(lib.symbols.duckdb_row_count(ptr(result))).toBe(1n);
            expect(readCString(lib.symbols.duckdb_column_name(ptr(result), 0n))).toBe("answer");
            expect(lib.symbols.duckdb_value_int64(ptr(result), 0n, 0n)).toBe(42n);
            lib.symbols.duckdb_destroy_result(ptr(result));
        } finally {
            lib.symbols.duckdb_disconnect(ptr(conn));
            lib.symbols.duckdb_close(ptr(db));
            lib.close();
        }
    });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test packages/lib/src/duckdb/ffi.test.ts`
Expected: FAIL - `Cannot find module './ffi.ts'`.

- [ ] **Step 3: Write the implementation**

Create `packages/lib/src/duckdb/ffi.ts`:

```ts
/**
 * Raw `bun:ffi` bindings for the libduckdb C API. No Effect, no policy - the
 * bare symbol table plus the handle conventions the rest of the module relies
 * on.
 *
 * THE HANDLE GOTCHA (solved in scripts/duckdb-spike/ffi/duckdb-ffi.ts):
 * `duckdb_database`, `duckdb_connection`, `duckdb_config` and
 * `duckdb_prepared_statement` are opaque `void *` typedefs. In ARGUMENT
 * position they are passed BY VALUE, so they bind as `u64` and are read out of
 * a `BigUint64Array`. In OUT-PARAM position they are real pointers and bind as
 * `ptr`. Mixing the two up corrupts the handle and segfaults.
 *
 * Everything here takes `duckdb_result *`. The chunk API
 * (`duckdb_fetch_chunk`, `duckdb_result_chunk_count`) takes the 48-byte
 * `duckdb_result` struct BY VALUE, which `bun:ffi` cannot express, so the
 * row-major `duckdb_value_*` accessors are the only reachable read path.
 */
import { CString, dlopen, FFIType } from "bun:ffi";

const { i32, u64, f64, bool, ptr: PTR, cstring, void: VOID } = FFIType;

/** `duckdb_result` is 48 bytes in duckdb.h; 64 leaves headroom. */
export const DUCKDB_RESULT_SIZE = 64;
/** `DuckDBSuccess` from `duckdb_state`. */
export const DUCKDB_SUCCESS = 0;

const SYMBOLS = {
    // --- lifecycle -------------------------------------------------------
    duckdb_open_ext: { args: [cstring, PTR, u64, PTR], returns: i32 },
    duckdb_close: { args: [PTR], returns: VOID },
    duckdb_connect: { args: [u64, PTR], returns: i32 },
    duckdb_disconnect: { args: [PTR], returns: VOID },
    // --- config ----------------------------------------------------------
    duckdb_create_config: { args: [PTR], returns: i32 },
    duckdb_set_config: { args: [u64, cstring, cstring], returns: i32 },
    duckdb_destroy_config: { args: [PTR], returns: VOID },
    // --- statements ------------------------------------------------------
    duckdb_query: { args: [u64, cstring, PTR], returns: i32 },
    duckdb_prepare: { args: [u64, cstring, PTR], returns: i32 },
    duckdb_prepare_error: { args: [u64], returns: cstring },
    duckdb_destroy_prepare: { args: [PTR], returns: VOID },
    duckdb_execute_prepared: { args: [u64, PTR], returns: i32 },
    duckdb_bind_boolean: { args: [u64, u64, bool], returns: i32 },
    duckdb_bind_int64: { args: [u64, u64, FFIType.i64], returns: i32 },
    duckdb_bind_double: { args: [u64, u64, f64], returns: i32 },
    duckdb_bind_varchar: { args: [u64, u64, cstring], returns: i32 },
    duckdb_bind_null: { args: [u64, u64], returns: i32 },
    // --- results ---------------------------------------------------------
    duckdb_destroy_result: { args: [PTR], returns: VOID },
    duckdb_result_error: { args: [PTR], returns: PTR },
    duckdb_row_count: { args: [PTR], returns: u64 },
    duckdb_rows_changed: { args: [PTR], returns: u64 },
    duckdb_column_count: { args: [PTR], returns: u64 },
    duckdb_column_name: { args: [PTR, u64], returns: PTR },
    duckdb_column_type: { args: [PTR, u64], returns: i32 },
    // --- row-major value accessors --------------------------------------
    duckdb_value_boolean: { args: [PTR, u64, u64], returns: bool },
    duckdb_value_int64: { args: [PTR, u64, u64], returns: FFIType.i64 },
    duckdb_value_uint64: { args: [PTR, u64, u64], returns: u64 },
    duckdb_value_double: { args: [PTR, u64, u64], returns: f64 },
    duckdb_value_varchar: { args: [PTR, u64, u64], returns: PTR },
    duckdb_value_is_null: { args: [PTR, u64, u64], returns: bool },
    duckdb_free: { args: [PTR], returns: VOID },
} as const;

export type LibDuckDb = ReturnType<typeof dlopen<typeof SYMBOLS>>;

/** `dlopen` libduckdb with the full symbol table. Throws on a missing symbol. */
export const openLibDuckDb = (dylibPath: string): LibDuckDb => dlopen(dylibPath, SYMBOLS);

/** Backing store for one opaque handle (database / connection / statement). */
export const handleBuffer = (): BigUint64Array => new BigUint64Array(1);

/** NUL-terminated buffer for a `const char *` argument. */
export const cstr = (s: string): Buffer => Buffer.from(`${s}\0`, "utf8");

/** Read a `char *` return value, or null when the pointer is null. */
export const readCString = (p: number | bigint | null | undefined): string | null => {
    if (p === null || p === undefined || p === 0 || p === 0n) return null;
    return new CString(p as never).toString();
};
```

- [ ] **Step 4: Run the test to green**

Run: `bun test packages/lib/src/duckdb/ffi.test.ts`
Expected: PASS (2 tests). If `dlopen` throws on a symbol name, the dylib was built with
`DUCKDB_API_NO_DEPRECATED` - that is the loud failure this test exists to produce.

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

**RULING R6 APPLIES - this supersedes the code sketch below wherever they disagree.** `dylib.ts` is
a runtime module under `packages/lib/src/`, so `node:fs` and `node:path` are BANNED (the CI-wired
`check:no-node-fs` gate hard-fails on them). The sketch in Step 3 was written against `node:fs`;
port it:

- `existsSync(p)` -> `yield* fs.exists(p)` (`const fs = yield* FileSystem.FileSystem`)
- `mkdirSync(d, { recursive: true })` -> `yield* fs.makeDirectory(d, { recursive: true })`
- `join(a, b)` -> `posixPath.join(a, b)` from `@ax/lib/shared/path`
- the staging rename -> `yield* fs.rename(staging, out)` (NOT `Bun.$\`mv\``)
- `homedir()` from `node:os` STAYS - `node:os` is not banned.
- Map any `PlatformError` into `DuckDbDylibError` so the failure channel stays this module's own.
- `extractDylib` becomes an `Effect.gen`, not an `async` function; `Bun.file(p).arrayBuffer()` and
  `Bun.CryptoHasher` stay (they are not `node:fs`) - wrap them in `Effect.tryPromise` /
  `Effect.sync`.

Both exported effects therefore carry `FileSystem.FileSystem` in their requirements channel. The
test provides it with `BunFileSystem.layer` from `@effect/platform-bun`:
`Effect.runPromise(resolveDylibPath({ … }).pipe(Effect.provide(BunFileSystem.layer)))`. The TEST
file may keep using `node:fs` directly (`*.test.ts` is excluded from the gate), so the Step 1 test
body needs only its `Effect.runPromise` calls updated to provide the layer.

- [ ] **Step 1: Write the failing test**

Create `packages/lib/src/duckdb/dylib.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractDylib, isEmbeddedPath, resolveDylibPath } from "./dylib.ts";

const tempDir = () => mkdtempSync(join(tmpdir(), "ax-duckdb-dylib-"));

describe("isEmbeddedPath", () => {
    test("recognises the compiled-binary virtual filesystem", () => {
        expect(isEmbeddedPath("/$bunfs/root/libduckdb.dylib")).toBe(true);
        expect(isEmbeddedPath("B:/~BUN/root/libduckdb.dylib")).toBe(true);
        expect(isEmbeddedPath("/Users/x/vendor/libduckdb.dylib")).toBe(false);
    });
});

describe("extractDylib", () => {
    test("writes the bytes to a content-hash path under the cache dir", async () => {
        const dir = tempDir();
        const source = join(dir, "src.bin");
        await Bun.write(source, "duckdb-bytes");
        const cache = join(dir, "cache");

        const out = await extractDylib(source, cache);

        expect(out.startsWith(cache)).toBe(true);
        expect(existsSync(out)).toBe(true);
        expect(await Bun.file(out).text()).toBe("duckdb-bytes");
    });

    test("different bytes land on different paths", async () => {
        const dir = tempDir();
        const cache = join(dir, "cache");
        const a = join(dir, "a.bin");
        const b = join(dir, "b.bin");
        await Bun.write(a, "aaaa");
        await Bun.write(b, "bbbb");

        expect(await extractDylib(a, cache)).not.toBe(await extractDylib(b, cache));
    });

    test("reuses an already-extracted file instead of rewriting it", async () => {
        const dir = tempDir();
        const cache = join(dir, "cache");
        const source = join(dir, "src.bin");
        await Bun.write(source, "duckdb-bytes");

        const first = await extractDylib(source, cache);
        const firstMtime = statSync(first).mtimeMs;
        await Bun.sleep(15);
        const second = await extractDylib(source, cache);

        expect(second).toBe(first);
        expect(statSync(second).mtimeMs).toBe(firstMtime);
        expect(readdirSync(cache).length).toBe(1);
    });
});

describe("resolveDylibPath", () => {
    test("prefers AX_DUCKDB_DYLIB when it exists", async () => {
        const dir = tempDir();
        const injected = join(dir, "injected.dylib");
        await Bun.write(injected, "x");
        const prev = process.env.AX_DUCKDB_DYLIB;
        process.env.AX_DUCKDB_DYLIB = injected;
        try {
            expect(await Effect.runPromise(resolveDylibPath())).toBe(injected);
        } finally {
            if (prev === undefined) delete process.env.AX_DUCKDB_DYLIB;
            else process.env.AX_DUCKDB_DYLIB = prev;
        }
    });

    test("returns a real on-disk asset path unchanged (source mode)", async () => {
        const dir = tempDir();
        const asset = join(dir, "libduckdb.dylib");
        await Bun.write(asset, "x");
        const prev = process.env.AX_DUCKDB_DYLIB;
        delete process.env.AX_DUCKDB_DYLIB;
        try {
            expect(await Effect.runPromise(resolveDylibPath({ assetPath: asset }))).toBe(asset);
        } finally {
            if (prev !== undefined) process.env.AX_DUCKDB_DYLIB = prev;
        }
    });

    test("fails with a typed error when nothing resolves", async () => {
        const dir = tempDir();
        const prev = process.env.AX_DUCKDB_DYLIB;
        delete process.env.AX_DUCKDB_DYLIB;
        try {
            const exit = await Effect.runPromise(
                Effect.either(resolveDylibPath({ assetPath: join(dir, "missing.dylib") })),
            );
            expect(exit._tag).toBe("Left");
            if (exit._tag === "Left") expect(exit.left._tag).toBe("DuckDbDylibError");
        } finally {
            if (prev !== undefined) process.env.AX_DUCKDB_DYLIB = prev;
        }
    });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test packages/lib/src/duckdb/dylib.test.ts`
Expected: FAIL - `Cannot find module './dylib.ts'`.

- [ ] **Step 3: Write the implementation**

Create `packages/lib/src/duckdb/dylib.ts`:

```ts
/**
 * Where libduckdb comes from at runtime.
 *
 * Source mode (`bun run`): the asset path is already a real file, hand it back.
 * Compiled mode (`bun build --compile`): the asset lives in the binary's
 * virtual filesystem, and `dlopen` cannot open a `$bunfs` path - the bytes must
 * be materialised on disk first. They go to a CONTENT-HASH path so a given
 * binary extracts once and every later run (and every concurrent process)
 * reuses the same file. Mirrors the studio-embed pattern in
 * `scripts/gen-studio-embed.ts`.
 *
 * `AX_DUCKDB_DYLIB` overrides everything - it is how tests, and later the
 * custom static dylib from chunk w0-dylib-ci, inject their own build.
 */
import { Effect } from "effect";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DuckDbDylibError } from "./errors.ts";

export interface ResolveDylibOptions {
    /** The bundled asset path (a `{ type: "file" }` import in compiled mode). */
    readonly assetPath?: string;
    /** Where extracted copies land. Defaults to {@link dylibCacheDir}. */
    readonly cacheDir?: string;
}

/** `~/.ax/cache/duckdb` (honours `AX_DATA_DIR`, like the serve pidfile). */
export const dylibCacheDir = (): string => {
    const base = process.env.AX_DATA_DIR?.trim();
    return base ? join(base, "duckdb") : join(homedir(), ".ax", "cache", "duckdb");
};

/** Is this path inside a compiled binary's virtual filesystem? */
export const isEmbeddedPath = (p: string): boolean =>
    p.startsWith("/$bunfs/") || p.startsWith("B:/~BUN/") || p.startsWith("/~BUN/");

/**
 * Materialise `embeddedPath`'s bytes at `<cacheDir>/<sha256-16>-libduckdb`,
 * reusing an existing extraction. The hash is over the CONTENT, so a rebuilt
 * binary with a new dylib gets a new path instead of racing the old one.
 */
export const extractDylib = async (embeddedPath: string, cacheDir: string): Promise<string> => {
    const bytes = await Bun.file(embeddedPath).arrayBuffer();
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(new Uint8Array(bytes));
    const digest = hasher.digest("hex").slice(0, 16);
    const out = join(cacheDir, `${digest}-libduckdb`);
    if (existsSync(out)) return out;
    mkdirSync(cacheDir, { recursive: true });
    // Stage in a pid-suffixed sibling and rename, so two processes extracting
    // concurrently can never observe a half-written dylib.
    const staging = `${out}.${process.pid}.tmp`;
    await Bun.write(staging, bytes);
    await Bun.$`mv -f ${staging} ${out}`.quiet();
    return out;
};

export const resolveDylibPath = (
    options?: ResolveDylibOptions,
): Effect.Effect<string, DuckDbDylibError> =>
    Effect.gen(function* () {
        const injected = process.env.AX_DUCKDB_DYLIB?.trim();
        if (injected) {
            if (existsSync(injected)) return injected;
            return yield* Effect.fail(
                new DuckDbDylibError({
                    message: `AX_DUCKDB_DYLIB points at a missing file: ${injected}`,
                }),
            );
        }

        const asset = options?.assetPath;
        if (asset === undefined) {
            return yield* Effect.fail(
                new DuckDbDylibError({
                    message:
                        "no libduckdb available: set AX_DUCKDB_DYLIB, or pass assetPath from the embedded build",
                }),
            );
        }

        if (!isEmbeddedPath(asset)) {
            if (existsSync(asset)) return asset;
            return yield* Effect.fail(
                new DuckDbDylibError({ message: `libduckdb not found at ${asset}` }),
            );
        }

        return yield* Effect.tryPromise({
            try: () => extractDylib(asset, options?.cacheDir ?? dylibCacheDir()),
            catch: (err) =>
                new DuckDbDylibError({
                    message: `failed to extract the embedded libduckdb: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                }),
        });
    });
```

- [ ] **Step 4: Run the test to green**

Run: `bun test packages/lib/src/duckdb/dylib.test.ts`
Expected: PASS (7 tests).

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

**RULING R6 APPLIES - this supersedes the code sketch below wherever they disagree.** `client.ts` is
a runtime module under `packages/lib/src/`, so `node:fs` and `node:path` are BANNED (the CI-wired
`check:no-node-fs` gate hard-fails on them; `*.test.ts` is exempt, so the test file may keep them).
Concretely:

- The read-only "database must already exist" guard uses `yield* fs.exists(path)`, NOT `existsSync`.
- `join(...)` -> `posixPath.join(...)` from `@ax/lib/shared/path`; `homedir()` from `node:os` stays.
- **Acquire `FileSystem` in the LAYER, not in the method signatures.** Build the service with
  `Layer.effect(DuckDb)(Effect.gen(function* () { const fs = yield* FileSystem.FileSystem; … }))`
  so `fs` is closed over and every `DuckDbService` / `DuckDbConnection` method keeps `R = never` -
  the signatures in the Produces list above are exact and must not grow a requirements channel.
- Then provide the platform INSIDE this module so callers stay clean:
  `export const DuckDbLayer = (dylibPath: string): Layer.Layer<DuckDb> => baseLayer(dylibPath).pipe(Layer.provide(BunFileSystem.layer))`
  (`BunFileSystem` from `@effect/platform-bun`, already a dependency of `@ax/lib`). This module is
  Bun-only regardless - it loads `bun:ffi`.
- Map any `PlatformError` from `fs` into this module's own tagged errors; never let it leak.
- **`DuckDbLive` must wrap `openLibDuckDb` in `Effect.try`** mapping the throw to
  `DuckDbDylibError` (ruling R2). `dlopen` throws on a missing symbol; the sketch's `Effect.map`
  would turn that into an unhandled defect instead of a typed failure.
- **RULING R9 - `Effect.either` DOES NOT EXIST in `effect@4.0.0-beta.78`.** The Step 1 test snippet
  uses it repeatedly; it does not compile. The v4 equivalent is `Effect.result`, which returns
  `Result.Result<A, E>` (verified in `node_modules/effect/src/Effect.ts:3454` and
  `node_modules/effect/src/Result.ts:159`). Rewrite every occurrence as:
  ```ts
  const r = yield* Effect.result(conn.query("SELECT * FROM nope"));
  expect(r._tag).toBe("Failure");            // NOT "Left"
  if (r._tag === "Failure") expect(r.failure._tag).toBe("DuckDbQueryError");  // .failure, NOT .left
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/lib/src/duckdb/client.test.ts`:

```ts
import { beforeAll, describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noteSkippedDylib, resolveTestDylib } from "../testing/duckdb-dylib.ts";
import { DuckDb, DuckDbLayer } from "./client.ts";
import { DuckDbTypeId } from "./types.ts";

let layer: ReturnType<typeof DuckDbLayer> | null = null;
let skipReason = "";

beforeAll(async () => {
    const found = await resolveTestDylib();
    if (found.ok) layer = DuckDbLayer(found.path);
    else {
        skipReason = found.reason;
        noteSkippedDylib("duckdb client", found.reason);
    }
});

const tempDb = (name = "test.db") => join(mkdtempSync(join(tmpdir(), "ax-duckdb-client-")), name);

/** Runs `body` with the DuckDb service, or no-ops when there is no dylib. */
const withDuckDb = <A>(body: (db: DuckDbService) => Effect.Effect<A, unknown>) => async () => {
    if (layer === null) return expect(skipReason.length).toBeGreaterThan(0);
    await Effect.runPromise(
        Effect.gen(function* () {
            const db = yield* DuckDb;
            yield* body(db);
        }).pipe(Effect.provide(layer)) as Effect.Effect<void>,
    );
};
type DuckDbService = Effect.Effect.Success<typeof DuckDb.asEffect extends never ? never : never>;

describe("DuckDb", () => {
    test(
        "creates a database file and round-trips a typed row",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const path = tempDb();
                const conn = yield* db.open(path);
                yield* conn.exec("CREATE TABLE t (id BIGINT, note VARCHAR, ok BOOLEAN, score DOUBLE)");
                const changed = yield* conn.exec(
                    "INSERT INTO t VALUES (1, 'hello', true, 1.5), (2, NULL, false, 2.5)",
                );
                expect(changed).toBe(2);

                const result = yield* conn.query("SELECT id, note, ok, score FROM t ORDER BY id");
                expect(result.columns.map((c) => c.name)).toEqual(["id", "note", "ok", "score"]);
                expect(result.columns[0]!.typeId).toBe(DuckDbTypeId.BIGINT);
                expect(result.rows).toEqual([
                    { id: 1n, note: "hello", ok: true, score: 1.5 },
                    { id: 2n, note: null, ok: false, score: 2.5 },
                ]);

                yield* conn.close;
                expect(existsSync(path)).toBe(true);
            }),
        ),
    );

    test(
        "binds prepared-statement parameters instead of interpolating them",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const conn = yield* db.open(tempDb());
                yield* conn.exec("CREATE TABLE t (id INTEGER, note VARCHAR)");
                yield* conn.exec("INSERT INTO t VALUES (?, ?)", [1, "o'brien; DROP TABLE t;--"]);
                const result = yield* conn.query("SELECT note FROM t WHERE id = ?", [1]);
                expect(result.rows).toEqual([{ note: "o'brien; DROP TABLE t;--" }]);
                yield* conn.close;
            }),
        ),
    );

    test(
        "decodes rows through an Effect schema with queryAs",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const conn = yield* db.open(tempDb());
                yield* conn.exec("CREATE TABLE t (id INTEGER, note VARCHAR)");
                yield* conn.exec("INSERT INTO t VALUES (7, 'seven')");
                const Row = Schema.Struct({ id: Schema.Number, note: Schema.String });
                const rows = yield* conn.queryAs(Row, "SELECT id, note FROM t");
                expect(rows).toEqual([{ id: 7, note: "seven" }]);
                yield* conn.close;
            }),
        ),
    );

    test(
        "fails with DuckDbDecodeError when rows do not match the schema",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const conn = yield* db.open(tempDb());
                yield* conn.exec("CREATE TABLE t (note VARCHAR)");
                yield* conn.exec("INSERT INTO t VALUES ('not a number')");
                const Row = Schema.Struct({ note: Schema.Number });
                const either = yield* Effect.either(conn.queryAs(Row, "SELECT note FROM t"));
                expect(either._tag).toBe("Left");
                if (either._tag === "Left") expect(either.left._tag).toBe("DuckDbDecodeError");
                yield* conn.close;
            }),
        ),
    );

    test(
        "surfaces a SQL error as DuckDbQueryError carrying duckdb's message",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const conn = yield* db.open(tempDb());
                const either = yield* Effect.either(conn.query("SELECT * FROM nope"));
                expect(either._tag).toBe("Left");
                if (either._tag === "Left") {
                    expect(either.left._tag).toBe("DuckDbQueryError");
                    expect((either.left as { message: string }).message).toContain("nope");
                }
                yield* conn.close;
            }),
        ),
    );

    test(
        "refuses to decode a BLOB column instead of returning garbage",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const conn = yield* db.open(tempDb());
                const either = yield* Effect.either(conn.query("SELECT 'abc'::BLOB AS payload"));
                expect(either._tag).toBe("Left");
                if (either._tag === "Left") {
                    expect(either.left._tag).toBe("DuckDbUnsupportedTypeError");
                }
                // the documented workaround works
                const ok = yield* conn.query("SELECT hex('abc'::BLOB) AS payload");
                expect(ok.rows[0]!.payload).toBe("616263");
                yield* conn.close;
            }),
        ),
    );

    test(
        "reads timestamps back as Date",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const conn = yield* db.open(tempDb());
                const result = yield* conn.query(
                    "SELECT TIMESTAMP '2026-08-14 10:11:12' AS ts, DATE '2026-08-14' AS d",
                );
                expect(result.rows[0]!.ts).toBeInstanceOf(Date);
                expect((result.rows[0]!.ts as Date).toISOString()).toBe("2026-08-14T10:11:12.000Z");
                expect(result.rows[0]!.d).toBe("2026-08-14");
                yield* conn.close;
            }),
        ),
    );

    test(
        "a read-only open cannot write, and refuses a database that does not exist",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const path = tempDb();
                const rw = yield* db.open(path);
                yield* rw.exec("CREATE TABLE t (id INTEGER)");
                yield* rw.close;

                const ro = yield* db.open(path, { readOnly: true });
                expect(ro.readOnly).toBe(true);
                expect((yield* ro.query("SELECT count(*) AS n FROM t")).rows[0]!.n).toBe(0n);
                const either = yield* Effect.either(ro.exec("INSERT INTO t VALUES (1)"));
                expect(either._tag).toBe("Left");
                yield* ro.close;

                const missing = yield* Effect.either(
                    db.open(join(tempDb(), "..", "absent.db"), { readOnly: true }),
                );
                expect(missing._tag).toBe("Left");
                if (missing._tag === "Left") expect(missing.left._tag).toBe("DuckDbOpenError");
            }),
        ),
    );

    test(
        "scoped closes the connection when the scope closes",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const path = tempDb();
                yield* Effect.scoped(
                    Effect.gen(function* () {
                        const conn = yield* db.scoped(path);
                        yield* conn.exec("CREATE TABLE t (id INTEGER)");
                    }),
                );
                // the file is closed and reopenable read-only, which a leaked
                // write handle on the same path would not allow
                const ro = yield* db.open(path, { readOnly: true });
                yield* ro.close;
            }),
        ),
    );
});
```

> Note for the implementer: the `withDuckDb` helper above carries a placeholder
> `DuckDbService` type alias that will not compile. Replace it with a direct
> `import type { DuckDbService } from "./client.ts";` - the alias is only in this plan to keep the
> test readable before `client.ts` exists.

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test packages/lib/src/duckdb/client.test.ts`
Expected: FAIL - `Cannot find module './client.ts'`.

- [ ] **Step 3: Write the implementation**

Create `packages/lib/src/duckdb/client.ts`. The shape (write it in full; the sketch below is the
contract, not a stub - every branch shown must exist):

```ts
import { Context, Effect, Layer, Schema, Scope } from "effect";
import { ptr } from "bun:ffi";
import { existsSync } from "node:fs";
import {
    DuckDbDecodeError,
    DuckDbDylibError,
    DuckDbOpenError,
    DuckDbQueryError,
    DuckDbUnsupportedTypeError,
} from "./errors.ts";
import {
    cstr,
    DUCKDB_RESULT_SIZE,
    DUCKDB_SUCCESS,
    handleBuffer,
    openLibDuckDb,
    readCString,
    type LibDuckDb,
} from "./ffi.ts";
import { accessorFor, coerceValue, unsupportedColumns } from "./row-decode.ts";
import { resolveDylibPath } from "./dylib.ts";
import type { DuckDbColumn, DuckDbParam, DuckDbRow, DuckDbValue, QueryResult } from "./types.ts";
```

Implementation rules the code must follow:

1. **`sqlExcerpt(sql)`** - first 200 chars + `…`, mirroring `packages/lib/src/db.ts`. Every
   `DuckDbQueryError` uses it so a huge statement never bloats the error.
2. **`openDatabase(lib, path, readOnly)`** (private, sync):
   - `readOnly === true` and `!existsSync(path)` → throw a `DuckDbOpenError`; DuckDB would create
     an empty database otherwise, which silently hides a missing snapshot.
   - build a config: `duckdb_create_config(ptr(cfgBuf))`, then when read-only
     `duckdb_set_config(cfgBuf[0], cstr("access_mode"), cstr("READ_ONLY"))`; always
     `duckdb_destroy_config(ptr(cfgBuf))` after `duckdb_open_ext` returns.
   - `duckdb_open_ext(cstr(path), ptr(dbBuf), cfgBuf[0], ptr(errBuf))`; on non-success read
     `readCString(errBuf[0])`, `duckdb_free`, and throw `DuckDbOpenError`.
   - `duckdb_connect(dbBuf[0], ptr(connBuf))`; on non-success close the db and throw.
3. **`runStatement(lib, connHandle, sql, params)`** (private, sync) returns
   `{ resultPtr, resultBuf }` or throws `DuckDbQueryError`:
   - no params → `duckdb_query(connHandle, cstr(sql), ptr(resultBuf))`.
   - with params → `duckdb_prepare`, then per param (1-based index):
     `null`/`undefined` → `duckdb_bind_null`; `boolean` → `duckdb_bind_boolean`;
     `bigint` → `duckdb_bind_int64`; `number` → integer-valued and within
     `Number.isSafeInteger` → `duckdb_bind_int64(BigInt(v))`, else `duckdb_bind_double`;
     `Date` → `duckdb_bind_varchar(v.toISOString())`; `string` → `duckdb_bind_varchar`.
     Then `duckdb_execute_prepared`, and `duckdb_destroy_prepare` in a `finally`.
   - On a prepare failure read `duckdb_prepare_error(stmtHandle)`; on an execute/query failure read
     `duckdb_result_error(ptr(resultBuf))`, destroy the result, and throw.
4. **`readResult(lib, resultPtr, sql)`** (private, sync) → `QueryResult`:
   - columns: `duckdb_column_count`, then per index `duckdb_column_name` (via `readCString`) and
     `duckdb_column_type`.
   - `unsupportedColumns(columns)` non-empty → throw `DuckDbUnsupportedTypeError` for the FIRST one
     BEFORE reading any cell.
   - rows: `duckdb_row_count`, then per (row, col): `duckdb_value_is_null` → `null`; else dispatch
     on `accessorFor(typeId)` - `boolean`/`int64`/`uint64`/`double` call their accessor directly,
     `varchar` calls `duckdb_value_varchar`, `readCString`s it and **`duckdb_free`s the pointer**
     (leaking it leaks per cell). Feed the raw value through `coerceValue(typeId, raw)`.
   - `rowsChanged: Number(duckdb_rows_changed(resultPtr))`.
   - The caller always `duckdb_destroy_result`s in a `finally`.
5. **`makeConnection(lib, path, readOnly, dbBuf, connBuf)`** builds the `DuckDbConnection`:
   - `query` = `Effect.try({ try: … , catch: … })` wrapping runStatement + readResult +
     destroy-result, re-raising `DuckDbQueryError` / `DuckDbUnsupportedTypeError` as-is and wrapping
     anything else in `DuckDbQueryError`.
   - `exec` = same but returns `rowsChanged` and does not decode rows (still runs the
     unsupported-column check via `readResult`; DDL/DML results have no columns so it is free).
   - `queryAs(schema, sql, params)` = `query(...)` then
     `Schema.decodeUnknownEffect(Schema.Array(schema))(result.rows)` mapped to a
     `DuckDbDecodeError` carrying the schema failure message.
   - `close` = `Effect.sync` that is idempotent (a `closed` flag), calling `duckdb_disconnect` then
     `duckdb_close`.
6. **Service + layers**:

```ts
export class DuckDb extends Context.Service<DuckDb, DuckDbService>()("ax/DuckDb") {}

/** Layer over an explicit dylib path - the injection point for tests and for
 *  the custom static dylib from chunk w0-dylib-ci. */
export const DuckDbLayer = (dylibPath: string): Layer.Layer<DuckDb> =>
    Layer.effect(DuckDb)(
        Effect.sync(() => {
            const lib = openLibDuckDb(dylibPath);
            return makeService(lib);
        }),
    );

/** Layer that resolves the dylib itself (env override / bundled asset). */
export const DuckDbLive: Layer.Layer<DuckDb, DuckDbDylibError> = Layer.effect(DuckDb)(
    Effect.map(resolveDylibPath(), (path) => makeService(openLibDuckDb(path))),
);
```

  `scoped` = `Effect.acquireRelease(open(path, options), (conn) => conn.close)`.

- [ ] **Step 4: Run the test to green**

Run: `bun test packages/lib/src/duckdb/client.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Check the FFI does not leak varchar cells**

Run: `bun test packages/lib/src/duckdb/client.test.ts` and confirm no crash; then eyeball
`readResult` - every `duckdb_value_varchar` pointer must reach `duckdb_free` on both the value and
the null path.

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

**RULING R6 APPLIES - this supersedes the implementation rules below wherever they disagree.**
`lock.ts` and `lock-state.ts` are runtime modules under `packages/lib/src/`, so `node:fs` and
`node:path` are BANNED (`*.test.ts` is exempt, so `lock.test.ts` may keep them). `lock-state.ts` is
already pure and touches no filesystem - leave it alone. In `lock.ts`:

- `mkdirSync(dirname(path), { recursive: true })` -> `yield* fs.makeDirectory(posixPath.dirname(path), { recursive: true })`
- reading the lock file -> `yield* fs.readFileString(path)`, catching the not-found failure into
  `null` (`Effect.catchAll` / `Effect.option`), since "no file" is the `free` case, not an error
- **the exclusive create** -> `yield* fs.writeFileString(path, payload, { flag: "wx" })`. `"wx"` is a
  supported `OpenFlag` in effect's `FileSystem`, so the atomic create-or-fail semantics survive the
  port intact; a racing writer's failure loops back to the decide step exactly as specified.
- `unlinkSync` -> `yield* fs.remove(path)`
- `homedir()` from `node:os` STAYS; `join` -> `posixPath.join`
- Map every unexpected `PlatformError` into `IngestLockError`; never let it leak.
- **Acquire `FileSystem` in the LAYER, not in the method signatures:**
  `Layer.effect(IngestLock)(Effect.gen(function* () { const fs = yield* FileSystem.FileSystem; … }))`,
  then `export const IngestLockLayer = (path: string): Layer.Layer<IngestLock> => base(path).pipe(Layer.provide(BunFileSystem.layer))`.
  The `IngestLockService` signatures above are exact and must not grow a requirements channel.
- **RULING R9 - `Effect.either` DOES NOT EXIST in `effect@4.0.0-beta.78`.** The Step 5 test snippet
  uses it; it does not compile. The v4 equivalent is `Effect.result`, returning `Result.Result<A, E>`
  (verified in `node_modules/effect/src/Effect.ts:3454`, `node_modules/effect/src/Result.ts:159`):
  ```ts
  const r = yield* Effect.result(lock.acquire());
  expect(r._tag).toBe("Failure");            // NOT "Left"
  if (r._tag === "Failure") expect(r.failure._tag).toBe("IngestLockHeldError");  // .failure, NOT .left
  ```

- [ ] **Step 1: Write the failing pure-state test**

Create `packages/lib/src/duckdb/lock-state.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { decideLock, decodeLockPayload, encodeLockPayload } from "./lock-state.ts";

const alive = () => true;
const dead = () => false;

describe("lock payload codec", () => {
    test("round-trips pid and started_at", () => {
        const payload = { pid: 4242, started_at: "2026-08-14T10:00:00.000Z" };
        expect(decodeLockPayload(encodeLockPayload(payload))).toEqual(payload);
    });

    test("rejects junk and partial payloads instead of guessing", () => {
        expect(decodeLockPayload("not json")).toBeNull();
        expect(decodeLockPayload("{}")).toBeNull();
        expect(decodeLockPayload('{"pid":"x","started_at":"y"}')).toBeNull();
    });
});

describe("decideLock", () => {
    test("no file means free", () => {
        expect(decideLock(null, alive, 1).kind).toBe("free");
    });

    test("a live foreign holder means held, and the holder comes back with it", () => {
        const text = encodeLockPayload({ pid: 999, started_at: "2026-08-14T10:00:00.000Z" });
        const decision = decideLock(text, alive, 1);
        expect(decision.kind).toBe("held");
        expect(decision.holder?.pid).toBe(999);
    });

    test("a dead holder means stale, so the next run can take over", () => {
        const text = encodeLockPayload({ pid: 999, started_at: "2026-08-14T10:00:00.000Z" });
        expect(decideLock(text, dead, 1).kind).toBe("stale");
    });

    test("an unreadable lock file is stale, not a permanent wedge", () => {
        expect(decideLock("garbage", alive, 1).kind).toBe("stale");
    });

    test("our own pid is stale - a leftover from a crashed run of this process", () => {
        const text = encodeLockPayload({ pid: 7, started_at: "2026-08-14T10:00:00.000Z" });
        expect(decideLock(text, alive, 7).kind).toBe("stale");
    });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test packages/lib/src/duckdb/lock-state.test.ts`
Expected: FAIL - `Cannot find module './lock-state.ts'`.

- [ ] **Step 3: Write `lock-state.ts`**

```ts
/**
 * Pure lock-file reasoning: what the file says, and what to do about it.
 * Kept away from the filesystem so every branch (live holder, dead holder,
 * corrupt file, our own leftover) is testable without spawning a process.
 */
export interface LockPayload {
    readonly pid: number;
    readonly started_at: string;
}

export const encodeLockPayload = (payload: LockPayload): string =>
    `${JSON.stringify(payload)}\n`;

export const decodeLockPayload = (text: string): LockPayload | null => {
    try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== "object" || parsed === null) return null;
        const { pid, started_at } = parsed as Record<string, unknown>;
        if (typeof pid !== "number" || !Number.isInteger(pid)) return null;
        if (typeof started_at !== "string" || started_at.length === 0) return null;
        return { pid, started_at };
    } catch {
        return null;
    }
};

export interface LockDecision {
    readonly kind: "free" | "held" | "stale";
    readonly holder?: LockPayload;
}

/**
 * `stale` covers three cases that all mean "take it": the holder process is
 * gone, the file is unparseable, or the pid is US (a leftover from a crashed
 * run - a live process never contends with itself here because acquire is the
 * only writer).
 */
export const decideLock = (
    text: string | null,
    isAlive: (pid: number) => boolean,
    selfPid: number,
): LockDecision => {
    if (text === null) return { kind: "free" };
    const holder = decodeLockPayload(text);
    if (holder === null) return { kind: "stale" };
    if (holder.pid === selfPid) return { kind: "stale", holder };
    return isAlive(holder.pid) ? { kind: "held", holder } : { kind: "stale", holder };
};
```

- [ ] **Step 4: Run to green**

Run: `bun test packages/lib/src/duckdb/lock-state.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Write the failing lock-service test**

Create `packages/lib/src/duckdb/lock.test.ts`. This exercises the REAL filesystem - contention is
proven by a second acquire against the same real file, and cross-process contention by a real
`bun` subprocess, not by a stubbed lock.

```ts
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IngestLock, IngestLockLayer } from "./lock.ts";
import { encodeLockPayload } from "./lock-state.ts";

const lockPath = () => join(mkdtempSync(join(tmpdir(), "ax-ingest-lock-")), "ingest.lock");

const withLock = <A>(path: string, body: (lock: IngestLockService) => Effect.Effect<A, unknown>) =>
    Effect.runPromise(
        Effect.gen(function* () {
            const lock = yield* IngestLock;
            return yield* body(lock);
        }).pipe(Effect.provide(IngestLockLayer(path))) as Effect.Effect<A>,
    );

describe("IngestLock", () => {
    test("acquire writes a lock file holding our pid, release removes it", async () => {
        const path = lockPath();
        await withLock(path, (lock) =>
            Effect.gen(function* () {
                const handle = yield* lock.acquire();
                expect(existsSync(path)).toBe(true);
                expect((yield* lock.holder)?.pid).toBe(process.pid);
                yield* handle.release;
                expect(existsSync(path)).toBe(false);
            }),
        );
    });

    test("a second acquire while a LIVE holder owns the lock fails fast", async () => {
        const path = lockPath();
        // A live foreign holder: pid 1 always exists and is never us.
        writeFileSync(path, encodeLockPayload({ pid: 1, started_at: new Date().toISOString() }));
        const started = Date.now();
        const either = await withLock(path, (lock) => Effect.either(lock.acquire()));
        expect(either._tag).toBe("Left");
        if (either._tag === "Left") {
            expect(either.left._tag).toBe("IngestLockHeldError");
            expect((either.left as { pid: number }).pid).toBe(1);
        }
        expect(Date.now() - started).toBeLessThan(1000); // fail-fast, not a wait
    });

    test("wait mode gives up with the same typed error after the timeout", async () => {
        const path = lockPath();
        writeFileSync(path, encodeLockPayload({ pid: 1, started_at: new Date().toISOString() }));
        const started = Date.now();
        const either = await withLock(path, (lock) =>
            Effect.either(lock.acquire({ wait: true, timeoutMs: 250, pollMs: 25 })),
        );
        expect(either._tag).toBe("Left");
        if (either._tag === "Left") expect(either.left._tag).toBe("IngestLockHeldError");
        expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    });

    test("wait mode succeeds once the holder releases", async () => {
        const path = lockPath();
        writeFileSync(path, encodeLockPayload({ pid: 1, started_at: new Date().toISOString() }));
        setTimeout(() => {
            try {
                require("node:fs").unlinkSync(path);
            } catch {
                /* already gone */
            }
        }, 120);
        const handle = await withLock(path, (lock) =>
            lock.acquire({ wait: true, timeoutMs: 3000, pollMs: 25 }),
        );
        expect(existsSync(path)).toBe(true);
        await Effect.runPromise(handle.release);
    });

    test("takes over a lock whose holder is dead", async () => {
        const path = lockPath();
        // A pid that cannot be running: spawn a process and let it exit.
        const proc = Bun.spawnSync(["true"]);
        expect(proc.exitCode).toBe(0);
        writeFileSync(
            path,
            encodeLockPayload({ pid: 2 ** 22 - 1, started_at: "2020-01-01T00:00:00.000Z" }),
        );
        const handle = await withLock(path, (lock) => lock.acquire());
        expect(existsSync(path)).toBe(true);
        await Effect.runPromise(handle.release);
        expect(existsSync(path)).toBe(false);
    });

    test("release is idempotent and never removes someone else's lock", async () => {
        const path = lockPath();
        const handle = await withLock(path, (lock) => lock.acquire());
        await Effect.runPromise(handle.release);
        // someone else takes it
        writeFileSync(path, encodeLockPayload({ pid: 1, started_at: new Date().toISOString() }));
        await Effect.runPromise(handle.release);
        expect(existsSync(path)).toBe(true);
    });
});
```

> Implementer note: add `import type { IngestLockService } from "./lock.ts";` and drop the local
> alias; and prefer `unlinkSync` imported at the top over the inline `require`.

- [ ] **Step 6: Run it and watch it fail**

Run: `bun test packages/lib/src/duckdb/lock.test.ts`
Expected: FAIL - `Cannot find module './lock.ts'`.

- [ ] **Step 7: Write `lock.ts`**

Rules the implementation must follow:

- `ingestLockPath()` = `process.env.AX_INGEST_LOCK?.trim()` or `join(homedir(), ".ax", "ingest.lock")`.
- `acquire`:
  1. `mkdirSync(dirname(path), { recursive: true })`.
  2. Read the file (`null` when `ENOENT`), run `decideLock(text, isAlive, process.pid)`.
  3. `held` → fail `IngestLockHeldError({ path, pid, startedAt })` when not waiting; when waiting,
     sleep `pollMs` (default 100) and retry until `timeoutMs` (default 30_000) elapses, then fail
     with the SAME error.
  4. `free`/`stale` → write with `openSync(path, "wx")` (exclusive create; a `stale` decision
     `unlinkSync`s first). `EEXIST` from a racing writer loops back to step 2 rather than throwing.
  5. Return a handle whose `release` re-reads the file and only unlinks when the payload's pid is
     ours - so a late release never deletes a successor's lock. Idempotent.
- `isAlive(pid)` = `try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM" }`
  (EPERM means the process exists but belongs to another user).
- Filesystem failures other than the expected `ENOENT`/`EEXIST` become `IngestLockError`.
- Service/layers mirror Task 5: `IngestLock` tag, `IngestLockLayer(path)`, and
  `IngestLockLive = IngestLockLayer(ingestLockPath())`.

- [ ] **Step 8: Run to green**

Run: `bun test packages/lib/src/duckdb/lock.test.ts`
Expected: PASS (6 tests).

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

**RULING R6 APPLIES - this supersedes the implementation rules below wherever they disagree.** You
are editing `client.ts`, a runtime module: `node:fs` and `node:path` are BANNED (`snapshot.test.ts`
is exempt). Task 5 already closed a `FileSystem` instance over the service inside its layer - use
that same `fs`, and do NOT add a requirements channel to the two new method signatures above.

- the "livePath must exist" guard -> `yield* fs.exists(livePath)`
- removing a leftover temp file -> `yield* fs.remove(tmp)` (ignore a not-found failure)
- **the atomic swap** -> `yield* fs.rename(tmp, snapshotPath)`. `tmp` stays a SIBLING of
  `snapshotPath`, so the rename is same-filesystem and therefore atomic; that is the whole point of
  the test that proves a reader on the old inode keeps reading.
- Map every `PlatformError` into `SnapshotPublishError`.
- **RULING R9 - `Effect.either` DOES NOT EXIST in `effect@4.0.0-beta.78`.** The Step 1 test snippet
  uses it; it does not compile. The v4 equivalent is `Effect.result`, returning `Result.Result<A, E>`
  (verified in `node_modules/effect/src/Effect.ts:3454`, `node_modules/effect/src/Result.ts:159`):
  ```ts
  const r = yield* Effect.result(db.publishSnapshot(missing, snap));
  expect(r._tag).toBe("Failure");   // NOT "Left"; the failure value is `r.failure`, NOT `r.left`
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/lib/src/duckdb/snapshot.test.ts`:

```ts
import { beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noteSkippedDylib, resolveTestDylib } from "../testing/duckdb-dylib.ts";
import { DuckDb, DuckDbLayer } from "./client.ts";
import type { DuckDbService } from "./client.ts";

let layer: ReturnType<typeof DuckDbLayer> | null = null;
let skipReason = "";

beforeAll(async () => {
    const found = await resolveTestDylib();
    if (found.ok) layer = DuckDbLayer(found.path);
    else {
        skipReason = found.reason;
        noteSkippedDylib("duckdb snapshot", found.reason);
    }
});

const workDir = () => mkdtempSync(join(tmpdir(), "ax-duckdb-snapshot-"));

const withDuckDb = <A>(body: (db: DuckDbService) => Effect.Effect<A, unknown>) => async () => {
    if (layer === null) return expect(skipReason.length).toBeGreaterThan(0);
    await Effect.runPromise(
        Effect.gen(function* () {
            const db = yield* DuckDb;
            yield* body(db);
        }).pipe(Effect.provide(layer)) as Effect.Effect<void>,
    );
};

describe("publishSnapshot", () => {
    test(
        "copies the live database to the snapshot path and leaves no temp files",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const dir = workDir();
                const live = join(dir, "live.duckdb");
                const snap = join(dir, "snapshot.duckdb");

                const rw = yield* db.open(live);
                yield* rw.exec("CREATE TABLE t (id INTEGER, note VARCHAR)");
                yield* rw.exec("INSERT INTO t VALUES (1, 'first')");
                yield* rw.close;

                yield* db.publishSnapshot(live, snap);
                expect(existsSync(snap)).toBe(true);
                expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);

                const reader = yield* db.openSnapshot(snap);
                expect(reader.readOnly).toBe(true);
                expect((yield* reader.query("SELECT note FROM t")).rows).toEqual([
                    { note: "first" },
                ]);
                yield* reader.close;
            }),
        ),
    );

    test(
        "a reader holding the OLD snapshot keeps reading while a new one is renamed into place",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const dir = workDir();
                const live = join(dir, "live.duckdb");
                const snap = join(dir, "snapshot.duckdb");

                const rw = yield* db.open(live);
                yield* rw.exec("CREATE TABLE t (id INTEGER, note VARCHAR)");
                yield* rw.exec("INSERT INTO t VALUES (1, 'v1')");
                yield* rw.close;
                yield* db.publishSnapshot(live, snap);

                // A reader opens v1 and HOLDS it open across the republish.
                const reader = yield* db.openSnapshot(snap);
                const inodeBefore = statSync(snap).ino;
                expect((yield* reader.query("SELECT count(*) AS n FROM t")).rows[0]!.n).toBe(1);

                const rw2 = yield* db.open(live);
                yield* rw2.exec("INSERT INTO t VALUES (2, 'v2')");
                yield* rw2.close;
                yield* db.publishSnapshot(live, snap);

                // the path now points at a NEW inode ...
                expect(statSync(snap).ino).not.toBe(inodeBefore);
                // ... while the held reader still sees the OLD contents.
                expect((yield* reader.query("SELECT count(*) AS n FROM t")).rows[0]!.n).toBe(1);
                yield* reader.close;

                // a fresh reader sees the new snapshot
                const fresh = yield* db.openSnapshot(snap);
                expect((yield* fresh.query("SELECT count(*) AS n FROM t")).rows[0]!.n).toBe(2);
                yield* fresh.close;
            }),
        ),
    );

    test(
        "a failed publish leaves the previous snapshot intact",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const dir = workDir();
                const live = join(dir, "live.duckdb");
                const snap = join(dir, "snapshot.duckdb");

                const rw = yield* db.open(live);
                yield* rw.exec("CREATE TABLE t (id INTEGER)");
                yield* rw.exec("INSERT INTO t VALUES (1)");
                yield* rw.close;
                yield* db.publishSnapshot(live, snap);

                const either = yield* Effect.either(
                    db.publishSnapshot(join(dir, "does-not-exist.duckdb"), snap),
                );
                expect(either._tag).toBe("Left");

                const reader = yield* db.openSnapshot(snap);
                expect((yield* reader.query("SELECT count(*) AS n FROM t")).rows[0]!.n).toBe(1);
                yield* reader.close;
                expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
            }),
        ),
    );
});
```

> Note: `count(*)` comes back as `BIGINT`, so the expected value is `1n`/`2n` under the Task 2
> rule that BIGINT stays `bigint`. Fix the literals in these assertions to `1n` / `2n` when you
> write the test - they are shown unsuffixed here only to make the intent readable.

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test packages/lib/src/duckdb/snapshot.test.ts`
Expected: FAIL - `db.publishSnapshot is not a function`.

- [ ] **Step 3: Implement `publishSnapshot` / `openSnapshot` in `client.ts`**

Rules:

- `snapshotPath()` = `process.env.AX_DUCKDB_SNAPSHOT?.trim()` or
  `join(homedir(), ".ax", "cache", "ax-snapshot.duckdb")`.
- `openSnapshot(p?)` = `open(p ?? snapshotPath(), { readOnly: true })`.
- `publishSnapshot(livePath, snapshotPath)`:
  1. Fail `SnapshotPublishError` when `livePath` does not exist (do not create an empty database).
  2. `tmp = ${snapshotPath}.${process.pid}.tmp` - a SIBLING, so the rename is same-filesystem and
     therefore atomic (never `EXDEV`). `unlink` any leftover tmp first.
  3. Open `livePath` read-write, then in order:
     `CHECKPOINT`, `ATTACH '<tmp>' AS ax_snapshot`,
     `COPY FROM DATABASE "<name>" TO ax_snapshot` where `<name>` is
     `(yield* conn.query("SELECT current_database() AS n")).rows[0].n`,
     `DETACH ax_snapshot`. Single-quote-escape `tmp` (`replace(/'/g, "''")`) inside the ATTACH.
  4. Close the connection BEFORE the rename so the tmp file has no open writer.
  5. `renameSync(tmp, snapshotPath)`.
  6. Wrap the whole thing so ANY failure removes `tmp` (`Effect.ensuring` + `unlink … ignore`) and
     surfaces as `SnapshotPublishError` - the previous snapshot is untouched because nothing
     writes to `snapshotPath` until the rename.

- [ ] **Step 4: Run to green**

Run: `bun test packages/lib/src/duckdb/snapshot.test.ts`
Expected: PASS (3 tests).

---

### Task 8: Barrel, gates, single commit

**Files:**
- Create: `packages/lib/src/duckdb/index.ts`
- Create: `packages/lib/src/duckdb/index.test.ts`

- [ ] **Step 1: Write the failing surface test**

Create `packages/lib/src/duckdb/index.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import * as duckdb from "./index.ts";

describe("@ax/lib/duckdb public surface", () => {
    test("exports the services, layers and helpers callers need", () => {
        for (const name of [
            "DuckDb",
            "DuckDbLayer",
            "DuckDbLive",
            "IngestLock",
            "IngestLockLayer",
            "IngestLockLive",
            "ingestLockPath",
            "snapshotPath",
            "resolveDylibPath",
            "dylibCacheDir",
            "DuckDbTypeId",
        ]) {
            expect((duckdb as Record<string, unknown>)[name]).toBeDefined();
        }
    });

    test("exports every tagged error so callers can catch by tag", () => {
        for (const name of [
            "DuckDbOpenError",
            "DuckDbQueryError",
            "DuckDbDecodeError",
            "DuckDbUnsupportedTypeError",
            "DuckDbDylibError",
            "IngestLockHeldError",
            "IngestLockError",
            "SnapshotPublishError",
        ]) {
            expect((duckdb as Record<string, unknown>)[name]).toBeDefined();
        }
    });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test packages/lib/src/duckdb/index.test.ts`
Expected: FAIL - `Cannot find module './index.ts'`.

- [ ] **Step 3: Write the barrel**

```ts
/**
 * `@ax/lib/duckdb` - the typed DuckDB client the v2 architecture stands on.
 *
 * Reads go through a read-only handle on the published snapshot
 * (`openSnapshot`); writes only happen inside ingest, under the ingest lock
 * (`IngestLock`), against the live database; `publishSnapshot` is how the two
 * meet - CHECKPOINT, copy to a sibling temp file, atomic rename.
 */
export * from "./errors.ts";
export * from "./types.ts";
export * from "./row-decode.ts";
export * from "./dylib.ts";
export * from "./client.ts";
export * from "./lock-state.ts";
export * from "./lock.ts";
```

(`ffi.ts` is deliberately NOT re-exported - it is the internal FFI seam, not public surface.)

- [ ] **Step 4: Run to green**

Run: `bun test packages/lib/src/duckdb/index.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run every gate from the worktree and capture real exit codes**

```bash
cd /Users/necmttn/Projects/ax/.claude/worktrees/w0-ffi-client
bun run typecheck; echo "typecheck exit=$?"
bunx tsc --noEmit -p tsconfig.json; echo "tsc exit=$?"
bun test packages/lib/src/duckdb packages/lib/src/testing/duckdb-dylib.test.ts; echo "test exit=$?"
```

Expected: all three `exit=0`. Never pipe `tsc` through `tail`/`grep` before reading `$?`.

- [ ] **Step 6: Single conventional commit**

```bash
cd /Users/necmttn/Projects/ax/.claude/worktrees/w0-ffi-client
git add -A ':!BRIEF.md' ':!REPORT.md'
git status --short
git commit -m "feat(duckdb): typed DuckDB FFI client, ingest lock, snapshot publisher"
```

Confirm `vendor/duckdb/` is NOT in `git status --short` (Task 1 Step 1 ignores it) and that the
117MB dylib is not staged.

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
