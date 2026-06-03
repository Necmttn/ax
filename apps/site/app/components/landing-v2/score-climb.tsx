"use client";
import { useEffect, useRef, useState } from "react";

const R = 14;
const CIRC = 2 * Math.PI * R; // ~87.96

const START = 58;
const FIXES = [
  { ax: "added", cmd: "pnpm test to AGENTS.md", to: 67 },
  { ax: "ignored", cmd: "dist/ + .generated/", to: 76 },
  { ax: "pruned", cmd: "3 stale CLAUDE.md rules", to: 84 },
  { ax: "added", cmd: "recovery_path hook", to: 91 },
];
const END = FIXES[FIXES.length - 1]!.to;

function bandFor(score: number): { label: string; band: "low" | "mid" | "high" } {
  if (score >= 85) return { label: "solid", band: "high" };
  if (score >= 70) return { label: "getting there", band: "mid" };
  return { label: "needs work", band: "low" };
}

function offsetFor(score: number) {
  return (CIRC * (100 - score)) / 100;
}

export function ScoreClimb() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const ringRef = useRef<SVGCircleElement | null>(null);
  const numRef = useRef<HTMLSpanElement | null>(null);
  const bandRef = useRef<HTMLSpanElement | null>(null);
  const [revealed, setRevealed] = useState(0);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    function paint(score: number) {
      const rounded = Math.round(score);
      if (numRef.current) numRef.current.textContent = String(rounded);
      if (ringRef.current)
        ringRef.current.style.strokeDashoffset = String(offsetFor(score));
      const b = bandFor(rounded);
      if (bandRef.current) bandRef.current.textContent = b.label;
      if (rootRef.current) rootRef.current.dataset.band = b.band;
    }

    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    if (reduced) {
      paint(END);
      setRevealed(FIXES.length);
      return;
    }

    paint(START);
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let raf = 0;
    let started = false;

    function tween(from: number, to: number, dur: number) {
      const t0 = performance.now();
      function frame(now: number) {
        const t = Math.min(1, (now - t0) / dur);
        const eased = 1 - Math.pow(1 - t, 3);
        paint(from + (to - from) * eased);
        if (t < 1) raf = requestAnimationFrame(frame);
      }
      raf = requestAnimationFrame(frame);
    }

    function run() {
      if (started) return;
      started = true;
      let prev = START;
      FIXES.forEach((fix, i) => {
        timers.push(
          setTimeout(
            () => {
              setRevealed(i + 1);
              const from = prev;
              tween(from, fix.to, 720);
              prev = fix.to;
            },
            700 + i * 1100
          )
        );
      });
    }

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            run();
            io.disconnect();
          }
        });
      },
      { threshold: 0.4 }
    );
    io.observe(root);

    return () => {
      io.disconnect();
      timers.forEach((t) => clearTimeout(t));
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div className="score-climb" ref={rootRef} data-band="low">
      <div className="score-climb__dial">
        <svg className="score-ring" viewBox="0 0 36 36" aria-hidden="true">
          <circle className="track" cx="18" cy="18" r={R} />
          <circle
            className="fill"
            ref={ringRef}
            cx="18"
            cy="18"
            r={R}
            transform="rotate(-90 18 18)"
            strokeDasharray={`${CIRC} ${CIRC}`}
            strokeDashoffset={offsetFor(START)}
          />
        </svg>
        <div className="score-ring__center">
          <span className="n" ref={numRef}>
            {START}
          </span>
          <span className="denom">/ 100</span>
        </div>
      </div>

      <div className="score-climb__side">
        <span className="score-climb__band" ref={bandRef}>
          needs work
        </span>
        <p className="score-climb__feed-head">ax applied, one review at a time</p>
        <ul className="score-climb__feed" aria-label="improvements ax applied">
          {FIXES.map((f, i) => (
            <li key={f.cmd} className={i < revealed ? "is-on" : ""}>
              <span className="tick" aria-hidden="true">
                ✓
              </span>
              <span className="ax">ax</span>
              <span className="verb">{f.ax}</span>
              <code>{f.cmd}</code>
            </li>
          ))}
        </ul>
        <p className="score-climb__foot">
          same harness &middot; {revealed > 0 ? revealed : "four"} fixes later
        </p>
      </div>
    </div>
  );
}
