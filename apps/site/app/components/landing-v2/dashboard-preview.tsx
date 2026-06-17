"use client";
import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AGENT_ONBOARDING_WITH_INSTALL } from "@ax/onboarding-prompt";
import { HeroLogoField, PROVIDERS } from "./supports-strip";
import { RetroTerminal } from "./retro-terminal";
import {
  McBars,
  McLine,
  McRadar,
  McRing,
  McWaffle,
  McCandles,
  McComet,
  McWave,
  McBullet,
  McSignal,
  McScatter,
  McDelta,
} from "../card-viz";

// ============================================================================
// Mission Control preview - a static recreation of the studio home (instrument
// HUD) for the landing. Charts are CSS-only (segbars, heat cells, LED, archetype
// sigil); numbers are representative demo data. Mirrors the real component at
// apps/studio/src/instrument/mission-control.tsx so the landing reflects the
// ramped studio. Styles: .browser--instrument .mc-* in globals.css.
// ============================================================================
const MC_MODELS = [
  { name: "opus", pct: 46, usd: "$1.9K", tone: "var(--blue)" },
  { name: "sonnet", pct: 31, usd: "$1.3K", tone: "#e0556f" },
  { name: "fable", pct: 14, usd: "$588", tone: "var(--green)" },
  { name: "haiku", pct: 6, usd: "$252", tone: "var(--violet)" },
  { name: "gpt-5", pct: 3, usd: "$126", tone: "var(--gold)" },
];

// deterministic ~21-week activity strip (5 rows × 30 cols), contribution levels 0..4
const MC_ACTIVITY: number[] = Array.from({ length: 150 }, (_, i) => {
  const x = i % 30;
  const y = Math.floor(i / 30);
  const v = Math.sin(x * 0.7 + y) * 0.5 + Math.sin(x * 0.3) * 0.4 + 0.5;
  if (v < 0.18) return 0;
  return v > 0.85 ? 4 : v > 0.6 ? 3 : v > 0.35 ? 2 : 1;
});

// archetype "ring" sigil (11×7 dot-matrix), the studio's primary-archetype glyph
const MC_SIGIL: number[] = Array.from({ length: 77 }, (_, i) => {
  const x = i % 11;
  const y = Math.floor(i / 11);
  const d = Math.hypot(x - 5, (y - 3) * 1.25);
  const v = Math.max(0, Math.min(1, 1.1 - Math.abs(d - 2.7) * 0.8));
  return v > 0.66 ? 4 : v > 0.4 ? 3 : v > 0.15 ? 2 : v > 0 ? 1 : 0;
});

const pad2 = (n: number) => String(n).padStart(2, "0");

function McLed({ tone }: { tone?: "alert" }) {
  return <span className={`mc-led${tone ? ` mc-led--${tone}` : ""}`} aria-hidden="true" />;
}

function McSeg({
  total,
  on,
  color,
  gradient,
}: { total: number; on: number; color?: string; gradient?: boolean }) {
  return (
    <div className="mc-seg" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => {
        const lit = i < on;
        const style: React.CSSProperties = { animationDelay: `${0.2 + i * 0.04}s` };
        if (lit && color) {
          if (gradient) {
            const pct = Math.round(34 + 66 * (on <= 1 ? 1 : i / (on - 1)));
            style.background = `color-mix(in srgb, ${color} ${pct}%, var(--surface2))`;
          } else {
            style.background = color;
          }
        }
        return <i key={i} className={lit ? "on" : ""} style={style} />;
      })}
    </div>
  );
}

function McCells({
  levels,
  cols,
  cell = 11,
}: { levels: number[]; cols: number; cell?: number }) {
  return (
    <div
      className="mc-cells"
      aria-hidden="true"
      style={{
        gridTemplateColumns: `repeat(${cols}, ${cell}px)`,
        gridAutoRows: `${cell}px`,
      }}
    >
      {levels.map((l, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        return (
          <i
            key={i}
            className={l ? `lvl-${l}` : ""}
            style={{ animationDelay: `${0.15 + (col + row) * 0.016}s` }}
          />
        );
      })}
    </div>
  );
}

// SSR-stable placeholder until the clock mounts client-side, then it ticks live.
const MC_PLACEHOLDER = new Date(2026, 5, 16, 23, 14, 7);

function McClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const iv = window.setInterval(() => {
      if (!document.hidden) setNow(new Date());
    }, 1000);
    return () => window.clearInterval(iv);
  }, []);
  const t = now ?? MC_PLACEHOLDER;
  const day = t.toLocaleDateString("en-US", { weekday: "long" });
  const date = t
    .toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric" })
    .toUpperCase();
  return (
    <section className="mc-card mc-clock">
      <div className="mc-clock-top mc-label">
        <span>local time</span>
        <span className="mc-live">
          <McLed />
          live &middot; 312 active days
        </span>
      </div>
      <div className="mc-clock-time">
        <McLed tone="alert" />
        <span className="mc-doto t">
          {pad2(t.getHours())}:{pad2(t.getMinutes())}
        </span>
        <span className="mc-doto s">{pad2(t.getSeconds())}</span>
      </div>
      <div className="mc-clock-foot">
        <div>
          <div className="mc-day">{day}</div>
          <div className="mc-label">{date} &middot; 2,847 sessions traced</div>
        </div>
        <div className="mc-clock-push">
          <div className="mc-label">archetype &middot; high</div>
          <div className="mc-label mc-strong">
            The Cartographer <span className="mc-sq" />
          </div>
        </div>
      </div>
    </section>
  );
}


// The 12 wrapped readouts the floating popups cycle through - each keys a channel
// accent and carries one chart + a one-line caption. (Recreated from the studio
// card-viz registry: apps/studio/src/instrument/card-viz.tsx.)
const POP_CHARTS: ReadonlyArray<{
  key: string;
  accent: string;
  q: string;
  h: string;
  viz: React.ReactNode;
}> = [
  { key: "bars", accent: "acc-green", q: "when you ship", h: "Tuesday nights", viz: <McBars data={[22, 31, 28, 44, 39, 58, 47, 63, 71, 55, 82, 90, 74, 61, 88, 96]} /> },
  { key: "ring", accent: "acc-gold", q: "fixes stick", h: "82% hold", viz: <McRing pct={82} /> },
  { key: "line", accent: "acc-blue", q: "tokens / year", h: "1.4B", viz: <McLine data={[18, 24, 21, 33, 40, 38, 52, 60, 57, 71, 80, 78, 92, 100]} /> },
  { key: "radar", accent: "acc-violet", q: "skill profile", h: "systems mind", viz: <McRadar data={[82, 64, 91, 48, 73]} /> },
  { key: "waffle", accent: "acc-green", q: "paths covered", h: "73%", viz: <McWaffle pct={73} /> },
  { key: "candles", accent: "acc-rose", q: "session swings", h: "big nights", viz: <McCandles data={[40, 60, 55, 75, 70, 50, 62, 80, 72, 88]} /> },
  { key: "comet", accent: "acc-blue", q: "quota burn", h: "61%", viz: <McComet pct={61} /> },
  { key: "wave", accent: "acc-violet", q: "latency", h: "steady", viz: <McWave data={[50, 80, 20, 60, 35, 70, 45, 66, 30, 72]} /> },
  { key: "scatter", accent: "acc-rose", q: "cost vs reward", h: "lands cheap", viz: <McScatter data={[30, 50, 45, 70, 60, 85, 55, 40, 66, 52]} /> },
  { key: "bullet", accent: "acc-gold", q: "ship goal", h: "82 / 70", viz: <McBullet actual={82} target={70} /> },
  { key: "signal", accent: "acc-green", q: "harness health", h: "5 / 6", viz: <McSignal on={5} /> },
  { key: "delta", accent: "acc-blue", q: "weekly tokens", h: "+18", viz: <McDelta data={[40, 55, 48, 62, 70, 66, 78, 84]} /> },
];

// chart kinds that render small/fixed-size (center them in the popup viz row);
// the rest are full-width and stretch.
const POP_CENTERED = new Set(["ring", "radar", "comet", "waffle"]);
// 3 popup slots, each offset into the 12-chart ring so they always show
// different findings; advancing `popTick` cycles every chart through every slot.
const POP_SLOTS = [
  { off: 0, place: "mc-pop--tr" },
  { off: 4, place: "mc-pop--bl" },
  { off: 8, place: "mc-pop--br" },
];

export function DashboardPreview() {
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [hovered, setHovered] = useState(false);
  // Scroll-driven: the wrapped popups parallax (each at a different rate, for
  // depth) and cycle through all 12 charts as the section moves up the viewport.
  const mcStageRef = useRef<HTMLDivElement>(null);
  const [popTick, setPopTick] = useState(0);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const stage = mcStageRef.current;
    if (!stage) return;
    const pops = Array.from(stage.querySelectorAll<HTMLElement>(".mc-pop"));
    const FACTORS = [1, -0.85, 0.5]; // per-slot parallax rate (tr, bl, br)
    const AMP = 46; // px of parallax drift
    const STEP = 120; // px of scroll per chart advance
    let scheduled = false;
    const update = () => {
      scheduled = false;
      const rect = stage.getBoundingClientRect();
      const vh = window.innerHeight || 1;
      const raw = ((vh - rect.top) / (vh + rect.height) - 0.5) * 2;
      const centered = Math.max(-1, Math.min(1, raw)); // clamp to -1..1

      pops.forEach((el, i) => {
        el.style.setProperty("--py", `${(centered * AMP * (FACTORS[i] ?? 0)).toFixed(1)}px`);
      });
      const scrolled = Math.max(0, vh - rect.top);
      const tick = Math.floor(scrolled / STEP);
      setPopTick((prev) => (prev === tick ? prev : tick));
    };
    const onScroll = () => {
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(update);
      }
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  function onCopyPrompt() {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard.writeText(AGENT_ONBOARDING_WITH_INSTALL).then(() => {
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 2200);
    });
  }

  return (
    <>
      {/* ============= hero ============= */}
      <section className="hero">
        <HeroLogoField />
        <span className="eyebrow">a feedback loop for your coding agent</span>
        <h1>
          Turn every agent session<br />
          into a better <em>next run</em>.
        </h1>
        <p className="hero-human">
          Built because we got tired of guessing what actually works.
        </p>
        <p className="lede">
          ax watches every session your coding harness runs, spots the mistakes
          it repeats, and turns them into small, repo-specific fixes you review
          and apply &mdash; one at a time.
        </p>

        <div className="install-wrap">
          <span className="install-label">install in 30 seconds</span>

          <div className="cta-row">
            <button
              type="button"
              className="prompt-pill"
              onClick={onCopyPrompt}
              onMouseEnter={() => setHovered(true)}
              onMouseLeave={() => setHovered(false)}
              onFocus={() => setHovered(true)}
              onBlur={() => setHovered(false)}
              aria-label="copy agent setup prompt"
            >
              <span className="prompt-pill__icons" aria-hidden="true">
                {PROVIDERS.map((p) => (
                  <span
                    key={p.key}
                    className={`prompt-pill__icon prompt-pill__icon--${p.key}`}
                  >
                    {p.svg}
                  </span>
                ))}
              </span>
              <span className="prompt-pill__label">Copy setup prompt</span>
            </button>

            <Link to="/docs" className="cta-secondary">
              <span className="cta-secondary__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" focusable="false">
                  <path
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinejoin="round"
                    d="M6 3.5h7L18 8v12.5H6z"
                  />
                  <path
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    d="M9 12h6M9 15.5h6"
                  />
                </svg>
              </span>
              Read the docs
            </Link>
          </div>

          <p
            className={`cta-foot${hovered ? " is-hover" : ""}${copiedPrompt ? " is-copied" : ""}`}
            aria-live="polite"
          >
            <span className="cta-foot__hint">
              paste it - your agent installs ax, labels your skills, and tells
              you which ones to actually use
            </span>
            <span className="cta-foot__copied">
              ✓ Copied - paste into your coding agent for the guided setup
            </span>
          </p>
        </div>
      </section>

      {/* ============= retro terminal: the mechanism ============= */}
      <RetroTerminal />

      {/* ============= demo: Mission Control window + floating wrapped-highlight popups ============= */}
      <section className="demo demo--popups">
        <div className="demo-intro">
          <span className="eyebrow">open the studio</span>
          <h2>
            Mission Control for your&nbsp;agents.
          </h2>
          <p>
            Run <code>ax serve</code> and the whole HUD lights up &mdash; archetype
            sigil, live activity, streaks, token spend by model. The wrapped
            highlights pop out as ax finds them.
          </p>
        </div>

        <div className="mc-stage" ref={mcStageRef}>
          <div
            className="browser browser--instrument"
            role="img"
            aria-label="ax studio Mission Control, dark instrument dashboard at 127.0.0.1:1738"
          >
            <div className="browser-bar">
              <div className="browser-dots">
                <span></span>
                <span></span>
                <span></span>
              </div>
              <div className="browser-url">127.0.0.1:1738</div>
              <div className="browser-spacer"></div>
            </div>

            <div className="mc-shell">
              <nav className="mc-rail" aria-hidden="true">
                <span className="mc-logo">ax</span>
                <span className="mc-railbtn on">◎</span>
                <span className="mc-railbtn">✦</span>
                <span className="mc-railbtn">▤</span>
                <span className="mc-railbtn">◳</span>
                <span className="mc-railbtn">⎈</span>
              </nav>

              <div className="mc-main">
                <McClock />

                <div className="mc-bento">
                  <section className="mc-card mc-hero span2 row2">
                    <div className="mc-meta mc-label">
                      <span>archetype &middot; primary</span>
                      <span>high confidence</span>
                    </div>
                    <div className="mc-sigil">
                      <McCells levels={MC_SIGIL} cols={11} cell={16} />
                    </div>
                    <div className="mc-hero-text">
                      <div className="mc-hero-name">The Cartographer</div>
                      <p className="mc-hero-tag">
                        Maps the whole repo before touching a line &mdash; reads
                        wide, edits once.
                      </p>
                    </div>
                  </section>

                  <section className="mc-card">
                    <div className="mc-label">sessions</div>
                    <div className="mc-metric mc-bottom">2,847</div>
                    <div className="mc-label">58.2K messages</div>
                  </section>

                  <section className="mc-card">
                    <div className="mc-label">tokens</div>
                    <div className="mc-metric mc-bottom">1.4B</div>
                    <div className="mc-label">+18% vs prior 90d</div>
                  </section>

                  <section className="mc-card span2">
                    <div className="mc-meta mc-label">
                      <span>activity &middot; daily</span>
                      <span className="mc-live">
                        <McLed />
                        live
                      </span>
                    </div>
                    <div className="mc-actwrap">
                      <McCells levels={MC_ACTIVITY} cols={30} cell={11} />
                    </div>
                    <div className="mc-meta mc-label">
                      <span>312 active days</span>
                      <span>21 weeks</span>
                    </div>
                  </section>

                  <section className="mc-card">
                    <div className="mc-label">streak</div>
                    <div className="mc-num mc-bottom">
                      23<small>d</small>
                    </div>
                    <McSeg total={41} on={23} color="var(--alert)" gradient />
                    <div className="mc-label">best 41 days</div>
                  </section>

                  <section className="mc-card">
                    <div className="mc-label">peak hour</div>
                    <div className="mc-metric mc-bottom">11 PM</div>
                    <div className="mc-label">most active</div>
                  </section>

                  <section className="mc-card span2 mc-split">
                    <div className="mc-meta mc-label">
                      <span>model split &middot; 365d</span>
                      <span>~$4.2K total</span>
                    </div>
                    <div className="mc-splitlist">
                      {MC_MODELS.map((m) => (
                        <div className="mc-split-row" key={m.name}>
                          <span className="mc-model">
                            <span className="mc-swatch" style={{ background: m.tone }} />
                            {m.name}
                          </span>
                          <span>
                            {m.pct}% &middot; {m.usd}
                          </span>
                          <span className="mc-segwrap">
                            <McSeg total={24} on={Math.max(1, Math.round((m.pct / 100) * 24))} color={m.tone} />
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>
                </div>
              </div>
            </div>
          </div>

          {/* floating wrapped highlights - cycle through all 12 charts */}
          <div className="mc-pop-strip">
            {POP_SLOTS.map(({ off, place }) => {
              const c = POP_CHARTS[(popTick + off) % POP_CHARTS.length];
              return (
                <article key={place} className={`mc-pop ${place} ${c.accent} browser--instrument`}>
                  <span className="mc-pop-badge">wrapped</span>
                  <div key={c.key} className="mc-pop-swap">
                    <div className={`mc-pop-viz${POP_CENTERED.has(c.key) ? " mc-pop-viz--center" : ""}`}>
                      {c.viz}
                    </div>
                    <span className="mc-pop-q">$ {c.q}</span>
                    <h4 className="mc-pop-h">{c.h}</h4>
                  </div>
                </article>
              );
            })}
          </div>
        </div>

        <p className="demo-caption">
          Run <code>ax serve</code> to see yours &mdash; Mission Control, the
          Improve deck, Agent Wrapped, sessions and skill triage.
        </p>
      </section>
    </>
  );
}
