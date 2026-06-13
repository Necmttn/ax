import type { QuotaSnapshot } from "../quota/schema.ts";
import type { BindingWindow, BudgetEnvelope } from "./schema.ts";

export const DEFAULT_RESERVE_PCT = 15;

/** Forced training window when quota is unreachable: 2 hours from now. */
export const FORCED_FALLBACK_WINDOW_MS = 2 * 60 * 60 * 1000;

export interface BudgetOptions {
    /** keep this many percentage points untouched (default 15) */
    readonly reservePct?: number;
    /** --budget=N : spend at most N points, replaces reserve math */
    readonly budgetPctOverride?: number | null;
    /** --until resolved to ISO by the CLI layer */
    readonly untilIso?: string | null;
    /** --force : dojo with no surplus */
    readonly force?: boolean;
}

export const computeBudgetEnvelope = (
    snapshot: QuotaSnapshot | null,
    opts: BudgetOptions,
    nowMs: number,
): BudgetEnvelope => {
    const reserve = opts.reservePct ?? DEFAULT_RESERVE_PCT;

    const windows: Array<{ name: BindingWindow; remaining: number; resetsAt: string }> = [];
    if (snapshot?.five_hour) {
        windows.push({
            name: "five_hour",
            remaining: Math.max(0, 100 - snapshot.five_hour.utilization),
            resetsAt: snapshot.five_hour.resets_at,
        });
    }
    if (snapshot?.seven_day) {
        windows.push({
            name: "seven_day",
            remaining: Math.max(0, 100 - snapshot.seven_day.utilization),
            resetsAt: snapshot.seven_day.resets_at,
        });
    }

    if (windows.length === 0) {
        return {
            has_surplus: opts.force === true,
            spendable_pct: 0,
            binding_window: null,
            window_remaining_pct: 0,
            reserve_pct: reserve,
            deadline: opts.untilIso
                ?? new Date(opts.force === true ? nowMs + FORCED_FALLBACK_WINDOW_MS : nowMs).toISOString(),
            source: opts.force === true ? "forced" : "unavailable",
        };
    }

    const binding = windows.reduce((min, w) => (w.remaining < min.remaining ? w : min));
    const earliestReset = windows.reduce((min, w) =>
        Date.parse(w.resetsAt) < Date.parse(min.resetsAt) ? w : min,
    ).resetsAt;

    const fromReserve = Math.max(0, binding.remaining - reserve);
    const overridden = opts.budgetPctOverride != null
        ? Math.min(opts.budgetPctOverride, binding.remaining)
        : null;
    let spendable = overridden ?? fromReserve;
    let source: BudgetEnvelope["source"] = overridden != null ? "override" : "quota";

    if (spendable <= 0 && opts.force === true) {
        spendable = Math.max(1, binding.remaining);
        source = "forced";
    }

    return {
        has_surplus: spendable > 0,
        spendable_pct: spendable,
        binding_window: binding.name,
        window_remaining_pct: binding.remaining,
        reserve_pct: reserve,
        deadline: opts.untilIso ?? earliestReset,
        source,
    };
};
