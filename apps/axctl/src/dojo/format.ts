/**
 * ax dojo - human-readable agenda renderer.
 * Spec: docs/superpowers/specs/2026-06-13-ax-dojo-design.md
 */
import type { DojoAgenda } from "./schema.ts";

/** Human label for a binding window - the single source for both the agenda
 *  and the dojo report budget lines. */
export const windowLabel = (w: DojoAgenda["budget"]["binding_window"]): string =>
    w === "five_hour" ? "5h window" : w === "seven_day" ? "7d window" : "no window";

export const renderAgenda = (agenda: DojoAgenda): string => {
    const b = agenda.budget;
    const lines: string[] = [];
    lines.push(
        `budget: ${b.spendable_pct}% spendable (${windowLabel(b.binding_window)}, ` +
        `${b.window_remaining_pct}% left, ${b.reserve_pct}% reserve) - ` +
        `deadline ${b.deadline.slice(0, 16)} [${b.source}]`,
    );
    if (!b.has_surplus) {
        lines.push("no surplus in the current window - dojo will not start without --force");
    }
    if (agenda.source_failures.length > 0) {
        lines.push(`degraded sources: ${agenda.source_failures.map((f) => f.source).join(", ")}`);
    }
    lines.push("");
    agenda.items.forEach((item, i) => {
        lines.push(`${i + 1}. [${item.kind}/${item.cost_class}] ${item.title}`);
        for (const cmd of item.commands) lines.push(`   $ ${cmd}`);
        lines.push(`   done when: ${item.success}`);
    });
    return lines.join("\n");
};
