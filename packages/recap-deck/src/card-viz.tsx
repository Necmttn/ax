/** @jsxImportSource react */
/**
 * Approved card-viz registry - a small set of blessed, reusable instrument
 * visuals the wrapped agent can target DECLARATIVELY (json-render.dev mindset).
 * A card carries a `viz` spec ({ kind, data, label }); CardViz maps the kind to
 * a component. Until the agent emits specs, the deck assigns a kind positionally.
 * Each viz is self-contained, robust to any data length, and keyed to
 * var(--card-accent). Built from the per-visual design-curator roasts.
 *
 * Each kind reads as a DISTINCT instrument readout in the nullframe HUD aesthetic
 * (dot-matrix / receipt motif, editorial restraint). Motion is subtle and live -
 * never noisy. Variety of SHAPE, not just more bars.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { Doto, Segbar } from "./viz.tsx";

export type VizKind =
    | "bars" | "line" | "cells" | "meter" | "ring"
    | "radar" | "wave" | "stream" | "scatter" | "bullet"
    | "comet" | "waffle" | "candles" | "signal" | "delta";
export interface VizSpec { readonly kind: VizKind; readonly data: number[]; readonly label?: string }
interface P { readonly data: number[]; readonly label?: string }

const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
const clampPct = (n: number) => (Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0);
/** Resample/clamp a series to exactly `n` points (nearest sample). */
const take = (a: number[], n: number): number[] =>
    a.length === 0 ? Array.from({ length: n }, () => 0)
    : Array.from({ length: n }, (_, i) => a[Math.min(a.length - 1, Math.floor((i / n) * a.length))] ?? 0);

/** Measure a wrapper's px width (for real-aspect SVG viz). */
function useWidth(initial = 220): readonly [React.RefObject<HTMLDivElement | null>, number] {
    const ref = useRef<HTMLDivElement>(null);
    const [w, setW] = useState(initial);
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const ro = new ResizeObserver((e) => setW(Math.max(40, e[0]?.contentRect.width ?? 40)));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    return [ref, w] as const;
}

/* ── Bars ─────────────────────────────────────────────────────────────────── */
/** Vertical bars with a hairline baseline, peak tick, and a live "now" cap. */
function Bars({ data, label }: P): ReactElement {
    if (data.length === 0) return <div className="wr-bars" aria-hidden="true" />;
    const peak = data.reduce((m, b, i) => (b > (data[m] ?? 0) ? i : m), 0);
    const last = data.length - 1;
    return (
        <div className="wr-bars" role="img" aria-label={label} style={{ ["--bars-n"]: data.length } as CSSProperties}>
            <span className="wr-bars-base" />
            {data.map((b, i) => (
                <i key={i} className={i === last ? "is-now" : i === peak ? "is-peak" : undefined}
                    style={{ height: `${Math.max(4, b)}%`, animationDelay: `${(i / data.length) * 0.4}s` }}>
                    {i === peak ? <b className="wr-bars-tick" /> : null}
                </i>
            ))}
        </div>
    );
}

/* ── Line ─────────────────────────────────────────────────────────────────── */
/** Smooth area sparkline, real-aspect (measured), with a pulsing last point. */
function Line({ data, label }: P): ReactElement {
    const [wrap, w] = useWidth();
    const H = 46, PAD_T = 5, PAD_B = 4, usableH = H - PAD_T - PAD_B;
    const pts = data.length >= 1 ? data : [50];
    const n = pts.length, dotR = 2.6, padX = dotR + 1.5;
    const innerW = Math.max(1, w - padX * 2);
    const xy = pts.map((b, i) => {
        const x = padX + (n === 1 ? innerW : (i / (n - 1)) * innerW);
        const y = PAD_T + (1 - clampPct(b) / 100) * usableH;
        return [x, y] as const;
    });
    const d = xy.length === 1
        ? `M ${xy[0]![0]} ${xy[0]![1]} L ${w - padX} ${xy[0]![1]}`
        : xy.reduce((acc, [x, y], i) => {
            if (i === 0) return `M ${x} ${y}`;
            const [x0, y0] = xy[Math.max(0, i - 2)]!;
            const [x1, y1] = xy[i - 1]!;
            const [x2, y2] = xy[Math.min(n - 1, i + 1)]!;
            return `${acc} C ${x1 + (x - x0) / 6} ${y1 + (y - y0) / 6}, ${x - (x2 - x1) / 6} ${y - (y2 - y1) / 6}, ${x} ${y}`;
        }, "");
    const [lx, ly] = xy[xy.length - 1]!;
    const area = `${d} L ${lx} ${H - PAD_B + 4} L ${xy[0]![0]} ${H - PAD_B + 4} Z`;
    const gid = `wrl-${Math.round(w)}-${n}`;
    return (
        <div className="wr-line-wrap" ref={wrap} title={label}>
            <svg className="wr-line" width={w} height={H} viewBox={`0 0 ${w} ${H}`} aria-hidden="true">
                <defs>
                    <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--card-accent)" stopOpacity="0.30" />
                        <stop offset="100%" stopColor="var(--card-accent)" stopOpacity="0" />
                    </linearGradient>
                </defs>
                <line className="wr-line-base" x1={padX} y1={H - PAD_B} x2={w - padX} y2={H - PAD_B} />
                <path d={area} fill={`url(#${gid})`} />
                <path className="wr-line-stroke" d={d} fill="none" />
                <circle className="wr-line-pulse" cx={lx} cy={ly} r={dotR + 2} />
                <circle className="wr-line-dot" cx={lx} cy={ly} r={dotR} />
            </svg>
        </div>
    );
}

/* ── Cells ────────────────────────────────────────────────────────────────── */
/** Dot-matrix intensity field: 2 rows of rounded dots, continuous opacity. */
function CellMatrix({ data, label }: P): ReactElement {
    const ROWS = 2, MAX_COLS = 30;
    const cols = Math.min(MAX_COLS, Math.max(8, Math.ceil(data.length / ROWS)));
    const slots = cols * ROWS;
    const max = Math.max(...data, 1);
    const cells = Array.from({ length: slots }, (_, i) => clamp01((data[Math.floor((i / slots) * data.length)] ?? 0) / max));
    return (
        <div className="wr-matrix" role="img" aria-label={label} style={{ ["--cols"]: cols } as CSSProperties}>
            {cells.map((t, i) => (
                <span key={i} className={`wr-cell${t >= 0.66 ? " hot" : ""}`} style={{ ["--t"]: t.toFixed(3) } as CSSProperties} />
            ))}
        </div>
    );
}

/* ── Meter ────────────────────────────────────────────────────────────────── */
/** Dual-row segmented readout: per-point heat strip over a battery meter. */
function SegMeter({ data }: P): ReactElement {
    const n = data.length;
    const last = n ? (data[n - 1] ?? 0) : 0;
    const mean = avg(data);
    const cells = 22;
    const onCells = Math.round(clamp01(last / 100) * cells);
    return (
        <div className="wr-meter" aria-hidden="true">
            <div className="wr-meter-strip">
                {data.map((p, i) => (
                    <i key={i} style={{ background: `color-mix(in srgb, var(--card-accent) ${Math.round(10 + clamp01(p / 100) * 90)}%, var(--surface))`, animationDelay: `${0.12 + i * 0.018}s` }} />
                ))}
            </div>
            <div className="wr-meter-batt">
                <div className="wr-batt-cells">
                    <Segbar total={cells} on={onCells} tone="card" gradient />
                    <span className="wr-batt-tick" style={{ left: `${clamp01(mean / 100) * 100}%` }} />
                </div>
                <span className="wr-batt-cap" />
                <Doto className="wr-batt-val">{String(Math.round(last)).padStart(2, "0")}</Doto>
            </div>
        </div>
    );
}

/* ── Ring ─────────────────────────────────────────────────────────────────── */
/** 270° gauge with a Doto center value + a right-side legend & sparkline. */
function Ring({ data, label }: P): ReactElement {
    const pct = clampPct(avg(data));
    const frac = Math.max(0.04, pct / 100);
    const R = 15.5, C = 2 * Math.PI * R, SWEEP = 0.75, dash = C * SWEEP;
    const shown = Math.round(pct);
    const last = data.length - 1;
    const spark = data.map((b, i) => `${(i / Math.max(1, last)) * 100},${16 - (clampPct(b) / 100) * 14}`).join(" ");
    return (
        <div className="wr-ring" aria-hidden="true">
            <div className="wr-ring-dial">
                <svg viewBox="0 0 40 40">
                    <circle cx="20" cy="20" r={R} className="bg" strokeDasharray={`${dash} ${C}`} />
                    <circle cx="20" cy="20" r={R} className="fg" strokeDasharray={`${dash} ${C}`} strokeDashoffset={dash * (1 - frac)} />
                </svg>
                <span className="wr-ring-val rdx-doto">{shown}</span>
            </div>
            <div className="wr-ring-meta">
                <span className="wr-ring-num">{shown}<i>%</i></span>
                <span className="wr-ring-label">{label ?? "avg"}</span>
                <svg className="wr-ring-spark" viewBox="0 0 100 16" preserveAspectRatio="none">
                    <polyline points={spark} fill="none" stroke="var(--card-accent)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                </svg>
            </div>
        </div>
    );
}

/* ── Radar ────────────────────────────────────────────────────────────────── */
/** Polar radar polygon over a faint web - a balance/profile readout. The fill
 *  breathes; 3..7 axes depending on data length, sized to fill the box height. */
function Radar({ data, label }: P): ReactElement {
    const axes = Math.max(3, Math.min(7, data.length || 5));
    const vals = take(data.length ? data : [60, 80, 40, 70, 55], axes);
    const max = Math.max(...vals, 1);
    const cx = 23, cy = 23, R = 21;
    const ang = (i: number) => -Math.PI / 2 + (i / axes) * Math.PI * 2;
    const rad = (v: number) => (clamp01(v / max) * 0.84 + 0.08) * R;
    const at = (i: number, r: number): [number, number] => [cx + Math.cos(ang(i)) * r, cy + Math.sin(ang(i)) * r];
    const fmt = (p: [number, number]) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
    const poly = vals.map((v, i) => fmt(at(i, rad(v)))).join(" ");
    const rings = [0.34, 0.62, 0.9];
    return (
        <div className="wr-radar" aria-hidden="true" title={label}>
            <svg className="wr-radar-svg" viewBox="0 0 46 46">
                {rings.map((rr, k) => (
                    <polygon key={k} className="web"
                        points={Array.from({ length: axes }, (_, i) => fmt(at(i, rr * R))).join(" ")} />
                ))}
                {Array.from({ length: axes }, (_, i) => {
                    const [x, y] = at(i, R * 0.9);
                    return <line key={i} className="spoke" x1={cx} y1={cy} x2={x.toFixed(2)} y2={y.toFixed(2)} />;
                })}
                <polygon className="wr-radar-fill" points={poly} />
                {vals.map((v, i) => {
                    const [x, y] = at(i, rad(v));
                    return <circle key={i} className="wr-radar-node" cx={x.toFixed(2)} cy={y.toFixed(2)} r={1.6} />;
                })}
            </svg>
            <div className="wr-radar-legend">
                {vals.map((v, i) => (
                    <span key={i} className="wr-radar-bar">
                        <i style={{ width: `${clamp01(v / max) * 100}%` }} />
                    </span>
                ))}
            </div>
        </div>
    );
}

/* ── Wave (oscilloscope) ────────────────────────────────────────────────────── */
/** Oscilloscope: the series traces a scope line over a centre graticule, with a
 *  travelling scan beam. The trace itself is static (real data); the beam sweeps. */
function Wave({ data, label }: P): ReactElement {
    const [wrap, w] = useWidth();
    const H = 46, mid = H / 2, n = Math.max(2, data.length);
    const pts = take(data.length ? data : [50, 80, 20, 60, 35, 70], n);
    const max = Math.max(...pts, 1), min = Math.min(...pts, 0), span = Math.max(1, max - min);
    const xy = pts.map((v, i) => {
        const x = (i / (n - 1)) * (w - 2) + 1;
        const y = mid + (0.5 - (v - min) / span) * (H - 10);
        return [x, y] as const;
    });
    const d = xy.map(([x, y], i) => `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");
    return (
        <div className="wr-wave-wrap" ref={wrap} title={label}>
            <svg className="wr-wave" width={w} height={H} viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none" aria-hidden="true">
                <line className="wr-wave-grat" x1={0} y1={mid} x2={w} y2={mid} />
                <line className="wr-wave-grat dash" x1={w * 0.5} y1={2} x2={w * 0.5} y2={H - 2} />
                <path className="wr-wave-trace" d={d} fill="none" vectorEffect="non-scaling-stroke" />
                <rect className="wr-wave-beam" x={0} y={0} width={Math.max(8, w * 0.18)} height={H} />
            </svg>
        </div>
    );
}

/* ── Stream (stacked ribbon) ──────────────────────────────────────────────────── */
/** Streamgraph: the series split into two interleaved bands flowing around a
 *  wavy centreline - a "where the volume went" ribbon. */
function Stream({ data, label }: P): ReactElement {
    const [wrap, w] = useWidth();
    const H = 46, n = Math.max(2, Math.min(40, data.length || 12));
    const pts = take(data.length ? data : [40, 65, 30, 80, 50, 70, 45], n);
    const max = Math.max(...pts, 1);
    const baseY = (i: number) => H / 2 + Math.sin((i / (n - 1)) * Math.PI * 1.6) * 5;
    const X = (i: number) => (i / (n - 1)) * w;
    const upTop: string[] = [], dnBot: string[] = [];
    pts.forEach((v, i) => {
        const t = clamp01(v / max), h = 2 + t * 17, b = baseY(i);
        upTop.push(`${X(i).toFixed(1)},${(b - h).toFixed(1)}`);
        dnBot.push(`${X(i).toFixed(1)},${(b + h * 0.72).toFixed(1)}`);
    });
    const baseFwd = pts.map((_, i) => `${X(i).toFixed(1)},${baseY(i).toFixed(1)}`);
    const upPath = `M ${upTop.join(" L ")} L ${[...baseFwd].reverse().join(" L ")} Z`;
    const dnPath = `M ${baseFwd.join(" L ")} L ${[...dnBot].reverse().join(" L ")} Z`;
    return (
        <div className="wr-stream-wrap" ref={wrap} title={label}>
            <svg className="wr-stream" width={w} height={H} viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none" aria-hidden="true">
                <path className="wr-stream-up" d={upPath} />
                <path className="wr-stream-dn" d={dnPath} />
                <path className="wr-stream-mid" d={`M ${baseFwd.join(" L ")}`} fill="none" vectorEffect="non-scaling-stroke" />
            </svg>
        </div>
    );
}

/* ── Scatter (dot-density) ──────────────────────────────────────────────────── */
/** Dot-density plot: each point is a node positioned by value (y) over index (x),
 *  with a faint trend baseline. Reads as a measurement cloud, not a chart. */
function Scatter({ data, label }: P): ReactElement {
    const pts = (data.length ? data : [30, 50, 45, 70, 60, 85, 55, 40]);
    const n = pts.length;
    const max = Math.max(...pts, 1), min = Math.min(...pts, 0), span = Math.max(1, max - min);
    const mean = avg(pts);
    const meanY = (4 + (1 - (mean - min) / span) * 38).toFixed(1);
    return (
        <div className="wr-scatter" aria-hidden="true" title={label}>
            <svg className="wr-scatter-svg" viewBox="0 0 100 46" preserveAspectRatio="none">
                <line className="wr-scatter-mean" x1={0} y1={meanY} x2={100} y2={meanY} vectorEffect="non-scaling-stroke" />
            </svg>
            <div className="wr-scatter-dots">
                {pts.map((v, i) => {
                    const x = n === 1 ? 50 : (i / (n - 1)) * 100;
                    const y = 4 + (1 - (v - min) / span) * 38;
                    const hot = v >= mean;
                    return <span key={i} className={`wr-scatter-dot${hot ? " hot" : ""}`}
                        style={{ left: `${x}%`, top: `${y}px`, animationDelay: `${0.1 + i * 0.04}s` } as CSSProperties} />;
                })}
            </div>
        </div>
    );
}

/* ── Bullet (actual vs target) ──────────────────────────────────────────────── */
/** Bullet chart: a qualitative range track, the actual value as a filled bar,
 *  and a target as a vertical tick - a single KPI-against-goal readout. */
function Bullet({ data, label }: P): ReactElement {
    const vals = data.length ? data : [68, 82];
    const actual = clampPct(vals[vals.length - 1] ?? 0);
    const target = clampPct(vals.length >= 2 ? (vals[0] ?? 0) : avg(vals) + 14);
    const onTrack = actual >= target;
    return (
        <div className="wr-bullet" aria-hidden="true" title={label}>
            <div className="wr-bullet-track">
                <span className="wr-bullet-band b1" />
                <span className="wr-bullet-band b2" />
                <span className="wr-bullet-band b3" />
                <span className="wr-bullet-fill" style={{ width: `${actual}%` }} />
                <span className={`wr-bullet-tick${onTrack ? " ok" : ""}`} style={{ left: `${target}%` }} />
            </div>
            <div className="wr-bullet-foot">
                <Doto className="wr-bullet-val">{String(Math.round(actual)).padStart(2, "0")}</Doto>
                <span className="wr-ring-label">/ {Math.round(target)} {label ?? "goal"}</span>
            </div>
        </div>
    );
}

/* ── Comet (orbit progress) ───────────────────────────────────────────────────── */
/** Orbit progress: a comet rides an elliptical track to the percentage point,
 *  trailing a fading tail. The comet head pulses; reads as a progress orbit. */
function Comet({ data, label }: P): ReactElement {
    const pct = clampPct(avg(data));
    const frac = Math.max(0.02, pct / 100);
    const cx = 23, cy = 23, rx = 19, ry = 15;
    const C = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry))); // Ramanujan
    const dash = C * frac;
    const ang = -Math.PI / 2 + frac * Math.PI * 2;
    const hx = (cx + Math.cos(ang) * rx).toFixed(2), hy = (cy + Math.sin(ang) * ry).toFixed(2);
    const shown = Math.round(pct);
    return (
        <div className="wr-comet" aria-hidden="true" title={label}>
            <svg className="wr-comet-svg" viewBox="0 0 46 46">
                <ellipse className="wr-comet-orbit" cx={cx} cy={cy} rx={rx} ry={ry} />
                <ellipse className="wr-comet-trail" cx={cx} cy={cy} rx={rx} ry={ry}
                    strokeDasharray={`${dash.toFixed(2)} ${C.toFixed(2)}`}
                    transform={`rotate(-90 ${cx} ${cy})`} pathLength={C} />
                <circle className="wr-comet-head" cx={hx} cy={hy} r={2.6} />
            </svg>
            <div className="wr-comet-meta">
                <span className="wr-radar-n rdx-doto">{shown}</span>
                <span className="wr-ring-label">{label ?? "orbit %"}</span>
            </div>
        </div>
    );
}

/* ── Waffle (grid-fill) ───────────────────────────────────────────────────────── */
/** Waffle / grid-fill: a 5×N square grid fills cell-by-cell to the percentage -
 *  a tactile "X out of 100" share readout. The leading cell glints. */
function Waffle({ data, label }: P): ReactElement {
    const pct = clampPct(avg(data));
    const ROWS = 5, COLS = 14, total = ROWS * COLS;
    const on = Math.round((pct / 100) * total);
    return (
        <div className="wr-waffle" aria-hidden="true" title={label}>
            <div className="wr-waffle-grid" style={{ ["--wc"]: COLS, ["--wr"]: ROWS } as CSSProperties}>
                {Array.from({ length: total }, (_, i) => {
                    // column-major fill so it reads as rising columns, receipt-like
                    const col = i % COLS, row = Math.floor(i / COLS);
                    const order = col * ROWS + (ROWS - 1 - row);
                    const lit = order < on;
                    return <span key={i} className={`wr-waffle-cell${lit ? " on" : ""}${lit && order === on - 1 ? " lead" : ""}`}
                        style={{ animationDelay: `${0.1 + order * 0.006}s` } as CSSProperties} />;
                })}
            </div>
            <div className="wr-waffle-meta">
                <Doto className="wr-bullet-val">{Math.round(pct)}</Doto>
                <span className="wr-ring-label">{label ?? "%"}</span>
            </div>
        </div>
    );
}

/* ── Candles (OHLC bars) ─────────────────────────────────────────────────────── */
/** Candlestick bars: consecutive value pairs form open/close bodies with a wick,
 *  up vs down toned by direction - a session-by-session swing readout. */
function Candles({ data, label }: P): ReactElement {
    const src = data.length >= 2 ? data : [40, 60, 55, 75, 70, 50, 62, 80];
    const MAX = 12;
    const series = take(src, Math.min(MAX, Math.max(3, src.length)));
    const max = Math.max(...series, 1), min = Math.min(...series, 0), span = Math.max(1, max - min);
    const Y = (v: number) => 4 + (1 - (v - min) / span) * 36; // px in 46h, padded
    return (
        <div className="wr-candles" role="img" aria-label={label} style={{ ["--cn"]: series.length } as CSSProperties}>
            {series.map((v, i) => {
                const prev = (i === 0 ? series[0] : series[i - 1]) ?? v;
                const up = v >= prev;
                const oY = Y(prev), cY = Y(v);
                const top = Math.min(oY, cY), bodyH = Math.max(2, Math.abs(cY - oY));
                const wickTop = Math.min(top, Y(Math.max(v, prev)) - 3);
                const wickBot = Math.max(top + bodyH, Y(Math.min(v, prev)) + 3);
                return (
                    <span key={i} className={`wr-candle${up ? " up" : " dn"}`} style={{ animationDelay: `${0.08 + i * 0.05}s` } as CSSProperties}>
                        <span className="wr-candle-wick" style={{ top: `${wickTop}px`, height: `${Math.max(3, wickBot - wickTop)}px` }} />
                        <span className="wr-candle-body" style={{ top: `${top}px`, height: `${bodyH}px` }} />
                    </span>
                );
            })}
        </div>
    );
}

/* ── Signal (telecom bars) ────────────────────────────────────────────────────── */
/** Signal-strength readout: ascending stepped bars (reception style), lit up to
 *  the value, plus a small Doto strength. The top lit bar pulses like a live link. */
function Signal({ data, label }: P): ReactElement {
    const pct = clampPct(avg(data));
    const BARS = 6;
    const on = Math.max(1, Math.round((pct / 100) * BARS));
    return (
        <div className="wr-signal" aria-hidden="true" title={label}>
            <div className="wr-signal-bars">
                {Array.from({ length: BARS }, (_, i) => {
                    const lit = i < on;
                    return <span key={i} className={`wr-signal-bar${lit ? " on" : ""}${lit && i === on - 1 ? " live" : ""}`}
                        style={{ height: `${28 + (i / (BARS - 1)) * 70}%`, animationDelay: `${0.1 + i * 0.06}s` } as CSSProperties} />;
                })}
            </div>
            <div className="wr-signal-meta">
                <span className="wr-signal-n rdx-doto">{on}<i>/{BARS}</i></span>
                <span className="wr-ring-label">{label ?? "signal"}</span>
            </div>
        </div>
    );
}

/* ── Delta (big number + trend) ──────────────────────────────────────────────── */
/** Delta readout: a large Doto figure (latest value) with a trend arrow + Δ vs the
 *  series start, over a hairline micro-sparkline. The arrow tints up/down. */
function Delta({ data, label }: P): ReactElement {
    const pts = data.length ? data : [40, 55, 48, 62, 70];
    const last = pts[pts.length - 1] ?? 0, first = pts[0] ?? 0;
    const diff = last - first;
    const up = diff >= 0;
    const n = pts.length, max = Math.max(...pts, 1), min = Math.min(...pts, 0), span = Math.max(1, max - min);
    const spark = pts.map((v, i) => `${(i / Math.max(1, n - 1)) * 100},${14 - ((v - min) / span) * 12}`).join(" ");
    return (
        <div className={`wr-delta${up ? " up" : " dn"}`} aria-hidden="true" title={label}>
            <div className="wr-delta-num">
                <Doto className="wr-delta-val">{Math.round(last)}</Doto>
                <span className="wr-delta-trend">
                    <i className="wr-delta-arrow">{up ? "▲" : "▼"}</i>
                    {Math.abs(Math.round(diff))}
                </span>
            </div>
            <svg className="wr-delta-spark" viewBox="0 0 100 14" preserveAspectRatio="none">
                <polyline points={spark} fill="none" stroke="var(--card-accent)" strokeWidth="1.25" vectorEffect="non-scaling-stroke" />
            </svg>
        </div>
    );
}

const REGISTRY: Record<VizKind, (p: P) => ReactElement> = {
    bars: Bars, line: Line, cells: CellMatrix, meter: SegMeter, ring: Ring,
    radar: Radar, wave: Wave, stream: Stream, scatter: Scatter, bullet: Bullet,
    comet: Comet, waffle: Waffle, candles: Candles, signal: Signal, delta: Delta,
};
/** Deck cycles this list positionally - ordered to maximise shape variety
 *  between adjacent cards (no two neighbours share a family). */
export const VIZ_KINDS: VizKind[] = [
    "bars", "radar", "line", "waffle", "candles", "comet",
    "wave", "bullet", "cells", "stream", "signal", "scatter",
    "meter", "delta", "ring",
];

/** Render an approved viz from its declarative spec. */
export function CardViz({ spec }: { spec: VizSpec }): ReactElement {
    const C = REGISTRY[spec.kind] ?? Bars;
    return <C data={spec.data} label={spec.label} />;
}
