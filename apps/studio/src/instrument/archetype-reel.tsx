/** An animated, per-archetype dot-matrix sigil. Each archetype has a short
 *  sequence of glyph frames (a little pixel gag); the matrix morphs between
 *  them with a slam + sweep - the "switching animation" - instead of cycling
 *  generic patterns. Frames are sampled once; the rAF loop pauses on hidden tab. */
import { useEffect, useRef } from "react";

const GW = 13, GH = 9, SS = 6;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const hex = (h: string) => { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
function easeOutBack(p: number) { const c = 1.70158, q = p - 1; return 1 + (c + 1) * q * q * q + c * q * q; }

/** A short, characterful frame sequence per archetype id (a mini pixel gag).
 *  Falls back to a single symbol for unknown ids. */
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

function sampleChar(symbol: string): Float32Array {
    const W = GW * SS, H = GH * SS;
    const off = document.createElement("canvas");
    off.width = W; off.height = H;
    const ctx = off.getContext("2d")!;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${Math.round(H * 0.84)}px "Apple Symbols", "Segoe UI Symbol", system-ui, sans-serif`;
    ctx.fillText(symbol, W / 2, H / 2 + H * 0.02);
    const d = ctx.getImageData(0, 0, W, H).data;
    const cov = new Float32Array(GW * GH);
    for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
        let a = 0;
        for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) a += d[((gy * SS + sy) * W + (gx * SS + sx)) * 4 + 3];
        cov[gy * GW + gx] = a / (SS * SS * 255);
    }
    return cov;
}

export function ArchetypeReel({ archetypeId, symbol, dim = "#222222", lit = "#eafff0" }: { archetypeId: string; symbol: string; dim?: string; lit?: string }) {
    const ref = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        const cv = ref.current, ctx = cv?.getContext("2d");
        if (!cv || !ctx) return;
        const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const [d0, d1, d2] = hex(dim), [l0, l1, l2] = hex(lit);
        const frames = (FRAMES[archetypeId] ?? [symbol]).map(sampleChar);
        let w = cv.clientWidth, h = cv.clientHeight;
        const size = () => { w = cv.clientWidth; h = cv.clientHeight; cv.width = Math.max(1, Math.round(w * dpr)); cv.height = Math.max(1, Math.round(h * dpr)); };
        size();
        const N = GW * GH;
        const cur = new Float32Array(N), slam = new Float32Array(N).fill(1), dly = new Float32Array(N);
        if (frames[0]) cur.set(frames[0]); // render the first frame fully even before/without animation (e.g. hidden tab)
        let idx = 0, switchAt = 2.2, last = 0, raf = 0, sweepAt = -10;
        const draw = (t: number, step: number) => {
            if (!w || !h) return;
            if (!reduced && frames.length > 1 && t >= switchAt) {
                idx = (idx + 1) % frames.length;
                switchAt = t + 2.2; sweepAt = t;
                for (let i = 0; i < N; i++) { dly[i] = t + Math.random() * 0.26; slam[i] = 0; }
            }
            const c = frames[idx];
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);
            const gap = Math.max(2, Math.min(w, h) / GW * 0.2);
            const cell = Math.min((w - (GW - 1) * gap) / GW, (h - (GH - 1) * gap) / GH);
            const ox = (w - (GW * cell + (GW - 1) * gap)) / 2, oy = (h - (GH * cell + (GH - 1) * gap)) / 2;
            const sweepX = (t - sweepAt) * (GW + 4) / 0.7 - 2;
            for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
                const i = y * GW + x;
                if (t > dly[i]) slam[i] = Math.min(1, slam[i] + step / 0.3);
                cur[i] += (c[i] - cur[i]) * Math.min(1, step * 9);
                let v = clamp01(cur[i] * slam[i]);
                const sd = Math.abs(x - sweepX);
                if (sd < 1.3) v = Math.max(v, (1 - sd / 1.3) * 0.8);
                const g0 = Math.round(d0 + (l0 - d0) * v), g1 = Math.round(d1 + (l1 - d1) * v), g2 = Math.round(d2 + (l2 - d2) * v);
                ctx.fillStyle = `rgb(${g0},${g1},${g2})`;
                const s = cell * (0.5 + 0.45 * v) * (0.5 + 0.5 * easeOutBack(slam[i]));
                const cx = ox + x * (cell + gap) + cell / 2, cy = oy + y * (cell + gap) + cell / 2;
                ctx.beginPath();
                ctx.roundRect(cx - s / 2, cy - s / 2, Math.max(0.5, s), Math.max(0.5, s), 2);
                ctx.fill();
            }
        };
        const frame = (ms: number) => {
            raf = requestAnimationFrame(frame);
            if (document.hidden) { last = 0; return; }
            const t = ms / 1000, step = last ? Math.min(0.1, t - last) : 0.016; last = t;
            draw(t, step);
        };
        // Repaint a static first frame whenever layout settles - fires even on a
        // hidden tab (where rAF is paused), so the sigil is never blank. The rAF
        // loop only adds the morph once the tab is actually visible.
        const repaint = () => { size(); draw(0, 0); };
        const ro = new ResizeObserver(repaint); ro.observe(cv);
        repaint();
        raf = requestAnimationFrame(frame);
        return () => { cancelAnimationFrame(raf); ro.disconnect(); };
    }, [archetypeId, symbol, dim, lit]);
    return <div className="rdx-glyph"><canvas ref={ref} /></div>;
}
