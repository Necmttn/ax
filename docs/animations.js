/**
 * ax landing canvas animations - vanilla JS port from
 * necmttn.com/services OfferAnimations.tsx.
 *
 * Each animation attaches to a <canvas> element by id. Slow ambient
 * baseline; speeds up on hover (or when the section is in view if
 * data-autoplay="true").
 */

const GREEN  = [58, 163, 82];
const BLUE   = [70, 120, 220];
const PURPLE = [150, 80, 200];
const MUTED  = [160, 155, 148];

const lerp = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));

function drawNode(ctx, x, y, dpr, color, scale = 1, glow = 0) {
  const r = lerp(4, 8, scale) * dpr;
  const rr = lerp(8, 14, scale) * dpr;
  if (glow > 0) {
    ctx.beginPath(); ctx.arc(x, y, rr + 6 * dpr * glow, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${0.08 * glow})`; ctx.fill();
  }
  ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(${color[0]},${color[1]},${color[2]},${0.15 + 0.1 * glow})`;
  ctx.lineWidth = 1.5 * dpr; ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${0.55 + 0.25 * scale})`; ctx.fill();
}

function drawDots(ctx, x1, y1, x2, y2, dpr) {
  const dist = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
  const spacing = 6 * dpr, dots = Math.floor(dist / spacing);
  for (let i = 0; i <= dots; i++) {
    const t = i / dots;
    ctx.beginPath();
    ctx.arc(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, 1 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${MUTED[0]},${MUTED[1]},${MUTED[2]},0.28)`; ctx.fill();
  }
}

function drawParticle(ctx, x, y, size, opacity, dpr, color = GREEN) {
  const s = size * dpr;
  ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${opacity})`;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x - s / 2, y - s / 2, s, s, s * 0.3);
  else ctx.rect(x - s / 2, y - s / 2, s, s);
  ctx.fill();
}

/**
 * Wires standard canvas plumbing (DPR-aware sizing, RAF loop, hover/in-view
 * autoplay, cleanup). Returns nothing - call once per canvas.
 *
 *   draw(ctx, w, h, dpr, now, hoverProgress)  // called each frame
 */
function attachCanvas(cvs, draw, { autoplay = false } = {}) {
  const ctx = cvs.getContext("2d");
  if (!ctx) return;

  let dpr = window.devicePixelRatio || 1;
  const resize = () => {
    dpr = window.devicePixelRatio || 1;
    const r = cvs.getBoundingClientRect();
    cvs.width = r.width * dpr;
    cvs.height = r.height * dpr;
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(cvs);

  let hovered = false;
  cvs.addEventListener("mouseenter", () => { hovered = true; });
  cvs.addEventListener("mouseleave", () => { hovered = false; });

  if (autoplay) {
    const io = new IntersectionObserver(([e]) => { hovered = e.isIntersecting; }, { threshold: 0.3 });
    io.observe(cvs);
  }

  let t = autoplay ? 1 : 0;
  let last = 0;
  let raf = 0;

  const loop = (now) => {
    if (last === 0) last = now;
    const dt = now - last; last = now;
    const step = dt / 600;
    t = hovered ? Math.min(1, t + step) : Math.max(0, t - step);

    draw(ctx, cvs.width, cvs.height, dpr, now, t);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  return () => { cancelAnimationFrame(raf); ro.disconnect(); };
}

/* ── Accelerate: slow → fast particle flow ── */
export function attachAccelerate(cvs) {
  const particles = [];
  let lastSpawn = 0;

  attachCanvas(cvs, (ctx, w, h, dpr, now, t) => {
    ctx.clearRect(0, 0, w, h);
    const pulse = Math.sin(now / 400) * 0.3 + 0.7;
    const pad = 24 * dpr, nrr = 14 * dpr;
    const ax = pad + nrr, bx = w - pad - nrr, cy = h / 2;

    drawDots(ctx, ax + nrr + 4 * dpr, cy, bx - nrr - 4 * dpr, cy, dpr);
    drawNode(ctx, ax, cy, dpr, MUTED, lerp(0.3, 1, t), t * pulse);
    drawNode(ctx, bx, cy, dpr, GREEN, lerp(0.3, 1, t), t * pulse);

    if (now - lastSpawn > lerp(1800, 120, t)) {
      lastSpawn = now;
      particles.push({ progress: 0, speed: 0.003 + Math.random() * 0.002, size: 4 + Math.random() * 2, opacity: 0.6 + Math.random() * 0.3 });
    }

    const sx = ax + nrr + 6 * dpr, ex = bx - nrr - 6 * dpr, len = ex - sx;
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.progress += p.speed * lerp(1, 3.5, t);
      if (p.progress > 1) { particles.splice(i, 1); continue; }
      const x = sx + len * p.progress;
      const y = cy + Math.sin(p.progress * Math.PI * 4) * 2 * dpr;
      let a = p.opacity;
      if (p.progress < 0.1) a *= p.progress / 0.1;
      if (p.progress > 0.85) a *= (1 - p.progress) / 0.15;
      drawParticle(ctx, x, y, p.size, a, dpr);
    }
  }, { autoplay: cvs.dataset.autoplay === "true" });
}

/* ── Pipeline: 4 sources → agent → production ── */
export function attachPipeline(cvs) {
  const particles = [];
  const checks = [];
  let lastSpawn = 0;
  let spawnIdx = 0;

  attachCanvas(cvs, (ctx, w, h, dpr, now, t) => {
    ctx.clearRect(0, 0, w, h);
    const pulse = Math.sin(now / 400) * 0.3 + 0.7;
    const pad = 20 * dpr, snrr = 8 * dpr, nrr = 14 * dpr;
    const agentX = w * 0.5, prodX = w - pad - nrr, cy = h / 2;

    // 4 input nodes in a small arc on the left
    const baseX = pad + snrr;
    const inputNodes = [0, 1, 2, 3].map((i) => {
      const tt = i - 1.5;
      return { x: baseX + tt * tt * 4 * dpr, y: cy + tt * 16 * dpr };
    });

    // dotted lines from inputs to agent + agent to production
    for (const n of inputNodes) {
      drawDots(ctx, n.x + snrr + 2 * dpr, n.y, agentX - nrr - 4 * dpr, cy, dpr);
    }
    drawDots(ctx, agentX + nrr + 4 * dpr, cy, prodX - nrr - 4 * dpr, cy, dpr);

    // input nodes
    const iScale = lerp(0.3, 0.8, t);
    for (const n of inputNodes) drawNode(ctx, n.x, n.y, dpr, MUTED, iScale, t * pulse * 0.5);

    // agent node (purple)
    ctx.beginPath(); ctx.arc(agentX, cy, nrr, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${PURPLE[0]},${PURPLE[1]},${PURPLE[2]},0.2)`;
    ctx.lineWidth = 1.5 * dpr; ctx.stroke();
    ctx.beginPath(); ctx.arc(agentX, cy, 8 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${PURPLE[0]},${PURPLE[1]},${PURPLE[2]},0.65)`; ctx.fill();

    // production node (green square)
    const pScale = lerp(0.3, 1, t);
    const sq = lerp(4, 8, pScale) * dpr;
    const sqr = lerp(8, 14, pScale) * dpr;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(prodX - sq, cy - sq, sq * 2, sq * 2, 3 * dpr);
    else ctx.rect(prodX - sq, cy - sq, sq * 2, sq * 2);
    ctx.fillStyle = `rgba(${GREEN[0]},${GREEN[1]},${GREEN[2]},${0.5 + 0.2 * pScale})`; ctx.fill();
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(prodX - sqr, cy - sqr, sqr * 2, sqr * 2, 4 * dpr);
    else ctx.rect(prodX - sqr, cy - sqr, sqr * 2, sqr * 2);
    ctx.strokeStyle = `rgba(${GREEN[0]},${GREEN[1]},${GREEN[2]},${0.12 + 0.08 * pScale})`;
    ctx.lineWidth = 1.5 * dpr; ctx.stroke();

    // spawn particles
    if (now - lastSpawn > lerp(1600, 140, t)) {
      lastSpawn = now;
      particles.push({ progress: 0, speed: 0.008 + Math.random() * 0.005, size: 4 + Math.random() * 2, opacity: 0.7, stage: 0, srcIdx: spawnIdx++ % 4 });
    }

    const toPromote = [];
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.progress += p.speed * lerp(1, 3, t);
      let x, y;
      if (p.stage === 0) {
        const src = inputNodes[p.srcIdx];
        const sx = src.x + snrr + 4 * dpr, sy = src.y, ex = agentX - nrr - 4 * dpr;
        if (p.progress > 1) {
          toPromote.push({ progress: 0, stage: 1, speed: 0.01 + Math.random() * 0.006, size: p.size, opacity: p.opacity, srcIdx: p.srcIdx });
          particles.splice(i, 1); continue;
        }
        x = sx + (ex - sx) * p.progress; y = sy + (cy - sy) * p.progress;
      } else {
        const sx = agentX + nrr + 4 * dpr, ex = prodX - sqr - 4 * dpr;
        if (p.progress > 1) { checks.push({ x: prodX, y: cy, t: now }); particles.splice(i, 1); continue; }
        x = sx + (ex - sx) * p.progress; y = cy;
      }
      let a = p.opacity;
      if (p.progress < 0.1) a *= p.progress / 0.1;
      if (p.progress > 0.85) a *= (1 - p.progress) / 0.15;
      drawParticle(ctx, x, y, p.size, a, dpr);
    }
    for (const p of toPromote) particles.push(p);

    // checkmarks fade up
    for (let i = checks.length - 1; i >= 0; i--) {
      const c = checks[i];
      const age = now - c.t;
      if (age > 600) { checks.splice(i, 1); continue; }
      ctx.save();
      ctx.font = `${10 * dpr}px ui-monospace, monospace`;
      ctx.fillStyle = `rgba(${GREEN[0]},${GREEN[1]},${GREEN[2]},${1 - age / 600})`;
      ctx.textAlign = "center";
      ctx.fillText("✓", c.x, c.y - (nrr + 10) * dpr - (age / 600) * 6 * dpr);
      ctx.restore();
    }
  }, { autoplay: cvs.dataset.autoplay === "true" });
}

// Auto-wire elements on DOMContentLoaded
function init() {
  document.querySelectorAll("canvas[data-anim='accelerate']").forEach(attachAccelerate);
  document.querySelectorAll("canvas[data-anim='pipeline']").forEach(attachPipeline);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
