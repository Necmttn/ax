// apps/site/app/components/radar-chart.tsx
//
// Dependency-free SVG spider/radar chart for the agent-sign dossier section.
// Renders 1 or 2 series over the six fixed RADAR axes. Pure geometry, no JS
// interactivity beyond <title> tooltips on the vertices (so SSR == client).
//
// Untrusted strings (login) render as text only - never as markup.

import { RADAR_AXES_META, type RadarAxes } from "~/lib/radar";

export interface RadarSeries {
    readonly login: string;
    readonly axes: RadarAxes;
    /** stroke/fill base colour, e.g. var(--green) or #2567a8 */
    readonly color: string;
}

const RINGS = [20, 40, 60, 80, 100] as const;
const N = RADAR_AXES_META.length; // 6

/** angle (radians) for axis i; first spoke points straight up, clockwise. */
function angleFor(i: number): number {
    return -Math.PI / 2 + (i / N) * Math.PI * 2;
}

/** map a 0..100 value on axis i to an [x,y] point inside the chart box. */
function point(cx: number, cy: number, radius: number, i: number, value: number): readonly [number, number] {
    const r = (Math.max(0, Math.min(100, value)) / 100) * radius;
    const a = angleFor(i);
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
}

const fmt = (n: number): string => (Math.round(n * 10) / 10).toString();

export function RadarChart({
    series,
    size = 420,
}: {
    series: readonly RadarSeries[];
    size?: number;
}) {
    const pad = 58; // room for spoke labels outside the rings
    const cx = size / 2;
    const cy = size / 2;
    const radius = size / 2 - pad;

    // concentric ring circles - a circle can never resolve into the
    // isometric-cube faces that nested hexagons read as, so the data shapes
    // (not the grid) dominate the chart.
    const ringCircles = RINGS.map((pct) => ({ pct, r: (pct / 100) * radius }));

    // spoke endpoints + label anchors
    const spokes = RADAR_AXES_META.map((meta, i) => {
        const a = angleFor(i);
        const ex = cx + Math.cos(a) * radius;
        const ey = cy + Math.sin(a) * radius;
        const lx = cx + Math.cos(a) * (radius + 22);
        const ly = cy + Math.sin(a) * (radius + 22);
        // horizontal anchoring by quadrant so labels don't overlap the rings
        const cos = Math.cos(a);
        const anchor: "middle" | "start" | "end" =
            Math.abs(cos) < 0.25 ? "middle" : cos > 0 ? "start" : "end";
        // nudge top/bottom labels vertically off the spoke tip
        const sin = Math.sin(a);
        const dy = Math.abs(sin) < 0.25 ? 0 : sin > 0 ? 11 : -4;
        return { meta, ex, ey, lx, ly, anchor, dy };
    });

    return (
        <div className="pf-radar-wrap">
            <svg
                className="pf-radar"
                viewBox={`0 0 ${size} ${size}`}
                role="img"
                aria-label={`radar chart comparing ${series.map((s) => `@${s.login}`).join(" and ")} across six axes`}
            >
                {/* rings */}
                {ringCircles.map((ring) => (
                    <circle
                        key={ring.pct}
                        className={ring.pct === 100 ? "pf-radar-ring pf-radar-ring--outer" : "pf-radar-ring"}
                        cx={cx}
                        cy={cy}
                        r={ring.r}
                    />
                ))}

                {/* spokes + labels */}
                {spokes.map((s) => (
                    <g key={s.meta.key}>
                        <line className="pf-radar-spoke" x1={cx} y1={cy} x2={s.ex} y2={s.ey} />
                        <text
                            className="pf-radar-axis-label"
                            x={s.lx}
                            y={s.ly + s.dy}
                            textAnchor={s.anchor}
                        >
                            {s.meta.label}
                        </text>
                    </g>
                ))}

                {/* series polygons (drawn back-to-front: first series on top) */}
                {[...series].reverse().map((serie) => {
                    const pts = RADAR_AXES_META.map((meta, i) =>
                        point(cx, cy, radius, i, serie.axes.scores[meta.key]),
                    );
                    const poly = pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
                    return (
                        <g key={serie.login} style={{ color: serie.color }}>
                            <polygon className="pf-radar-area" points={poly} />
                            {pts.map(([x, y], i) => (
                                <circle key={RADAR_AXES_META[i]!.key} className="pf-radar-dot" cx={x} cy={y} r={3.4}>
                                    <title>{`@${serie.login} · ${RADAR_AXES_META[i]!.label}: ${fmt(serie.axes.scores[RADAR_AXES_META[i]!.key])}`}</title>
                                </circle>
                            ))}
                        </g>
                    );
                })}
            </svg>

            {series.length > 1 && (
                <div className="pf-radar-legend">
                    {series.map((s) => (
                        <span className="pf-radar-chip" key={s.login}>
                            <span className="pf-radar-chip-swatch" style={{ background: s.color }} aria-hidden="true" />
                            @{s.login}
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}
