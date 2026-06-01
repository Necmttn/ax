/**
 * Shared canvas helpers - ported from docs/animations.js
 *
 * NOTE: docs/animations.js (attachAccelerate / attachPipeline) is NOT used
 * by origin.html. These helpers are provided for completeness and for any
 * future canvas-based components. The origin.html interactive exhibits use
 * SVG + DOM, not <canvas>.
 */

export const GREEN  = [58, 163, 82]   as const;
export const BLUE   = [70, 120, 220]  as const;
export const PURPLE = [150, 80, 200]  as const;
export const MUTED  = [160, 155, 148] as const;

export const lerp = (a: number, b: number, t: number): number =>
  a + (b - a) * Math.max(0, Math.min(1, t));

export function drawNode(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  dpr: number,
  color: readonly [number, number, number],
  scale = 1,
  glow = 0,
): void {
  const r  = lerp(4, 8, scale) * dpr;
  const rr = lerp(8, 14, scale) * dpr;
  if (glow > 0) {
    ctx.beginPath();
    ctx.arc(x, y, rr + 6 * dpr * glow, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${0.08 * glow})`;
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(x, y, rr, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(${color[0]},${color[1]},${color[2]},${0.15 + 0.1 * glow})`;
  ctx.lineWidth = 1.5 * dpr;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${0.55 + 0.25 * scale})`;
  ctx.fill();
}

export function drawDots(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  dpr: number,
): void {
  const dist    = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
  const spacing = 6 * dpr;
  const dots    = Math.floor(dist / spacing);
  for (let i = 0; i <= dots; i++) {
    const t = i / dots;
    ctx.beginPath();
    ctx.arc(
      x1 + (x2 - x1) * t,
      y1 + (y2 - y1) * t,
      1 * dpr,
      0,
      Math.PI * 2,
    );
    ctx.fillStyle = `rgba(${MUTED[0]},${MUTED[1]},${MUTED[2]},0.28)`;
    ctx.fill();
  }
}

export function drawParticle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  opacity: number,
  dpr: number,
  color: readonly [number, number, number] = GREEN,
): void {
  const s = size * dpr;
  ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${opacity})`;
  ctx.beginPath();
  if ((ctx as CanvasRenderingContext2D & { roundRect?: (...args: unknown[]) => void }).roundRect) {
    (ctx as CanvasRenderingContext2D & { roundRect: (x: number, y: number, w: number, h: number, r: number) => void })
      .roundRect(x - s / 2, y - s / 2, s, s, s * 0.3);
  } else {
    ctx.rect(x - s / 2, y - s / 2, s, s);
  }
  ctx.fill();
}
