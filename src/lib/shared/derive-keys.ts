/**
 * @file Canonical key/timestamp seam for ingest derive stages.
 *
 * All ingest derive stages that build SurrealDB record IDs must import from
 * this module. `safeKeyPart` output feeds record IDs directly, so the 96-char
 * slice cap is load-bearing - SurrealDB record keys have a practical length
 * limit and a consistent cap prevents divergence across stages.
 *
 * Previously each derive stage defined its own copies of these helpers;
 * those copies had started to diverge. This module is the single source of
 * truth. Do not redefine these helpers locally - import them from here.
 */

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
