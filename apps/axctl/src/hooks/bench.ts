/**
 * ax hooks bench - hook latency ledger.
 *
 * Pure cores (this file's top section) are unit-tested; Effect glue (subprocess
 * spawn timing, graph queries, installed-hook chain) is tested with fakes + a
 * live CLI smoke. Built incrementally across the hooks-bench plan tasks.
 */

import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { surrealDate, surrealString } from "@ax/lib/shared/surql";

export interface PerFireStats {
    readonly p50: number; readonly p95: number;
    readonly min: number; readonly max: number; readonly mean: number;
}
export interface ChainSummary {
    readonly event: string;
    readonly beforeMs: number; readonly withMs: number;
    readonly budgetMs: number; readonly overBudget: boolean;
    readonly hooks: readonly string[];
}
export interface BenchLedger {
    readonly name: string;
    readonly perFire: PerFireStats;
    readonly warmupMs: number | null;
    readonly spawns: number;
    readonly logicMs: number | null;
    readonly frequency: { readonly perDay: number | null; readonly matched: readonly string[]; readonly basis: string };
    readonly dailyCostMs: number | null;
    readonly chain: ChainSummary | null;
}
export interface HookMetaLite {
    readonly name: string;
    readonly events: readonly string[];
    readonly matcher?: { readonly tools?: readonly string[] } | undefined;
}

const round = (n: number) => Math.round(n);

/** Nearest-rank percentiles over wall-time samples (ms). Empty -> zeros. */
export const percentiles = (samples: readonly number[]): PerFireStats => {
    if (samples.length === 0) return { p50: 0, p95: 0, min: 0, max: 0, mean: 0 };
    const s = [...samples].sort((a, b) => a - b);
    const at = (q: number) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] ?? 0;
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    return { min: round(s[0] ?? 0), max: round(s[s.length - 1] ?? 0), p50: round(at(0.5)), p95: round(at(0.95)), mean: round(mean) };
};

/** Raw harness stdin payload that decodeHookInput accepts. */
export const buildRepresentativePayload = (
    meta: HookMetaLite,
    sampleInput: Record<string, unknown> | null,
    cwd: string,
): string => {
    const event = meta.events[0] ?? "PreToolUse";
    const firstTool = meta.matcher?.tools?.[0];
    const payload: Record<string, unknown> = { hook_event_name: event, cwd };
    if (firstTool) {
        payload.tool_name = firstTool;
        payload.tool_input = sampleInput ?? {};
    }
    return JSON.stringify(payload);
};

export const renderLedger = (l: BenchLedger): string => {
    const lines: string[] = [`hook: ${l.name}`];
    const warm = l.warmupMs != null ? `, 1 warmup ${l.warmupMs}ms` : "";
    const logic = l.logicMs != null ? ` · logic ${l.logicMs}ms` : "";
    lines.push(`per-fire:      p50 ${l.perFire.p50}ms · p95 ${l.perFire.p95}ms · (${l.spawns} spawns${warm})${logic}`);
    if (l.frequency.perDay == null) {
        lines.push(`fires/day:     n/a  (${l.frequency.basis})`);
    } else {
        lines.push(`fires/day:     ~${l.frequency.perDay}  (${l.frequency.matched.join(",")} via ${l.frequency.basis})`);
        if (l.dailyCostMs != null) lines.push(`daily cost:    ~${(l.dailyCostMs / 1000).toFixed(1)} s/day`);
    }
    if (l.chain) {
        const warn = l.chain.overBudget ? `  ⚠ over ${l.chain.budgetMs}ms budget` : ` (under ${l.chain.budgetMs}ms budget)`;
        lines.push(`chain (${l.chain.event}): ${l.chain.beforeMs}ms -> ${l.chain.withMs}ms with this${warn}`);
    }
    return lines.join("\n");
};

// ---------------------------------------------------------------------------
// Effect glue: fire-frequency query + subprocess spawn timing
// ---------------------------------------------------------------------------

export interface FireFrequency {
    readonly perDay: number | null;
    readonly matched: readonly string[];
    readonly basis: string;
}

/**
 * Estimate fires/day for a tool-matching hook: COUNT tool_call rows whose
 * `name` is in the hook's matched tools over the last `days`, divided by days.
 * Non-tool hooks (no matched tools) have no tool_call basis -> perDay null.
 *
 * Datetime cutoff inlined via `surrealDate` (SurrealClient.query takes no
 * bindings; same pattern as report-queries.ts). Count idiom: top-level
 * `count() AS total ... GROUP ALL` (mirrors wrapped.ts / recall.ts; the repo
 * memory note that count needs GROUP ALL).
 */
export const estFiresPerDay = (
    tools: readonly string[],
    days: number,
): Effect.Effect<FireFrequency, DbError, SurrealClient> =>
    Effect.gen(function* () {
        if (tools.length === 0) return { perDay: null, matched: [], basis: "n/a" };
        const db = yield* SurrealClient;
        // Guard days so days=0 can't divide to Infinity.
        const window = Math.max(1, days);
        const since = new Date(Date.now() - window * 86_400_000);
        const list = tools.map((t) => surrealString(t)).join(", ");
        const r = yield* db.query<[Array<{ total: number }>]>(
            `SELECT count() AS total FROM tool_call WHERE name IN [${list}] AND ts > ${surrealDate(since)} GROUP ALL;`,
        );
        const total = r?.[0]?.[0]?.total ?? 0;
        return { perDay: Math.round(total / window), matched: [...tools], basis: `tool_call/${window}d` };
    });

/**
 * Per-spawn deadline (ms). Hooks have a 10s harness limit, so 15s is a safe
 * ceiling: a hook that blows past it is misbehaving/hanging and we kill it
 * rather than stall the bench forever. The deadline value is recorded as the
 * sample so percentiles still reflect the timeout cost.
 */
const SPAWN_DEADLINE_MS = 15_000;

/**
 * Spawn `bun <absFile>` feeding `payload` on stdin, `runs` times (capped 1-100),
 * timing each invocation with `performance.now()`. Returns all wall-time samples
 * (ms). Each spawn is bounded by SPAWN_DEADLINE_MS: a hanging hook is killed and
 * the deadline recorded as its sample (no leaked process). Covered by the live
 * CLI smoke (Task 3), not a unit test - spawning bun in unit tests is slow/flaky.
 */
export const measureSpawn = (
    absFile: string,
    payload: string,
    runs: number,
): Effect.Effect<number[]> =>
    Effect.promise(async () => {
        const samples: number[] = [];
        const n = Math.min(100, Math.max(1, runs));
        for (let i = 0; i < n; i++) {
            const t0 = performance.now();
            const proc = Bun.spawn(["bun", absFile], {
                stdin: new TextEncoder().encode(payload),
                stdout: "ignore",
                stderr: "ignore",
            });
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timedOut = await Promise.race([
                proc.exited.then(() => false),
                new Promise<boolean>((resolve) => {
                    timer = setTimeout(() => resolve(true), SPAWN_DEADLINE_MS);
                }),
            ]);
            if (timer !== undefined) clearTimeout(timer);
            if (timedOut) {
                // Kill the hanging process and record the deadline as the cost.
                proc.kill();
                samples.push(SPAWN_DEADLINE_MS);
            } else {
                samples.push(performance.now() - t0);
            }
        }
        return samples;
    });
