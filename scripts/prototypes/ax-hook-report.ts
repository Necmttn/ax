/**
 * Static HTML report for the `hook_fire` table.
 *
 * Run: `bun scripts/prototypes/ax-hook-report.ts [output.html]`
 * Default output path: dogfood-output/ax-hook-report.html
 *
 * Sections:
 *  - Summary card: total fires, inject rate, dedup rate, latency p50/p95.
 *  - By reason: counts + percentages.
 *  - By harness/event: pivot.
 *  - Recent injects: file + injected title(s) + ts.
 *  - Top files seen: most-fired paths with reason breakdown.
 *  - Hourly bucket bar chart: fire volume over the last 24h.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect, Layer } from "effect";
import { SurrealClient, SurrealClientLive } from "@ax/lib/db";
import { AxConfigLive } from "@ax/lib/config";

interface HookFireRow {
    readonly id: string;
    readonly ts: string;
    readonly harness: string;
    readonly event: string;
    readonly file_path: string;
    readonly inject: boolean;
    readonly reason: string;
    readonly latency_ms: number;
    readonly injected_titles: readonly string[];
}

const escapeHtml = (s: string): string =>
    s.replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

const REASON_COLORS: Record<string, string> = {
    high_signal: "#16a34a",
    no_prior_sessions: "#94a3b8",
    suppressed_path: "#a16207",
    low_signal_only: "#0ea5e9",
    session_already_injected: "#7c3aed",
    no_files: "#dc2626",
};

const reasonColor = (r: string): string => REASON_COLORS[r] ?? "#475569";

function percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(((sorted.length - 1) * p) / 100));
    return sorted[idx]!;
}

function relPath(path: string): string {
    return path.replace(/^\/Users\/[^/]+\/Projects\//, "");
}

function shortHm(iso: string): string {
    return new Date(iso).toISOString().replace("T", " ").replace(/\..+/, " UTC");
}

function renderHtml(rows: readonly HookFireRow[]): string {
    const total = rows.length;
    const injects = rows.filter((r) => r.inject);
    const dedups = rows.filter((r) => r.reason === "session_already_injected");
    const latencies = rows.map((r) => r.latency_ms);
    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    const p99 = percentile(latencies, 99);

    const reasonCounts = new Map<string, number>();
    for (const r of rows) reasonCounts.set(r.reason, (reasonCounts.get(r.reason) ?? 0) + 1);
    const reasonRows = Array.from(reasonCounts.entries()).sort((a, b) => b[1] - a[1]);

    const harnessCounts = new Map<string, number>();
    for (const r of rows) harnessCounts.set(r.harness, (harnessCounts.get(r.harness) ?? 0) + 1);

    const eventCounts = new Map<string, number>();
    for (const r of rows) eventCounts.set(r.event, (eventCounts.get(r.event) ?? 0) + 1);

    const recentInjects = injects.slice(-30).reverse();

    const fileCounts = new Map<string, { total: number; injects: number }>();
    for (const r of rows) {
        const e = fileCounts.get(r.file_path) ?? { total: 0, injects: 0 };
        e.total += 1;
        if (r.inject) e.injects += 1;
        fileCounts.set(r.file_path, e);
    }
    const topFiles = Array.from(fileCounts.entries())
        .sort((a, b) => b[1].total - a[1].total)
        .slice(0, 20);

    const now = Date.now();
    const hourBuckets = new Array<{ label: string; n: number; injects: number }>(24)
        .fill(null as never)
        .map((_, i) => {
            const ts = new Date(now - (23 - i) * 3_600_000);
            return { label: ts.toISOString().slice(11, 13), n: 0, injects: 0 };
        });
    for (const r of rows) {
        const age = now - new Date(r.ts).getTime();
        const hourIdx = 23 - Math.floor(age / 3_600_000);
        if (hourIdx >= 0 && hourIdx < 24) {
            hourBuckets[hourIdx]!.n += 1;
            if (r.inject) hourBuckets[hourIdx]!.injects += 1;
        }
    }
    const maxHour = Math.max(1, ...hourBuckets.map((b) => b.n));

    const css = `
        body { font: 13px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro", system-ui, sans-serif; margin: 24px; max-width: 1200px; color: #0f172a; background: #fafafa; }
        h1 { font-size: 20px; margin: 0 0 4px; }
        h2 { font-size: 14px; margin: 24px 0 8px; color: #475569; text-transform: uppercase; letter-spacing: 0.04em; }
        .subtle { color: #64748b; }
        .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 12px 0 8px; }
        .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 14px; }
        .card .label { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.06em; }
        .card .value { font-size: 22px; font-weight: 600; margin-top: 4px; }
        table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }
        th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
        th { font-weight: 600; color: #475569; background: #f8fafc; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
        tr:last-child td { border-bottom: 0; }
        td.code { font-family: ui-monospace, SF Mono, monospace; font-size: 12px; }
        td.title { font-style: italic; color: #334155; max-width: 480px; }
        .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; color: #fff; font-weight: 600; }
        .bar-row { display: grid; grid-template-columns: 220px 1fr 80px; gap: 10px; align-items: center; padding: 4px 0; }
        .bar { background: #e2e8f0; border-radius: 4px; height: 12px; position: relative; overflow: hidden; }
        .bar > span { display: block; height: 100%; }
        .hour-grid { display: grid; grid-template-columns: repeat(24, 1fr); gap: 2px; margin-top: 6px; align-items: end; height: 60px; }
        .hour-col { background: #cbd5e1; border-radius: 2px; position: relative; }
        .hour-col .inj { background: ${reasonColor("high_signal")}; position: absolute; bottom: 0; left: 0; right: 0; }
        .hour-labels { display: grid; grid-template-columns: repeat(24, 1fr); gap: 2px; margin-top: 4px; font-size: 9px; color: #94a3b8; text-align: center; }
    `;

    const reasonRowsHtml = reasonRows.map(([reason, n]) => {
        const pct = (n / total) * 100;
        return `
            <div class="bar-row">
                <div><span class="pill" style="background:${reasonColor(reason)}">${escapeHtml(reason)}</span></div>
                <div class="bar"><span style="width:${pct.toFixed(1)}%;background:${reasonColor(reason)}"></span></div>
                <div class="subtle">${n} (${pct.toFixed(1)}%)</div>
            </div>
        `;
    }).join("");

    const recentInjectsHtml = recentInjects.length === 0
        ? `<tr><td colspan="3" class="subtle">No injects in the captured window.</td></tr>`
        : recentInjects.map((r) => `
            <tr>
                <td class="code">${shortHm(r.ts)}</td>
                <td class="code">${escapeHtml(relPath(r.file_path))}</td>
                <td class="title">${r.injected_titles.length === 0 ? '<span class="subtle">(no title)</span>' : r.injected_titles.map((t) => `"${escapeHtml(t)}"`).join(" <br> ")}</td>
            </tr>
        `).join("");

    const topFilesHtml = topFiles.map(([path, c]) => `
        <tr>
            <td class="code">${escapeHtml(relPath(path))}</td>
            <td>${c.total}</td>
            <td>${c.injects} (${((c.injects / c.total) * 100).toFixed(0)}%)</td>
        </tr>
    `).join("");

    const hourColsHtml = hourBuckets.map((b) => {
        const h = (b.n / maxHour) * 100;
        const inj = (b.injects / Math.max(1, b.n)) * h;
        return `<div class="hour-col" style="height:${h}%;" title="${b.label}h: ${b.n} fires, ${b.injects} injects"><div class="inj" style="height:${(inj / Math.max(0.01, h)) * 100}%"></div></div>`;
    }).join("");
    const hourLabelsHtml = hourBuckets.map((b) => `<div>${b.label}</div>`).join("");

    const reasonCountsHtml = reasonRows
        .map(([r, n]) => `${escapeHtml(r)}=${n}`)
        .join(" · ");
    const harnessHtml = Array.from(harnessCounts.entries())
        .map(([h, n]) => `${escapeHtml(h)}=${n}`).join(" · ");
    const eventHtml = Array.from(eventCounts.entries())
        .map(([e, n]) => `${escapeHtml(e)}=${n}`).join(" · ");

    const injectRate = total > 0 ? (injects.length / total) * 100 : 0;
    const dedupRate = injects.length + dedups.length > 0
        ? (dedups.length / (injects.length + dedups.length)) * 100
        : 0;

    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>ax hook_fire report</title>
    <style>${css}</style>
</head>
<body>
    <h1>ax hook_fire report</h1>
    <div class="subtle">Generated ${escapeHtml(new Date().toISOString())} · ${total} fires</div>

    <div class="cards">
        <div class="card"><div class="label">Total fires</div><div class="value">${total}</div></div>
        <div class="card"><div class="label">Injects</div><div class="value">${injects.length} <span class="subtle" style="font-size:13px;font-weight:400">(${injectRate.toFixed(1)}%)</span></div></div>
        <div class="card"><div class="label">Dedup hits</div><div class="value">${dedups.length} <span class="subtle" style="font-size:13px;font-weight:400">(${dedupRate.toFixed(1)}% of would-inject)</span></div></div>
        <div class="card"><div class="label">Latency p50 / p95 / p99</div><div class="value" style="font-size:16px">${p50}ms / ${p95}ms / ${p99}ms</div></div>
    </div>

    <h2>Distribution by reason</h2>
    ${reasonRowsHtml}

    <h2>Hourly volume (last 24h, green = injects)</h2>
    <div class="hour-grid">${hourColsHtml}</div>
    <div class="hour-labels">${hourLabelsHtml}</div>

    <h2>Recent injects (top 30, most recent first)</h2>
    <table>
        <thead><tr><th>ts</th><th>file</th><th>injected title(s)</th></tr></thead>
        <tbody>${recentInjectsHtml}</tbody>
    </table>

    <h2>Top files by fire count</h2>
    <table>
        <thead><tr><th>file</th><th>fires</th><th>injects</th></tr></thead>
        <tbody>${topFilesHtml}</tbody>
    </table>

    <h2>Raw counts</h2>
    <div class="subtle code" style="font-size:12px">
        reasons: ${reasonCountsHtml}<br>
        harness: ${harnessHtml}<br>
        event:   ${eventHtml}
    </div>
</body>
</html>`;
}

const program = Effect.gen(function* () {
    const db = yield* SurrealClient;
    const [rows] = yield* db.query<[
        Array<{
            id: string;
            ts: string;
            harness: string;
            event: string;
            file_path: string;
            inject: boolean;
            reason: string;
            latency_ms: number;
            injected_titles: string[] | null;
        }>
    ]>(`
        SELECT
            <string>id AS id,
            <string>ts AS ts,
            harness, event, file_path, inject, reason, latency_ms,
            injected_titles
        FROM hook_fire
        ORDER BY ts ASC;
    `);

    const normalized: HookFireRow[] = rows.map((r) => ({
        ...r,
        injected_titles: r.injected_titles ?? [],
    }));

    const outPath = resolve(process.argv[2] ?? "dogfood-output/ax-hook-report.html");
    yield* Effect.promise(async () => {
        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(outPath, renderHtml(normalized), "utf8");
    });
    console.log(`wrote ${normalized.length} fires -> ${outPath}`);
});

const AppLayer = SurrealClientLive.pipe(Layer.provide(AxConfigLive));
await Effect.runPromise(program.pipe(Effect.provide(AppLayer), Effect.scoped));
