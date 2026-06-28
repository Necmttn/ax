/**
 * Pure helpers behind the dossier "window" stacked-bar chart, the workflow
 * arcs, and the leverage-sorted rig. Kept out of the route component so the
 * non-trivial logic (stable model->colour assignment, per-day sub-1% merging,
 * arc display formatting, leverage sort) is unit-testable without React.
 *
 * Everything here is fed untrusted gist data; callers still render the result
 * as text only.
 */
import type { ProfileDailyRow, ProfileModel, ProfileSkill, WorkflowArc } from "@ax/lib/shared/community";

/**
 * Stable model -> colour assignment. The top model (by window share) is always
 * ax green; the rest follow an editorial ramp. "other" (the merged tail) is the
 * faint line colour. The same model name always maps to the same colour, so a
 * per-day segment and its legend chip agree.
 */
export const MODEL_RAMP: readonly string[] = [
    "var(--green)", // top model
    "#2567a8", // blue
    "#b08968", // tan
    "#8b6db0", // violet-muted
    "#c0392b", // red-muted
    "#6b6b66", // gray
];
export const OTHER_COLOR = "var(--line)";
export const OTHER_NAME = "other";

export interface ModelColor {
    readonly name: string;
    readonly color: string;
}

/**
 * Assign colours to models in window-share order. Models beyond the ramp length
 * collapse into a single "other" bucket sharing OTHER_COLOR. Returns an ordered
 * map (lookup) plus the ordered legend list.
 */
export function buildModelColors(models: readonly ProfileModel[]): {
    readonly colorOf: (name: string) => string;
    readonly order: readonly string[];
} {
    const sorted = [...models].sort((a, b) => b.share - a.share);
    const map = new Map<string, string>();
    const order: string[] = [];
    sorted.forEach((m, i) => {
        if (i < MODEL_RAMP.length) {
            map.set(m.name, MODEL_RAMP[i]!);
            order.push(m.name);
        } else {
            // tail collapses to a single "other" legend entry
            if (!order.includes(OTHER_NAME)) order.push(OTHER_NAME);
            map.set(m.name, OTHER_COLOR);
        }
    });
    return {
        colorOf: (name: string) => map.get(name) ?? OTHER_COLOR,
        order,
    };
}

export interface DaySegment {
    readonly name: string;
    readonly tokens: number;
    readonly color: string;
    readonly share: number; // of the day's total tokens
}
export interface DayColumn {
    readonly date: string;
    readonly sessions: number;
    readonly tokens: number;
    readonly tool_calls?: number;
    readonly commits?: number;
    readonly segments: readonly DaySegment[];
    /** column height as a share (0..1) of the busiest day's total tokens */
    readonly heightShare: number;
    readonly isPeak: boolean;
}

/**
 * Turn the daily rows into stacked columns. Within each day, models under
 * `minSegmentShare` of that day's tokens merge into a single "other" segment so
 * a 7-model day stays legible. Column height is scaled to the max daily tokens
 * across the window. Segments are colour-keyed by the window-level assignment
 * so a model is the same colour everywhere.
 */
export function buildDayColumns(
    daily: readonly ProfileDailyRow[],
    colorOf: (name: string) => string,
    opts: { readonly peakDate?: string; readonly minSegmentShare?: number } = {},
): readonly DayColumn[] {
    const minShare = opts.minSegmentShare ?? 0.01;
    const maxTokens = daily.reduce((m, d) => Math.max(m, d.tokens), 0);
    return daily.map((d) => {
        const total = d.tokens;
        let segments: DaySegment[] = [];
        if (d.models && d.models.length > 0 && total > 0) {
            const big: DaySegment[] = [];
            let otherTokens = 0;
            // group identical names (defensive) and split big vs tail
            const byName = new Map<string, number>();
            for (const m of d.models) byName.set(m.name, (byName.get(m.name) ?? 0) + m.tokens);
            const rows = [...byName.entries()].sort((a, b) => b[1] - a[1]);
            for (const [name, tokens] of rows) {
                const share = tokens / total;
                if (share >= minShare && colorOf(name) !== OTHER_COLOR) {
                    big.push({ name, tokens, color: colorOf(name), share });
                } else {
                    otherTokens += tokens;
                }
            }
            // keep big segments in the window colour order (already share-sorted
            // here, which is close enough and reads as a clean ramp per day)
            segments = big;
            if (otherTokens > 0) {
                segments.push({
                    name: OTHER_NAME,
                    tokens: otherTokens,
                    color: OTHER_COLOR,
                    share: otherTokens / total,
                });
            }
        } else if (total > 0) {
            // no per-model breakdown: one neutral column
            segments = [{ name: OTHER_NAME, tokens: total, color: OTHER_COLOR, share: 1 }];
        }
        return {
            date: d.date,
            sessions: d.sessions,
            tokens: d.tokens,
            tool_calls: d.tool_calls,
            commits: d.commits,
            segments,
            heightShare: maxTokens > 0 ? d.tokens / maxTokens : 0,
            isPeak: opts.peakDate !== undefined && d.date === opts.peakDate,
        };
    });
}

/** Known plugin/skill namespaces stripped for display (full name kept in title). */
const SKILL_PREFIXES = ["superpowers:", "caveman:", "lazyweb:", "codex:", "brand:"];

/** "superpowers:writing-plans" -> "writing-plans" for display. */
export function stripSkillPrefix(name: string): string {
    for (const p of SKILL_PREFIXES) {
        if (name.startsWith(p)) return name.slice(p.length);
    }
    // generic "ns:thing" fallback
    const colon = name.indexOf(":");
    return colon > 0 ? name.slice(colon + 1) : name;
}

export interface DisplayArc {
    readonly steps: readonly { readonly display: string; readonly full: string }[];
    readonly count: number;
}

/** Strongest arcs first, capped, with display/full step pairs. */
export function buildDisplayArcs(arcs: readonly WorkflowArc[], limit = 5): readonly DisplayArc[] {
    return [...arcs]
        .filter((a) => a.steps.length > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, limit)
        .map((a) => ({
            count: a.count,
            steps: a.steps.map((s) => ({ display: stripSkillPrefix(s), full: s })),
        }));
}

/**
 * Sort skills within a group by leverage (downstream_share) DESC; rows missing
 * a share sort last, then by runs DESC. Stable on name for determinism.
 */
export function sortSkillsByLeverage(skills: readonly ProfileSkill[]): readonly ProfileSkill[] {
    return [...skills].sort((a, b) => {
        const as = a.downstream_share;
        const bs = b.downstream_share;
        if (as !== undefined && bs !== undefined && as !== bs) return bs - as;
        if (as !== undefined && bs === undefined) return -1;
        if (as === undefined && bs !== undefined) return 1;
        if (a.runs !== b.runs) return b.runs - a.runs;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
}
