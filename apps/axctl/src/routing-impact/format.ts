/**
 * Render the `ax routing impact` receipt - the routing-off vs routing-on card,
 * headlined on 5h plan-window utilization. Pure string-building, so it's tested
 * without IO. The shareable text card carries the ax attribution plug.
 */
import { withAxAttribution } from "@ax/lib/shared/attribution";
import type { ImpactReport, BlockResult } from "./compute.ts";

const armLabel = (b: BlockResult): string =>
    `${b.arm === "off" ? "routing OFF" : "routing ON "}${b.label ? ` (${b.label})` : ""}`;

const pp = (n: number | null): string => (n === null ? "  -  " : `${n.toFixed(1)}pp`);
const pct = (n: number | null): string => (n === null ? " - " : `${n.toFixed(0)}%`);
const usd = (n: number): string => `$${n.toFixed(2)}`;

const blockLine = (b: BlockResult): string => {
    const win = b.windowReset ? "window reset" : pp(b.fiveHourPpConsumed);
    return [
        `  ${armLabel(b).padEnd(22)}`,
        `5h window: ${win.padStart(11)}`,
        `tokens: ${usd(b.tokenCostUsd).padStart(9)}`,
        `inherit: ${pct(b.inheritPct).padStart(4)}`,
        `turns: ${String(b.turns).padStart(4)}`,
    ].join("  ");
};

/** Human card. `share: true` appends the ax attribution plug (for posting). */
export const renderImpact = (report: ImpactReport, opts: { share?: boolean } = {}): string => {
    const lines: string[] = [];
    lines.push("routing impact - same work, routing off vs on (per 5h plan window)");
    lines.push("");
    if (report.blocks.length === 0) {
        lines.push("  no completed blocks yet.");
        lines.push("  run: ax routing impact begin --arm=off   (work a block)   ax routing impact end");
        lines.push("  then the same with --arm=on, then: ax routing impact report");
        return lines.join("\n");
    }

    for (const b of report.blocks) lines.push(blockLine(b));

    const c = report.comparison;
    if (c) {
        lines.push("");
        if (c.workPerWindowRatio !== null) {
            lines.push(
                `  ▸ ${c.workPerWindowRatio.toFixed(2)}× more work per 5h window with routing on`,
            );
        }
        if (c.costRatio !== null) {
            lines.push(`  ▸ ${c.costRatio.toFixed(2)}× cheaper in token-equiv $ (same work)`);
        }
        if (c.inheritPctDrop !== null) {
            lines.push(`  ▸ inherit (frontier) rate down ${c.inheritPctDrop.toFixed(0)} points`);
        }
    }

    if (report.notes.length > 0) {
        lines.push("");
        for (const n of report.notes) lines.push(`  note: ${n}`);
    }

    const out = lines.join("\n");
    return opts.share ? withAxAttribution(out) : out;
};
