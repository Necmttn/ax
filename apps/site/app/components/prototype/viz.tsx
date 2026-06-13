/* THROWAWAY prototype viz primitives - nullframe grammar (MIT, m1ckc3s/nullframe).
   Theme-agnostic: colours come from CSS vars on the .rdx scope. */
import { useEffect, useRef } from "react";

/** Dot-matrix numerals. */
export function Doto({ children, className = "" }: { children: React.ReactNode; className?: string }) {
    return <span className={`rdx-doto ${className}`}>{children}</span>;
}

/** Segmented bar - first `on` of `total` cells lit, staggered slam-in. */
export function Segbar({
    total, on, tone = "accent", wave = false,
}: { total: number; on: number; tone?: "accent" | "green" | "pri"; wave?: boolean }) {
    return (
        <div className={`rdx-seg ${tone} ${wave ? "wave" : ""}`} aria-hidden="true">
            {Array.from({ length: total }, (_, i) => (
                <i key={i} className={i < on ? "on" : ""} style={{ animationDelay: `${0.2 + i * 0.04}s` }} />
            ))}
        </div>
    );
}

/** Contribution cell grid with diagonal slam + glim. levels row-major 0..4. */
export function CellGrid({
    levels, cols, cell = 12, gap = 3, glim = true,
}: { levels: ReadonlyArray<number>; cols: number; cell?: number; gap?: number; glim?: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!glim) return;
        if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
        const el = ref.current;
        if (!el) return;
        const iv = window.setInterval(() => {
            if (document.hidden) return;
            const kids = el.children;
            if (!kids.length) return;
            const k = kids[(Math.random() * kids.length) | 0] as HTMLElement;
            if (!/lvl-[234]/.test(k.className)) return;
            k.classList.add("glim");
            window.setTimeout(() => k.classList.remove("glim"), 420);
        }, 600);
        return () => window.clearInterval(iv);
    }, [glim, levels.length]);
    return (
        <div ref={ref} className="rdx-cells" aria-hidden="true"
            style={{ gridTemplateColumns: `repeat(${cols}, ${cell}px)`, gridAutoRows: `${cell}px`, gap: `${gap}px` }}>
            {levels.map((lvl, i) => {
                const col = i % cols, row = Math.floor(i / cols);
                return <i key={i} className={lvl ? `lvl-${Math.min(4, lvl)}` : ""}
                    style={{ animationDelay: `${0.15 + (col + row) * 0.016}s` }} />;
            })}
        </div>
    );
}

const GW = 11, GH = 7;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const dist = (x: number, y: number) => Math.hypot(x - 5, (y - 3) * 1.25);
const PATS: ReadonlyArray<(x: number, y: number, t: number) => number> = [
    (x, y, t) => clamp01(1.1 - (dist(x, y) - 2.6 + 0.25 * Math.sin(t * 1.6)) * 0.8),
    (x, y) => clamp01(1.1 - Math.abs(dist(x, y) - 2.7) * 0.8),
    (x, y) => (Math.abs(Math.atan2(y - 3, x - 5)) < 0.62 ? 0.06 : clamp01(1.1 - Math.abs(dist(x, y) - 2.7) * 0.8)),
    (x, y) => Math.max(clamp01(1.1 - Math.abs(dist(x, y) - 2.7) * 0.8), dist(x, y) < 1 ? 0.95 : 0),
    (x, y) => (y >= 1 && y <= 5 && (x === 3 || x === 4 || x === 6 || x === 7) ? 0.92 : 0.06),
    (x, y) => (((x === 2 || x === 8) && y >= 1 && y <= 5) || ((y === 1 || y === 5) && (x === 3 || x === 7)) ? 0.92 : 0.06),
    (x, y) => clamp01(1.1 - (Math.abs(x - 5) + Math.abs(y - 3)) * 0.36),
    (x, y, t) => { const h = (Math.sin(t * 1.9 + x * 0.9) + Math.sin(t * 1.3 + x * 1.7)) * 0.25 + 0.55; return GH - 1 - y < h * GH ? 0.84 : 0.06; },
    (x, y, t) => { const v = Math.sin(x * 12.9898 + y * 37.719 + Math.floor(t * 2.5 + ((x * 7 + y * 13) % 4)) * 78.233) * 43758.5; return (v - Math.floor(v)) * 0.92; },
];
function easeOutBack(p: number): number { const c = 1.70158, q = p - 1; return 1 + (c + 1) * q * q * q + c * q * q; }
const hex = (h: string) => { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

/** Canvas dot-matrix reel. `dim`/`lit` are hex endpoints so it reads in either theme. */
export function GlyphReel({ seed = 0, dim = "#222222", lit = "#ffffff" }: { seed?: number; dim?: string; lit?: string }) {
    const ref = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        const cv = ref.current, ctx = cv?.getContext("2d");
        if (!cv || !ctx) return;
        const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const [d0, d1, d2] = hex(dim), [l0, l1, l2] = hex(lit);
        let w = cv.clientWidth, h = cv.clientHeight;
        const size = () => { w = cv.clientWidth; h = cv.clientHeight; cv.width = Math.max(1, Math.round(w * dpr)); cv.height = Math.max(1, Math.round(h * dpr)); };
        size();
        const ro = new ResizeObserver(size); ro.observe(cv);
        const N = GW * GH, cur = new Float32Array(N), slam = new Float32Array(N), dly = new Float32Array(N);
        let pat = Math.abs(seed) % PATS.length, switchAt = 1.6, last = 0, raf = 0;
        const draw = (t: number, step: number) => {
            if (!w || !h) return;
            if (!reduced && t >= switchAt) { pat = (pat + 1) % PATS.length; switchAt = t + 1.6; for (let i = 0; i < N; i++) { dly[i] = t + Math.random() * 0.24; slam[i] = 0; } }
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
            const gap = 3, cell = Math.min((w - (GW - 1) * gap) / GW, (h - (GH - 1) * gap) / GH);
            const ox = (w - (GW * cell + (GW - 1) * gap)) / 2, oy = (h - (GH * cell + (GH - 1) * gap)) / 2;
            for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
                const i = y * GW + x;
                if (t > dly[i]) slam[i] = Math.min(1, slam[i] + step / 0.3);
                cur[i] += (PATS[pat](x, y, t) - cur[i]) * Math.min(1, step * 10);
                const v = clamp01(cur[i] * slam[i]);
                ctx.fillStyle = `rgb(${Math.round(d0 + (l0 - d0) * v)},${Math.round(d1 + (l1 - d1) * v)},${Math.round(d2 + (l2 - d2) * v)})`;
                const s = cell * (0.5 + 0.5 * easeOutBack(slam[i]));
                const cx = ox + x * (cell + gap) + cell / 2, cy = oy + y * (cell + gap) + cell / 2;
                ctx.beginPath(); ctx.roundRect(cx - s / 2, cy - s / 2, s, s, 2); ctx.fill();
            }
        };
        const frame = (ms: number) => { raf = requestAnimationFrame(frame); if (document.hidden) { last = 0; return; } const t = ms / 1000, step = last ? Math.min(0.1, t - last) : 0.016; last = t; draw(t, step); };
        draw(0.016, 0.016); raf = requestAnimationFrame(frame);
        return () => { cancelAnimationFrame(raf); ro.disconnect(); };
    }, [seed, dim, lit]);
    return <div className="rdx-glyph"><canvas ref={ref} /></div>;
}

/** Pulsing live LED. */
export function Led({ tone = "green" }: { tone?: "green" | "accent" | "red" }) {
    return <span className={`rdx-led ${tone}`} aria-hidden="true" />;
}
