/** An animated, per-archetype pixel-art sigil for the hero card. Each archetype
 *  has hand-drawn bitmap frames (NOT a rasterised Unicode glyph - those read as
 *  an illegible blob) that form a tiny, recognisable gag: the verifier checks a
 *  box, the debugger squashes a bug, the observer blinks. The matrix morphs
 *  between the frames with a slam + sweep - the "switching animation".
 *
 *  The canvas is full-bleed over the card; it draws only the lit icon dots
 *  (big, centred, biased up so the bottom text scrim doesn't bury them) over the
 *  card's faint 16px radial-dot field. cur initialises to frame[0] and a
 *  ResizeObserver repaints a static frame on layout, so it's never blank even on
 *  a hidden tab (where rAF is paused). Bitmaps are plain string grids - edit
 *  freely, '#' = lit, anything else = empty; every frame in a set must be the
 *  same width/height. */
import { useEffect, useRef } from "react";

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const hex = (h: string) => { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const; };
function easeOutBack(p: number) { const c = 1.70158, q = p - 1; return 1 + (c + 1) * q * q * q + c * q * q; }

/** Hand-drawn icon frames per archetype (13×11). Two frames each → a little gag
 *  the morph plays back and forth. */
const PIXEL_FRAMES: Record<string, string[][]> = {
    // a triangle scaffolds up, then fills in solid - it finally builds the thing
    architect: [
        ["......#......", "......#......", ".....#.#.....", "....#...#....", "....#...#....", "...#.....#...", "...#.....#...", "..#.......#..", "..#.......#..", ".#.........#.", ".###########."],
        ["......#......", "......#......", ".....###.....", "....#####....", "....#####....", "...#######...", "...#######...", "..#########..", "..#########..", ".###########.", ".###########."],
    ],
    // an empty box gets a big check stamped into it (then re-checks, paranoid)
    verifier: [
        [".###########.", ".#.........#.", ".#.........#.", ".#.........#.", ".#.........#.", ".#.........#.", ".#.........#.", ".#.........#.", ".#.........#.", ".#.........#.", ".###########."],
        [".###########.", ".#.........#.", ".#.......#.#.", ".#......#..#.", ".#.....#...#.", ".#.#..#....#.", ".#.##.#....#.", ".#..###....#.", ".#...#.....#.", ".#.........#.", ".###########."],
    ],
    // a beetle appears, then gets splatted into an X
    debugger: [
        [".....#.#.....", "...#..#..#...", "....#####....", "...#######...", "..##.###.##..", "..#.#####.#..", "..##.###.##..", "...#######...", "....#####....", "...#..#..#...", ".....#.#....."],
        ["#...#...#...#", ".#..#...#..#.", "..#.#...#.#..", "...##...##...", "....#####....", ".....###.....", "....#####....", "...##...##...", "..#.#...#.#..", ".#..#...#..#.", "#...#...#...#"],
    ],
    // a hub fans out to its agents (then they light up)
    orchestrator: [
        ["......#......", ".....###.....", "......#......", "..#...#...#..", ".###.###.###.", "..#...#...#..", "......#......", ".....###.....", "......#......", ".............", "............."],
        ["#.....#.....#", "###...#...###", "#.....#.....#", "..#...#...#..", ".###.###.###.", "..#...#...#..", "#.....#.....#", "###...#...###", "#.....#.....#", ".............", "............."],
    ],
    // bricks keep stacking - it hoards skills it never uses
    "skill-collector": [
        [".............", ".............", ".............", ".............", ".............", ".............", "...#######...", "...#######...", "...#######...", "...#######...", "............."],
        [".............", "...#######...", "...#######...", "...#######...", "...#######...", "...#######...", "...#######...", "...#######...", "...#######...", "...#######...", "............."],
    ],
    // an open book of text (then a page turns)
    "context-curator": [
        [".###########.", ".#....#....#.", ".#.##.#.##.#.", ".#....#....#.", ".#.##.#.##.#.", ".#....#....#.", ".#.##.#.##.#.", ".#....#....#.", ".#.##.#.##.#.", ".#....#....#.", ".###########."],
        [".###########.", ".#....##...#.", ".#.##.#.#..#.", ".#....#..#.#.", ".#.##.#...##.", ".#....#...##.", ".#.##.#...##.", ".#....#..#.#.", ".#.##.#.#..#.", ".#....##...#.", ".###########."],
    ],
    // a chevron hops forward across the repo
    "repo-hopper": [
        ["...#.........", "...##........", "...###.......", "...####......", "...#####.....", "...######....", "...#####.....", "...####......", "...###.......", "...##........", "...#........."],
        [".........#...", "........##...", ".......###...", "......####...", ".....#####...", "....######...", ".....#####...", "......####...", ".......###...", "........##...", ".........#..."],
    ],
    // an eye opens, then blinks shut
    observer: [
        [".............", ".............", "....#####....", "..##.....##..", ".#...###...#.", ".#..#####..#.", ".#...###...#.", "..##.....##..", "....#####....", ".............", "............."],
        [".............", ".............", ".............", ".............", "...#######...", "..#########..", "...#######...", ".............", ".............", ".............", "............."],
    ],
};

const FALLBACK: string[][] = [[".............", ".....###.....", "....#...#....", "...#.....#...", "...#.....#...", "...#.....#...", "...#.....#...", "....#...#....", ".....###.....", ".............", "............."]];

/** A bitmap frame → per-cell coverage (1 lit / 0 empty), with its dimensions. */
function bitmapCoverage(rows: string[]): { cov: Float32Array; bw: number; bh: number } {
    const bh = rows.length, bw = rows[0]?.length ?? 0;
    const cov = new Float32Array(bw * bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) cov[y * bw + x] = rows[y][x] === "#" ? 1 : 0;
    return { cov, bw, bh };
}

export function ArchetypeReel({ archetypeId }: { archetypeId: string; symbol?: string }) {
    const ref = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        const cv = ref.current, ctx = cv?.getContext("2d");
        if (!cv || !ctx) return;
        const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const lit = hex("#eafff0");
        const raw = PIXEL_FRAMES[archetypeId] ?? FALLBACK;
        const frames = raw.map(bitmapCoverage);
        const { bw, bh } = frames[0];
        const N = bw * bh;
        const cur = new Float32Array(N), slam = new Float32Array(N).fill(1), dly = new Float32Array(N);
        if (frames[0]) cur.set(frames[0].cov);
        let idx = 0, switchAt = 2.6, last = 0, raf = 0, sweepAt = -10, w = 0, h = 0;

        const draw = (t: number, step: number) => {
            if (!w || !h) return;
            if (!reduced && frames.length > 1 && t >= switchAt) {
                idx = (idx + 1) % frames.length;
                switchAt = t + 2.6; sweepAt = t;
                for (let i = 0; i < N; i++) { dly[i] = t + Math.random() * 0.3; slam[i] = 0; }
            }
            const c = frames[idx].cov;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);
            // big dots: fill ~90% width / ~62% height, centred horizontally, biased up
            const cell = Math.min((w * 0.94) / bw, (h * 0.78) / bh);
            const blockW = bw * cell, blockH = bh * cell;
            const ox = (w - blockW) / 2, oy = h * 0.42 - blockH / 2;
            const sweepX = (t - sweepAt) * (bw + 6) / 0.8 - 3;
            for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
                const i = y * bw + x;
                if (t > dly[i]) slam[i] = Math.min(1, slam[i] + step / 0.32);
                cur[i] += (c[i] - cur[i]) * Math.min(1, step * 9);
                let v = clamp01(cur[i] * slam[i]);
                const sd = Math.abs(x - sweepX);
                if (sd < 1.4) v = Math.max(v, (1 - sd / 1.4) * 0.5);
                if (v < 0.04) continue; // empty → the card's faint dot field shows through
                ctx.fillStyle = `rgba(${lit[0]},${lit[1]},${lit[2]},${(0.3 + 0.7 * v).toFixed(3)})`;
                const s = cell * 0.74 * (0.5 + 0.5 * v) * (0.55 + 0.45 * easeOutBack(slam[i] || 1));
                const cx = ox + x * cell + cell / 2, cy = oy + y * cell + cell / 2;
                ctx.beginPath();
                ctx.roundRect(cx - s / 2, cy - s / 2, Math.max(0.5, s), Math.max(0.5, s), Math.max(1, cell * 0.18));
                ctx.fill();
            }
        };
        const rebuild = () => {
            w = cv.clientWidth; h = cv.clientHeight;
            cv.width = Math.max(1, Math.round(w * dpr)); cv.height = Math.max(1, Math.round(h * dpr));
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
    }, [archetypeId]);
    return <div className="arc-reel" aria-hidden="true"><canvas ref={ref} /></div>;
}
