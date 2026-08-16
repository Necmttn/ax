/**
 * row-fields: the ENGINE-NEUTRAL half of the old Graph Access Toolkit.
 *
 * Two things live here, and neither one talks to a database:
 *
 *   1. TYPED ROW FIELD ACCESS - pull a typed value out of a
 *      `Record<string, unknown>` result row. Written for SurrealDB's untyped
 *      rows, still used by every not-yet-ported reader, and by ported code that
 *      decodes a JSON payload rather than a DuckDB column.
 *   2. RECORD-ID KEY DERIVATION - `safeKeyPart` / `recordKeyPart` /
 *      `isoTimestamp` / `nonEmptyString`. `safeKeyPart` in particular feeds row
 *      ids that the DuckDB writers still emit, so it OUTLIVES SurrealDB.
 *
 * These moved out of `shared/surreal.ts` in wave 3 (`c-read-seam`). That file
 * is now only SurrealQL TEXT emitters and dies whole in `c-surreal-delete`;
 * this one has no Surreal dependency and stays. It re-exports nothing and
 * imports nothing from the client, so it is safe to import from ported code.
 */

// ============================================================================
// 1. TYPED ROW FIELD ACCESS
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
// 2. RECORD-ID KEY DERIVATION
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
 * - SurrealDB DateTime - any object exposing `toISOString()`; detected
 *                        structurally (see `isoTimestamp` for why not by name)
 */
export type TimestampInput =
    | Date
    | string
    | { toISOString(): string };

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
 * 3. Any object exposing a `toISOString()` method (the SurrealDB DateTime) →
 *    `value.toISOString()`. We duck-type on the method rather than checking
 *    `constructor.name === "DateTime"`, because `bun build --compile` renames
 *    the bundled SDK class (observed as `DateTime3`), so an exact-name check
 *    silently falls through to epoch ONLY in the compiled binary - the #670
 *    "1970-01-01" friction-view timestamps that source builds never showed.
 * 4. Anything else (null / undefined / unknown) → epoch `new Date(0).toISOString()`
 *    and emits a `console.warn` so silent epoch timestamps surface as data bugs
 *    (symptom: `ax insights friction` events timestamped `1970-01-01 00:00:00`)
 */
export const isoTimestamp = (value: TimestampInput | null | undefined): string => {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "string" && value.length > 0) return value;
    if (
        value &&
        typeof value === "object" &&
        typeof (value as { toISOString?: unknown }).toISOString === "function"
    ) {
        return (value as { toISOString(): string }).toISOString();
    }
    const typeDesc = (() => {
        try {
            if (value === null) return "null";
            if (value === undefined) return "undefined";
            const t = typeof value;
            const ctor =
                value != null && typeof value === "object"
                    ? ((value as object).constructor?.name ?? "?")
                    : undefined;
            return ctor ? `${t}(${ctor})` : t;
        } catch {
            return "unknown";
        }
    })();
    console.warn("[ax] isoTimestamp: unrecognized timestamp value, defaulting to epoch:", typeDesc);
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
