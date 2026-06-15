/** An animated, per-archetype pixel-art sigil for the hero card. Each archetype
 *  is a SHORT STORY told across 3-5 hand-drawn bitmap frames (NOT a rasterised
 *  Unicode glyph - those read as an illegible blob) that loops: the architect
 *  builds, the verifier checks then seals, the debugger squashes a bug, the
 *  observer opens an eye and blinks. Frames crossfade softly into one another -
 *  no directional wipe, no bounce - in the spirit of nullframe's glyph loop:
 *  each cell gently fades its brightness toward the next frame, with a calm
 *  dwell on every frame before the next crossfade.
 *
 *  The canvas is full-bleed over the card; it draws only the lit icon dots
 *  (big, centred in a fixed band between the top meta row and the bottom title
 *  block) over the card's faint 16px radial-dot field. cur initialises to
 *  frame[0] and a ResizeObserver repaints a static frame on layout, so it's
 *  never blank even on a hidden tab (where rAF is paused). Bitmaps are plain
 *  string grids - edit freely, '#' = lit, anything else = empty; every frame in
 *  a set must be the same width/height. */
import { useEffect, useRef } from "react";

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const hex = (h: string) => { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const; };

/** Hand-drawn icon STORY frames per archetype (13×11). 3-5 frames each form a
 *  little narrative the loop crossfades through, then repeats. */
const PIXEL_FRAMES: Record<string, string[][]> = {
    // BUILDS A TRIANGLE: empty plot → foundation line → half-built frame →
    // full solid triangle.
    architect: [
        [".............", ".............", ".............", ".............", ".............", ".............", ".............", ".............", ".............", ".............", ".###########."],
        [".............", ".............", ".............", ".............", ".............", "......#......", ".....#.#.....", "....#...#....", "...#.....#...", "..#.......#..", ".###########."],
        ["......#......", "......#......", ".....#.#.....", ".....#.#.....", "....#...#....", "....#...#....", "...#.....#...", "...#.....#...", "..#.......#..", "..#.......#..", ".###########."],
        ["......#......", "......#......", ".....###.....", ".....###.....", "....#####....", "....#####....", "...#######...", "...#######...", "..#########..", "..#########..", ".###########."],
    ],
    // CHECKS THEN SEALS: empty box → box with a check → double-check →
    // sealed/locked (a padlock body).
    verifier: [
        [".###########.", ".#.........#.", ".#.........#.", ".#.........#.", ".#.........#.", ".#.........#.", ".#.........#.", ".#.........#.", ".#.........#.", ".#.........#.", ".###########."],
        [".###########.", ".#.........#.", ".#.......#.#.", ".#......#..#.", ".#.....#...#.", ".#.#..#....#.", ".#.##.#....#.", ".#..###....#.", ".#...#.....#.", ".#.........#.", ".###########."],
        [".###########.", ".#.#.....#.#.", ".#.##...#..#.", ".#..#..#...#.", ".#..##.#...#.", ".#.#.##....#.", ".#.#..#....#.", ".#....#....#.", ".#.........#.", ".#.........#.", ".###########."],
        [".....###.....", "....#...#....", "....#...#....", "...#######...", "...#######...", "...##.#.##...", "...##.#.##...", "...#######...", "...#######...", ".............", "............."],
    ],
    // SQUASHES A BUG: bug crawling → bug under a magnifier → splatted (X) →
    // clean (a tidy check, all clear).
    debugger: [
        ["...#.....#...", "....#...#....", "....#####....", "..#.######.#.", ".#.#######.#.", "...#######...", ".#.#######.#.", "..#.######.#.", "....#####....", "...#.....#...", "..#.......#.."],
        [".....#####...", "....#...#.#..", "...#.###.#.#.", "...#.###..#..", "...#.###.#...", "....#####.#..", ".....###...#.", "...........##", "............#", "............#", "............#"],
        ["#...#...#...#", ".#..#...#..#.", "..#.#...#.#..", "...##...##...", "....#####....", ".....###.....", "....#####....", "...##...##...", "..#.#...#.#..", ".#..#...#..#.", "#...#...#...#"],
        [".............", ".............", "..........#..", ".........##..", "........##...", ".#.....##....", ".##...##.....", "..##.##......", "...###.......", "....#........", "............."],
    ],
    // ORCHESTRATES A FAN-OUT: lone hub → hub + 2 nodes → hub + 4 nodes →
    // all nodes lit (rings).
    orchestrator: [
        [".............", ".............", ".............", ".............", ".....###.....", "....#####....", ".....###.....", ".............", ".............", ".............", "............."],
        ["##.........##", "##.........##", "....#...#....", ".....#.#.....", ".....###.....", "....#####....", ".....###.....", ".............", ".............", ".............", "............."],
        ["##.........##", "##....#....##", "...#..#..#...", "....#.#.#....", ".....###.....", "..#.#####.#..", ".....###.....", "....#.#.#....", "...#..#..#...", "##....#....##", "##.........##"],
        ["###.......###", "###...#...###", "#..##.#.##..#", "....#.#.#....", ".....###.....", "..#.#####.#..", ".....###.....", "....#.#.#....", "#..##.#.##..#", "###...#...###", "###.......###"],
    ],
    // HOARDS SKILLS: 1 card → 2 → 3 → 4 stacked (a growing fanned deck).
    "skill-collector": [
        [".............", ".............", ".............", ".#########...", ".#.......#...", ".#.......#...", ".#.......#...", ".#.......#...", ".#########...", ".............", "............."],
        [".............", ".............", "..#########..", "..#.......#..", ".##.......#..", ".#.#######.#.", ".#.#......#..", ".#.#......#..", ".#.#######...", ".............", "............."],
        [".............", "...#########.", "...#.......#.", "..##.......#.", ".#.########.#", ".#.#......#.#", "##.#......#..", "#..########..", "#..#......#..", "...#######...", "............."],
        ["....#########", "....#.......#", "...##.......#", "..#.########.", ".#.#......#.#", "##.#......#.#", "#..########.#", "#..#......#..", "...########..", "...#......#..", "...#######..."],
    ],
    // OPENS A BOOK: closed book (cover + spine) → cracking open → open with two
    // text pages → a page turning. The open frame reads as a clear open book -
    // a thin centre gutter splits two pages whose outer tops rise away from the
    // spine (the 📖 silhouette), with a few short ruled text lines per page.
    "context-curator": [
        [".............", "..########...", "..#......##..", "..#......#.#.", "..#......#.#.", "..#......#.#.", "..#......#.#.", "..#......#.#.", "..#......##..", "..########...", "............."],
        [".....#.......", "...###.#.....", "..#..#.##....", "..#..#...##..", "..#..#.....#.", "..#..#.....#.", "..#..#.....#.", "..#..#...##..", "..#..#.##....", "...###.#.....", ".....#......."],
        [".#.........#.", "###.......###", "####.....####", "#####.#.#####", "#.###.#.###.#", "#####.#.#####", "#.###.#.###.#", "#####.#.#####", "#####.#.#####", "#####.#.#####", ".###########."],
        [".#.........#.", "###.......##.", "####.....#.#.", "#####.#.#..##", "#.###.#.#.###", "#####.#.#.##.", "#.###.#.####.", "#####.#.###.#", "#####.#.####.", "#####.#.###..", ".########.#.."],
    ],
    // HOPS REPOS: chevron at left → mid → right → landed on the far repo (a
    // stack of files appears where it arrives).
    "repo-hopper": [
        ["#............", "##...........", "###..........", "####.........", "#####........", "####.........", "###..........", "##...........", "#............", ".............", "............."],
        [".....#.......", ".....##......", ".....###.....", ".....####....", ".....#####...", ".....####....", ".....###.....", ".....##......", ".....#.......", ".............", "............."],
        ["........#....", "........##...", "........###..", "........####.", "........#####", "........####.", "........###..", "........##...", "........#....", ".............", "............."],
        [".............", "....#######..", "....#.....#..", "....#######..", "....#.....#..", "....#######..", "....#.....#..", "....#######..", "....#.....#..", "....#######..", "............."],
    ],
    // OPENS AN EYE: closed (lid line) → opening → open with a round iris →
    // blink (back to a line).
    observer: [
        [".............", ".............", ".............", ".............", ".............", "#############", ".............", ".............", ".............", ".............", "............."],
        [".............", ".............", ".............", "....#####....", "..##.....##..", "#####...#####", "..##.....##..", "....#####....", ".............", ".............", "............."],
        [".............", ".............", "...#######...", ".##.......##.", "#....###....#", "#...#####...#", "#....###....#", ".##.......##.", "...#######...", ".............", "............."],
        [".............", ".............", ".............", ".............", "....#####....", "#############", "....#####....", ".............", ".............", ".............", "............."],
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

const DWELL = 1.6;      // seconds a frame holds before the matrix re-materialises (nullframe tempo)
const SLAM = 0.3;       // per-cell materialise ramp (nullframe: slam += step / 0.3)
const LERP = 10;        // brightness ease toward target (nullframe: step * 10)
const BG = 0.22;        // amplitude of the faint background field that keeps the WHOLE matrix alive
function easeOutBack(p: number) { const c = 1.70158, q = p - 1; return 1 + (c + 1) * q * q * q + c * q * q; }
/** A slow animated interference field over the grid, [0,1] - so every cell is
 *  always lit and breathing (like nullframe's procedural patterns), not a sparse
 *  icon on black. The bright archetype icon rides on top of it. */
function field(x: number, y: number, t: number) { return 0.5 + 0.5 * Math.sin(x * 0.7 + y * 0.5 + t * 1.4) * Math.cos(x * 0.35 - y * 0.45 - t * 0.95); }

export function ArchetypeReel({ archetypeId }: { archetypeId: string; symbol?: string }) {
    const ref = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        const cv = ref.current, ctx = cv?.getContext("2d");
        if (!cv || !ctx) return;
        const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        // brand primary green tint - reads as the instrument's own glow rather
        // than a stray off-white element. a faint cool lift keeps it from going muddy.
        const lit = hex("#7fe39b");
        const raw = PIXEL_FRAMES[archetypeId] ?? FALLBACK;
        const frames = raw.map(bitmapCoverage);
        const { bw, bh } = frames[0];
        const N = bw * bh;
        // cur = each cell's live icon brightness, eased toward the active frame.
        // slam/dly drive the staggered materialise on every frame switch.
        const cur = new Float32Array(N);
        const slam = new Float32Array(N).fill(1);
        const dly = new Float32Array(N);
        if (frames[0]) cur.set(frames[0].cov);
        let idx = 0, switchAt = DWELL, last = 0, raf = 0, w = 0, h = 0;

        const draw = (t: number, step: number) => {
            if (!w || !h) return;
            // advance to the next story frame, then RE-MATERIALISE the whole
            // matrix: every cell resets its slam with a small random stagger and
            // pops back in (nullframe's "the whole grid changes" feel).
            if (!reduced && frames.length > 1 && t >= switchAt) {
                idx = (idx + 1) % frames.length;
                switchAt = t + DWELL;
                for (let i = 0; i < N; i++) { dly[i] = t + Math.random() * 0.24; slam[i] = 0; }
            }
            const c = frames[idx].cov;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);
            // Sit the icon in the clear band BETWEEN the top meta row and the
            // bottom title block - fixed px clearances (not fractions) so it
            // grows on tall cards instead of shrinking, and never collides with
            // either label.
            const top = 48;                 // clears the "ARCHETYPE · PRIMARY" meta row
            const bottom = 104;             // clears the name + tagline + humor block
            const avail = Math.max(40, h - top - bottom);
            const cell = Math.min((w * 0.9) / bw, avail / bh);
            const blockW = bw * cell, blockH = bh * cell;
            const ox = (w - blockW) / 2;
            const oy = top + (avail - blockH) / 2;
            const k = reduced ? 1 : Math.min(1, step * LERP);
            for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
                const i = y * bw + x;
                if (t > dly[i]) slam[i] = Math.min(1, slam[i] + step / SLAM);
                cur[i] += (c[i] - cur[i]) * k;
                // icon brightness, lifted by the faint living field so the whole
                // matrix breathes; the icon (cur≈1) always dominates the field.
                const bg = reduced ? 0 : BG * field(x, y, t);
                const v = clamp01(Math.max(cur[i], cur[i] + (1 - cur[i]) * bg));
                if (v < 0.03) continue;
                const sl = reduced ? 1 : slam[i];
                ctx.fillStyle = `rgba(${lit[0]},${lit[1]},${lit[2]},${(0.18 + 0.82 * v * (0.3 + 0.7 * sl)).toFixed(3)})`;
                // size: staggered pop (easeOutBack 0.45→1.0) × brightness.
                const s = cell * 0.78 * (0.45 + 0.55 * easeOutBack(sl)) * (0.5 + 0.5 * v);
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
