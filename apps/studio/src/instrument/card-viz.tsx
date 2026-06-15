/**
 * Approved card-viz registry - a small set of blessed, reusable instrument
 * visuals the wrapped agent can target DECLARATIVELY (json-render.dev mindset).
 * A card carries a `viz` spec ({ kind, data, label }); CardViz maps the kind to
 * a component. Until the agent emits specs, the deck assigns a kind positionally.
 * Each viz is self-contained, robust to any data length, and keyed to
 * var(--card-accent). Built from the per-visual design-curator roasts.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { Doto, Segbar } from "./viz.tsx";

export type VizKind = "bars" | "line" | "cells" | "meter" | "ring";
export interface VizSpec { readonly kind: VizKind; readonly data: number[]; readonly label?: string }
interface P { readonly data: number[]; readonly label?: string }

const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
const clampPct = (n: number) => (Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0);

/** Vertical bars with a hairline baseline, peak tick, and a live "now" cap. */
function Bars({ data, label }: P): ReactElement {
    if (data.length === 0) return <div className="wr-bars" aria-hidden="true" />;
    const peak = data.reduce((m, b, i) => (b > data[m] ? i : m), 0);
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

/** Smooth area sparkline, real-aspect (measured), with a pulsing last point. */
function Line({ data, label }: P): ReactElement {
    const wrap = useRef<HTMLDivElement>(null);
    const [w, setW] = useState(220);
    useEffect(() => {
        const el = wrap.current;
        if (!el) return;
        const ro = new ResizeObserver((e) => setW(Math.max(40, e[0].contentRect.width)));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
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
        ? `M ${xy[0][0]} ${xy[0][1]} L ${w - padX} ${xy[0][1]}`
        : xy.reduce((acc, [x, y], i) => {
            if (i === 0) return `M ${x} ${y}`;
            const [x0, y0] = xy[Math.max(0, i - 2)];
            const [x1, y1] = xy[i - 1];
            const [x2, y2] = xy[Math.min(n - 1, i + 1)];
            return `${acc} C ${x1 + (x - x0) / 6} ${y1 + (y - y0) / 6}, ${x - (x2 - x1) / 6} ${y - (y2 - y1) / 6}, ${x} ${y}`;
        }, "");
    const [lx, ly] = xy[xy.length - 1];
    const area = `${d} L ${lx} ${H - PAD_B + 4} L ${xy[0][0]} ${H - PAD_B + 4} Z`;
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

/** Dual-row segmented readout: per-point heat strip over a battery meter. */
function SegMeter({ data }: P): ReactElement {
    const n = data.length;
    const last = n ? data[n - 1] : 0;
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

const REGISTRY: Record<VizKind, (p: P) => ReactElement> = { bars: Bars, line: Line, cells: CellMatrix, meter: SegMeter, ring: Ring };
export const VIZ_KINDS: VizKind[] = ["bars", "line", "cells", "meter", "ring"];

/** Render an approved viz from its declarative spec. */
export function CardViz({ spec }: { spec: VizSpec }): ReactElement {
    const C = REGISTRY[spec.kind] ?? Bars;
    return <C data={spec.data} label={spec.label} />;
}
