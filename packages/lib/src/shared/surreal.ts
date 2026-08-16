/**
 * surreal: the Graph Access Toolkit - the single shared module of safe
 * Storage Backend (SurrealDB) access primitives that query modules compose.
 *
 * WHAT IS LEFT AFTER WAVE 3's `c-read-seam`. Only the parts that emit
 * SurrealQL TEXT, and they exist purely to keep the not-yet-ported readers
 * compiling until their own chunk lands:
 *
 *   1. LITERALS / ESCAPING  - turn JS values into SurrealQL literals so
 *      escaping is defined exactly once.
 *   2. RECORD SELECTION     - the one reliable shape for bulk fetch-by-record-id
 *      and the home of the SurrealDB 3.0.x id-IN quirk.
 *
 * Everything engine-NEUTRAL moved to `./row-fields.ts` (re-exported at the
 * bottom, so existing import sites are untouched), and statement execution was
 * deleted outright - see the note above that re-export. This whole file goes in
 * `c-surreal-delete`; `row-fields.ts` does not.
 */

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
// 2. RECORD SELECTION
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
// 4. ENGINE-NEUTRAL HELPERS (moved out)
// ----------------------------------------------------------------------------
// Typed row-field access and record-id key derivation moved to
// `./row-fields.ts` in wave 3 (`c-read-seam`): they have no Surreal dependency
// and must survive `c-surreal-delete`, which deletes this file whole. The
// re-export keeps the existing `@ax/lib/shared/surreal` import sites working
// until their own chunk ports them; NEW callers import `./row-fields.ts`.
//
// Statement execution (`executeStatements` / `executeStatementsWith`) was
// DELETED in the same pass, not moved: after wave 2 ported every ingest writer
// onto the DuckDB seam, its only remaining caller was the dead
// `shared/watermark.ts`, which went with it.
// ============================================================================

export {
    isRecord,
    stringField,
    dateField,
    numberFieldOrNull,
    countField,
    stringFieldOr,
    numberOrNull,
    numberOrZero,
    stringOrNull,
    recordIdString,
    safeKeyPart,
    recordKeyPart,
    isoTimestamp,
    nonEmptyString,
    type TimestampInput,
} from "./row-fields.ts";
