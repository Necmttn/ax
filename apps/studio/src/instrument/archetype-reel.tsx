/** An animated, per-archetype dot-matrix sigil that fills the whole hero card.
 *  Each archetype has a short sequence of glyph frames (a little pixel gag); the
 *  matrix morphs between them with a slam + sweep - the "switching animation".
 *  The canvas is full-bleed and draws ONLY the lit symbol dots, aligned to the
 *  card's 16px radial-dot field (.v-mc-hero background) - empty cells let that
 *  faint field show through, so the sigil reads as bright dots on the panel.
 *  cur initialises to frame[0] and a ResizeObserver repaints a static frame on
 *  layout, so it's never blank even on a hidden tab (where rAF is paused). */
import { useEffect, useRef } from "react";

const SS = 4;        // supersample per cell when rasterising the glyph
const PITCH = 16;    // px per dot cell - matches .v-mc-hero background-size 16px
const ORIGIN = 8;    // matches background-position 8px (dot centres land on grid)
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const hex = (h: string) => { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const; };
function easeOutBack(p: number) { const c = 1.70158, q = p - 1; return 1 + (c + 1) * q * q * q + c * q * q; }

/** A short, characterful frame sequence per archetype id (a mini pixel gag). */
const FRAMES: Record<string, string[]> = {
    architect: ["·", "▽", "◭", "▲"],          // scaffolds up into a solid triangle
    verifier: ["□", "▣", "✓", "✓"],           // empty box → fills → checks (twice, paranoid)
    debugger: ["·", "◌", "◉", "✕"],           // a speck becomes a bug, then gets squashed
    orchestrator: ["◆", "❖", "✦", "❖"],       // a star spinning up its agents
    "skill-collector": ["▪", "▤", "▦", "▩"],   // bricks stacking denser
    "context-curator": ["▭", "◫", "▤", "◫"],   // a book opening and closing
    "repo-hopper": ["›", "»", "⟫", "»"],       // chevrons hopping forward
    observer: ["◌", "○", "◉", "○"],            // an eye opening, focusing, blinking
};

/** Rasterise one glyph into a cols×rows coverage grid, scaled to ~0.62 of the
 *  card height and biased into the upper portion (so the bottom text scrim
 *  doesn't bury it). */
function sampleInto(ch: string, cols: number, rows: number): Float32Array {
    const W = cols * SS, H = rows * SS;
    const off = document.createElement("canvas");
    off.width = W; off.height = H;
    const ctx = off.getContext("2d")!;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${Math.round(H * 0.62)}px "Apple Symbols", "Segoe UI Symbol", system-ui, sans-serif`;
    ctx.fillText(ch, W / 2, H * 0.40);
    const d = ctx.getImageData(0, 0, W, H).data;
    const cov = new Float32Array(cols * rows);
    for (let gy = 0; gy < rows; gy++) for (let gx = 0; gx < cols; gx++) {
        let a = 0;
        for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) a += d[((gy * SS + sy) * W + (gx * SS + sx)) * 4 + 3];
        cov[gy * cols + gx] = a / (SS * SS * 255);
    }
    return cov;
}

export function ArchetypeReel({ archetypeId, symbol }: { archetypeId: string; symbol: string }) {
    const ref = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        const cv = ref.current, ctx = cv?.getContext("2d");
        if (!cv || !ctx) return;
        const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const lit = hex("#eafff0");
        const chars = FRAMES[archetypeId] ?? [symbol];
        let cols = 0, rows = 0, N = 0, frames: Float32Array[] = [];
        let cur = new Float32Array(0), slam = new Float32Array(0), dly = new Float32Array(0);
        let idx = 0, switchAt = 2.4, last = 0, raf = 0, sweepAt = -10, w = 0, h = 0;

        const draw = (t: number, step: number) => {
            if (!w || !h || !N) return;
            if (!reduced && frames.length > 1 && t >= switchAt) {
                idx = (idx + 1) % frames.length;
                switchAt = t + 2.4; sweepAt = t;
                for (let i = 0; i < N; i++) { dly[i] = t + Math.random() * 0.3; slam[i] = 0; }
            }
            const c = frames[idx];
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);
            const sweepX = (t - sweepAt) * (cols + 8) / 0.85 - 4;
            for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
                const i = y * cols + x;
                if (t > dly[i]) slam[i] = Math.min(1, slam[i] + step / 0.32);
                cur[i] += (c[i] - cur[i]) * Math.min(1, step * 9);
                let v = clamp01(cur[i] * slam[i]);
                const sd = Math.abs(x - sweepX);
                if (sd < 1.4) v = Math.max(v, (1 - sd / 1.4) * 0.45);
                if (v < 0.04) continue; // empty → the card's faint dot field shows through
                ctx.fillStyle = `rgba(${lit[0]},${lit[1]},${lit[2]},${(0.25 + 0.75 * v).toFixed(3)})`;
                const cx = ORIGIN + x * PITCH, cy = ORIGIN + y * PITCH;
                const s = PITCH * (0.34 + 0.30 * v) * (0.6 + 0.4 * easeOutBack(slam[i] || 1));
                ctx.beginPath();
                ctx.roundRect(cx - s / 2, cy - s / 2, Math.max(0.5, s), Math.max(0.5, s), 2);
                ctx.fill();
            }
        };
        const rebuild = () => {
            w = cv.clientWidth; h = cv.clientHeight;
            cv.width = Math.max(1, Math.round(w * dpr)); cv.height = Math.max(1, Math.round(h * dpr));
            if (!w || !h) return;
            const nc = Math.max(8, Math.ceil(w / PITCH)), nr = Math.max(6, Math.ceil(h / PITCH));
            if (nc !== cols || nr !== rows) {
                cols = nc; rows = nr; N = cols * rows;
                frames = chars.map((c) => sampleInto(c, cols, rows));
                cur = new Float32Array(N); if (frames[0]) cur.set(frames[0]);
                slam = new Float32Array(N).fill(1); dly = new Float32Array(N);
            }
            draw(0, 0);
        };
        const frame = (ms: number) => {
            raf = requestAnimationFrame(frame);
            if (document.hidden) { last = 0; return; }
            const t = ms / 1000, step = last ? Math.min(0.1, t - last) : 0.016; last = t;
            draw(t, step);
        };
        const ro = new ResizeObserver(rebuild); ro.observe(cv);
        rebuild();
        raf = requestAnimationFrame(frame);
        return () => { cancelAnimationFrame(raf); ro.disconnect(); };
    }, [archetypeId, symbol]);
    return <div className="arc-reel" aria-hidden="true"><canvas ref={ref} /></div>;
}
