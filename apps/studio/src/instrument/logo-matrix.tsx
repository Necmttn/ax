/* THROWAWAY - high-def dot-matrix "pixel screen" that renders the harness
   logos as dots (the cool morphing screen, but meaningful: it cycles the five
   coding harnesses ax ingests). Each logo's SVG is rasterised once and sampled
   into a GW×GH coverage grid; the screen slams between them. */
import { useEffect, useRef, useState } from "react";

type Glyph = { key: string; name: string; vb: string; paths: { d: string; rule?: "evenodd" }[] };

// Real harness marks (paths from the site's provider set).
const HARNESS: Glyph[] = [
    { key: "claude", name: "Claude Code", vb: "0 0 24 24", paths: [{ d: "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" }] },
    { key: "codex", name: "Codex", vb: "0 0 24 24", paths: [{ d: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" }] },
    { key: "pi", name: "Pi", vb: "150 150 500 500", paths: [{ d: "M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z", rule: "evenodd" }, { d: "M517.36 400 H634.72 V634.72 H517.36 Z" }] },
    { key: "opencode", name: "OpenCode", vb: "0 0 24 24", paths: [{ d: "M19 21H5V3H19V21ZM16 7H8V17H16V7Z", rule: "evenodd" }, { d: "M15 11H9V15H15V11Z" }] },
    { key: "cursor", name: "Cursor", vb: "0 0 24 24", paths: [{ d: "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" }] },
];

const GW = 26, GH = 26; // higher-def grid than the abstract glyph reel
const SS = 5; // supersample per cell when rasterising the logo
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const hex = (h: string) => { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

function svgUri(g: Glyph, w: number, h: number): string {
    const body = g.paths.map((p) => `<path fill='#fff'${p.rule ? " fill-rule='evenodd'" : ""} d='${p.d}'/>`).join("");
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='${g.vb}' width='${w}' height='${h}' preserveAspectRatio='xMidYMid meet'>${body}</svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function LogoMatrix({ dim = "#1a2019", mid = "#56b06a", lit = "#eafff0" }: { dim?: string; mid?: string; lit?: string }) {
    const ref = useRef<HTMLCanvasElement>(null);
    const cov = useRef<Array<Float32Array | null>>(HARNESS.map(() => null));
    const [, setReady] = useState(0);
    const [activeName, setActiveName] = useState(HARNESS[0].name);

    // rasterise each logo once into a coverage grid
    useEffect(() => {
        let alive = true;
        HARNESS.forEach((g, gi) => {
            const W = GW * SS, H = GH * SS;
            const off = document.createElement("canvas");
            off.width = W; off.height = H;
            const octx = off.getContext("2d");
            if (!octx) return;
            const img = new Image();
            img.onload = () => {
                if (!alive) return;
                octx.clearRect(0, 0, W, H);
                octx.drawImage(img, 0, 0, W, H);
                const d = octx.getImageData(0, 0, W, H).data;
                const c = new Float32Array(GW * GH);
                for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
                    let a = 0;
                    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
                        const px = gx * SS + sx, py = gy * SS + sy;
                        a += d[(py * W + px) * 4 + 3];
                    }
                    c[gy * GW + gx] = a / (SS * SS * 255);
                }
                cov.current[gi] = c;
                setReady((n) => n + 1);
            };
            img.src = svgUri(g, W, H);
        });
        return () => { alive = false; };
    }, []);

    useEffect(() => {
        const cv = ref.current;
        const ctx = cv?.getContext("2d");
        if (!cv || !ctx) return;
        const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const [d0, d1, d2] = hex(dim), [m0, m1, m2] = hex(mid), [l0, l1, l2] = hex(lit);
        // 3-stop ramp: dim -> accent green -> bright core. Reads as a green-lit
        // logo screen with white-hot cores, instead of a flat grey-to-white fade.
        const ramp = (v: number): [number, number, number] => {
            if (v <= 0.5) { const k = v / 0.5; return [d0 + (m0 - d0) * k, d1 + (m1 - d1) * k, d2 + (m2 - d2) * k]; }
            const k = (v - 0.5) / 0.5; return [m0 + (l0 - m0) * k, m1 + (l1 - m1) * k, m2 + (l2 - m2) * k];
        };
        let w = cv.clientWidth, h = cv.clientHeight;
        // Always track the live box (absolute canvas already prevents the
        // resize feedback loop). Keeping a stale bitmap left the logo rendering
        // in a corner when the box settled to its final size after font/layout.
        const size = () => {
            w = cv.clientWidth; h = cv.clientHeight;
            cv.width = Math.max(1, Math.round(w * dpr));
            cv.height = Math.max(1, Math.round(h * dpr));
        };
        size();
        const ro = new ResizeObserver(size); ro.observe(cv);

        const N = GW * GH;
        const cur = new Float32Array(N), slam = new Float32Array(N).fill(1), dly = new Float32Array(N);
        let idx = 0, switchAt = 2.6, last = 0, raf = 0, sweepAt = -10;
        const firstReady = () => cov.current.findIndex(Boolean);

        const frame = (ms: number) => {
            raf = requestAnimationFrame(frame);
            if (document.hidden) { last = 0; return; }
            const t = ms / 1000;
            const step = last ? Math.min(0.1, t - last) : 0.016;
            last = t;
            if (!w || !h) return;
            if (cov.current[idx] == null) { const f = firstReady(); if (f < 0) return; idx = f; }

            if (!reduced && t >= switchAt) {
                // advance to the next ready logo
                for (let k = 1; k <= HARNESS.length; k++) {
                    const cand = (idx + k) % HARNESS.length;
                    if (cov.current[cand]) { idx = cand; break; }
                }
                switchAt = t + 2.6;
                sweepAt = t;
                for (let i = 0; i < N; i++) { dly[i] = t + Math.random() * 0.3; slam[i] = 0; }
                setActiveName(HARNESS[idx].name);
            }
            const c = cov.current[idx]!;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);
            const gap = Math.max(1.6, Math.min(w, h) / GW * 0.22);
            const cell = Math.min((w - (GW - 1) * gap) / GW, (h - (GH - 1) * gap) / GH);
            const ox = (w - (GW * cell + (GW - 1) * gap)) / 2, oy = (h - (GH * cell + (GH - 1) * gap)) / 2;
            const sweepX = (t - sweepAt) * (GW + 4) / 0.7 - 2; // a bright band crossing left→right on switch
            for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
                const i = y * GW + x;
                if (t > dly[i]) slam[i] = Math.min(1, slam[i] + step / 0.3);
                cur[i] += (c[i] - cur[i]) * Math.min(1, step * 9);
                let v = clamp01(cur[i] * slam[i]);
                const sd = Math.abs(x - sweepX);
                if (sd < 1.4) v = Math.max(v, (1 - sd / 1.4) * 0.85); // sweep glow
                const [r, g, b] = ramp(v);
                ctx.fillStyle = `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
                // lit dots a touch larger + rounder; unlit stay small + quiet
                const s = cell * (0.5 + 0.42 * v) * slam[i];
                const cx = ox + x * (cell + gap) + cell / 2, cy = oy + y * (cell + gap) + cell / 2;
                ctx.beginPath();
                ctx.roundRect(cx - s / 2, cy - s / 2, Math.max(0.5, s), Math.max(0.5, s), Math.max(1, s * 0.32));
                ctx.fill();
            }
        };
        raf = requestAnimationFrame(frame);
        return () => { cancelAnimationFrame(raf); ro.disconnect(); };
    }, [dim, mid, lit]);

    return (
        <div className="v-land-screen">
            <div className="v-land-screen-canvas rdx-glyph"><canvas ref={ref} /></div>
            <div className="v-land-screen-cap rdx-stamp">ingesting · {activeName}</div>
        </div>
    );
}
