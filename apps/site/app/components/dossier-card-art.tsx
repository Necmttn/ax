// apps/site/app/components/dossier-card-art.tsx
//
// Generative dithered "terrain" artwork for the dossier insight cards.
// Deterministic: a card's seed (its question text) always renders the same
// art, so SSR and client hydration agree - no Math.random anywhere.
//
// Art recipe:
//   seed string -> fnv1a hash -> mulberry32 PRNG
//   -> a low-res value-noise field (COLS x ROWS cells), vertically biased so
//      it reads as a rolling landscape (denser toward the bottom)
//   -> each cell's value is thresholded through an ordered Bayer 4x4 matrix,
//      producing three halftone tone layers: a light-green wash, a mid-green
//      body, and sparse ink pixels on the ridge.
//
// The grid generator (`buildDitherGrid`) is exported pure for unit testing
// (determinism + dimensions); the React component just paints its cells.

export type CardArtAccent = "green" | "red" | "ink";

export const ART_COLS = 56;
export const ART_ROWS = 16;
export const ART_CELL = 6; // px per cell

/** tone level for one cell: 0 = bare panel, 1 = wash, 2 = body, 3 = ink */
export type Tone = 0 | 1 | 2 | 3;

/* ---------- seeded PRNG (hydration-safe) ---------- */

/** fnv1a 32-bit hash of a string -> uint32 seed */
export function fnv1a(str: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        // h *= 16777619, kept in uint32 via Math.imul
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/** mulberry32: tiny, fast, deterministic PRNG returning [0, 1) */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/* ---------- ordered Bayer 4x4 dither matrix ---------- */

// classic 4x4 Bayer thresholds, normalized to (0,1)
const BAYER_4 = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
].map((row) => row.map((v) => (v + 0.5) / 16));

/* ---------- value-noise terrain field ---------- */

/**
 * Build the dither grid for a seed. Returns a ROWS-by-COLS matrix of Tone
 * values. Pure + deterministic - identical seed yields an identical grid.
 *
 * The field is a sum of a few sine ridges (frequencies + phases drawn from
 * the PRNG) plus a low-frequency value-noise wobble, then biased vertically
 * so density rises toward the bottom - a rolling landscape, not flat static.
 */
export function buildDitherGrid(
    seed: string,
    cols: number = ART_COLS,
    rows: number = ART_ROWS,
): Tone[][] {
    const rng = mulberry32(fnv1a(seed));

    // a handful of sine ridges define the silhouette of the terrain
    const ridges = Array.from({ length: 3 }, () => ({
        freq: 0.6 + rng() * 2.4, // waves across the width
        phase: rng() * Math.PI * 2,
        amp: 0.18 + rng() * 0.34,
    }));

    // a sparse low-freq value-noise lattice for organic wobble
    const latticeN = 8;
    const lattice = Array.from({ length: latticeN + 1 }, () => rng());
    const sampleLattice = (x: number): number => {
        const t = x * latticeN;
        const i = Math.floor(t);
        const f = t - i;
        const a = lattice[i] ?? 0;
        const b = lattice[i + 1] ?? a;
        // smoothstep interpolation
        const s = f * f * (3 - 2 * f);
        return a + (b - a) * s;
    };

    // overall slope direction: occasionally tilt the ridge across the card
    const slope = (rng() - 0.5) * 0.5;
    const baseLine = 0.42 + rng() * 0.16; // where the horizon sits (0 top .. 1 bottom)

    const grid: Tone[][] = [];
    for (let y = 0; y < rows; y++) {
        const row: Tone[] = [];
        const yNorm = y / (rows - 1); // 0 top .. 1 bottom
        for (let x = 0; x < cols; x++) {
            const xNorm = x / (cols - 1);

            // terrain height (0..1) at this column - higher = taller ridge
            let ridge = 0;
            for (const r of ridges) {
                ridge += Math.sin(xNorm * r.freq * Math.PI * 2 + r.phase) * r.amp;
            }
            ridge += (sampleLattice(xNorm) - 0.5) * 0.5;
            ridge += slope * (xNorm - 0.5);
            const horizon = baseLine - ridge * 0.5; // 0..1 surface position

            // value: how "solid" this cell is. Below the horizon line fills in,
            // and density grows toward the bottom of the card (landscape mass).
            const depth = yNorm - horizon; // >0 means below the surface
            let value: number;
            if (depth < 0) {
                // sky: faint, fades out upward
                value = 0.08 + (yNorm * 0.12) + depth * 0.6;
            } else {
                // ground: ramps up with depth, densest at the base
                value = 0.35 + depth * 0.9 + yNorm * 0.18;
            }
            value = Math.max(0, Math.min(1, value));

            // ordered dither threshold
            const threshold = BAYER_4[y % 4]![x % 4]!;

            // map dithered value -> three tone bands. Ink is intentionally
            // sparse - specks on the ridge crest, not solid mass - so the
            // ink-accent cards read as topography rather than black blocks.
            let tone: Tone = 0;
            if (value > threshold) {
                if (value > 0.82 && value > threshold + 0.34) tone = 3; // sparse ink crest
                else if (value > 0.45) tone = 2; // mid body
                else tone = 1; // light wash
            }
            row.push(tone);
        }
        grid.push(row);
    }
    return grid;
}

/* ---------- colour mapping per accent ---------- */

interface ToneColors {
    readonly wash: string;
    readonly body: string;
    readonly ink: string;
}

function tonePalette(accent: CardArtAccent): ToneColors {
    switch (accent) {
        case "red":
            return {
                wash: "color-mix(in srgb, var(--red) 14%, var(--panel))",
                body: "color-mix(in srgb, var(--red) 42%, var(--panel))",
                ink: "color-mix(in srgb, var(--red) 78%, var(--ink))",
            };
        case "ink":
            return {
                wash: "color-mix(in srgb, var(--ink) 9%, var(--panel))",
                body: "color-mix(in srgb, var(--ink) 32%, var(--panel))",
                ink: "var(--ink)",
            };
        case "green":
        default:
            return {
                wash: "color-mix(in srgb, var(--green) 14%, var(--panel))",
                body: "color-mix(in srgb, var(--green) 40%, var(--panel))",
                ink: "color-mix(in srgb, var(--green) 72%, var(--ink))",
            };
    }
}

/* ---------- the component ---------- */

export function CardArt({
    seed,
    accent = "green",
}: {
    seed: string;
    accent?: CardArtAccent;
}) {
    const grid = buildDitherGrid(seed);
    const pal = tonePalette(accent);
    const colorFor = (t: Tone): string | null => {
        if (t === 1) return pal.wash;
        if (t === 2) return pal.body;
        if (t === 3) return pal.ink;
        return null;
    };

    const w = ART_COLS * ART_CELL;
    const h = ART_ROWS * ART_CELL;

    // collect filled cells; group by tone is unnecessary - inline fill is fine
    const rects: React.ReactNode[] = [];
    for (let y = 0; y < ART_ROWS; y++) {
        for (let x = 0; x < ART_COLS; x++) {
            const fill = colorFor(grid[y]![x]!);
            if (!fill) continue;
            rects.push(
                <rect
                    key={`${x}-${y}`}
                    x={x * ART_CELL}
                    y={y * ART_CELL}
                    width={ART_CELL}
                    height={ART_CELL}
                    fill={fill}
                />,
            );
        }
    }

    return (
        <div className="pf-card-art" aria-hidden="true">
            <svg
                className="pf-card-art-svg"
                viewBox={`0 0 ${w} ${h}`}
                preserveAspectRatio="none"
                role="presentation"
            >
                {rects}
            </svg>
            {/* terminal-window wink: three dots top-left */}
            <span className="pf-card-art-dots">
                <span />
                <span />
                <span />
            </span>
        </div>
    );
}
