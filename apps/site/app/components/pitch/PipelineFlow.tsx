import { useEffect, useRef } from "react";

const STAGES = ["PLAN", "CODE", "REVIEW", "TEST", "DEPLOY"];
const SQ = 5;
const MAX_DOTS = 120;
const OPEN_MS = 320;
const CLOSE_MS = 520;
const GREENS = ["#39d353", "#26a641", "#006d32", "#0e4429", "#39d353", "#26a641", "#006d32", "#0e4429"];
const FALLBACK_GREEN = "#39d353";

interface Dot {
  x: number;
  y: number;
  speed: number;
  colorIdx: number;
}

export function PipelineFlow({
  scrollProgress,
  className,
}: {
  scrollProgress: React.RefObject<{ value: number }>;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<(HTMLSpanElement | null)[]>([]);

  const state = useRef({
    dots: [] as Dot[],
    transitions: new Float64Array(STAGES.length),
    tick: 0,
    nid: 0,
    w: 0,
    h: 0,
    lastTs: 0,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const s = state.current;
    let raf = 0;
    let visible = true;

    const fit = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = devicePixelRatio || 1;
      s.w = rect.width;
      s.h = rect.height;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(wrap);
    fit();

    const intersectionObserver = new IntersectionObserver(
      ([entry]) => {
        visible = entry?.isIntersecting ?? false;
      },
      { threshold: 0 },
    );
    intersectionObserver.observe(wrap);

    const maxH = 0.38;
    const minH = 0.06;
    const sigma = 0.035;

    const half = (x: number) => {
      let result = maxH;
      for (let i = 0; i < STAGES.length; i++) {
        const center = (i + 0.5) / STAGES.length;
        const bell = Math.exp(-0.5 * ((x - center) / sigma) ** 2);
        const transition = s.transitions[i] ?? 0;
        const min = minH + (maxH - minH) * transition;
        result -= (maxH - min) * bell;
      }
      return Math.max(minH, result);
    };

    const speed = (x: number) => {
      const h = half(x);
      return 0.003 + 0.997 * (((h - minH) / (maxH - minH)) ** 0.3);
    };

    const frame = (ts: number) => {
      const dt = s.lastTs === 0 ? 16.67 : Math.min(ts - s.lastTs, 48);
      s.lastTs = ts;
      if (!visible || !s.w) {
        raf = requestAnimationFrame(frame);
        return;
      }

      const { w, h, dots } = s;
      const cy = h * 0.52;
      const ps = h * 0.7;
      const progress = scrollProgress.current?.value ?? 0;

      for (let i = 0; i < STAGES.length; i++) {
        const threshold = (i + 1) / (STAGES.length + 1);
        const target = progress >= threshold ? 1 : 0;
        const duration = target === 1 ? OPEN_MS : CLOSE_MS;
        const maxStep = dt / duration;
        const current = s.transitions[i] ?? 0;
        const delta = target - current;
        s.transitions[i] =
          Math.abs(delta) <= maxStep ? target : current + Math.sign(delta) * maxStep;

        const label = labelsRef.current[i];
        if (label) {
          const open = progress >= threshold;
          label.style.color = open ? "var(--green)" : "var(--muted)";
          label.style.fontWeight = open ? "700" : "500";
        }
      }

      s.tick++;
      if (s.tick % 2 === 0 && dots.length < MAX_DOTS) {
        dots.push({
          x: -0.015,
          y: 0.5 + (Math.random() - 0.5) * 0.35,
          speed: 0.002 + Math.random() * 0.003,
          colorIdx: s.nid++ % GREENS.length,
        });
      }

      dots.sort((a, b) => a.x - b.x);

      const bottlenecks: { center: number; closedness: number }[] = [];
      for (let i = 0; i < STAGES.length; i++) {
        const closedness = 1 - (s.transitions[i] ?? 0);
        if (closedness > 0.1) bottlenecks.push({ center: (i + 0.5) / STAGES.length, closedness });
      }

      for (let dotIndex = 0; dotIndex < dots.length; dotIndex++) {
        const dot = dots[dotIndex];
        if (!dot) continue;
        let dotSpeed = speed(dot.x);
        for (const bottleneck of bottlenecks) {
          const zone = 0.18;
          const distance = bottleneck.center - dot.x;
          if (distance > -0.02 && distance < zone) {
            const minGap = 0.01 + 0.03 * (1 - bottleneck.closedness);
            for (let j = dotIndex + 1; j < dots.length; j++) {
              const next = dots[j];
              if (!next) continue;
              const gap = next.x - dot.x;
              if (gap > minGap * 2) break;
              if (next.x > bottleneck.center - zone && gap < minGap) {
                const far = distance / zone;
                dotSpeed *= 0.03 + 0.7 * far * far;
                break;
              }
            }
          }
        }
        dot.x += dot.speed * dotSpeed * (0.8 + Math.random() * 0.4);
        dot.y += (Math.random() - 0.5) * 0.004;
        const h2 = half(dot.x);
        dot.y = Math.max(0.5 - h2 + 0.04, Math.min(0.5 + h2 - 0.04, dot.y));
      }
      s.dots = dots.filter((dot) => dot.x < 1.04);

      ctx.clearRect(0, 0, w, h);

      const isDark = document.documentElement.classList.contains("dark");
      const wallColor = isDark ? "rgba(255,255,255,0.15)" : "#ccc9c3";
      const divColor = isDark ? "rgba(255,255,255,0.06)" : "#ccc9c340";

      ctx.lineWidth = 1;
      ctx.strokeStyle = wallColor;
      for (const sign of [-1, 1]) {
        ctx.beginPath();
        for (let i = 0; i <= 200; i++) {
          const nx = i / 200;
          const px = nx * w;
          const py = cy + sign * half(nx) * ps;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }

      ctx.setLineDash([3, 5]);
      ctx.strokeStyle = divColor;
      for (let i = 1; i < STAGES.length; i++) {
        const px = (i / STAGES.length) * w;
        ctx.beginPath();
        ctx.moveTo(px, cy - maxH * ps);
        ctx.lineTo(px, cy + maxH * ps);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      for (let i = 0; i < STAGES.length; i++) {
        const transition = s.transitions[i] ?? 0;
        if (transition < 0.9) {
          const bx = ((i + 0.5) / STAGES.length) * w;
          ctx.setLineDash([2, 4]);
          ctx.strokeStyle = isDark
            ? `rgba(255,120,80,${0.3 * (1 - transition)})`
            : `rgba(191,74,48,${0.3 * (1 - transition)})`;
          ctx.beginPath();
          ctx.moveTo(bx, cy - 0.44 * ps);
          ctx.lineTo(bx, cy + 0.44 * ps);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      ctx.save();
      ctx.shadowColor = "#39d35380";
      ctx.shadowBlur = 5;
      for (const dot of s.dots) {
        ctx.fillStyle = GREENS[dot.colorIdx] ?? FALLBACK_GREEN;
        ctx.fillRect(dot.x * w - SQ / 2, cy + (dot.y - 0.5) * ps * 0.6 - SQ / 2, SQ, SQ);
      }
      ctx.restore();

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
    };
  }, [scrollProgress]);

  return (
    <div className={`pipeline-flow ${className || ""}`}>
      <div className="pipeline-flow__labels">
        {STAGES.map((name, index) => (
          <div key={name}>
            <span
              ref={(element) => {
                labelsRef.current[index] = element;
              }}
            >
              {name}
            </span>
          </div>
        ))}
      </div>
      <div ref={wrapRef} className="pipeline-flow__canvas-wrap">
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}
