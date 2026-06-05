import { Fragment, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../api.ts";
import { InPlaceDetail } from "./canvas-detail-inplace.tsx";
import { FocusDetail } from "./canvas-detail-focus.tsx";
import type {
    SessionCanvasNode,
    SessionCanvasPayload,
    SessionOrchestration,
    SessionOrchestrationSubagent,
} from "@shared/dashboard-types.ts";

// Session Canvas - swimlanes (repo × time). Each pill is a session: width = √tokens,
// color = outcome, red ticks = compaction, and an inline work/wait rail (solid =
// main working, hatched = blocked on a subagent). Click a pill to drill into its
// orchestration timeline (the subagent fan-out / parallel / sequential dance).

const LANES = 8;            // top repos shown; rest collapse into "+ more"
const AUTO_ZOOM = 6;        // at/above this zoom, the detail panel auto-follows the centered session
const ROW_H = 40;           // min lane height (1 sub-row)
const SUBROW_H = 18;        // height of each stacked sub-row within a lane
const PILL_H = 14;
const TRACK_LEFT = 150;     // px reserved for lane labels

const tMs = (iso: string | null): number | null => {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) ? t : null;
};

const fmtTokens = (n: number): string =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `${n}`;

const fmtDur = (msv: number | null): string => {
    if (msv === null) return "?";
    const s = Math.round(msv / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60}m`;
};

const repoOf = (n: SessionCanvasNode): string => {
    const p = n.project ?? "unknown";
    const m = p.match(/(?:Projects|workspaces|worktrees)[-/]([^-/]+)/);
    return m?.[1] ?? p.split(/[-/]/).filter(Boolean).pop() ?? "unknown";
};

const toneFill = (tone: string): string =>
    tone === "warning" ? "#3a2c12" : tone === "live" ? "#13294d" : "#173a27";
const toneStroke = (tone: string): string =>
    tone === "warning" ? "#d49a3a" : tone === "live" ? "#4f8bff" : "#3fbf7a";

export function CanvasRoute() {
    const query = useQuery({
        queryKey: ["session-canvas"],
        queryFn: () => api.sessionCanvas({ limit: 800 }),
    });
    const data: SessionCanvasPayload | null = query.data ?? null;
    const [selected, setSelected] = useState<string | null>(null);
    const [width, setWidth] = useState(1000);
    // time-axis camera: zoom = horizontal scale, panX = px scrolled into content
    const [zoom, setZoom] = useState(1);
    const [panX, setPanX] = useState(0);
    const [detailMode, setDetailMode] = useState<"inplace" | "focus" | "both">("focus");
    const qc = useQueryClient();
    const prefetchInspect = (id: string) =>
        qc.prefetchQuery({ queryKey: ["session-summary", id], queryFn: () => api.sessionSummary(id), staleTime: 120_000 });
    const dragRef = useRef<{ px: number; pan: number } | null>(null);

    // top-level sessions only (subagents live in the drill-in)
    const sessions = useMemo(
        () => (data?.nodes ?? []).filter((n) => !n.is_subagent && n.started_at),
        [data],
    );

    // lanes: group by repo, keep the most-active LANES, collapse the rest
    const { lanes, laneOf } = useMemo(() => {
        const byRepo = new Map<string, number>();
        for (const s of sessions) byRepo.set(repoOf(s), (byRepo.get(repoOf(s)) ?? 0) + 1);
        const ranked = [...byRepo.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r);
        const keep = new Set(ranked.slice(0, LANES));
        const lanes = [...ranked.slice(0, LANES), ...(ranked.length > LANES ? ["+ more"] : [])];
        const laneOf = (s: SessionCanvasNode) => (keep.has(repoOf(s)) ? repoOf(s) : "+ more");
        return { lanes, laneOf };
    }, [sessions]);

    // time range across visible sessions
    const [t0, t1] = useMemo(() => {
        let lo = Infinity, hi = -Infinity;
        for (const s of sessions) {
            const a = tMs(s.started_at); const b = tMs(s.ended_at) ?? a;
            if (a !== null) { lo = Math.min(lo, a); hi = Math.max(hi, b ?? a); }
        }
        return Number.isFinite(lo) ? [lo, Math.max(hi, lo + 1)] : [0, 1];
    }, [sessions]);

    const trackW = Math.max(200, width - TRACK_LEFT - 24);
    const contentW = trackW * zoom;
    const maxPan = Math.max(0, contentW - trackW);
    const clampedPan = Math.min(maxPan, Math.max(0, panX));
    // ms -> px within the visible track (after zoom + horizontal pan)
    const xOf = (msv: number) => ((msv - t0) / (t1 - t0)) * contentW - clampedPan;


    // start time of the next pill in the same lane - bounds how wide a label can
    // grow before it would collide with the next session. As you zoom in, this
    // gap widens, so labels fade in progressively (semantic zoom).
    const nextStartById = useMemo(() => {
        const m = new Map<string, number>();
        const byLane = new Map<string, SessionCanvasNode[]>();
        for (const s of sessions) {
            const k = laneOf(s);
            const arr = byLane.get(k) ?? [];
            arr.push(s); byLane.set(k, arr);
        }
        for (const arr of byLane.values()) {
            arr.sort((x, y) => (tMs(x.started_at) ?? 0) - (tMs(y.started_at) ?? 0));
            for (let i = 0; i < arr.length; i++) {
                m.set(arr[i]!.id, i + 1 < arr.length ? (tMs(arr[i + 1]!.started_at) ?? Infinity) : Infinity);
            }
        }
        return m;
    }, [sessions, laneOf]);

    // sub-row packing: within a lane, sessions whose [start,end] overlap in TIME
    // (multiple agents on the same project at once) stack into separate rows via
    // greedy interval packing. Time-based (not zoom-based) so lane heights are
    // stable. Lane height grows with the max concurrency it ever saw.
    const { rowById, laneRows } = useMemo(() => {
        const rowById = new Map<string, number>();
        const laneRows = new Map<string, number>();
        const byLane = new Map<string, SessionCanvasNode[]>();
        for (const s of sessions) {
            const k = laneOf(s);
            const arr = byLane.get(k) ?? [];
            arr.push(s); byLane.set(k, arr);
        }
        for (const [lane, arr] of byLane) {
            arr.sort((x, y) => (tMs(x.started_at) ?? 0) - (tMs(y.started_at) ?? 0));
            const rowEnds: number[] = [];
            for (const s of arr) {
                const a = tMs(s.started_at) ?? 0;
                const b = Math.max(tMs(s.ended_at) ?? a, a);
                let row = rowEnds.findIndex((end) => end <= a);
                if (row === -1) { row = rowEnds.length; rowEnds.push(b); } else rowEnds[row] = b;
                rowById.set(s.id, row);
            }
            laneRows.set(lane, Math.max(1, rowEnds.length));
        }
        return { rowById, laneRows };
    }, [sessions, laneOf]);

    // cumulative lane y-offsets + heights (variable, from sub-row count)
    const laneGeom = useMemo(() => {
        const yByLane = new Map<string, number>();
        const hByLane = new Map<string, number>();
        let acc = 0;
        for (const lane of lanes) {
            const rows = laneRows.get(lane) ?? 1;
            const h = Math.max(ROW_H, rows * SUBROW_H + 8);
            yByLane.set(lane, acc); hByLane.set(lane, h); acc += h;
        }
        return { yByLane, hByLane, total: Math.max(ROW_H, acc) };
    }, [lanes, laneRows]);
    const topOf = (s: SessionCanvasNode) =>
        (laneGeom.yByLane.get(laneOf(s)) ?? 0) + (rowById.get(s.id) ?? 0) * SUBROW_H + (SUBROW_H - PILL_H) / 2 + 4;

    const dayTicks = useMemo(() => {
        const out: Array<{ x: number; label: string }> = [];
        const day = 86_400_000;
        const start = Math.ceil(t0 / day) * day;
        for (let t = start; t <= t1; t += day) {
            const x = ((t - t0) / (t1 - t0)) * contentW - clampedPan;
            if (x < -40 || x > trackW + 40) continue;
            out.push({ x, label: new Date(t).toLocaleDateString("en-US", { weekday: "short", day: "numeric" }) });
        }
        return out;
    }, [t0, t1, contentW, clampedPan, trackW]);

    // at deep zoom, auto-focus the session whose pill is nearest viewport-center
    // so the detail panel follows what you scrub to - no clicking needed.
    const autoFocusId = useMemo(() => {
        if (zoom < AUTO_ZOOM) return null;
        const center = trackW / 2;
        let best: string | null = null, bestD = Infinity;
        for (const s of sessions) {
            const a = tMs(s.started_at); if (a === null) continue;
            const px = xOf(a); if (px < -40 || px > trackW + 40) continue;
            const w = 12 + Math.sqrt(Math.min(1, s.size / 2_000_000)) * 78;
            const d = Math.abs(px + w / 2 - center);
            if (d < bestD) { bestD = d; best = s.id; }
        }
        return best;
    }, [zoom, sessions, trackW, contentW, clampedPan]);
    // manual click pins a session; otherwise (deep zoom) follow the centered one
    const focusId = selected ?? autoFocusId;

    // zoom toward an anchor x (px from track origin), keeping that time fixed
    const zoomAt = (anchorX: number, factor: number) => {
        const next = Math.max(1, Math.min(2000, zoom * factor));
        const worldFrac = (clampedPan + anchorX) / contentW;          // time under anchor
        const nextContentW = trackW * next;
        setPanX(Math.max(0, worldFrac * nextContentW - anchorX));
        setZoom(next);
    };
    const onWheel = (e: React.WheelEvent) => {
        if (e.deltaY === 0) return;
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        const anchor = e.clientX - rect.left - TRACK_LEFT;
        zoomAt(Math.max(0, anchor), Math.exp(-e.deltaY * 0.0015));
    };
    const onPointerDown = (e: React.PointerEvent) => {
        (e.target as Element).setPointerCapture?.(e.pointerId);
        dragRef.current = { px: e.clientX, pan: clampedPan };
    };
    const onPointerMove = (e: React.PointerEvent) => {
        const d = dragRef.current; if (!d) return;
        setPanX(Math.max(0, Math.min(maxPan, d.pan - (e.clientX - d.px))));
    };
    const onPointerUp = () => { dragRef.current = null; };

    return (
        <section className="panel" style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            <header>
                <h2>Session Canvas</h2>
                <span className="meta">
                    {data ? `${sessions.length} sessions · ${lanes.length} lanes` : "swimlanes"}
                </span>
            </header>

            {query.isLoading ? <div style={{ padding: 16, color: "#7e8ba3" }}>Loading…</div> : null}
            {query.error ? <div style={{ padding: 16, color: "#e0563a" }}>Error: {String(query.error)}</div> : null}

            <div style={{ display: "flex", gap: 6, alignItems: "center", margin: "6px 0" }}>
                {([["−", 1 / 1.4], ["+", 1.4]] as const).map(([sym, f]) => (
                    <button key={sym} type="button" onClick={() => zoomAt(trackW / 2, f)}
                        style={{ width: 26, height: 24, background: "#0e1422", border: "1px solid #2a3650", color: "#cfe0ff", borderRadius: 6, cursor: "pointer" }}>{sym}</button>
                ))}
                <button type="button" onClick={() => { setZoom(1); setPanX(0); }}
                    style={{ height: 24, padding: "0 9px", background: "#0e1422", border: "1px solid #2a3650", color: "#cfe0ff", borderRadius: 6, cursor: "pointer", fontSize: 11 }}>Fit</button>
                <span style={{ fontSize: 11, color: "#55657f" }}>{zoom.toFixed(1)}× · scroll to zoom, drag to pan</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 10, color: "#55657f" }}>detail:</span>
                {(["inplace", "focus", "both"] as const).map((m) => (
                    <button key={m} type="button" onClick={() => setDetailMode(m)}
                        style={{ height: 24, padding: "0 9px", borderRadius: 6, cursor: "pointer", fontSize: 11,
                            background: detailMode === m ? "#16345e" : "#0e1422",
                            border: `1px solid ${detailMode === m ? "#4f8bff" : "#2a3650"}`,
                            color: detailMode === m ? "#cfe0ff" : "#8b9ab3" }}>{m === "inplace" ? "in-place" : m}</button>
                ))}
            </div>

            <div
                ref={(el) => { if (el && el.clientWidth && el.clientWidth !== width) setWidth(el.clientWidth); }}
                onWheel={onWheel}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerLeave={onPointerUp}
                style={{ background: "#0a0d13", border: "1px solid #1b2330", borderRadius: 12, overflow: "hidden", cursor: dragRef.current ? "grabbing" : "grab", touchAction: "none" }}
            >
                {/* day axis */}
                <div style={{ position: "relative", height: 22, borderBottom: "1px solid #131922", marginLeft: TRACK_LEFT }}>
                    {dayTicks.map((d, i) => (
                        <span key={i} style={{ position: "absolute", left: d.x, top: 5, fontSize: 9, color: "#3f4c63", letterSpacing: ".05em", textTransform: "uppercase" }}>{d.label}</span>
                    ))}
                </div>
                {/* lanes */}
                <div style={{ position: "relative", height: laneGeom.total }}>
                    {lanes.map((lane) => {
                        const rows = laneRows.get(lane) ?? 1;
                        return (
                            <div key={lane} style={{ position: "absolute", left: 0, right: 0, top: laneGeom.yByLane.get(lane) ?? 0, height: laneGeom.hByLane.get(lane) ?? ROW_H, borderBottom: "1px solid #0f141d" }}>
                                <div style={{ position: "absolute", left: 14, top: 6, width: TRACK_LEFT - 20, fontSize: 11, color: lane === "+ more" ? "#55657f" : "#8b9ab3", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                    {lane}{rows > 1 ? <span style={{ color: "#3f4c63" }}> ·{rows}</span> : null}
                                </div>
                            </div>
                        );
                    })}
                    {/* day gridlines */}
                    {dayTicks.map((d, i) => (
                        <div key={`g${i}`} style={{ position: "absolute", top: 0, bottom: 0, left: TRACK_LEFT + d.x, width: 1, background: "#0f141d" }} />
                    ))}
                    {/* pills - render subagent-heavy + selected last so they sit on
                        top of overlapping solo pills (clickability + the interesting
                        ones win the z-order) */}
                    {[...sessions]
                        .sort((a, b) =>
                            (a.id === focusId ? 1 : 0) - (b.id === focusId ? 1 : 0) ||
                            a.subagent_count - b.subagent_count)
                        .map((s) => {
                        const a = tMs(s.started_at); if (a === null) return null;
                        const b = tMs(s.ended_at) ?? a;
                        const left = TRACK_LEFT + xOf(a);
                        // width = √tokens (NOT duration - a session's [start,end] often
                        // spans idle days). Placed at start-time; the inline rail shows
                        // the blocked proportion regardless of pill width.
                        void b;
                        const w = 12 + Math.sqrt(Math.min(1, s.size / 2_000_000)) * 78;
                        const top = topOf(s);
                        const isSel = s.id === focusId;
                        // progressive label: grow into the gap before the next pill
                        const nextStart = nextStartById.get(s.id) ?? Infinity;
                        const nextX = nextStart === Infinity ? left + w + 320 : TRACK_LEFT + xOf(nextStart);
                        const labelMaxPx = Math.min(320, nextX - (left + w) - 6);
                        const showLabel = labelMaxPx > 34 && left < width && left + w > TRACK_LEFT;
                        return (
                            <Fragment key={s.id}>
                            <div
                                title={`${s.label}\n${repoOf(s)} · ${s.turns} turns · ${fmtTokens(s.size)} tok${s.subagent_count ? ` · ${s.subagent_count} subagents` : ""}${s.epochs > 1 ? ` · ${s.epochs - 1}× compacted` : ""}`}
                                onMouseEnter={() => prefetchInspect(s.id)}
                                onClick={() => setSelected(isSel ? null : s.id)}
                                style={{
                                    position: "absolute", left, top, width: w, height: PILL_H, borderRadius: 7,
                                    background: toneFill(s.tone), border: `1px solid ${isSel ? "#fff" : toneStroke(s.tone)}`,
                                    cursor: "pointer", overflow: "hidden", boxSizing: "border-box",
                                }}
                            >
                                {/* inline work/wait rail: hatched bands where main was blocked */}
                                {s.wait_segments.map((seg, k) => (
                                    <div key={k} style={{
                                        position: "absolute", top: 0, bottom: 0,
                                        left: `${seg.start * 100}%`, width: `${Math.max(0.5, (seg.end - seg.start) * 100)}%`,
                                        background: "repeating-linear-gradient(45deg,#0e1830,#0e1830 2px,#0b1426 2px,#0b1426 4px)",
                                        borderLeft: "1px solid #2a3f6688", borderRight: "1px solid #2a3f6688",
                                    }} />
                                ))}
                                {/* compaction ticks */}
                                {s.compactions.map((_, k) => (
                                    <div key={`c${k}`} style={{ position: "absolute", top: -1, bottom: -1, left: `${((k + 1) / (s.compactions.length + 1)) * 100}%`, width: 1.5, background: "#ff6b4a" }} />
                                ))}
                                {/* subagent count dot */}
                                {s.subagent_count > 0 ? (
                                    <div style={{ position: "absolute", top: 1, right: 2, fontSize: 7, color: "#9fc0ff" }}>{s.subagent_count}</div>
                                ) : null}
                            </div>
                            {showLabel ? (
                                <div style={{
                                    position: "absolute", left: left + w + 5, top: top + 1, width: labelMaxPx, height: PILL_H,
                                    fontSize: 10, lineHeight: `${PILL_H - 2}px`, color: "#aab9d6",
                                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", pointerEvents: "none",
                                }}>{s.label}</div>
                            ) : null}
                            </Fragment>
                        );
                    })}
                    {focusId && (detailMode === "inplace" || detailMode === "both") ? (() => {
                        const fid = focusId;
                        const sel = sessions.find((s) => s.id === fid);
                        const a = sel?.started_at ? tMs(sel.started_at) : null;
                        if (!sel || a === null) return null;
                        const x = Math.max(TRACK_LEFT, Math.min(Math.max(TRACK_LEFT, width - 380), TRACK_LEFT + xOf(a) + 12));
                        const y = Math.max(4, Math.min(Math.max(4, laneGeom.total - 250), topOf(sel) + 16));
                        return <InPlaceDetail sessionId={fid} x={x} y={y} onClose={() => setSelected(null)} />;
                    })() : null}
                </div>
            </div>

            <div style={{ display: "flex", gap: 14, padding: "8px 2px", fontSize: 10, color: "#55657f", flexWrap: "wrap" }}>
                <span>pill = session · width = √tokens · color = outcome</span>
                <span style={{ color: "#8b9ab3" }}>▨ hatched = main blocked on subagent</span>
                <span style={{ color: "#ff6b4a" }}>| = compaction</span>
                <span>click a pill → detail (toggle in-place / focus / both)</span>
            </div>

            {focusId && (detailMode === "focus" || detailMode === "both")
                ? <FocusDetail sessionId={focusId} onClose={() => setSelected(null)} />
                : null}
        </section>
    );
}

// ---- Orchestration drill-in ----

function laneAssign(subs: ReadonlyArray<{ a: number; b: number }>): number[] {
    // greedy: place each bar in the first row whose last bar ended before it starts
    const rowEnds: number[] = [];
    return subs.map((s) => {
        let row = rowEnds.findIndex((end) => end <= s.a);
        if (row === -1) { row = rowEnds.length; rowEnds.push(s.b); }
        else rowEnds[row] = s.b;
        return row;
    });
}

function OrchestrationPanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
    const q = useQuery({
        queryKey: ["orchestration", sessionId],
        queryFn: () => api.sessionOrchestration(sessionId),
    });
    const d: SessionOrchestration | null = q.data ?? null;

    const view = useMemo(() => {
        if (!d) return null;
        const p0 = tMs(d.started_at); const p1 = tMs(d.ended_at);
        if (p0 === null || p1 === null || p1 <= p0) return null;
        const span = p1 - p0;
        const frac = (t: number) => Math.max(0, Math.min(1, (t - p0) / span));
        const bars = d.subagents
            .map((s: SessionOrchestrationSubagent) => {
                const a = tMs(s.started_at); const b = tMs(s.ended_at) ?? a;
                if (a === null || b === null) return null;
                return { s, a: frac(a), b: frac(b) };
            })
            .filter((x): x is { s: SessionOrchestrationSubagent; a: number; b: number } => !!x);
        const rows = laneAssign(bars);
        return { bars, rows, rowCount: Math.max(1, ...rows.map((r) => r + 1)) };
    }, [d]);

    return (
        <div style={{ marginTop: 12, background: "#0a0d13", border: "1px solid #1b2330", borderRadius: 12, overflow: "hidden" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid #161d29" }}>
                <div>
                    <div style={{ fontSize: 12, color: "#e6edf6", fontWeight: 600 }}>{d?.label ?? "…"}</div>
                    <div style={{ fontSize: 10, color: "#55657f", marginTop: 2 }}>
                        {d ? `${d.subagents.length} subagents · main blocked ${Math.round(d.wait_pct * 100)}%` : "loading orchestration…"}
                    </div>
                </div>
                <button type="button" onClick={onClose} style={{ background: "none", border: "1px solid #2a3650", color: "#8b9ab3", borderRadius: 6, padding: "3px 9px", cursor: "pointer", fontSize: 11 }}>close</button>
            </div>
            {q.error ? <div style={{ padding: 14, color: "#e0563a" }}>Error: {String(q.error)}</div> : null}
            {d && d.subagents.length === 0 ? <div style={{ padding: 14, color: "#7e8ba3", fontSize: 12 }}>No subagents - this session ran solo.</div> : null}
            {view ? (
                <div style={{ position: "relative", padding: "14px 16px 18px 70px" }}>
                    {/* main rail */}
                    <div style={{ position: "relative", height: 16, marginBottom: 8 }}>
                        <span style={{ position: "absolute", left: -58, top: 1, fontSize: 10, color: "#cfe0ff" }}>main</span>
                        <div style={{ position: "absolute", inset: 0, background: "#16345e", border: "1px solid #4f8bff", borderRadius: 4 }} />
                        {/* compute wait bands from bars (merged) */}
                        {mergeBands(view.bars.map((x) => ({ a: x.a, b: x.b }))).map((seg, k) => (
                            <div key={k} style={{ position: "absolute", top: 0, bottom: 0, left: `${seg.a * 100}%`, width: `${Math.max(0.4, (seg.b - seg.a) * 100)}%`, background: "repeating-linear-gradient(45deg,#0e1830,#0e1830 4px,#0b1426 4px,#0b1426 8px)", border: "1px dashed #2a3f66" }} />
                        ))}
                    </div>
                    <span style={{ position: "absolute", left: 12, top: 46, fontSize: 10, color: "#8b9ab3" }}>subagents</span>
                    {/* subagent bars */}
                    <div style={{ position: "relative", marginTop: 4, height: view.rowCount * 16 + 4 }}>
                        {view.bars.map((x, i) => (
                            <div
                                key={x.s.id + i}
                                title={`${x.s.task ?? x.s.nickname ?? x.s.id}\n${fmtDur(x.s.duration_ms)}`}
                                style={{
                                    position: "absolute", top: view.rows[i]! * 16, left: `${x.a * 100}%`,
                                    width: `${Math.max(0.6, (x.b - x.a) * 100)}%`, height: 11, borderRadius: 6,
                                    background: x.s.tone === "long" ? "#3a2c12" : "#173a27",
                                    border: `1px solid ${x.s.tone === "long" ? "#d49a3a" : "#3fbf7a"}`,
                                    overflow: "hidden", whiteSpace: "nowrap", fontSize: 8, color: "#cfe0ff", padding: "0 3px", lineHeight: "11px",
                                }}
                            >{(x.b - x.a) > 0.06 ? (x.s.task ?? "") : ""}</div>
                        ))}
                    </div>
                    <Link to="/sessions/$sessionId/inspect" params={{ sessionId }} style={{ color: "#2f6df0", fontSize: 11, display: "inline-block", marginTop: 10 }}>
                        open session turns →
                    </Link>
                </div>
            ) : null}
        </div>
    );
}

function mergeBands(intervals: ReadonlyArray<{ a: number; b: number }>): Array<{ a: number; b: number }> {
    const sorted = [...intervals].filter((x) => x.b > x.a).sort((x, y) => x.a - y.a);
    const out: Array<{ a: number; b: number }> = [];
    for (const c of sorted) {
        const last = out[out.length - 1];
        if (last && c.a <= last.b) last.b = Math.max(last.b, c.b);
        else out.push({ ...c });
    }
    return out;
}
