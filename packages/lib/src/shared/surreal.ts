/**
 * surreal: the Graph Access Toolkit - the single shared module of safe
 * Storage Backend (SurrealDB) access primitives that query modules compose.
 *
 * Five sections, each previously its own file (now deprecated re-export shims):
 *
 *   1. LITERALS / ESCAPING        (was surql.ts) - turn JS values into
 *      SurrealQL literals so escaping is defined exactly once.
 *   2. TYPED ROW FIELD ACCESS     (was row-fields.ts) - extract typed values
 *      from `Record<string, unknown>` result rows.
 *   3. RECORD SELECTION           (was record-select.ts) - the one reliable
 *      shape for bulk fetch-by-record-id and the home of the 3.0.x id-IN quirk.
 *   4. STATEMENT EXECUTION        (was statement-exec.ts) - chunked execution
 *      of a batch of SurrealQL statements.
 *   5. RECORD-ID KEY DERIVATION   (was derive-keys.ts) - canonical
 *      key/timestamp helpers for building SurrealDB record IDs.
 *
 * The typed read DSL (`query.ts` / `graph-query.ts`) is its own module and
 * composes these primitives; it is intentionally NOT folded in here.
 */

import { Array as Arr, Effect } from "effect";
import { SurrealClient, type SurrealClientShape } from "../db.ts";
import type { DbError } from "../errors.ts";
import { recordLiteral } from "../ids.ts";

// ============================================================================
// 1. LITERALS / ESCAPING
// ----------------------------------------------------------------------------
// The WRITE-literal counterpart to `graph-query.ts` (the READ seam): every
// ingest module that builds `RELATE` / `UPSERT` / `CREATE` / `UPDATE`
// statements by string interpolation routes its string/JSON literals through
// here, so SurrealQL escaping is defined exactly once.
//
// The load-bearing detail is `stripLoneSurrogates`: ingest excerpts are
// produced by `text.slice(start, end)`, and a slice boundary can fall in the
// middle of an emoji's UTF-16 surrogate pair, leaving a lone surrogate.
// `JSON.stringify` emits that lone surrogate verbatim as a `\uXXXX` escape,
// and SurrealDB's string parser rejects `\uD800`-`\uDFFF` because a lone
// surrogate is not a valid Unicode scalar. Stripping lone surrogates before
// quoting makes any sliced text safe to embed.
// ============================================================================

/**
 * Matches a lone UTF-16 surrogate code unit: a high surrogate not followed by
 * a low surrogate, or a low surrogate not preceded by a high surrogate. Valid
 * surrogate PAIRS (real emoji / astral chars) do not match and are preserved.
 */
const LONE_SURROGATE =
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Strip lone UTF-16 surrogates. A `slice()` that splits an emoji's surrogate
 * pair leaves a lone surrogate; `JSON.stringify` emits it as a `\uXXXX` escape
 * that SurrealDB's parser rejects. Removing lone surrogates makes any text
 * safe to embed. Valid surrogate PAIRS are left intact. Dropping a half-emoji
 * is acceptable here - the excerpts being embedded are already lossy clips.
 */
const stripLoneSurrogates = (s: string): string => s.replace(LONE_SURROGATE, "");

/**
 * A SurrealQL string literal: JSON-quoted, lone surrogates removed. The one
 * way to embed arbitrary text (transcript excerpts, patterns, paths) into a
 * SurrealQL statement.
 *
 * The parameter type is `string`, but DB-sourced rows routinely hand back
 * `null` / `undefined` where a `string` was declared (a missing column reads
 * back as `undefined`). Rather than throw inside an ingest pipeline, a nullish
 * value is coerced to the empty string. Callers that want a SurrealQL `NONE`
 * for absent values must branch before calling (or use `surrealJsonOption`).
 */
export const surrealString = (value: string): string =>
    JSON.stringify(stripLoneSurrogates(value == null ? "" : value));

/**
 * A SurrealQL literal for an arbitrary JSON-serialisable value - serialises to
 * a JSON string, then quotes. For SET fields typed as `string` that store JSON
 * blobs (e.g. tool-call `args`). When `JSON.stringify` returns `undefined`
 * (e.g. the input is itself `undefined`), the literal `"null"` is used.
 */
export const surrealJson = (value: unknown): string =>
    surrealString(JSON.stringify(value) ?? "null");

/**
 * Like `surrealJson`, but `null` / `undefined` inputs produce the SurrealQL
 * keyword `NONE` (unquoted) rather than a `"null"` string. Mirrors the
 * existing per-file `sqlJsonOption` helpers.
 */
export const surrealJsonOption = (value: unknown): string =>
    value === null || value === undefined ? "NONE" : surrealJson(value);

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
 * Duck-type check for a SurrealDB `RecordId` instance. Avoids importing the
 * surrealdb package at the module level (would make this module depend on the
 * DB client) while still emitting a native record reference literal when a
 * `RecordId` flows through `surrealValue`.
 *
 * A `RecordId` has `.table.name` (string) and `.id` (RecordIdValue). The
 * `toString()` shape is `table:id`, so we use that as the canonical check.
 */
const isRecordId = (
    value: unknown,
): value is { table: { name: string }; id: unknown } =>
    typeof value === "object" &&
    value !== null &&
    "table" in value &&
    typeof (value as { table: unknown }).table === "object" &&
    (value as { table: unknown }).table !== null &&
    "name" in (value as { table: { name: unknown } }).table &&
    typeof (value as { table: { name: unknown } }).table.name === "string" &&
    "id" in value;

/**
 * Universal value encoder: turn any JS value into a SurrealQL literal.
 *
 *  - string  → quoted string literal
 *  - finite number → bare numeric literal
 *  - boolean → `true` / `false`
 *  - null / undefined → `NONE`
 *  - Date → datetime literal
 *  - RecordId (string id) → `table:`key`` native record reference
 *  - array → `[...]` of encoded elements (RecordId elements become refs)
 *  - object → `surrealJson` literal (JSON-text column)
 *
 * Used by the telemetry write path, where rows are heterogeneous and a typed
 * per-field builder would be overkill.
 */
export const surrealValue = (value: unknown): string => {
    if (value === null || value === undefined) return "NONE";
    if (typeof value === "string") return surrealString(value);
    if (typeof value === "number") {
        return Number.isFinite(value) ? value.toString(10) : "NONE";
    }
    if (typeof value === "boolean") return value ? "true" : "false";
    if (value instanceof Date) return surrealDate(value);
    // Only a string id yields a native record reference. A RecordId with a
    // non-string id (object/array key) would `String()`-mangle into garbage
    // like `t:`[object Object]``; let it fall through to the JSON fallback.
    if (isRecordId(value) && typeof value.id === "string") {
        return recordRef(value.table.name, value.id);
    }
    if (Array.isArray(value)) {
        return `[${value.map((v) => surrealValue(v)).join(", ")}]`;
    }
    return surrealJson(value);
};

// ============================================================================
// 2. TYPED ROW FIELD ACCESS
// ----------------------------------------------------------------------------
// SurrealDB hands back `Record<string, unknown>`; a missing column reads as
// `undefined`, datetimes arrive as `Date` or ISO string depending on path, and
// record ids as strings or `RecordId`-like objects. Every dashboard read used
// to redefine these same guards. They live here once.
// ============================================================================

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

/** Finite number at `key`, else `null` (no coercion - a string `"3"` is
 *  `null`). Naming follows metrics/util.ts `numOrNull`. */
export const numberFieldOrNull = (
    row: Record<string, unknown>,
    key: string,
): number | null => {
    const v = row[key];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
};

/** Aggregate count at `key`, coerced from any numeric-ish value (string
 *  counts, Date no); non-finite or missing → `0`. Named `countField` (not
 *  `numberFieldOrZero`) so the coercing/defaulting helper can't be confused
 *  with the strict `numberFieldOrNull` one suffix away. Use for aggregate
 *  counts where a missing column means zero. */
export const countField = (
    row: Record<string, unknown>,
    key: string,
): number => {
    const v = Number(row[key] ?? 0);
    return Number.isFinite(v) ? v : 0;
};

/**
 * Coerce a row field to a string.
 *
 * `String(v)` is called on non-null/undefined values so numbers, booleans,
 * and `RecordId`-like objects (whose `.toString()` emits `table:key`) all
 * produce readable strings rather than `'[object Object]'`. Null / undefined
 * fall back to `fallback` (default `""`).
 *
 * Use this instead of `String(row[key] ?? "")` so the coercion is named and
 * centrally tested. Distinct from the strict `stringField` which returns null
 * for any non-string input (no coercion).
 */
export const stringFieldOr = (
    row: Record<string, unknown>,
    key: string,
    fallback = "",
): string => {
    const v = row[key];
    return v === null || v === undefined ? fallback : String(v);
};

// ---------------------------------------------------------------------------
// VALUE-FORM coercers - shared bodies for the deprecated local copies in
// metrics/util.ts, dashboard/cost-query.ts, etc.  Named by behavior, not by
// coerce* vocabulary (spec §F).  New DB-row reads should prefer the ROW-form
// helpers above (countField, stringFieldOr); these value-form variants exist
// only as the canonical tested implementation the shims re-export.
// ---------------------------------------------------------------------------

/**
 * Coerce any value to a finite number, `null` for null / undefined /
 * non-finite (including NaN). Unlike the strict `numberFieldOrNull` (which
 * rejects string `"3"` → null), this calls `Number(v)` first so string counts
 * and similar coercible values are handled.
 *
 * VALUE-form sibling of `numberFieldOrNull`.
 */
export const numberOrNull = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

/**
 * Coerce any value to a finite number, `0` for null / undefined / non-finite.
 * VALUE-form sibling of `countField`.
 */
export const numberOrZero = (v: unknown): number => numberOrNull(v) ?? 0;

/**
 * Non-empty string or null; null for any non-string input (no coercion).
 * VALUE-form sibling of `stringField`. Use `stringFieldOr` (or `String(v)`)
 * when coercing numbers / RecordIds to a string is acceptable.
 */
export const stringOrNull = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;

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

// ============================================================================
// 3. RECORD SELECTION
// ----------------------------------------------------------------------------
// The ONE reliable shape for bulk fetch-by-record-id, and the single home of
// the SurrealDB id-IN-list quirk documentation.
//
// INVARIANT (verified live against SurrealDB 3.0.5 AND 3.1.0 in-memory
// instances, 2026-06-11, plus 3.1.0 on 127.0.0.1:8521 against real rows on
// 2026-06-10):
//
//   - Bare record-list selection `SELECT ... FROM [table:`k1`, table:`k2`]`
//     works on 3.1.0 but THROWS "Specify a database to use" on 3.0.x even
//     with the session namespace/database set (issue #251 - it aborted every
//     Claude/Codex ingest on fresh installs, which pinned SurrealDB 3.0.5).
//     Parameterized `FROM $ids` fails identically on 3.0.x.
//
//   - Materializing the records first - `FROM [refs].map(|$r| $r.*)` -
//     resolves every existing record on BOTH 3.0.5 and 3.1.0. Missing
//     records dereference to NONE; the appended `.filter(|$o| $o != NONE)`
//     drops them explicitly (1 real + 1 missing → 1 row; all missing → 0
//     rows, no error). Field expressions over the materialized objects -
//     aliases, `type::string(id)`, `<string>id` casts - behave exactly as
//     they do over a table source. This is the shape both helpers below emit.
//
//   - `SELECT ... FROM <table> WHERE id IN [refs]` is UNRELIABLE: with the
//     exact same refs it matched 0 rows on skill, file, commit, tool_call and
//     pull_request, while matching correctly on session and turn. `WHERE id
//     INSIDE [...]` fails the same way; single-equality `WHERE id = <ref>`
//     works everywhere. The failing/working split does not follow key quoting
//     (backticked-uuid session keys AND digit-leading plain turn keys both
//     work), so do not assume any table is safe - just never bulk-filter on
//     `id IN`.
//
//   - NON-id field IN-lists (`WHERE out IN [...]`, `WHERE session IN [...]`,
//     `WHERE sha IN [...]`) are NOT affected and remain the right shape for
//     indexed edge/field scans.
//
// Callers: build the FROM-source with `recordListSource` (bare keys) or
// `refListSource` (pre-formatted record literals, e.g. `type::string(id)`
// round-trips), or take the whole statement from `selectByIds`.
// ============================================================================

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Dereference a record-id list into plain objects so the SELECT source is
 * version-portable (see the 3.0.x invariant above), dropping missing records.
 *
 * `pick` narrows the materialization to a destructured field subset
 * (`$r.{a, b}`) - use it on tables with heavy payload fields (e.g. `turn.text`,
 * `content_block.search_text`) so the server doesn't copy the full record just
 * to project two columns. It must include EVERY field the surrounding
 * statement touches: SELECT expressions (`type::string(id)` needs `id`,
 * `turn.seq` needs `turn`), WHERE, and ORDER BY.
 */
const materialized = (refList: string, pick?: readonly string[]): string => {
    if (pick !== undefined) {
        if (pick.length === 0) throw new Error("record-select: empty pick");
        for (const field of pick) {
            if (!IDENT_RE.test(field)) throw new Error(`record-select: invalid pick field ${JSON.stringify(field)}`);
        }
    }
    const shape = pick === undefined ? "*" : `{${pick.join(", ")}}`;
    return `${refList}.map(|$r| $r.${shape}).filter(|$o| $o != NONE)`;
};

/**
 * A materialized FROM source from bare record keys:
 * `` [table:`k1`, table:`k2`].map(|$r| $r.*).filter(|$o| $o != NONE) ``.
 *
 * @throws {Error} when any key is empty or contains a backtick/newline/null
 *   byte (see `recordLiteral`). Filter/normalize keys before calling.
 */
export const recordListSource = (table: string, keys: readonly string[], pick?: readonly string[]): string =>
    materialized(`[${keys.map((k) => recordLiteral(table, k)).join(", ")}]`, pick);

/**
 * A materialized FROM source from refs that are ALREADY valid record literals
 * (e.g. strings produced by `type::string(id)` / `<string>id`, which come back
 * as `` table:`key` `` or `table:⟨key⟩`). No escaping is applied - never pass
 * user input through this form.
 */
export const refListSource = (refs: readonly string[], pick?: readonly string[]): string =>
    materialized(`[${refs.join(", ")}]`, pick);

/**
 * The full bulk fetch-by-id statement:
 * `SELECT <fields> FROM [refs].map(|$r| $r.*).filter(|$o| $o != NONE);`.
 * Missing records are skipped; an all-missing list yields zero rows.
 */
export const selectByIds = (fields: string, table: string, keys: readonly string[], pick?: readonly string[]): string =>
    `SELECT ${fields} FROM ${recordListSource(table, keys, pick)};`;

// ============================================================================
// 4. STATEMENT EXECUTION
// ----------------------------------------------------------------------------
// The shared seam for executing a batch of SurrealQL statements. Statements
// are joined and sent in chunks because a single `db.query()` with thousands
// of statements blows past SurrealDB's parser limits and balloons memory.
//
// This is the EXECUTE counterpart to the LITERALS section (which formats
// literals) and `graph-query.ts` (which runs typed reads). Every ingest stage
// that builds `UPSERT`/`RELATE`/`CREATE` statement arrays routes them through
// here, so chunking + concurrency policy lives in exactly one place.
// ============================================================================

/** Default statements per `db.query()` call. Matches the long-standing
 *  evidence-writers value; safely under SurrealDB's parser limits. */
export const DEFAULT_CHUNK_SIZE = 250;

export interface ExecuteOptions {
    /** Statements per `db.query()` call. Defaults to {@link DEFAULT_CHUNK_SIZE}. */
    readonly chunkSize?: number;
    /** Span label identifying the caller (e.g. "upsertTurns") so DB time is
     *  attributable per write-helper in a trace viewer. Default "statements". */
    readonly label?: string;
}

/** Execute pre-built statements against an already-resolved client. Use when
 *  the caller already holds a `SurrealClientShape` (e.g. inside a larger
 *  `Effect.gen` that resolved `SurrealClient` once). */
export const executeStatementsWith = (
    db: SurrealClientShape,
    statements: readonly string[],
    options?: ExecuteOptions,
): Effect.Effect<void, DbError> => {
    if (statements.length === 0) return Effect.void;
    const chunks = Arr.chunksOf(statements, options?.chunkSize ?? DEFAULT_CHUNK_SIZE);
    return Effect.forEach(
        chunks,
        (chunk, i) =>
            db.query(chunk.join("")).pipe(
                Effect.asVoid,
                Effect.withSpan("db.chunk", {
                    attributes: { "db.chunk.index": i, "db.chunk.statements": chunk.length },
                }),
            ),
        { discard: true },
    ).pipe(
        Effect.withSpan(`db.exec:${options?.label ?? "statements"}`, {
            attributes: {
                "db.exec.statements": statements.length,
                "db.exec.chunks": chunks.length,
            },
        }),
    );
};

/** Execute pre-built statements, resolving `SurrealClient` from context. */
export const executeStatements = (
    statements: readonly string[],
    options?: ExecuteOptions,
): Effect.Effect<void, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        yield* executeStatementsWith(db, statements, options);
    });

// ============================================================================
// 5. RECORD-ID KEY DERIVATION
// ----------------------------------------------------------------------------
// Canonical key/timestamp seam for ingest derive stages.
//
// All ingest derive stages that build SurrealDB record IDs must import from
// here. `safeKeyPart` output feeds record IDs directly, so the 96-char slice
// cap is load-bearing - SurrealDB record keys have a practical length limit
// and a consistent cap prevents divergence across stages.
//
// Previously each derive stage defined its own copies of these helpers; those
// copies had started to diverge. This module is the single source of truth.
// Do not redefine these helpers locally - import them from here.
// ============================================================================

/**
 * The union of input types accepted by `isoTimestamp`.
 * - `Date`            - JS Date object
 * - `string`          - already-formatted ISO string, passed through as-is
 * - SurrealDB DateTime - detected by `constructor.name === "DateTime"`,
 *                        coerced via `String(value)`
 */
export type TimestampInput =
    | Date
    | string
    | { readonly constructor: { readonly name: string }; toString(): string };

/**
 * Sanitize an arbitrary string into a safe SurrealDB record-key segment.
 *
 * Rules applied in order:
 * 1. Replace `:` with `__` (plugin-namespaced skill names use `:`)
 * 2. Replace any remaining non-alphanumeric characters with `_`
 * 3. Collapse runs of 3+ underscores to `__`
 * 4. Trim leading and trailing underscores
 * 5. If the result is non-empty, slice to 96 chars (SurrealDB key hygiene)
 * 6. If the result is empty, return the hex hash of the original value
 */
export const safeKeyPart = (value: string): string => {
    const sanitized = value
        .replace(/:/g, "__")
        .replace(/[^a-zA-Z0-9_]+/g, "_")
        .replace(/_{3,}/g, "__")
        .replace(/^_+|_+$/g, "");
    return sanitized.length > 0 ? sanitized.slice(0, 96) : Bun.hash(value).toString(16);
};

/**
 * Extract the key portion from a SurrealDB record-ID value.
 *
 * Handles:
 * - `"table:key"` strings - strips the table prefix (expected or first colon)
 * - Backtick- or angle-bracket-quoted keys - strips the quoting characters
 * - Objects with an `.id` property - coerces `.id` to string
 *
 * Returns `null` for null/undefined, empty strings, or unrecognised types.
 */
export const recordKeyPart = (value: unknown, expectedTable?: string): string | null => {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") {
        let raw = value.trim();
        const prefix = expectedTable ? `${expectedTable}:` : null;
        if (prefix && raw.startsWith(prefix)) raw = raw.slice(prefix.length);
        else if (raw.includes(":")) raw = raw.slice(raw.indexOf(":") + 1);
        if ((raw.startsWith("`") && raw.endsWith("`")) || (raw.startsWith("⟨") && raw.endsWith("⟩"))) {
            raw = raw.slice(1, -1);
        }
        return raw.length > 0 ? raw : null;
    }
    if (typeof value === "object" && "id" in value) {
        const id = (value as { id: unknown }).id;
        return id === null || id === undefined ? null : String(id);
    }
    return null;
};

/**
 * Coerce a timestamp value to an ISO 8601 string.
 *
 * Branch order:
 * 1. `value instanceof Date`  → `value.toISOString()`
 * 2. Non-empty string         → pass through unchanged
 * 3. SurrealDB DateTime object (`constructor.name === "DateTime"`) → `String(value)`
 * 4. Anything else (null / undefined / unknown) → epoch `new Date(0).toISOString()`
 */
export const isoTimestamp = (value: TimestampInput | null | undefined): string => {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "string" && value.length > 0) return value;
    if (value && typeof value === "object" && value.constructor.name === "DateTime") return String(value);
    return new Date(0).toISOString();
};

/**
 * Return the trimmed string if non-empty, otherwise `null`.
 * Returns `null` for any non-string input (number, object, null, undefined).
 */
export const nonEmptyString = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
};
