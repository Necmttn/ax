"use client";
import { useEffect, useRef } from "react";

export function ChapterExhibitA() {
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    // ── Rail drag (vertical re-injection dial) ──────────────────────────────
    const LEVEL_ORDER = ["off", "light", "full"] as const;
    type Level = typeof LEVEL_ORDER[number];
    const LEVELS: Record<Level, number> = { off: 400, light: 290, full: 118 };

    const fig          = root;
    const handleEl     = root.querySelector<SVGRectElement>("[data-cs-handle]");
    const reinjectLine = root.querySelector<SVGLineElement>("[data-curve-reinject]");
    const axHalo       = root.querySelector<SVGCircleElement>("[data-ax-halo]");
    const axMarker     = root.querySelector<SVGCircleElement>("[data-ax-marker]");
    const axLabel      = root.querySelector<SVGTextElement>("[data-ax-label]");
    const axSub        = root.querySelector<SVGTextElement>("[data-ax-sub]");
    const axMeta       = root.querySelector<HTMLElement>("[data-ax-meta]");
    const pill         = root.querySelector<HTMLElement>("[data-curve-pill]");
    const pillLabel    = root.querySelector<HTMLElement>("[data-curve-label]");
    const resetBtn     = root.querySelector<HTMLElement>("[data-curve-reset]");

    if (!handleEl || !reinjectLine || !axHalo || !axMarker) return;

    let currentLevel: Level = "full";

    const META: Record<Level, string> = {
      full:  "~14 signals/week, sustained · retros + corrections + tool calls + git",
      light: "~4 signals/week · retros only",
      off:   "null state · no signal reinjected",
    };

    // y positions: off=400, light=290, full=118 (SVG coords)
    const CURVE_Y: Record<Level, number> = { off: 386, light: 280, full: 118 };
    const LABEL_Y: Record<Level, number> = { off: 374, light: 268, full: 106 };
    const LABEL_X = 848;

    function setLevel(level: Level) {
      currentLevel = level;
      fig.setAttribute("data-level", level);

      const railY = LEVELS[level];
      // move handle
      handleEl!.setAttribute("y", String(railY - 5));
      handleEl!.setAttribute("aria-valuenow", String(LEVEL_ORDER.indexOf(level)));

      // move ax marker + reinject line
      const cy    = CURVE_Y[level];
      const ly    = LABEL_Y[level];
      reinjectLine!.setAttribute("y2", String(railY));
      axHalo!.setAttribute("cy", String(cy));
      axMarker!.setAttribute("cy", String(cy));
      if (axLabel) {
        axLabel.setAttribute("y", String(ly));
        axSub?.setAttribute("y", String(ly + 18));
      }

      // update meta text
      if (axMeta) axMeta.textContent = META[level];

      // aria
      handleEl!.setAttribute(
        "aria-label",
        `re-injection level: ${level} (${LEVEL_ORDER.indexOf(level)} of 2)`,
      );
    }

    // ── Autoplay sequence ───────────────────────────────────────────────────
    function setPillState(state: string, text: string) {
      pill?.setAttribute("data-state", state);
      if (pillLabel) pillLabel.textContent = text;
    }

    let pendingTimers: ReturnType<typeof setTimeout>[] = [];
    let pendingRafs: number[] = [];
    let userTookOver = false;
    let autoPlaying  = false;

    function clearPending() {
      pendingTimers.forEach(clearTimeout);
      pendingRafs.forEach(cancelAnimationFrame);
      pendingTimers = [];
      pendingRafs   = [];
    }

    function tween(
      from: Level,
      to: Level,
      durMs: number,
    ): Promise<void> {
      return new Promise((resolve) => {
        if (userTookOver) { resolve(); return; }
        const fromY = LEVELS[from];
        const toY   = LEVELS[to];
        const t0    = performance.now();
        function frame(now: number) {
          if (userTookOver) { resolve(); return; }
          let t = (now - t0) / durMs;
          if (t >= 1) t = 1;
          const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
          const yVal = fromY + (toY - fromY) * eased;

          // mid-tween: update visual only, not the level snap
          handleEl!.setAttribute("y", String(yVal - 5));
          const frac = (yVal - 400) / (118 - 400); // 0=off, 1=full
          const cy = CURVE_Y.off + (CURVE_Y.full - CURVE_Y.off) * frac;
          const ly = LABEL_Y.off + (LABEL_Y.full - LABEL_Y.off) * frac;
          reinjectLine!.setAttribute("y2", String(yVal));
          axHalo!.setAttribute("cy", String(cy));
          axMarker!.setAttribute("cy", String(cy));
          if (axLabel) axLabel.setAttribute("y", String(ly));
          if (axSub)   axSub.setAttribute("y", String(ly + 18));

          if (t < 1) {
            const rid = requestAnimationFrame(frame);
            pendingRafs.push(rid);
          } else {
            setLevel(to);
            resolve();
          }
        }
        const rid = requestAnimationFrame(frame);
        pendingRafs.push(rid);
      });
    }

    function wait(ms: number): Promise<void> {
      return new Promise((resolve) => {
        const id = setTimeout(() => {
          pendingTimers = pendingTimers.filter((t) => t !== id);
          resolve();
        }, ms);
        pendingTimers.push(id);
      });
    }

    async function runAutoplay() {
      if (userTookOver || reduce) return;
      autoPlaying = true;
      setPillState("playing", "auto · playing");

      // Start at off, animate to full, pause, then back to light
      setLevel("off");
      await wait(800);
      if (userTookOver) return;
      await tween("off", "full", 1800);
      if (userTookOver) return;
      await wait(1400);
      if (userTookOver) return;
      await tween("full", "light", 1200);
      if (userTookOver) return;
      await wait(600);

      autoPlaying = false;
      setPillState("done", "auto · done");
    }

    function takeover() {
      if (userTookOver) return;
      userTookOver = true;
      autoPlaying  = false;
      clearPending();
      setPillState("manual", "manual");
    }

    // ── Drag handle ─────────────────────────────────────────────────────────
    const svg = root.querySelector<SVGSVGElement>("svg");
    if (!svg) return;

    let dragging = false;
    const RAIL_X = 965;
    const RAIL_TOP = 118;
    const RAIL_BOT = 400;

    function svgY(clientY: number) {
      const rect = svg!.getBoundingClientRect();
      const scaleY = 520 / rect.height;
      return (clientY - rect.top) * scaleY;
    }

    function snapLevel(y: number): Level {
      const mid1 = (LEVELS.off + LEVELS.light) / 2;   // 345
      const mid2 = (LEVELS.light + LEVELS.full) / 2;  // 204
      if (y >= mid1) return "off";
      if (y >= mid2) return "light";
      return "full";
    }

    handleEl.addEventListener("pointerdown", (ev) => {
      if (reduce) return;
      takeover();
      dragging = true;
      handleEl.classList.add("is-dragging");
      handleEl.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    });

    handleEl.addEventListener("pointermove", (ev) => {
      if (!dragging) return;
      const y = Math.max(RAIL_TOP, Math.min(RAIL_BOT, svgY(ev.clientY)));
      handleEl.setAttribute("y", String(y - 5));
      reinjectLine!.setAttribute("y2", String(y));
      const frac = (y - RAIL_BOT) / (RAIL_TOP - RAIL_BOT);
      const cy = CURVE_Y.off + (CURVE_Y.full - CURVE_Y.off) * frac;
      const ly = LABEL_Y.off + (LABEL_Y.full - LABEL_Y.off) * frac;
      axHalo!.setAttribute("cy", String(cy));
      axMarker!.setAttribute("cy", String(cy));
      if (axLabel) axLabel.setAttribute("y", String(ly));
      if (axSub)   axSub.setAttribute("y", String(ly + 18));
    });

    handleEl.addEventListener("pointerup", (ev) => {
      if (!dragging) return;
      dragging = false;
      handleEl.classList.remove("is-dragging");
      try { handleEl.releasePointerCapture(ev.pointerId); } catch (_) {}
      const y = svgY(ev.clientY);
      setLevel(snapLevel(y));
    });

    handleEl.addEventListener("pointercancel", () => {
      dragging = false;
      handleEl.classList.remove("is-dragging");
    });

    // Keyboard on handle
    handleEl.addEventListener("keydown", (ev) => {
      if (reduce) return;
      takeover();
      const idx = LEVEL_ORDER.indexOf(currentLevel);
      if (ev.key === "ArrowUp" && idx < 2) {
        const next = LEVEL_ORDER[idx + 1];
        if (next) setLevel(next);
      }
      if (ev.key === "ArrowDown" && idx > 0) {
        const previous = LEVEL_ORDER[idx - 1];
        if (previous) setLevel(previous);
      }
      ev.preventDefault();
    });

    resetBtn?.addEventListener("click", () => {
      userTookOver = false;
      autoPlaying  = false;
      clearPending();
      setLevel("full");
      setPillState("idle", "auto · idle");
      if (!reduce) {
        const id = setTimeout(() => { if (!userTookOver) runAutoplay(); }, 1200);
        pendingTimers.push(id);
      }
    });

    root.addEventListener("pointerdown", (ev) => {
      if ((ev.target as Element).closest("[data-curve-reset]")) return;
      if ((ev.target as Element).closest("[data-cs-handle]")) return;
      if (autoPlaying) takeover();
    }, true);

    // Boot
    if (reduce) {
      fig.setAttribute("data-static", "1");
      setPillState("reduce", "motion paused");
      setLevel("full");
    } else {
      setLevel("full");
      setPillState("idle", "auto · idle");
      let io: IntersectionObserver | null = null;
      let fired = false;
      if ("IntersectionObserver" in window) {
        io = new IntersectionObserver((entries) => {
          entries.forEach((e) => {
            if (e.isIntersecting && !fired && !userTookOver) {
              fired = true;
              io?.disconnect();
              io = null;
              const id = setTimeout(() => { if (!userTookOver) runAutoplay(); }, 600);
              pendingTimers.push(id);
            }
          });
        }, { threshold: 0.3 });
        io.observe(root);
      }

      return () => {
        clearPending();
        io?.disconnect();
      };
    }

    return () => {
      clearPending();
    };
  }, []);

  return (
    <figure className="fig-curve" data-level="full" ref={rootRef}
      aria-label="As agent autonomy grew, human feedback density collapsed - drag the dial to set how much signal ax reinjects">
      <div className="fig-head">
        <span className="fig-id">Exhibit A</span>
        <span>capability vs. signal density · 2021 - 2026</span>
        <button type="button" className="auto-pill" data-curve-pill data-state="idle" aria-label="autoplay status">
          <span className="auto-dot" aria-hidden="true"></span><span className="auto-label" data-curve-label>auto · idle</span>
        </button>
        <button type="button" className="reset" data-curve-reset aria-label="reset re-injection dial">reset</button>
      </div>

      <div className="curve-wrap" data-curve-wrap>
        <svg viewBox="0 0 1000 520" preserveAspectRatio="xMidYMid meet" role="img" aria-hidden="true">
          {/* y axis label (rotated) */}
          <text className="ax-y-title" x="-235" y="32" transform="rotate(-90)" textAnchor="middle">human feedback density</text>
          <text className="ax-y-sub"   x="-235" y="50" transform="rotate(-90)" textAnchor="middle">signals per hour, log scale</text>

          {/* y axis line + sparse tick marks */}
          <line className="ax-axis" x1="130" y1="70"  x2="130" y2="400"/>
          <line className="ax-tick" x1="124" y1="70"  x2="130" y2="70"/>
          <line className="ax-tick" x1="124" y1="180" x2="130" y2="180"/>
          <line className="ax-tick" x1="124" y1="290" x2="130" y2="290"/>
          <line className="ax-tick" x1="124" y1="400" x2="130" y2="400"/>

          {/* y tick labels */}
          <text className="ax-tick-label" x="118" y="74"  textAnchor="end">~60/min</text>
          <text className="ax-tick-label" x="118" y="184" textAnchor="end">~6/hr</text>
          <text className="ax-tick-label" x="118" y="294" textAnchor="end">~1/hr</text>
          <text className="ax-tick-label" x="118" y="404" textAnchor="end">~2/week</text>

          {/* x axis line + sparse tick marks at each generation */}
          <line className="ax-axis" x1="130" y1="400" x2="930" y2="400"/>
          <line className="ax-tick" x1="200" y1="400" x2="200" y2="406"/>
          <line className="ax-tick" x1="430" y1="400" x2="430" y2="406"/>
          <line className="ax-tick" x1="660" y1="400" x2="660" y2="406"/>
          <line className="ax-tick" x1="870" y1="400" x2="870" y2="406"/>

          {/* x axis labels */}
          <text className="ax-x-title" x="530" y="488" textAnchor="middle">agent capability / autonomy →</text>
          <text className="ax-tick-label" x="200" y="424" textAnchor="middle">autocomplete</text>
          <text className="ax-tick-label" x="430" y="424" textAnchor="middle">chat</text>
          <text className="ax-tick-label" x="660" y="424" textAnchor="middle">task loop</text>
          <text className="ax-tick-label" x="870" y="424" textAnchor="middle">background</text>

          <text className="ax-tick-label dim" x="200" y="442" textAnchor="middle">2021 - 22</text>
          <text className="ax-tick-label dim" x="430" y="442" textAnchor="middle">2023</text>
          <text className="ax-tick-label dim" x="660" y="442" textAnchor="middle">2024 - 25</text>
          <text className="ax-tick-label dim" x="870" y="442" textAnchor="middle">2025 - 26</text>

          {/* descending curve through the four points */}
          <path className="curve-line"
                d="M 200,84 C 290,110 360,160 430,180 C 510,205 590,260 660,290 C 740,318 820,378 870,386"/>

          {/* four open dots on the curve, numbered 1..4 */}
          <g className="curve-dot-group">
            <circle className="curve-dot" cx="200" cy="84"  r="14"/>
            <text   className="curve-dot-num" x="200" y="89" textAnchor="middle">1</text>
          </g>
          <g className="curve-dot-group">
            <circle className="curve-dot" cx="430" cy="180" r="14"/>
            <text   className="curve-dot-num" x="430" y="185" textAnchor="middle">2</text>
          </g>
          <g className="curve-dot-group">
            <circle className="curve-dot" cx="660" cy="290" r="14"/>
            <text   className="curve-dot-num" x="660" y="295" textAnchor="middle">3</text>
          </g>
          <g className="curve-dot-group">
            <circle className="curve-dot" cx="870" cy="386" r="14"/>
            <text   className="curve-dot-num" x="870" y="391" textAnchor="middle">4</text>
          </g>

          {/* ax reinjection: dashed line from t+4 dot up to marker */}
          <line className="curve-reinject" data-curve-reinject
                x1="870" y1="386" x2="870" y2="118"/>
          <circle className="ax-marker-halo" data-ax-halo cx="870" cy="118" r="22"/>
          <circle className="ax-marker"      data-ax-marker cx="870" cy="118" r="9"/>
          <text className="ax-marker-label" data-ax-label x="848" y="106" textAnchor="end">ax</text>
          <text className="ax-marker-sub"   data-ax-sub   x="848" y="124" textAnchor="end">signal reinjected</text>

          {/* re-injection dial */}
          <g className="curve-slider" data-curve-slider aria-hidden="true">
            <line className="cs-rail" x1="965" y1="118" x2="965" y2="400"/>
            <line className="cs-tick" x1="958" y1="400" x2="972" y2="400"/>
            <line className="cs-tick" x1="958" y1="290" x2="972" y2="290"/>
            <line className="cs-tick" x1="958" y1="118" x2="972" y2="118"/>
            <text className="cs-tick-label" x="980" y="404" textAnchor="start">off</text>
            <text className="cs-tick-label" x="980" y="294" textAnchor="start">light</text>
            <text className="cs-tick-label" x="980" y="122" textAnchor="start">full</text>
            <text className="cs-rail-label" x="965" y="94" textAnchor="middle">re-inject</text>
            <rect className="cs-handle" data-cs-handle
                  x="960" y="113" width="10" height="10"
                  tabIndex={0} role="slider"
                  aria-valuemin={0} aria-valuemax={2} aria-valuenow={2}
                  aria-label="re-injection level: off, light, or full"/>
          </g>
        </svg>
      </div>

      {/* legend */}
      <ol className="curve-legend" aria-label="generations on the curve">
        <li><span className="lg-num">1</span><span className="lg-name">autocomplete</span><span className="lg-meta"><kbd>tab</kbd> / no-tab · ~60 signals per minute</span></li>
        <li><span className="lg-num">2</span><span className="lg-name">chat</span><span className="lg-meta">correction in prose · ~6 per hour</span></li>
        <li><span className="lg-num">3</span><span className="lg-name">task loop</span><span className="lg-meta">plan + check · ~1 per hour</span></li>
        <li><span className="lg-num">4</span><span className="lg-name">background</span><span className="lg-meta">hand off, walk away · ~2 per week</span></li>
        <li className="is-ax"><span className="lg-num">ax</span><span className="lg-name">signal reinjected</span><span className="lg-meta ax-meta" data-ax-meta>~14 signals/week, sustained · retros + corrections + tool calls + git</span></li>
      </ol>

      <figcaption>
        <strong>Capability went up. Signal density collapsed.</strong>{" "}
        Drag the dial on the right to set how much of that lost signal{" "}
        <code>ax</code> rejoins. Off is the null state — what the
        article looks like without it. Re-injection rates illustrative;
        actual values vary by session length and ingest scope.
      </figcaption>
    </figure>
  );
}
