/**
 * Shared CLI output formatters - the single home for the small value
 * formatters that used to be copy-pasted across command handlers
 * (costs, ax-cost, ax-dispatches, ax-routing, profile, insights-format,
 * classifiers-explain-format).
 *
 * BYTE-IDENTICAL contract: every formatter here reproduces the exact output
 * of the local copies it replaced. Where copies differed (e.g. `usd` decimal
 * places: 4 in cost tables, 2 in routing proposals; `truncate` default max),
 * the difference is a parameter so each call site keeps its current bytes.
 *
 * Deliberately NOT unified here (semantics differ - do not "clean up"):
 *  - `share/format.ts` usd (conditional 2/4 decimals on magnitude)
 *  - `improve/impact.ts` usd (rounds >= 100 with en grouping)
 *  - `session-show-format.ts` usd (null renders "?")
 *  - `profile.ts` money ("~$22.6K" compaction)
 *  - `quota/format.ts` pct (Math.round, no decimal)
 *  - `metrics/session-churn.ts` truncate ("..." 3-char suffix)
 */

/**
 * Format a value as USD with fixed decimals (default 4: "$0.1234").
 * Coerces numeric strings; anything non-finite renders as zero
 * ("$0.0000" / "$0.00") rather than throwing - cost tables must never crash
 * on a missing aggregate.
 */
export const usd = (value: unknown, decimals: number = 4): string => {
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(n) ? `$${n.toFixed(decimals)}` : `$${(0).toFixed(decimals)}`;
};

/**
 * Format a value as a truncated integer with en-US thousands grouping
 * ("1,234,567"). Coerces numeric strings; non-finite renders "0".
 */
export const integer = (value: unknown): string => {
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(n) ? Math.trunc(n).toLocaleString("en-US") : "0";
};

/** Format a percentage with one decimal ("12.3%"); non-finite renders "0.0%". */
export const pct = (n: number): string =>
    Number.isFinite(n) ? `${n.toFixed(1)}%` : "0.0%";

/**
 * Truncate a plain string to `len` characters, replacing the last kept
 * character with a single "…" when it overflows. Nullish/empty input
 * renders "". Whitespace is preserved as-is (table cells - see
 * `truncateText` for the prose variant).
 */
export const truncate = (s: string | null, len: number): string => {
    if (!s) return "";
    return s.length <= len ? s : `${s.slice(0, len - 1)}…`;
};

/** Render any value as text: strings pass through, nullish renders "". */
export const textOf = (value: unknown): string =>
    typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);

/**
 * Prose-style truncation: collapse whitespace runs to single spaces, trim,
 * then cap at `max` characters with a trailing "…" (trailing spaces trimmed
 * before the ellipsis). Accepts any value via `textOf`.
 */
export const truncateText = (value: unknown, max: number): string => {
    const text = textOf(value).replace(/\s+/g, " ").trim();
    return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
};

/**
 * Single-line JSON for machine-readable stdout (`--json` paths that
 * intentionally do NOT pretty-print). Byte-identical to a bare
 * `JSON.stringify(value)` - kept here so command handlers have one JSON
 * output seam alongside `prettyPrint` (@ax/lib/json).
 */
export const compactPrint = (value: unknown): string => JSON.stringify(value);
