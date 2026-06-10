import { recordLiteral } from "@ax/lib/ids";
import { recordKeyPart } from "@ax/lib/shared/derive-keys";
import type { SessionMetricsRow } from "./session-metrics-query.ts";

/** Comma-joined `session:`key`` record-literal IN-list body for the given session ids. */
export const sessionRefList = (sessionIds: readonly string[]): string =>
    sessionIds.map((id) => recordLiteral("session", recordKeyPart(id, "session") ?? "")).join(", ");

/** Split into fixed-size chunks (for bounded `IN [...]` query batches). */
export const chunked = <T>(items: readonly T[], size: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
};

// ---------------------------------------------------------------------------
// Row-field coercion (shared by the metrics fetchers - single copy, #166 review)
// ---------------------------------------------------------------------------

export const numOrNull = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
export const numOrZero = (v: unknown): number => numOrNull(v) ?? 0;
export const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** Set absent ids to a default (mutates + returns the map). */
export const fillDefaults = <V>(map: Map<string, V>, ids: readonly string[], def: V): Map<string, V> => {
    for (const id of ids) if (!map.has(id)) map.set(id, def);
    return map;
};

/** Parse an ISO datetime string to epoch ms, or null. */
export const isoMs = (iso: unknown): number | null => {
    if (typeof iso !== "string" || iso.length === 0) return null;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) ? t : null;
};

// ---------------------------------------------------------------------------
// `ax sessions metrics` table formatting (pure - unit-tested in util.test.ts)
// ---------------------------------------------------------------------------

/** Render a 0..1 ratio as a whole percent; "-" when null. Unpadded - column
 *  alignment is the table layout's concern, not the formatter's. */
export const metricPct = (v: number | null): string =>
    v === null ? "-" : `${Math.round(v * 100)}%`;

/**
 * Render a duration-in-ms metric column: "-" when null, "<1m" under a minute,
 * whole minutes under an hour, else "X.Xh".
 *
 * Sub-minute values are legitimate, not noise: squash-merged PRs land at ~0ms
 * because the PR's merge_sha IS the session's commit (commit ts == merge ts),
 * so we render "<1m" instead of flooring to a misleading "1m".
 */
export const metricMs = (v: number | null): string =>
    v === null
        ? "-"
        : v >= 3600000
            ? `${(v / 3600000).toFixed(1)}h`
            : v < 60000
                ? "<1m"
                : `${Math.round(v / 60000)}m`;

/**
 * One-line column legend for the `ax sessions metrics` table (printed on TTY
 * output; the column names alone are too terse - blind-dogfood finding #178).
 */
export const SESSION_METRICS_LEGEND =
    "legend: durab = commits not later reverted / commits produced (- = session produced no commits) | "
    + "land = first commit -> PR-merge latency (squash merges legitimately land at ~0 -> \"<1m\") | "
    + "1st-edit = session start -> first Edit/Write | reads = Read/Grep/Glob calls before the first edit | "
    + "deleg% = commits produced by spawned subagents / all produced commits";

/** Strip the `session:` prefix + record-id delimiters so ids from different
 *  surfaces (`type::string(session)` vs raw keys) compare equal. */
export const cleanSessionId = (id: string): string => id.replace(/^session:/, "").replace(/[`⟨⟩]/g, "");

export interface FormatSessionMetricsOptions {
    /**
     * Print untruncated session ids (default truncates to 20 chars). Full ids
     * feed straight into `ax sessions show` / `ax sessions compare` without a
     * --json round-trip.
     */
    readonly fullIds?: boolean;
}

/** Render `ax sessions metrics` rows as an aligned plain-text table. */
export const formatSessionMetrics = (
    rows: readonly SessionMetricsRow[],
    opts: FormatSessionMetricsOptions = {},
): string => {
    if (rows.length === 0) return "no session_metrics rows (run `ax ingest` to populate).";
    const ids = rows.map((r) => cleanSessionId(r.session));
    const idWidth = opts.fullIds === true ? Math.max(20, ...ids.map((id) => id.length)) : 20;
    const lines: string[] = [];
    lines.push(
        `${"session".padEnd(idWidth)} ${"durab".padStart(5)} ${"commits".padStart(7)} ${"land".padStart(5)} ${"+/-loc".padStart(12)} `
        + `${"1st-edit".padStart(8)} ${"reads".padStart(5)} ${"deleg%".padStart(6)}  task`,
    );
    for (const [i, r] of rows.entries()) {
        const id = opts.fullIds === true ? ids[i]! : ids[i]!.slice(0, 20);
        lines.push(
            `${id.padEnd(idWidth)} `
            + `${metricPct(r.durabilityRatio).padStart(5)} ${String(r.producedCommits).padStart(7)} ${metricMs(r.timeToLandMs).padStart(5)} `
            + `${`+${r.linesAdded}/-${r.linesRemoved}`.padStart(12)} `
            + `${metricMs(r.timeToFirstEditMs).padStart(8)} ${String(r.coldStartReads).padStart(5)} ${metricPct(r.delegationRatio).padStart(6)}  `
            + `${(r.taskLabel ?? "").replace(/\s+/g, " ").slice(0, 50)}`,
        );
    }
    return lines.join("\n");
};
