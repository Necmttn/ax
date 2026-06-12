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

const pctOf = (t: number, t0: number, span: number): number =>
    Math.min(100, Math.max(0, ((t - t0) / span) * 100));

const fmtMs = (ms: number): string =>
    ms < 60_000
        ? `${Math.round(ms / 1000)}s`
        : ms < 3_600_000
            ? `${Math.round(ms / 60_000)}m`
            : `${(ms / 3_600_000).toFixed(1)}h`;

function buildTitle(insights: SessionInsightsPayload): string {
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

    const span = t1 - t0;
    const pct = (ts: string | null): number | null => {
        const t = timeOf(ts);
        return t === null ? null : pctOf(t, t0, span);
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
                const left = pct(c.ts);
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

    const isMini = variant === "mini";

    if (isMini) {
        // 120×8 mini timeline cell
        return (
            <span
                ref={wrapRef}
                title={q.data ? buildTitle(q.data) : undefined}
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
            title={q.data ? buildTitle(q.data) : undefined}
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
