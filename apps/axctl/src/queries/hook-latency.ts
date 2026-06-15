/**
 * `ax hooks latency` query: windowed regression lens over hook_command_invocation.duration_ms.
 *
 * Detects whether installed hooks are getting slower over time by comparing
 * a "recent" window against a "baseline" window of the same width immediately before.
 * No new schema needed - reads existing hook_command_invocation telemetry.
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { percentiles } from "../hooks/bench.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HookLatencyWindow {
    readonly p50: number;
    readonly p95: number;
    readonly samples: number;
}

export interface HookLatencyRow {
    readonly hook_name: string;
    readonly recent: HookLatencyWindow;
    readonly baseline: HookLatencyWindow;
    readonly p95_delta_ms: number;    // recent.p95 - baseline.p95
    readonly p95_ratio: number;       // recent.p95 / baseline.p95 (0 if baseline.p95 === 0)
    readonly regressed: boolean;
}

export interface HookLatencyReport {
    readonly recent_days: number;
    readonly baseline_days: number;
    readonly rows: ReadonlyArray<HookLatencyRow>;
    readonly total_fires_with_latency: number;
}

// ---------------------------------------------------------------------------
// Raw DB row shape
// ---------------------------------------------------------------------------

interface RawInvocationRow {
    readonly hook_name: string;
    readonly ts: string | Date;
    readonly duration_ms: number;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const validDays = (n: number): number => Math.max(1, Math.trunc(n));

/**
 * PURE: group raw rows into recent/baseline buckets per hook, compute percentiles,
 * apply regression flag, sort.
 */
export const computeHookLatency = (
    rows: ReadonlyArray<RawInvocationRow>,
    opts: {
        recentDays: number;
        baselineDays: number;
        factor: number;
        minDeltaMs: number;
        minSamples: number;
    },
): HookLatencyRow[] => {
    const nowMs = Date.now();
    const recentCutoffMs = nowMs - opts.recentDays * 86_400_000;
    const baselineCutoffMs = nowMs - (opts.recentDays + opts.baselineDays) * 86_400_000;

    // Bucket: hook_name -> { recent: ms[], baseline: ms[] }
    const byHook = new Map<string, { recent: number[]; baseline: number[] }>();
    for (const row of rows) {
        const tsMs = row.ts instanceof Date ? row.ts.getTime() : new Date(String(row.ts)).getTime();
        const ms = Number(row.duration_ms);
        if (!Number.isFinite(ms)) continue;
        // recent window: ts > now - recentDays·d
        const isRecent = tsMs > recentCutoffMs;
        // baseline window: now - (recentDays+baselineDays)·d < ts <= now - recentDays·d
        const isBaseline = tsMs > baselineCutoffMs && tsMs <= recentCutoffMs;
        if (!isRecent && !isBaseline) continue;
        const entry = byHook.get(row.hook_name) ?? { recent: [], baseline: [] };
        if (isRecent) entry.recent.push(ms);
        else entry.baseline.push(ms);
        byHook.set(row.hook_name, entry);
    }

    const result: HookLatencyRow[] = [];
    for (const [hook_name, { recent: recentMs, baseline: baselineMs }] of byHook.entries()) {
        const recentStats = percentiles(recentMs);
        const baselineStats = percentiles(baselineMs);
        const p95_delta_ms = recentStats.p95 - baselineStats.p95;
        const p95_ratio = baselineStats.p95 === 0 ? 0 : recentStats.p95 / baselineStats.p95;
        const regressed =
            recentMs.length >= opts.minSamples &&
            baselineMs.length >= opts.minSamples &&
            p95_delta_ms >= opts.minDeltaMs &&
            recentStats.p95 >= baselineStats.p95 * opts.factor;
        result.push({
            hook_name,
            recent: { p50: recentStats.p50, p95: recentStats.p95, samples: recentMs.length },
            baseline: { p50: baselineStats.p50, p95: baselineStats.p95, samples: baselineMs.length },
            p95_delta_ms,
            p95_ratio,
            regressed,
        });
    }

    // Sort: regressed first, then p95_delta_ms desc
    result.sort((a, b) => {
        if (a.regressed !== b.regressed) return a.regressed ? -1 : 1;
        return b.p95_delta_ms - a.p95_delta_ms;
    });

    return result;
};

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const pad = (s: string, n: number) => s.padEnd(n);
const rpad = (s: string, n: number) => s.padStart(n);

/**
 * PURE: render a HookLatencyReport as a string.
 * Table: hook_name · recent p50/p95 (n) · baseline p50/p95 (n) · Δp95 · ratio · ⚠
 * Footer: N regressed / M hooks
 * Empty-state when total_fires_with_latency === 0.
 */
export const renderHookLatency = (report: HookLatencyReport): string => {
    if (report.total_fires_with_latency === 0) {
        return "no hook latency telemetry in this window - duration_ms is provider-reported and may be absent; try a wider --days or run `ax hooks bench <file>` for a synthetic measure.";
    }

    const rows = report.rows;
    if (rows.length === 0) {
        return `no hook invocations with latency data found (total_fires_with_latency=${report.total_fires_with_latency})`;
    }

    const header = [
        pad("hook", 32),
        rpad("rec p50", 8),
        rpad("rec p95", 8),
        rpad("rec n", 7),
        rpad("base p50", 9),
        rpad("base p95", 9),
        rpad("base n", 7),
        rpad("Δp95", 8),
        rpad("ratio", 7),
        "⚠",
    ].join(" ");

    const lines: string[] = [header];
    for (const row of rows) {
        const warn = row.regressed ? "⚠" : "";
        // Δp95 and ratio compare the two windows - meaningless when EITHER
        // window has no samples (e.g. a hook that only fired recently shows a
        // huge "+delta" purely because baseline is empty). Blank them so the
        // table can't be misread as a regression/improvement. The populated
        // window's p50/p95 columns still render; the raw JSON keeps the numbers.
        const oneWindowEmpty = row.recent.samples === 0 || row.baseline.samples === 0;
        const deltaCell = oneWindowEmpty
            ? "-"
            : `${row.p95_delta_ms >= 0 ? "+" : ""}${row.p95_delta_ms}ms`;
        const ratioCell = oneWindowEmpty || row.p95_ratio === 0
            ? "n/a"
            : `${row.p95_ratio.toFixed(2)}x`;
        lines.push([
            pad(row.hook_name, 32),
            rpad(`${row.recent.p50}ms`, 8),
            rpad(`${row.recent.p95}ms`, 8),
            rpad(String(row.recent.samples), 7),
            rpad(`${row.baseline.p50}ms`, 9),
            rpad(`${row.baseline.p95}ms`, 9),
            rpad(String(row.baseline.samples), 7),
            rpad(deltaCell, 8),
            rpad(ratioCell, 7),
            warn,
        ].join(" "));
    }

    const regrCount = rows.filter((r) => r.regressed).length;
    lines.push(`\n${regrCount} regressed / ${rows.length} hooks  (recent=${report.recent_days}d vs baseline=${report.baseline_days}d)`);
    return lines.join("\n");
};

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export const fetchHookLatencyRegression = (opts: {
    readonly recentDays: number;
    readonly baselineDays: number;
    readonly factor?: number;
    readonly minDeltaMs?: number;
    readonly minSamples?: number;
}): Effect.Effect<HookLatencyReport, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const factor = opts.factor ?? 1.5;
        const minDeltaMs = opts.minDeltaMs ?? 15;
        const minSamples = opts.minSamples ?? 20;
        const totalDays = validDays(opts.recentDays) + validDays(opts.baselineDays);

        const sql = `SELECT hook_name, <string>ts AS ts, duration_ms FROM hook_command_invocation WHERE duration_ms != NONE AND ts > time::now() - ${totalDays}d ORDER BY ts DESC;`;

        const [rows] = yield* db.query<[RawInvocationRow[]]>(sql);
        const rawRows = rows ?? [];

        const computedRows = computeHookLatency(rawRows, {
            recentDays: validDays(opts.recentDays),
            baselineDays: validDays(opts.baselineDays),
            factor,
            minDeltaMs,
            minSamples,
        });

        return {
            recent_days: validDays(opts.recentDays),
            baseline_days: validDays(opts.baselineDays),
            rows: computedRows,
            total_fires_with_latency: rawRows.length,
        } satisfies HookLatencyReport;
    });
