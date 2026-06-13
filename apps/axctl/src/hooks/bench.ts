/**
 * ax hooks bench - hook latency ledger.
 *
 * Pure cores (this file's top section) are unit-tested; Effect glue (subprocess
 * spawn timing, graph queries, installed-hook chain) is tested with fakes + a
 * live CLI smoke. Built incrementally across the hooks-bench plan tasks.
 */

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
