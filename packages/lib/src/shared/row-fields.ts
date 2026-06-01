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
