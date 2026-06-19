/**
 * Pure compute for `ax routing impact` - the routing-off vs routing-on receipt,
 * measured per 5-hour plan window (issue #575).
 *
 * On a fixed plan the unit that matters is the 5h rate-limit window, not dollars
 * (you don't pay per token). We capture an `ax quota` snapshot at the start and
 * end of each work block and diff the 5h-window utilization. Token-equiv $ and
 * the dispatch inherit rate ride along as secondary evidence.
 *
 * Correctness trap: the 5h window RESETS every 5h. If a block straddles a reset,
 * `end.utilization < start.utilization` (or `resets_at` changed) and the delta is
 * not a clean single-window consumption - we flag it `windowReset` and fall back
 * to token-$ rather than printing a bogus/negative number.
 *
 * No DB, no Effect here - just data in, card out, so it's exhaustively testable.
 */

export type Arm = "off" | "on";

/** A captured window edge: utilization (0-100, matching the quota endpoint) +
 *  the reset boundary it belongs to. */
export interface WindowEdge {
    readonly utilization: number;
    readonly resets_at: string;
}

/** One completed work block (filled in by begin/end against the state file). */
export interface BlockInput {
    readonly arm: Arm;
    readonly label?: string | undefined;
    readonly started_at: string;
    readonly ended_at: string;
    /** 5h-window edge at block start / end (null if quota was unavailable). */
    readonly fiveHourStart: WindowEdge | null;
    readonly fiveHourEnd: WindowEdge | null;
    /** Token-equivalent cost summed over the block window (USD). */
    readonly tokenCostUsd: number;
    /** Subagent dispatches that started in the block window. */
    readonly dispatchCount: number;
    /** Of those, how many ran on an inherited (unrouted) model. */
    readonly inheritCount: number;
    /** Work-volume proxy: assistant turns in the block window. */
    readonly turns: number;
}

export interface BlockResult {
    readonly arm: Arm;
    readonly label?: string | undefined;
    readonly durationMin: number;
    /** Percentage POINTS of the 5h window consumed (end-start, ×100). Null when
     *  quota was missing or the window reset mid-block (see windowReset). */
    readonly fiveHourPpConsumed: number | null;
    readonly windowReset: boolean;
    readonly tokenCostUsd: number;
    readonly inheritPct: number | null;
    readonly dispatchCount: number;
    readonly turns: number;
    /** Work per percentage-point of 5h window (turns / pp). Null when pp is
     *  unavailable or zero. The normalizer for "more work per window". */
    readonly workPerWindowPp: number | null;
}

export interface ImpactReport {
    readonly blocks: ReadonlyArray<BlockResult>;
    /** Present only when exactly one off and one on block are complete. */
    readonly comparison: {
        /** on.workPerWindowPp / off.workPerWindowPp - the "1.Nx more work per
         *  window" headline. Null when either side lacks a clean window delta. */
        readonly workPerWindowRatio: number | null;
        /** off.tokenCostUsd / on.tokenCostUsd (token-equiv $ saved factor). */
        readonly costRatio: number | null;
        /** inherit-rate change in points (off - on); positive = routing helped. */
        readonly inheritPctDrop: number | null;
    } | null;
    readonly notes: ReadonlyArray<string>;
}

const minutesBetween = (a: string, b: string): number =>
    Math.max(0, (new Date(b).getTime() - new Date(a).getTime()) / 60_000);

const round = (n: number, dp = 2): number => {
    const f = 10 ** dp;
    return Math.round(n * f) / f;
};

/** Did the 5h window roll over between the two edges? */
const didReset = (start: WindowEdge, end: WindowEdge): boolean =>
    end.resets_at !== start.resets_at || end.utilization < start.utilization;

const resolveBlock = (b: BlockInput): BlockResult => {
    const durationMin = round(minutesBetween(b.started_at, b.ended_at), 1);

    let fiveHourPpConsumed: number | null = null;
    let windowReset = false;
    if (b.fiveHourStart && b.fiveHourEnd) {
        if (didReset(b.fiveHourStart, b.fiveHourEnd)) {
            windowReset = true;
        } else {
            // utilization is already 0-100, so the delta is already in points.
            fiveHourPpConsumed = round(b.fiveHourEnd.utilization - b.fiveHourStart.utilization, 2);
        }
    }

    const inheritPct = b.dispatchCount > 0 ? round((b.inheritCount / b.dispatchCount) * 100, 1) : null;

    const workPerWindowPp =
        fiveHourPpConsumed !== null && fiveHourPpConsumed > 0
            ? round(b.turns / fiveHourPpConsumed, 2)
            : null;

    return {
        arm: b.arm,
        label: b.label,
        durationMin,
        fiveHourPpConsumed,
        windowReset,
        tokenCostUsd: round(b.tokenCostUsd, 2),
        inheritPct,
        dispatchCount: b.dispatchCount,
        turns: b.turns,
        workPerWindowPp,
    };
};

/** Build the off-vs-on impact report from completed blocks. Pure. */
export const buildImpactReport = (blocks: ReadonlyArray<BlockInput>): ImpactReport => {
    const results = blocks.map(resolveBlock);
    const notes: string[] = [];

    if (results.some((r) => r.windowReset)) {
        notes.push(
            "a block straddled a 5h-window reset - its window delta is omitted; compare token-$ instead.",
        );
    }
    if (results.some((r) => r.fiveHourPpConsumed === null && !r.windowReset)) {
        notes.push("quota was unavailable for a block - window delta omitted for it.");
    }

    // Comparison only when we have exactly one clean off and one clean on block.
    const off = results.filter((r) => r.arm === "off");
    const on = results.filter((r) => r.arm === "on");
    let comparison: ImpactReport["comparison"] = null;
    if (off.length === 1 && on.length === 1) {
        const o = off[0]!;
        const n = on[0]!;
        comparison = {
            workPerWindowRatio:
                o.workPerWindowPp !== null && n.workPerWindowPp !== null && o.workPerWindowPp > 0
                    ? round(n.workPerWindowPp / o.workPerWindowPp, 2)
                    : null,
            costRatio: n.tokenCostUsd > 0 ? round(o.tokenCostUsd / n.tokenCostUsd, 2) : null,
            inheritPctDrop:
                o.inheritPct !== null && n.inheritPct !== null
                    ? round(o.inheritPct - n.inheritPct, 1)
                    : null,
        };
        notes.push("matched work across the two blocks is your responsibility - the ratio assumes it.");
    } else if (off.length > 1 || on.length > 1) {
        notes.push("multiple blocks per arm - showing each; comparison needs exactly one off + one on.");
    }

    return { blocks: results, comparison, notes };
};
