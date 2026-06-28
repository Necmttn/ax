import { useEffect, useRef } from "react";

const METRICS = [
  {
    label: "PRs merged / sprint",
    num: "+38%",
    detail: "more shipped work, same headcount",
  },
  {
    label: "QA & ops automated",
    num: "61%",
    detail: "of manual QA & ops steps now agent-run",
  },
  {
    label: "time to ship",
    num: "−29%",
    detail: "median cycle time, idea → deploy",
  },
];

const RANGES: [number, number][] = [
  [0, 0.38],
  [0.15, 0.53],
  [0.3, 0.68],
];

function MetricBar({
  label,
  num,
  detail,
  range,
  scrollProgress,
}: {
  label: string;
  num: string;
  detail: string;
  range: [number, number];
  scrollProgress: React.RefObject<{ value: number }>;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const numRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    // "+38%" / "61%" / "−29%" → sign, digits, suffix for the count-up
    const parsed = num.match(/^([+−-]?)(\d+)(%?)$/);
    let raf: number;
    const update = () => {
      const p = scrollProgress.current?.value ?? 0;
      const [lo, hi] = range;
      const fill = Math.max(0, Math.min(1, (p - lo) / (hi - lo)));
      if (barRef.current) barRef.current.style.transform = `scaleX(${fill})`;
      if (numRef.current && parsed) {
        const sign = parsed[1] ?? "";
        const digits = parsed[2] ?? "0";
        const suffix = parsed[3] ?? "";
        const value = Math.round(Number.parseInt(digits, 10) * fill);
        numRef.current.textContent = `${sign}${value}${suffix}`;
      }
      raf = requestAnimationFrame(update);
    };
    raf = requestAnimationFrame(update);
    return () => cancelAnimationFrame(raf);
  }, [scrollProgress, range, num]);

  return (
    <div className="metric-bar">
      <div className="metric-bar__top">
        <span className="metric-bar__label">{label}</span>
        <span ref={numRef} className="metric-bar__num">
          {num}
        </span>
      </div>
      <div className="metric-bar__track">
        <div ref={barRef} className="metric-bar__fill" />
      </div>
      <p>{detail}</p>
    </div>
  );
}

export function MetricsBars({
  scrollProgress,
  className,
}: {
  scrollProgress: React.RefObject<{ value: number }>;
  className?: string;
}) {
  return (
    <div className={`metrics-bars ${className || ""}`}>
      {METRICS.map((metric, index) => (
        <MetricBar
          key={metric.label}
          scrollProgress={scrollProgress}
          label={metric.label}
          num={metric.num}
          detail={metric.detail}
          range={RANGES[index] ?? [0, 1]}
        />
      ))}
    </div>
  );
}
