/**
 * L2 segmentation + L1 importance capping. Turns the flat event stream into
 * phases (segments) bounded by LLM-free signals - commits, user asks,
 * compactions, large time-gaps - then ranks events within each segment and caps
 * them so a 45k-turn loop reads as ~its iterations, each drillable, instead of
 * thousands of rows. Segment rollups keep the FULL counts so nothing is hidden.
 * Pure - unit-testable with plain fixtures.
 */
import type {
    SegmentBoundary,
    TimelineEvent,
    TimelineEventKind,
    TimelineSegment,
} from "./types.ts";
import type { AskRow, CommitRow, CompactionRow } from "./queries.ts";

export const MAX_SEGMENTS = 30;
export const PER_SEGMENT_CAP = 25;
export const GLOBAL_BUDGET = 300;
const TIME_GAP_MS = 30 * 60 * 1000;

const KIND_WEIGHT: Record<TimelineEventKind, number> = {
    outcome: 100, failure: 90, decision: 80, checkpoint: 75,
    correction: 70, skill_invocation: 55, file_edit: 45, tool_call: 30,
};

const tsValue = (ts: string | null): number => {
    if (!ts) return Number.POSITIVE_INFINITY;
    const t = new Date(ts).getTime();
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
};
const firstLine = (s: string | null | undefined): string =>
    (s ?? "").split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

interface Boundary {
    readonly ts: string;
    readonly seq: number | null;
    readonly kind: SegmentBoundary;
    readonly label: string;
}

export interface SegmentInputs {
    readonly asks: ReadonlyArray<AskRow>;
    readonly commits: ReadonlyArray<CommitRow>;
    readonly compactions: ReadonlyArray<CompactionRow>;
}

/** Collect every boundary signal, ts-sorted, with a session_start anchor. */
export function buildBoundaries(input: SegmentInputs, firstTs: string | null): Boundary[] {
    const bs: Boundary[] = [];
    for (const a of input.asks) {
        if (a.ts) bs.push({ ts: a.ts, seq: a.seq, kind: "ask", label: clip(firstLine(a.text) || "user ask", 100) });
    }
    for (const c of input.commits) {
        if (c.ts) bs.push({ ts: c.ts, seq: null, kind: "commit", label: clip(`committed${c.sha ? ` ${c.sha.slice(0, 7)}` : ""}${c.message ? ` · ${firstLine(c.message)}` : ""}`, 100) });
    }
    for (const k of input.compactions) {
        if (k.ts) bs.push({ ts: k.ts, seq: null, kind: "compaction", label: "context compacted" });
    }
    bs.sort((a, b) => tsValue(a.ts) - tsValue(b.ts));
    const anchorTs = firstTs ?? bs[0]?.ts ?? null;
    if (anchorTs && (bs.length === 0 || tsValue(bs[0]!.ts) > tsValue(anchorTs))) {
        bs.unshift({ ts: anchorTs, seq: null, kind: "session_start", label: "session start" });
    }
    return bs;
}

/** Insert time-gap boundaries where events jump > TIME_GAP_MS and no boundary
 *  already sits in the gap - the universal fallback when asks/commits are sparse. */
function withTimeGaps(boundaries: Boundary[], events: ReadonlyArray<TimelineEvent>): Boundary[] {
    if (events.length === 0) return boundaries;
    const out = [...boundaries];
    const bset = new Set(boundaries.map((b) => Math.floor(tsValue(b.ts) / 1000)));
    for (let i = 1; i < events.length; i++) {
        const prev = tsValue(events[i - 1]!.ts);
        const cur = tsValue(events[i]!.ts);
        if (cur - prev > TIME_GAP_MS && !bset.has(Math.floor(cur / 1000))) {
            out.push({ ts: events[i]!.ts, seq: events[i]!.seq, kind: "time_gap", label: "resumed after a pause" });
            bset.add(Math.floor(cur / 1000));
        }
    }
    out.sort((a, b) => tsValue(a.ts) - tsValue(b.ts));
    return out;
}

const evenSample = <T>(arr: ReadonlyArray<T>, n: number): T[] => {
    if (n >= arr.length) return [...arr];
    if (n <= 0) return [];
    const step = arr.length / n;
    return Array.from({ length: n }, (_, i) => arr[Math.floor(i * step)]!);
};

/**
 * Adaptive collapse to <= max segments. Always keep session_start; prefer
 * structural boundaries (commit/compaction) over soft ones (ask/time_gap); if
 * even the structural ones exceed the budget, evenly sample THEM too so a
 * 200-commit loop still reads as ~max phases (drill-down covers the rest).
 */
function selectBoundaries(boundaries: Boundary[], max: number): Boundary[] {
    if (boundaries.length <= max) return boundaries;
    const start = boundaries.filter((b) => b.kind === "session_start");
    const structural = boundaries.filter((b) => b.kind === "commit" || b.kind === "compaction");
    const soft = boundaries.filter((b) => b.kind === "ask" || b.kind === "time_gap");
    const slots = Math.max(0, max - start.length);
    const chosen = structural.length >= slots
        ? evenSample(structural, slots)
        : [...structural, ...evenSample(soft, slots - structural.length)];
    const merged = [...start, ...chosen];
    merged.sort((a, b) => tsValue(a.ts) - tsValue(b.ts));
    return merged;
}

const emptyRollup = () => ({
    tool_calls: 0, file_edits: 0, files: 0, failures: 0, recovered: 0,
    skills: 0, decisions: 0, checkpoints: 0, corrections: 0,
});

function tally(rollup: ReturnType<typeof emptyRollup>, e: TimelineEvent, files: Set<string>): void {
    switch (e.kind) {
        case "tool_call": rollup.tool_calls++; break;
        case "file_edit": {
            rollup.file_edits++;
            const f = e.refs.find((r) => r.type === "file")?.id;
            if (f) files.add(f);
            break;
        }
        case "failure": rollup.failures++; if (e.recovered_by_seq != null) rollup.recovered++; break;
        case "skill_invocation": rollup.skills++; break;
        case "decision": rollup.decisions++; break;
        case "checkpoint": rollup.checkpoints++; break;
        case "correction": rollup.corrections++; break;
        default: break;
    }
}

export interface Segmented {
    readonly segments: TimelineSegment[];
    /** Events, capped per-segment + globally, each tagged with segment_id. */
    readonly events: TimelineEvent[];
}

/**
 * Assign events to segments, compute full rollups, then rank + cap the events.
 * `allEvents` must already be ts-sorted.
 */
export function segmentize(
    allEvents: ReadonlyArray<TimelineEvent>,
    input: SegmentInputs,
    firstTs: string | null,
    opts: { maxSegments?: number; perSegmentCap?: number; globalBudget?: number } = {},
): Segmented {
    const maxSegments = opts.maxSegments ?? MAX_SEGMENTS;
    const perSegmentCap = opts.perSegmentCap ?? PER_SEGMENT_CAP;
    const globalBudget = opts.globalBudget ?? GLOBAL_BUDGET;

    let boundaries = withTimeGaps(buildBoundaries(input, firstTs), allEvents);
    boundaries = selectBoundaries(boundaries, maxSegments);
    if (boundaries.length === 0) {
        boundaries = [{ ts: firstTs ?? allEvents[0]?.ts ?? "1970-01-01T00:00:00Z", seq: null, kind: "session_start", label: "session" }];
    }

    // bucket each event into the last boundary at-or-before its ts
    const buckets: TimelineEvent[][] = boundaries.map(() => []);
    const bts = boundaries.map((b) => tsValue(b.ts));
    for (const e of allEvents) {
        const et = tsValue(e.ts);
        let idx = 0;
        for (let i = 0; i < bts.length; i++) { if (bts[i]! <= et) idx = i; else break; }
        buckets[idx]!.push(e);
    }

    // build segment metas (full rollups) + per-segment ranked+capped events
    const segments: TimelineSegment[] = [];
    let kept: TimelineEvent[] = [];
    boundaries.forEach((b, i) => {
        const evs = buckets[i]!;
        const id = `seg-${i}`;
        const rollup = emptyRollup();
        const files = new Set<string>();
        for (const e of evs) tally(rollup, e, files);
        rollup.files = files.size;
        const seqs = evs.map((e) => e.seq).filter((s): s is number => s != null);
        const lastTs = evs.length > 0 ? evs[evs.length - 1]!.ts : (boundaries[i + 1]?.ts ?? null);
        segments.push({
            id, index: i, title: b.label, boundary: b.kind,
            start_seq: b.seq ?? (seqs.length ? Math.min(...seqs) : null),
            end_seq: seqs.length ? Math.max(...seqs) : null,
            started_at: b.ts, ended_at: lastTs,
            duration_ms: lastTs ? Math.max(0, tsValue(lastTs) - tsValue(b.ts)) : null,
            rollup, event_count: evs.length,
        });
        const ranked = [...evs]
            .map((e) => ({ e, w: KIND_WEIGHT[e.kind] ?? 0 }))
            .sort((a, z) => (z.w - a.w) || (tsValue(a.e.ts) - tsValue(z.e.ts)))
            .slice(0, perSegmentCap)
            .map(({ e }) => ({ ...e, segment_id: id }));
        kept.push(...ranked);
    });

    // global budget: if still over, keep the highest-weight events overall
    if (kept.length > globalBudget) {
        kept = [...kept]
            .sort((a, b) => (KIND_WEIGHT[b.kind] - KIND_WEIGHT[a.kind]) || (tsValue(a.ts) - tsValue(b.ts)))
            .slice(0, globalBudget);
    }
    kept.sort((a, b) => (tsValue(a.ts) - tsValue(b.ts)) || ((a.seq ?? Infinity) - (b.seq ?? Infinity)));
    return { segments, events: kept };
}
