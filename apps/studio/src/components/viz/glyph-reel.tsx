import { useEffect, useRef } from "react";

/**
 * Glyph reel - a canvas grid of rounded dots that morphs through a set of
 * procedural patterns (disc, ring, brackets, bars, dither, diamond...).
 * Adapted from nullframe's GlyphCard (MIT, github.com/m1ckc3s/nullframe).
 *
 * A single rAF loop drives the draw; DPR is capped at 2, work pauses when the
 * canvas is offscreen or the tab is hidden, and prefers-reduced-motion freezes
 * it on a single pattern. `seed` picks the starting pattern so a given
 * archetype always opens on the same glyph.
 */
const GW = 11;
const GH = 7;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const dist = (x: number, y: number) => Math.hypot(x - 5, (y - 3) * 1.25);

const PATS: ReadonlyArray<(x: number, y: number, t: number) => number> = [
    (x, y, t) => clamp01(1.1 - (dist(x, y) - 2.6 + 0.25 * Math.sin(t * 1.6)) * 0.8), // pulsing disc
    (x, y) => clamp01(1.1 - Math.abs(dist(x, y) - 2.7) * 0.8), // ring
    (x, y) => (Math.abs(Math.atan2(y - 3, x - 5)) < 0.62 ? 0.06 : clamp01(1.1 - Math.abs(dist(x, y) - 2.7) * 0.8)), // C
    (x, y) => Math.max(clamp01(1.1 - Math.abs(dist(x, y) - 2.7) * 0.8), dist(x, y) < 1 ? 0.95 : 0), // ring + dot
    (x, y) => (y >= 1 && y <= 5 && (x === 3 || x === 4 || x === 6 || x === 7) ? 0.92 : 0.06), // pause bars
    (x, y) => (((x === 2 || x === 8) && y >= 1 && y <= 5) || ((y === 1 || y === 5) && (x === 3 || x === 7)) ? 0.92 : 0.06), // brackets
    (x, y) => clamp01(1.1 - (Math.abs(x - 5) + Math.abs(y - 3)) * 0.36), // diamond
    (x, y, t) => {
        const h = (Math.sin(t * 1.9 + x * 0.9) + Math.sin(t * 1.3 + x * 1.7)) * 0.25 + 0.55;
        return GH - 1 - y < h * GH ? 0.84 : 0.06; // waveform bars
    },
    (x, y, t) => {
        const v = Math.sin(x * 12.9898 + y * 37.719 + Math.floor(t * 2.5 + ((x * 7 + y * 13) % 4)) * 78.233) * 43758.5;
        return (v - Math.floor(v)) * 0.92; // dither
    },
];

function easeOutBack(p: number): number {
    const c = 1.70158;
    const q = p - 1;
    return 1 + (c + 1) * q * q * q + c * q * q;
}

export function GlyphReel({ seed = 0 }: { readonly seed?: number }) {
    const ref = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const cv = ref.current;
        const ctx = cv?.getContext("2d");
        if (!cv || !ctx) return;
        const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        let w = cv.clientWidth;
        let h = cv.clientHeight;
        const size = () => {
            w = cv.clientWidth;
            h = cv.clientHeight;
            cv.width = Math.max(1, Math.round(w * dpr));
            cv.height = Math.max(1, Math.round(h * dpr));
        };
        size();
        const ro = new ResizeObserver(size);
        ro.observe(cv);

        const N = GW * GH;
        const cur = new Float32Array(N);
        const slam = new Float32Array(N).fill(0);
        const dly = new Float32Array(N);
        let pat = Math.abs(seed) % PATS.length;
        let switchAt = 1.6;
        let last = 0;
        let raf = 0;

        const draw = (t: number, step: number) => {
            if (!w || !h) return;
            if (!reduced && t >= switchAt) {
                pat = (pat + 1) % PATS.length;
                switchAt = t + 1.6;
                for (let i = 0; i < N; i++) {
                    dly[i] = t + Math.random() * 0.24;
                    slam[i] = 0;
                }
            }
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);
            const gap = 3;
            const cell = Math.min((w - (GW - 1) * gap) / GW, (h - (GH - 1) * gap) / GH);
            const ox = (w - (GW * cell + (GW - 1) * gap)) / 2;
            const oy = (h - (GH * cell + (GH - 1) * gap)) / 2;
            for (let y = 0; y < GH; y++) {
                for (let x = 0; x < GW; x++) {
                    const i = y * GW + x;
                    if (t > dly[i]) slam[i] = Math.min(1, slam[i] + step / 0.3);
                    cur[i] += (PATS[pat](x, y, t) - cur[i]) * Math.min(1, step * 10);
                    const v = clamp01(cur[i] * slam[i]);
                    // Floor at 28 so unlit cells still read as a dim dot matrix,
                    // ramp to 240 for lit cells.
                    const g = Math.round(28 + v * 212);
                    ctx.fillStyle = `rgb(${g},${g},${g})`;
                    const s = cell * (0.5 + 0.5 * easeOutBack(slam[i]));
                    const cx = ox + x * (cell + gap) + cell / 2;
                    const cy = oy + y * (cell + gap) + cell / 2;
                    ctx.beginPath();
                    ctx.roundRect(cx - s / 2, cy - s / 2, s, s, 2);
                    ctx.fill();
                }
            }
        };

        const frame = (nowMs: number) => {
            raf = requestAnimationFrame(frame);
            if (document.hidden) {
                last = 0;
                return;
            }
            const t = nowMs / 1000;
            const step = last ? Math.min(0.1, t - last) : 0.016;
            last = t;
            draw(t, step);
        };
        // Paint one frame immediately so the matrix is visible before rAF ticks.
        draw(0.016, 0.016);
        raf = requestAnimationFrame(frame);
        return () => {
            cancelAnimationFrame(raf);
            ro.disconnect();
        };
    }, [seed]);

    return (
        <div className="ax-glyph-reel" aria-hidden="true">
            <canvas ref={ref} />
        </div>
    );
}
