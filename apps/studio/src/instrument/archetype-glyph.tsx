/** A unique dot-matrix sigil per archetype: the archetype's `symbol` glyph is
 *  rasterised once and sampled into a grid of dots (slam-in, then static). Each
 *  archetype therefore renders a distinct mark instead of the generic morphing
 *  reel. Pure DOM (no canvas in flow) so it's robust + theme-driven. */
import { useEffect, useState } from "react";

const GW = 14, GH = 10, SS = 6;

function sample(symbol: string): Float32Array | null {
    if (typeof document === "undefined") return null;
    const W = GW * SS, H = GH * SS;
    const off = document.createElement("canvas");
    off.width = W; off.height = H;
    const ctx = off.getContext("2d");
    if (!ctx) return null;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${Math.round(H * 0.86)}px "Apple Symbols", "Segoe UI Symbol", system-ui, sans-serif`;
    ctx.fillText(symbol, W / 2, H / 2 + H * 0.02);
    const d = ctx.getImageData(0, 0, W, H).data;
    const cov = new Float32Array(GW * GH);
    for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
        let a = 0;
        for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
            a += d[((gy * SS + sy) * W + (gx * SS + sx)) * 4 + 3];
        }
        cov[gy * GW + gx] = a / (SS * SS * 255);
    }
    return cov;
}

export function ArchetypeGlyph({ symbol }: { symbol: string }) {
    const [cov, setCov] = useState<Float32Array | null>(null);
    useEffect(() => { setCov(sample(symbol)); }, [symbol]);
    return (
        <div className="arc-glyph" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${GW}, var(--arc-cell, 12px))` }}>
            {Array.from({ length: GW * GH }, (_, i) => {
                const v = cov ? cov[i] : 0;
                const col = i % GW, row = Math.floor(i / GW);
                return (
                    <i key={i}
                        className={v > 0.12 ? "on" : ""}
                        style={{ opacity: 0.1 + v * 0.9, animationDelay: `${0.1 + (col + row) * 0.014}s` }}
                    />
                );
            })}
        </div>
    );
}
