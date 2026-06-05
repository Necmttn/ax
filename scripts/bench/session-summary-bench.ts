#!/usr/bin/env bun
/**
 * Golden benchmark for the canvas detail path (`/api/session-summary`).
 *
 * The detail card MUST stay fast: it is DB-only and must never regress back to
 * the transcript-walking `/inspect` path (which can take 20-60s). This bench
 * samples sessions stratified by size, times the summary endpoint, and FAILS
 * (exit 1) if the slowest call exceeds the gold threshold.
 *
 *   bun scripts/bench/session-summary-bench.ts
 *   AX_BENCH_URL=http://localhost:1738 GOLD_MS=1500 bun scripts/bench/session-summary-bench.ts
 *
 * Wire into CI / `ax doctor` as a perf gate.
 */
import { Surreal } from "surrealdb";

const URL = process.env.AX_BENCH_URL ?? "http://localhost:1839";
const GOLD_MS = Number(process.env.GOLD_MS ?? 1500);   // max single-call budget
const GOLD_P50_MS = Number(process.env.GOLD_P50_MS ?? 400);

const db = new Surreal();
await db.connect("ws://127.0.0.1:8521");
await db.signin({ username: "root", password: "root" });
await db.use({ namespace: "ax", database: "main" });
const q = async (s: string) => (await db.query(s))[0] as Array<Record<string, unknown>>;

// size-stratified sample: biggest, p99, p95, p50, smallest, + random spread
const sizes = await q(
    `SELECT <string>session AS s, count() AS n FROM turn WHERE role IN ['user','assistant'] GROUP BY s ORDER BY n DESC`,
);
await db.close();
if (sizes.length === 0) { console.error("no sessions"); process.exit(2); }
const at = (p: number) => sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * p))]!;
const sample = new Map<string, { s: string; n: number }>();
for (const [tag, row] of [
    ["max", sizes[0]!], ["p99", at(0.01)], ["p95", at(0.05)], ["p50", at(0.5)], ["min", sizes[sizes.length - 1]!],
] as const) sample.set(tag, { s: String(row.s), n: Number(row.n) });
// a few random ones for spread
for (let i = 0; i < 8; i++) { const r = sizes[Math.floor((i + 1) / 9 * sizes.length)]!; sample.set(`r${i}`, { s: String(r.s), n: Number(r.n) }); }

const times: number[] = [];
const rows: Array<{ tag: string; n: number; ms: number; ok: boolean; note: string }> = [];
for (const [tag, { s, n }] of sample) {
    const enc = encodeURIComponent(s);
    const t0 = performance.now();
    const res = await fetch(`${URL}/api/session-summary?id=${enc}`);
    const ms = +(performance.now() - t0).toFixed(1);
    const body = (await res.json()) as { error?: string; turns?: number; task?: string | null };
    times.push(ms);
    rows.push({ tag, n, ms, ok: res.ok && !body.error, note: body.error ?? `${body.turns ?? "?"}t · ${(body.task ?? "").slice(0, 32)}` });
}

times.sort((a, b) => a - b);
const p = (q: number) => times[Math.min(times.length - 1, Math.floor(times.length * q))]!;
const max = times[times.length - 1]!;
const p50 = p(0.5);

console.log(`\nsession-summary bench · ${URL} · n=${rows.length}`);
console.log("  tag    turns      ms   note");
for (const r of rows.sort((a, b) => b.ms - a.ms)) {
    console.log(`  ${r.tag.padEnd(5)} ${String(r.n).padStart(6)} ${String(r.ms).padStart(8)}  ${r.ok ? "" : "ERR "}${r.note}`);
}
console.log(`\n  p50 ${p50}ms   p95 ${p(0.95)}ms   max ${max}ms`);

const errors = rows.filter((r) => !r.ok);
let failed = false;
if (errors.length) { console.error(`\nFAIL: ${errors.length} request(s) errored`); failed = true; }
if (max > GOLD_MS) { console.error(`\nFAIL: max ${max}ms > gold ${GOLD_MS}ms`); failed = true; }
if (p50 > GOLD_P50_MS) { console.error(`\nFAIL: p50 ${p50}ms > gold ${GOLD_P50_MS}ms`); failed = true; }
if (failed) process.exit(1);
console.log(`\nPASS · all ≤ gold (max ${GOLD_MS}ms, p50 ${GOLD_P50_MS}ms)`);
