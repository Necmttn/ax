import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api.ts";
import type { SessionInsightsPayload } from "@ax/lib/shared/dashboard-types";

// --- inline IntersectionObserver hook (latch - never goes false after true) ---
function useInView(rootMargin = "200px"): [boolean, React.RefObject<HTMLSpanElement | null>] {
    const [inView, setInView] = useState(false);
    const ref = useRef<HTMLSpanElement | null>(null);
    useEffect(() => {
        if (inView) return; // already latched - no observer needed
        const el = ref.current;
        if (!el) return;
        const obs = new IntersectionObserver(
            (entries) => {
                for (const e of entries) {
                    if (e.isIntersecting) {
                        setInView(true);
                        obs.disconnect();
                    }
                }
            },
            { rootMargin },
        );
        obs.observe(el);
        return () => obs.disconnect();
    }, [inView, rootMargin]);
    return [inView, ref];
}

// --- piecewise time-warp with idle-gap compression ---------------------------

export interface WarpSegment {
    realStart: number;
    realEnd: number;
    warpStart: number;
    warpEnd: number;
    compressed: boolean;
}

export function buildTimeWarp(
    anchors: number[],
    t0: number,
    t1: number,
    opts?: { maxGapShare?: number; compressedShare?: number },
): {
    segments: WarpSegment[];
    pct: (ts: number) => number; // 0..100 warped position
    compressedMs: number;        // total real ms hidden by compression
} {
    const maxGapShare = opts?.maxGapShare ?? 0.08;
    const compressedShare = opts?.compressedShare ?? 0.02;

    // Degenerate: zero-length session
    if (t1 <= t0) {
        return {
            segments: [],
            pct: () => 0,
            compressedMs: 0,
        };
    }

    const realSpan = t1 - t0;

    // Build sorted, deduped anchor list clamped to [t0, t1], always include t0 + t1
    const pts = Array.from(new Set([t0, t1, ...anchors.map((a) => Math.min(t1, Math.max(t0, a)))])).sort(
        (a, b) => a - b,
    );

    // Build raw segments between adjacent anchor points
    interface RawSeg {
        realStart: number;
        realEnd: number;
        realDur: number;
        idle: boolean;
    }
    const rawSegs: RawSeg[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
        const realStart = pts[i]!;
        const realEnd = pts[i + 1]!;
        const realDur = realEnd - realStart;
        const gapShare = realDur / realSpan;
        rawSegs.push({ realStart, realEnd, realDur, idle: gapShare > maxGapShare });
    }

    // If no segments are idle, or only one segment total, no compression needed
    const idleCount = rawSegs.filter((s) => s.idle).length;
    if (idleCount === 0 || rawSegs.length <= 1) {
        // Single identity-mapped segment
        const seg: WarpSegment = { realStart: t0, realEnd: t1, warpStart: 0, warpEnd: 100, compressed: false };
        return {
            segments: [seg],
            pct: (ts) => Math.min(100, Math.max(0, ((ts - t0) / realSpan) * 100)),
            compressedMs: 0,
        };
    }

    // Assign warp widths:
    // - idle segments each get compressedShare * 100 (in warp-pct space)
    // - active segments split the remaining space proportionally to real duration
    const idleWarpWidth = compressedShare * 100; // warp-pct per idle segment
    const totalIdleWarp = idleCount * idleWarpWidth;
    const activeWarpTotal = Math.max(0, 100 - totalIdleWarp);

    const activeTotalRealMs = rawSegs.filter((s) => !s.idle).reduce((sum, s) => sum + s.realDur, 0);

    const segments: WarpSegment[] = [];
    let warpCursor = 0;
    for (const raw of rawSegs) {
        let warpWidth: number;
        if (raw.idle) {
            warpWidth = idleWarpWidth;
        } else {
            warpWidth = activeTotalRealMs > 0 ? (raw.realDur / activeTotalRealMs) * activeWarpTotal : 0;
        }
        segments.push({
            realStart: raw.realStart,
            realEnd: raw.realEnd,
            warpStart: warpCursor,
            warpEnd: warpCursor + warpWidth,
            compressed: raw.idle,
        });
        warpCursor += warpWidth;
    }

    const compressedMs = rawSegs.filter((s) => s.idle).reduce((sum, s) => sum + s.realDur, 0);

    function pct(ts: number): number {
        const clamped = Math.min(t1, Math.max(t0, ts));
        // Find the segment containing clamped
        for (const seg of segments) {
            if (clamped >= seg.realStart && clamped <= seg.realEnd) {
                const segRealSpan = seg.realEnd - seg.realStart;
                if (segRealSpan <= 0) return seg.warpStart;
                const frac = (clamped - seg.realStart) / segRealSpan;
                return Math.min(100, Math.max(0, seg.warpStart + frac * (seg.warpEnd - seg.warpStart)));
            }
        }
        // Fallback: clamp to edges
        if (clamped <= t0) return 0;
        return 100;
    }

    return { segments, pct, compressedMs };
}

// --- timeline helpers --------------------------------------------------------

const PHASE_COLOR: Record<string, string> = {
    plan: "var(--sx-phase-plan)",
    execute: "var(--sx-phase-exec)",
    exec: "var(--sx-phase-exec)",
    review: "var(--sx-phase-review)",
};

const timeOf = (ts: string | null): number | null => {
    if (!ts) return null;
    const t = new Date(ts).getTime();
    return Number.isFinite(t) ? t : null;
};

const fmtMs = (ms: number): string =>
    ms < 60_000
        ? `${Math.round(ms / 1000)}s`
        : ms < 3_600_000
            ? `${Math.round(ms / 60_000)}m`
            : `${(ms / 3_600_000).toFixed(1)}h`;

function buildTitle(insights: SessionInsightsPayload, compressedMs = 0): string {
    const phaseTotals = new Map<string, number>();
    for (const p of insights.phases) {
        if (Number.isFinite(p.duration_ms) && p.duration_ms > 0) {
            phaseTotals.set(p.phase, (phaseTotals.get(p.phase) ?? 0) + p.duration_ms);
        }
    }
    const parts: string[] = [];
    for (const [k, v] of phaseTotals) {
        parts.push(`${k} ${fmtMs(v)}`);
    }
    const reverted = insights.commits.filter((c) => c.reverted).length;
    const landed = insights.commits.length - reverted;
    if (reverted > 0) parts.push(`✕${reverted}`);
    if (landed > 0) parts.push(`●${landed}`);
    if (insights.subagent_spans.length > 0) parts.push(`${insights.subagent_spans.length} subagents`);
    if (compressedMs > 60_000) parts.push(`· idle ~${fmtMs(compressedMs)} compressed`);
    return parts.join(" · ") || "no data";
}

// --- main renderers ----------------------------------------------------------

function renderTimeline(
    insights: SessionInsightsPayload,
    startedAt: string | null,
    endedAt: string | null,
    variant: "mini" | "underline",
): React.ReactNode {
    const phaseStarts = insights.phases.map((p) => timeOf(p.start_ts)).filter((t): t is number => t !== null);
    const phaseEnds = insights.phases.map((p) => timeOf(p.end_ts)).filter((t): t is number => t !== null);
    const t0 = timeOf(startedAt) ?? (phaseStarts.length > 0 ? Math.min(...phaseStarts) : null);
    const t1 = timeOf(endedAt) ?? (phaseEnds.length > 0 ? Math.max(...phaseEnds) : null);

    const noData =
        insights.phases.length === 0 &&
        insights.commits.length === 0 &&
        insights.subagent_spans.length === 0;

    const trackH = variant === "mini" ? 8 : 5;
    const trackStyle: React.CSSProperties = {
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: trackH,
        background: "var(--sx-phase-idle)",
    };

    if (noData || t0 === null || t1 === null || t1 <= t0) {
        // fallback: single idle-colored bar or dim dash
        if (variant === "mini") {
            return (
                <span style={{ color: "var(--sx-ink-300)", fontSize: 10 }}>–</span>
            );
        }
        return <span style={trackStyle} />;
    }

    // Collect all event anchors for time-warp
    const anchors: number[] = [];
    for (const p of insights.phases) {
        const s = timeOf(p.start_ts);
        const e = timeOf(p.end_ts);
        if (s !== null) anchors.push(s);
        if (e !== null) anchors.push(e);
    }
    for (const f of insights.friction_ticks) {
        const t = timeOf(f.ts);
        if (t !== null) anchors.push(t);
    }
    for (const c of insights.commits) {
        const t = timeOf(c.ts);
        if (t !== null) anchors.push(t);
    }
    for (const s of insights.subagent_spans) {
        const sa = timeOf(s.started_at);
        const ea = timeOf(s.ended_at);
        if (sa !== null) anchors.push(sa);
        if (ea !== null) anchors.push(ea);
    }

    // No event anchors beyond t0/t1 = no compression (just start+end)
    const hasEvents =
        insights.phases.length > 0 ||
        insights.friction_ticks.length > 0 ||
        insights.commits.length > 0 ||
        insights.subagent_spans.length > 0;

    const { segments, pct: warpPct, compressedMs } = buildTimeWarp(
        hasEvents ? anchors : [],
        t0,
        t1,
    );

    // pct helper that handles string timestamps
    const pct = (ts: string | null): number | null => {
        const t = timeOf(ts);
        return t === null ? null : warpPct(t);
    };

    const hasLanes = variant === "underline" && insights.subagent_spans.some((s) => s.started_at !== null);
    const wrapperH = variant === "mini" ? 8 : (hasLanes ? 8 : 5);
    const maxFriction = 12;
    const visibleFriction = insights.friction_ticks.slice(0, maxFriction);

    // For underline subagent lane: merge all spans into one
    let laneLeft: number | null = null;
    let laneRight: number | null = null;
    if (hasLanes) {
        for (const s of insights.subagent_spans) {
            if (!s.started_at) continue;
            const l = pct(s.started_at);
            const r = pct(s.ended_at) ?? 100;
            if (l !== null) {
                laneLeft = laneLeft === null ? l : Math.min(laneLeft, l);
                laneRight = laneRight === null ? r : Math.max(laneRight, r);
            }
        }
    }

    // Commit dot positions with de-overlap (underline only)
    // Compute raw positions then nudge collisions
    const commitPositions = insights.commits.map((c) => pct(c.ts));
    if (variant === "underline") {
        // Single-pass de-overlap: if two non-null dots land within 0.8%, nudge the later one
        for (let i = 1; i < commitPositions.length; i++) {
            const prev = commitPositions[i - 1];
            const cur = commitPositions[i];
            if (prev !== null && cur !== null && cur - prev < 0.8) {
                commitPositions[i] = Math.min(100, prev + 0.8);
            }
        }
    }

    // Compressed gap markers for underline variant
    const compressedSegments = variant === "underline" ? segments.filter((s) => s.compressed) : [];

    return (
        <>
            {/* idle track */}
            <span style={trackStyle} />
            {/* phase segments */}
            {insights.phases.map((p, i) => {
                const left = pct(p.start_ts);
                const right = pct(p.end_ts);
                if (left === null || right === null) return null;
                return (
                    <span
                        key={`ph-${i}`}
                        title={`${p.phase} ${fmtMs(p.duration_ms)}`}
                        style={{
                            position: "absolute",
                            top: 0,
                            height: trackH,
                            left: `${left}%`,
                            width: `${Math.max(0.5, right - left)}%`,
                            background: PHASE_COLOR[p.phase] ?? "var(--sx-phase-exec)",
                        }}
                    />
                );
            })}
            {/* compression markers (underline variant only) */}
            {compressedSegments.map((seg, i) => {
                const midWarp = (seg.warpStart + seg.warpEnd) / 2;
                return (
                    <span key={`cmp-${i}`} style={{ position: "absolute", top: 0, left: `${midWarp}%`, transform: "translateX(-50%)" }}>
                        {/* two 1px white slits */}
                        <span
                            style={{
                                display: "block",
                                position: "absolute",
                                top: 0,
                                left: -1,
                                width: 1,
                                height: 5,
                                background: "white",
                                opacity: 0.85,
                            }}
                        />
                        <span
                            style={{
                                display: "block",
                                position: "absolute",
                                top: 0,
                                left: 1,
                                width: 1,
                                height: 5,
                                background: "white",
                                opacity: 0.85,
                            }}
                        />
                    </span>
                );
            })}
            {/* friction ticks */}
            {visibleFriction.map((f, i) => {
                const left = pct(f.ts);
                if (left === null) return null;
                return (
                    <span
                        key={`fr-${i}`}
                        title={f.kind}
                        style={{
                            position: "absolute",
                            top: variant === "mini" ? -2 : -1,
                            width: variant === "mini" ? 2 : 1.5,
                            height: variant === "mini" ? 12 : 7,
                            left: `${left}%`,
                            background: "var(--sx-red-700)",
                            opacity: 0.82,
                        }}
                    />
                );
            })}
            {/* commit dots / reverted marks */}
            {insights.commits.map((c, i) => {
                const left = commitPositions[i];
                if (left === null) return null;
                return c.reverted ? (
                    <span
                        key={`cm-${i}`}
                        title={`${c.sha} (reverted)`}
                        style={{
                            position: "absolute",
                            top: variant === "mini" ? 0 : -1,
                            left: `${left}%`,
                            transform: "translateX(-50%)",
                            color: "var(--sx-red-700)",
                            fontSize: variant === "mini" ? 8 : 7,
                            fontWeight: 700,
                            lineHeight: 1,
                        }}
                    >
                        ✕
                    </span>
                ) : (
                    <span
                        key={`cm-${i}`}
                        title={c.sha}
                        style={{
                            position: "absolute",
                            top: variant === "mini" ? 1 : 0,
                            width: variant === "mini" ? 6 : 5,
                            height: variant === "mini" ? 6 : 5,
                            borderRadius: "50%",
                            left: `${left}%`,
                            transform: "translateX(-50%)",
                            background: "var(--sx-green-700)",
                        }}
                    />
                );
            })}
            {/* subagent lane: underline only, merged */}
            {hasLanes && laneLeft !== null && laneRight !== null ? (
                <span
                    title={`${insights.subagent_spans.length} subagents`}
                    style={{
                        position: "absolute",
                        top: 5,
                        height: 3,
                        borderRadius: 2,
                        left: `${laneLeft}%`,
                        width: `${Math.max(1, laneRight - laneLeft)}%`,
                        background: "var(--sx-violet-500)",
                        opacity: 0.72,
                    }}
                />
            ) : null}
        </>
    );
}

// --- public component --------------------------------------------------------

export function StoryStrip({ sessionId, startedAt, endedAt, variant }: {
    readonly sessionId: string;
    readonly startedAt: string | null;
    readonly endedAt: string | null;
    readonly variant: "mini" | "underline";
}) {
    const [inView, wrapRef] = useInView("200px");

    const q = useQuery({
        queryKey: ["session-insights", sessionId],
        queryFn: () => api.sessionInsights(sessionId),
        staleTime: 5 * 60_000,
        enabled: inView,
    });

    // Compute compressedMs for tooltip - derive anchors same way as renderTimeline
    let compressedMs = 0;
    if (q.data && startedAt && endedAt) {
        const t0 = new Date(startedAt).getTime();
        const t1 = new Date(endedAt).getTime();
        if (t1 > t0) {
            const anchors: number[] = [];
            const d = q.data;
            for (const p of d.phases) {
                const s = timeOf(p.start_ts); const e = timeOf(p.end_ts);
                if (s !== null) anchors.push(s);
                if (e !== null) anchors.push(e);
            }
            for (const f of d.friction_ticks) { const t = timeOf(f.ts); if (t !== null) anchors.push(t); }
            for (const c of d.commits) { const t = timeOf(c.ts); if (t !== null) anchors.push(t); }
            for (const s of d.subagent_spans) {
                const sa = timeOf(s.started_at); const ea = timeOf(s.ended_at);
                if (sa !== null) anchors.push(sa);
                if (ea !== null) anchors.push(ea);
            }
            const hasEvents = d.phases.length > 0 || d.friction_ticks.length > 0 || d.commits.length > 0 || d.subagent_spans.length > 0;
            const warp = buildTimeWarp(hasEvents ? anchors : [], t0, t1);
            compressedMs = warp.compressedMs;
        }
    }

    const isMini = variant === "mini";

    if (isMini) {
        // 120×8 mini timeline cell
        return (
            <span
                ref={wrapRef}
                title={q.data ? buildTitle(q.data, compressedMs) : undefined}
                style={{
                    display: "inline-block",
                    position: "relative",
                    width: 120,
                    height: 8,
                    verticalAlign: "middle",
                    background: "var(--sx-phase-idle)",
                }}
            >
                {q.data ? renderTimeline(q.data, startedAt, endedAt, "mini") : null}
            </span>
        );
    }

    // underline: 100% wide, 5px strip
    return (
        <span
            ref={wrapRef}
            title={q.data ? buildTitle(q.data, compressedMs) : undefined}
            style={{
                display: "block",
                position: "relative",
                width: "100%",
                // 5px strip track + optional 3px subagent lane below = up to 8px
                height: q.data && q.data.subagent_spans.some((s) => s.started_at !== null)
                    ? 8
                    : 5,
                background: "var(--sx-phase-idle)",
            }}
        >
            {q.data ? renderTimeline(q.data, startedAt, endedAt, "underline") : null}
        </span>
    );
}
