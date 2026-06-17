// apps/site/app/components/card-viz.tsx
//
// Shared wrapped-recap chart kit. These 12 chart components are static
// recreations of the studio card-viz registry (apps/studio/src/instrument/
// card-viz.tsx); each keys off the `--card-accent` CSS var and the dark
// `.browser--instrument .mc-*` rules in globals.css. They are consumed both by
// the landing demo (floating POP_CHARTS in landing-v2/dashboard-preview.tsx)
// and by the profile wrapped deck (CardViz dispatcher below). Pure render
// functions, no hooks - safe to import from server- and client-rendered trees.

import type { JSX } from "react";

// ---- chart components (moved verbatim from dashboard-preview.tsx) ----------

export function McBars({ data }: { data: number[] }) {
  const max = Math.max(...data, 1);
  const last = data.length - 1;
  return (
    <div className="mc-bars" aria-hidden="true">
      {data.map((b, i) => (
        <i
          key={i}
          className={i === last ? "is-now" : undefined}
          style={{ height: `${Math.max(6, (b / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

export function McLine({ data }: { data: number[] }) {
  const W = 100;
  const H = 46;
  const padX = 2;
  const padT = 5;
  const padB = 5;
  const uh = H - padT - padB;
  const n = data.length;
  const max = Math.max(...data, 1);
  const xy = data.map((v, i) => [padX + (i / (n - 1)) * (W - 2 * padX), padT + (1 - v / max) * uh] as const);
  const stroke = `M ${xy.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" L ")}`;
  const area = `${stroke} L ${xy[n - 1]![0].toFixed(1)} ${H - padB} L ${xy[0]![0].toFixed(1)} ${H - padB} Z`;
  return (
    <svg className="mc-line" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="mcLineFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--card-accent)" stopOpacity="0.32" />
          <stop offset="100%" stopColor="var(--card-accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#mcLineFill)" />
      <path d={stroke} className="mc-line-stroke" fill="none" />
    </svg>
  );
}

export function McRadar({ data }: { data: number[] }) {
  const axes = data.length;
  const cx = 23;
  const cy = 23;
  const R = 21;
  const max = Math.max(...data, 1);
  const ang = (i: number) => -Math.PI / 2 + (i / axes) * Math.PI * 2;
  const at = (i: number, r: number) => [cx + Math.cos(ang(i)) * r, cy + Math.sin(ang(i)) * r] as const;
  const rad = (v: number) => ((v / max) * 0.84 + 0.08) * R;
  const fmt = (p: readonly [number, number]) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
  const poly = data.map((v, i) => fmt(at(i, rad(v)))).join(" ");
  return (
    <svg className="mc-radar" viewBox="0 0 46 46" aria-hidden="true">
      {[0.4, 0.7, 1].map((rr, k) => (
        <polygon key={k} className="web" points={Array.from({ length: axes }, (_, i) => fmt(at(i, rr * R))).join(" ")} />
      ))}
      <polygon className="mc-radar-fill" points={poly} />
      {data.map((v, i) => {
        const [x, y] = at(i, rad(v));
        return <circle key={i} className="mc-radar-node" cx={x.toFixed(1)} cy={y.toFixed(1)} r={1.5} />;
      })}
    </svg>
  );
}

export function McRing({ pct }: { pct: number }) {
  const R = 15.5;
  const C = 2 * Math.PI * R;
  const dash = C * 0.75;
  const frac = Math.max(0.04, pct / 100);
  return (
    <div className="mc-ring" aria-hidden="true">
      <svg viewBox="0 0 40 40">
        <circle cx="20" cy="20" r={R} className="bg" strokeDasharray={`${dash} ${C}`} />
        <circle cx="20" cy="20" r={R} className="fg" strokeDasharray={`${dash} ${C}`} strokeDashoffset={dash * (1 - frac)} />
      </svg>
      <span className="mc-ring-val">{pct}</span>
    </div>
  );
}

export function McWaffle({ pct }: { pct: number }) {
  const ROWS = 5;
  const COLS = 14;
  const total = ROWS * COLS;
  const on = Math.round((pct / 100) * total);
  return (
    <div className="mc-waffle" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => {
        const col = i % COLS;
        const row = Math.floor(i / COLS);
        const order = col * ROWS + (ROWS - 1 - row);
        return <span key={i} className={`mc-waffle-cell${order < on ? " on" : ""}`} />;
      })}
    </div>
  );
}

export function McCandles({ data }: { data: number[] }) {
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const span = Math.max(1, max - min);
  const Y = (v: number) => 4 + (1 - (v - min) / span) * 36;
  return (
    <div className="mc-candles" aria-hidden="true">
      {data.map((v, i) => {
        const prev = (i === 0 ? data[0] : data[i - 1]) ?? v;
        const up = v >= prev;
        const oY = Y(prev);
        const cY = Y(v);
        const top = Math.min(oY, cY);
        const bodyH = Math.max(2, Math.abs(cY - oY));
        const wickTop = Math.min(top, Y(Math.max(v, prev)) - 3);
        const wickBot = Math.max(top + bodyH, Y(Math.min(v, prev)) + 3);
        return (
          <span key={i} className={`mc-candle ${up ? "up" : "dn"}`}>
            <span className="mc-candle-wick" style={{ top: `${wickTop}px`, height: `${Math.max(3, wickBot - wickTop)}px` }} />
            <span className="mc-candle-body" style={{ top: `${top}px`, height: `${bodyH}px` }} />
          </span>
        );
      })}
    </div>
  );
}

export function McComet({ pct }: { pct: number }) {
  const cx = 23;
  const cy = 23;
  const rx = 19;
  const ry = 15;
  const frac = Math.max(0.02, pct / 100);
  const C = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
  const dash = C * frac;
  const ang = -Math.PI / 2 + frac * Math.PI * 2;
  const hx = cx + Math.cos(ang) * rx;
  const hy = cy + Math.sin(ang) * ry;
  return (
    <div className="mc-comet" aria-hidden="true">
      <svg viewBox="0 0 46 46">
        <ellipse className="mc-comet-orbit" cx={cx} cy={cy} rx={rx} ry={ry} />
        <ellipse
          className="mc-comet-trail"
          cx={cx}
          cy={cy}
          rx={rx}
          ry={ry}
          strokeDasharray={`${dash.toFixed(1)} ${C.toFixed(1)}`}
          transform={`rotate(-90 ${cx} ${cy})`}
        />
        <circle className="mc-comet-head" cx={hx.toFixed(1)} cy={hy.toFixed(1)} r={2.6} />
      </svg>
    </div>
  );
}

export function McWave({ data }: { data: number[] }) {
  const W = 100;
  const H = 46;
  const mid = H / 2;
  const n = data.length;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const span = Math.max(1, max - min);
  const d = data
    .map((v, i) => {
      const x = (i / (n - 1)) * (W - 2) + 1;
      const y = mid + (0.5 - (v - min) / span) * (H - 10);
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg className="mc-wave" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <line className="mc-wave-grat" x1="0" y1={mid} x2={W} y2={mid} />
      <line className="mc-wave-grat dash" x1={W * 0.5} y1="2" x2={W * 0.5} y2={H - 2} />
      <path className="mc-wave-trace" d={d} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function McBullet({ actual, target }: { actual: number; target: number }) {
  const onTrack = actual >= target;
  return (
    <div className="mc-bullet" aria-hidden="true">
      <div className="mc-bullet-track">
        <span className="mc-bullet-fill" style={{ width: `${actual}%` }} />
        <span className={`mc-bullet-tick${onTrack ? " ok" : ""}`} style={{ left: `${target}%` }} />
      </div>
      <div className="mc-bullet-foot">
        <span className="mc-bullet-val">{actual}</span>
        <span className="mc-bullet-goal">/ {target} goal</span>
      </div>
    </div>
  );
}

export function McSignal({ on, bars = 6 }: { on: number; bars?: number }) {
  return (
    <div className="mc-signal" aria-hidden="true">
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          className={`mc-signal-bar${i < on ? " on" : ""}`}
          style={{ height: `${28 + (i / (bars - 1)) * 70}%` }}
        />
      ))}
    </div>
  );
}

export function McScatter({ data }: { data: number[] }) {
  const n = data.length;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const span = Math.max(1, max - min);
  const mean = data.reduce((a, b) => a + b, 0) / n;
  const meanY = 4 + (1 - (mean - min) / span) * 38;
  return (
    <div className="mc-scatter" aria-hidden="true">
      <svg className="mc-scatter-svg" viewBox="0 0 100 46" preserveAspectRatio="none">
        <line className="mc-scatter-mean" x1="0" y1={meanY.toFixed(1)} x2="100" y2={meanY.toFixed(1)} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mc-scatter-dots">
        {data.map((v, i) => {
          const x = (i / (n - 1)) * 100;
          const y = 4 + (1 - (v - min) / span) * 38;
          return <span key={i} className={`mc-scatter-dot${v >= mean ? " hot" : ""}`} style={{ left: `${x}%`, top: `${y}px` }} />;
        })}
      </div>
    </div>
  );
}

export function McDelta({ data }: { data: number[] }) {
  const last = data[data.length - 1] ?? 0;
  const first = data[0] ?? 0;
  const diff = last - first;
  const up = diff >= 0;
  const n = data.length;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const span = Math.max(1, max - min);
  const spark = data.map((v, i) => `${(i / (n - 1)) * 100},${(14 - ((v - min) / span) * 12).toFixed(1)}`).join(" ");
  return (
    <div className={`mc-delta ${up ? "up" : "dn"}`} aria-hidden="true">
      <div className="mc-delta-num">
        <span className="mc-delta-val">{Math.round(last)}</span>
        <span className="mc-delta-trend">
          <i>{up ? "▲" : "▼"}</i>
          {Math.abs(Math.round(diff))}
        </span>
      </div>
      <svg className="mc-delta-spark" viewBox="0 0 100 14" preserveAspectRatio="none">
        <polyline points={spark} fill="none" stroke="var(--card-accent)" strokeWidth="1.25" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

// ---- uniform spec + dispatcher --------------------------------------------

export type VizKind =
  | "bars"
  | "line"
  | "radar"
  | "ring"
  | "waffle"
  | "candles"
  | "comet"
  | "wave"
  | "bullet"
  | "signal"
  | "scatter"
  | "delta";

/**
 * A grounded chart spec. `data` is always a `number[]`; the dispatcher adapts
 * it to each component's native props:
 *  - series kinds (bars/line/wave/candles/scatter/delta/radar) consume the
 *    whole array;
 *  - gauge kinds (ring/waffle/comet) read `data[0]` as a 0..100 percent;
 *  - signal reads `[on, bars?]`; bullet reads `[actual, target]` as 0..100.
 */
export interface VizSpec {
  readonly kind: VizKind;
  readonly data: number[];
  readonly label?: string;
}

/**
 * Fixed/small chart kinds the deck centers horizontally (mirrors POP_CENTERED
 * in dashboard-preview.tsx); the rest are full-width and stretch.
 */
export const VIZ_CENTERED: ReadonlySet<VizKind> = new Set<VizKind>([
  "ring",
  "radar",
  "comet",
  "waffle",
]);

/** Series kinds that divide by (n-1) and need at least 2 points to be valid. */
const SERIES_KINDS: ReadonlySet<VizKind> = new Set<VizKind>([
  "line",
  "wave",
  "scatter",
  "delta",
  "candles",
]);

/** Dispatch a VizSpec to its chart component. Renders nothing for a degenerate
 *  series (fewer than 2 points) so callers can pass-through without guarding. */
export function CardViz({ spec }: { spec: VizSpec }): JSX.Element | null {
  const d = spec.data;
  if (SERIES_KINDS.has(spec.kind) && d.length < 2) return null;
  switch (spec.kind) {
    case "bars":
      return <McBars data={d} />;
    case "line":
      return <McLine data={d} />;
    case "wave":
      return <McWave data={d} />;
    case "candles":
      return <McCandles data={d} />;
    case "scatter":
      return <McScatter data={d} />;
    case "delta":
      return <McDelta data={d} />;
    case "radar":
      return <McRadar data={d} />;
    case "ring":
      return <McRing pct={Math.round(d[0] ?? 0)} />;
    case "waffle":
      return <McWaffle pct={d[0] ?? 0} />;
    case "comet":
      return <McComet pct={d[0] ?? 0} />;
    case "signal":
      return <McSignal on={d[0] ?? 0} bars={d[1] ?? 6} />;
    case "bullet":
      return <McBullet actual={Math.round(d[0] ?? 0)} target={Math.round(d[1] ?? 0)} />;
  }
}
