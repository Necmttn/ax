"use client";
import { useEffect, useRef } from "react";

/**
 * Showcase 4 - Verdict Timeline.
 *
 * Ported from `docs/prototypes/showcase-4-verdict-timeline.html`.
 *
 * Animation lives in a single useEffect: a token rides the SVG track
 * from accept → +3 sess → +10 sess → +30 sess (locked verdict). Each
 * checkpoint lights its node + halo + chip and rewrites the inspector
 * panel below. Plays once on first scroll-into-view, replay pill resets.
 *
 * Query-string flags (client-only, headless screenshots):
 *   ?autoplay - kick the animation immediately
 *   ?final    - skip to locked state, no animation
 */

type Color = "green" | "red" | "blue";
type EvidenceClass = "ok" | "err" | "ref" | "lk";

type Checkpoint = {
  id: number;
  x: number;
  dur: number;
  ease: (t: number) => number;
  chipId: string;
  haloId: string;
  nodeId: string;
  color: Color;
  inspect: {
    name: string;
    sub: string;
    evidence: Array<[string, string, EvidenceClass]>;
    state: string;
    stateCls: string;
  };
};

const TRACK_X0 = 60;
const TRACK_X1 = 840;

function easeOutCubic(t: number) { return 1 - Math.pow(1 - t, 3); }
function easeInCubic(t: number)  { return t * t * t; }
function linear(t: number)       { return t; }

const CP: Checkpoint[] = [
  {
    id: 3, x: 320, dur: 1400, ease: easeOutCubic,
    chipId: "chip-7", haloId: "halo-7", nodeId: "node-7",
    color: "green",
    inspect: {
      name: "+3 sessions", sub: "early signal",
      evidence: [
        ["marker",  "src/cli/run.ts:42 · still landed", "ok"],
        ["file",    "no fixes across 3 sessions",       "ok"],
        ["pattern", "target failure: 0 hits",           "ok"],
        ["tests",   "0 regressions in adjacent suite",  "ok"],
      ],
      state: "on-track", stateCls: "is-green",
    },
  },
  {
    id: 10, x: 580, dur: 1600, ease: linear,
    chipId: "chip-30", haloId: "halo-30", nodeId: "node-30",
    color: "green",
    inspect: {
      name: "+10 sessions", sub: "real-world settled",
      evidence: [
        ["marker",     "still landed · 0 rollbacks",          "ok"],
        ["dependents", "1 downstream skill fired against it", "ref"],
        ["pattern",    "target failure: 0 hits over 10 sess", "ok"],
        ["tests",      "6 runs · all green",                  "ok"],
      ],
      state: "holding", stateCls: "is-green",
    },
  },
  {
    id: 30, x: 840, dur: 1800, ease: easeInCubic,
    chipId: "chip-90", haloId: "halo-90", nodeId: "node-90",
    color: "green",
    inspect: {
      name: "+30 sessions", sub: "locked verdict",
      evidence: [
        ["verdict",  "ADOPTED",                                    "ok"],
        ["evidence", "marker · file · pattern · tests joined",     "lk"],
        ["feeds",    "dedupe graph · future proposals",            "ref"],
        ["locked",   "session 30 reached · cannot be re-proposed", "lk"],
      ],
      state: "adopted", stateCls: "is-green",
    },
  },
];

export function VerdictTimelineShowcase() {
  const sectionRef = useRef<HTMLElement | null>(null);
  const stageRef   = useRef<HTMLDivElement | null>(null);
  const tokenRef   = useRef<SVGCircleElement | null>(null);
  const tokenShRef = useRef<SVGCircleElement | null>(null);
  const fillRef    = useRef<SVGLineElement | null>(null);
  const pillRef    = useRef<HTMLButtonElement | null>(null);
  const pillTxtRef = useRef<HTMLSpanElement | null>(null);
  const inspCpRef  = useRef<HTMLSpanElement | null>(null);
  const inspSubRef = useRef<HTMLSpanElement | null>(null);
  const inspBodyRef= useRef<HTMLDivElement | null>(null);
  const inspStRef  = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const section = sectionRef.current;
    const stage   = stageRef.current;
    if (!section || !stage) return;

    let rafId: number | null = null;
    let running = false;
    let played  = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    function setPill(state: string, text?: string) {
      const pill = pillRef.current;
      if (!pill) return;
      pill.setAttribute("data-state", state);
      if (text && pillTxtRef.current) pillTxtRef.current.textContent = text;
    }

    function setTokenX(x: number) {
      tokenRef.current?.setAttribute("cx",   String(x));
      tokenShRef.current?.setAttribute("cx", String(x));
      fillRef.current?.setAttribute("x2",    String(x));
    }

    function clearTimers() {
      timers.forEach((t) => clearTimeout(t));
      timers.length = 0;
    }

    function clearVisualState() {
      if (rafId != null) cancelAnimationFrame(rafId);
      clearTimers();
      setTokenX(TRACK_X0);
      section!.querySelectorAll(".tl-chip").forEach((c) =>
        c.classList.remove("is-shown")
      );
      [7, 30, 90].forEach((id) => {
        const n = section!.querySelector("#node-" + id);
        const h = section!.querySelector("#halo-" + id);
        n?.classList.remove("is-reached", "is-green", "is-red", "is-blue");
        h?.classList.remove("is-shown", "is-red", "is-blue");
      });
      if (inspCpRef.current)  inspCpRef.current.textContent  = "accept";
      if (inspSubRef.current) inspSubRef.current.textContent = "experiment opened";
      if (inspBodyRef.current) {
        inspBodyRef.current.innerHTML = `
          <div class="ev is-shown"><span class="lk">exp_id</span> <span>post-feature-verify · t0</span></div>
          <div class="ev is-shown"><span class="lk">marker</span> <span>added · src/cli/run.ts:42</span></div>
          <div class="ev is-shown"><span class="lk">watching</span> <span>marker · file · pattern · tests</span></div>
        `;
      }
      if (inspStRef.current) {
        inspStRef.current.className = "insp-state";
        inspStRef.current.textContent = "pending";
      }
    }

    function updateInspector(cp: Checkpoint) {
      if (inspCpRef.current)  inspCpRef.current.textContent  = cp.inspect.name;
      if (inspSubRef.current) inspSubRef.current.textContent = cp.inspect.sub;
      const body = inspBodyRef.current;
      if (body) {
        body.innerHTML = "";
        cp.inspect.evidence.forEach((row, i) => {
          const [label, val, cls] = row;
          const div = document.createElement("div");
          div.className = "ev";
          div.innerHTML = `<span class="lk">${label}</span> <span class="${cls}">${val}</span>`;
          body.appendChild(div);
          const tid = setTimeout(() => div.classList.add("is-shown"), 80 + i * 90);
          timers.push(tid);
        });
      }
      if (inspStRef.current) {
        inspStRef.current.className = "insp-state " + cp.inspect.stateCls;
        inspStRef.current.textContent = cp.inspect.state;
      }
    }

    function animateLeg(fromX: number, toX: number, durMs: number, easeFn: (t: number) => number) {
      return new Promise<void>((resolve) => {
        const start = performance.now();
        function step(now: number) {
          const t = Math.min(1, (now - start) / durMs);
          const e = easeFn(t);
          const x = fromX + (toX - fromX) * e;
          setTokenX(x);
          if (t < 1) {
            rafId = requestAnimationFrame(step);
          } else {
            resolve();
          }
        }
        rafId = requestAnimationFrame(step);
      });
    }

    function wait(ms: number) {
      return new Promise<void>((r) => {
        const tid = setTimeout(r, ms);
        timers.push(tid);
      });
    }

    async function play() {
      if (running) return;
      running = true;
      setPill("playing", "playing");
      clearVisualState();

      let prevX = TRACK_X0;
      for (let i = 0; i < CP.length; i++) {
        const cp = CP[i]!;
        await animateLeg(prevX, cp.x, cp.dur, cp.ease);
        prevX = cp.x;

        const node = section!.querySelector("#" + cp.nodeId);
        const halo = section!.querySelector("#" + cp.haloId);
        const chip = section!.querySelector("#" + cp.chipId);
        node?.classList.add("is-reached", "is-" + cp.color);
        halo?.classList.add("is-shown");
        if (cp.color !== "green") halo?.classList.add("is-" + cp.color);
        chip?.classList.add("is-shown");
        updateInspector(cp);

        if (i < CP.length - 1) await wait(420);
      }

      running = false;
      played  = true;
      setPill("done", "replay");
    }

    function jumpToFinal() {
      setTokenX(TRACK_X1);
      CP.forEach((cp) => {
        section!.querySelector("#" + cp.nodeId)?.classList.add("is-reached", "is-" + cp.color);
        section!.querySelector("#" + cp.haloId)?.classList.add("is-shown");
        section!.querySelector("#" + cp.chipId)?.classList.add("is-shown");
      });
      updateInspector(CP[CP.length - 1]!);
      // skip per-row stagger
      section!.querySelectorAll(".insp-body .ev").forEach((el) =>
        el.classList.add("is-shown")
      );
      setPill("done", "replay");
      played = true;
    }

    // intersection-observer: play once on first scroll-into-view
    let io: IntersectionObserver | null = null;
    if ("IntersectionObserver" in window) {
      io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting && !played && !running) {
              const tid = setTimeout(play, 280);
              timers.push(tid);
            }
          }
        },
        { threshold: 0.45 }
      );
      io.observe(stage);
    }

    // query-string affordances (client-only)
    if (typeof window !== "undefined") {
      const qs = new URLSearchParams(window.location.search);
      if (qs.has("autoplay")) {
        const tid = setTimeout(play, 80);
        timers.push(tid);
      }
      if (qs.has("final")) {
        io?.disconnect();
        io = null;
        jumpToFinal();
      }
    }

    // replay pill
    const pill = pillRef.current;
    const onPillClick = () => {
      if (running) return;
      play();
    };
    pill?.addEventListener("click", onPillClick);

    // reduce-motion: skip to end state
    const prefersReduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (prefersReduced) {
      io?.disconnect();
      io = null;
      jumpToFinal();
    }

    return () => {
      if (rafId != null) cancelAnimationFrame(rafId);
      clearTimers();
      io?.disconnect();
      pill?.removeEventListener("click", onPillClick);
    };
  }, []);

  return (
    <section
      id="verdict-timeline"
      ref={sectionRef}
      className="showcase-verdict-timeline"
    >
      <p className="eyebrow">the compounding part</p>
      <h2>
        Every change earns its place by{" "}
        <em style={{ fontStyle: "italic", color: "var(--muted)" }}>session 30</em>.
      </h2>
      <p className="lede">
        Accepting a proposal doesn&apos;t make it true. ax turns each acceptance into an
        experiment with three forward-looking checkpoints &mdash; t+3, t+10, t+30{" "}
        <em style={{ fontStyle: "italic", color: "var(--muted)" }}>sessions</em> &mdash;
        and watches the next runs to see if the change actually held. Days are the wrong
        unit when an agent ships eight sessions a day. The verdict at t+30 sessions is
        locked. Future proposals know.
      </p>

      <figure className="figure fig-timeline" aria-label="ax verdict timeline showcase">
        <div className="fig-head">
          <span className="fig-id">Fig · S-04</span>
          <span>verdict timeline · post-feature-verify</span>
          <button
            className="auto-pill"
            type="button"
            data-state="idle"
            id="replay"
            ref={pillRef}
          >
            <span className="auto-dot" />
            <span className="auto-text" ref={pillTxtRef}>play</span>
          </button>
        </div>

        <div className="tl-stage" id="stage" ref={stageRef}>
          <svg
            className="tl-svg"
            viewBox="0 0 900 180"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {/* track baseline */}
            <line className="tl-track-bg" x1="60" y1="90" x2="840" y2="90" />
            <line
              className="tl-track-fill"
              id="track-fill"
              x1="60"
              y1="90"
              x2="60"
              y2="90"
              ref={fillRef}
            />

            {/* end labels */}
            <text className="tl-end left"  x="60"  y="62">accept</text>
            <text className="tl-end right" x="840" y="62">lock</text>

            {/* shadow + token */}
            <circle
              className="tl-token-shadow"
              id="token-shadow"
              cx="60"
              cy="98"
              r="9"
              ref={tokenShRef}
            />
            <g id="token-group">
              <circle
                className="tl-token"
                id="token"
                cx="60"
                cy="90"
                r="9"
                ref={tokenRef}
              />
            </g>

            {/* +3 sessions @ x=320 */}
            <circle className="tl-node-halo" id="halo-7" cx="320" cy="90" r="18" />
            <circle className="tl-node"      id="node-7" cx="320" cy="90" r="7" />
            <text className="tl-label is-cp" x="320" y="120" textAnchor="middle">+3 sess</text>
            <text className="tl-cp-title"    x="320" y="138" textAnchor="middle">early signal</text>

            {/* +10 sessions @ x=580 */}
            <circle className="tl-node-halo" id="halo-30" cx="580" cy="90" r="18" />
            <circle className="tl-node"      id="node-30" cx="580" cy="90" r="7" />
            <text className="tl-label is-cp" x="580" y="120" textAnchor="middle">+10 sess</text>
            <text className="tl-cp-title"    x="580" y="138" textAnchor="middle">real-world settled</text>

            {/* +30 sessions @ x=840 */}
            <circle className="tl-node-halo" id="halo-90" cx="840" cy="90" r="22" />
            <circle className="tl-node"      id="node-90" cx="840" cy="90" r="9" />
            <text className="tl-label is-cp" x="840" y="120" textAnchor="middle">+30 sess</text>
            <text className="tl-cp-title"    x="840" y="138" textAnchor="middle">locked verdict</text>

            {/* evidence chips */}
            <g className="tl-chip is-green" id="chip-7" transform="translate(220,18)">
              <g className="tl-chip-inner">
                <rect className="tl-chip-box" x="0" y="0" width="200" height="38" rx="2" />
                <text className="tl-chip-text"          x="12" y="16">marker still landed</text>
                <text className="tl-chip-text is-muted" x="12" y="30">0 fixes across 3 sessions</text>
              </g>
            </g>

            <g className="tl-chip is-green" id="chip-30" transform="translate(480,18)">
              <g className="tl-chip-inner">
                <rect className="tl-chip-box" x="0" y="0" width="200" height="38" rx="2" />
                <text className="tl-chip-text"          x="12" y="16">0 rollbacks · 10 sess held</text>
                <text className="tl-chip-text is-muted" x="12" y="30">1 dependent skill fired</text>
              </g>
            </g>

            {/* t+90: bigger emphasis as the locked verdict */}
            <g className="tl-chip is-green" id="chip-90" transform="translate(700,4)">
              <g className="tl-chip-inner">
                <rect
                  className="tl-chip-box"
                  x="0"
                  y="0"
                  width="200"
                  height="52"
                  rx="2"
                  style={{ fill: "var(--green)", stroke: "var(--green)" }}
                />
                <text
                  className="tl-chip-text"
                  x="14"
                  y="22"
                  style={{
                    fill: "var(--page)",
                    fontWeight: 500,
                    letterSpacing: "0.14em",
                    fontSize: "12px",
                  }}
                >
                  VERDICT: ADOPTED
                </text>
                <text
                  className="tl-chip-text"
                  x="14"
                  y="40"
                  style={{
                    fill: "color-mix(in srgb, var(--page) 78%, transparent)",
                    fontSize: "10.5px",
                  }}
                >
                  feeds dedupe graph
                </text>
              </g>
            </g>
          </svg>
        </div>

        {/* inspector panel */}
        <div className="inspector" id="inspector" aria-live="polite">
          <div className="insp-cp">
            <span id="insp-cp-name" ref={inspCpRef}>accept</span>
            <span className="insp-cp-sub" id="insp-cp-sub" ref={inspSubRef}>
              experiment opened
            </span>
          </div>
          <div className="insp-body" id="insp-body" ref={inspBodyRef}>
            <div className="ev is-shown">
              <span className="lk">exp_id</span> <span>post-feature-verify · t0</span>
            </div>
            <div className="ev is-shown">
              <span className="lk">marker</span> <span>added · src/cli/run.ts:42</span>
            </div>
            <div className="ev is-shown">
              <span className="lk">watching</span>{" "}
              <span>marker · file · pattern · tests</span>
            </div>
          </div>
          <div className="insp-state" id="insp-state" ref={inspStRef}>pending</div>
        </div>

        <p className="cap">
          <strong>ax doesn&apos;t trust the moment you accept</strong> &mdash; it earns
          the verdict by watching what happens across the next 30 sessions. Marker still
          landed? File still healthy? Pattern not recurring? Tests still green? Each
          checkpoint joins evidence from the same graph that generated the proposal.
          Sessions, not days &mdash; a weekend doesn&apos;t artificially delay; a
          productive afternoon doesn&apos;t artificially rush. The verdict at +30
          sessions is locked and feeds the next round. Verdicts live in the improve
          queue &mdash; <code>ax improve verdict</code> confirms or overrides one from
          the CLI.
        </p>
      </figure>

      {/* past experiments strip */}
      <section className="exp-strip" aria-label="five past experiments">
        <p className="exp-strip-head">
          <span>recent experiments</span>
          <span className="right">5 of 47</span>
        </p>

        <ul className="exp-list">
          <li>
            <span className="exp-name">post-feature-verify</span>
            <span className="exp-cp-tag">+30 sess</span>
            <span className="exp-reason">
              <span className="ok">marker landed</span> ·{" "}
              <span className="ok">0 rollbacks</span> ·{" "}
              <span className="ref">1 dependent</span>
            </span>
            <span className="vchip is-adopted">adopted</span>
          </li>
          <li>
            <span className="exp-name">main-branch-guardrail</span>
            <span className="exp-cp-tag">+10 sess</span>
            <span className="exp-reason">
              marker landed · <span className="err">2 of 4 callsites bypassed</span>
            </span>
            <span className="vchip is-partial">partial</span>
          </li>
          <li>
            <span className="exp-name">skill-ts-default</span>
            <span className="exp-cp-tag">+3 sess</span>
            <span className="exp-reason">awaiting first signal · 1 session remaining</span>
            <span className="vchip is-pending">pending</span>
          </li>
          <li>
            <span className="exp-name">ingest-regression</span>
            <span className="exp-cp-tag">+30 sess</span>
            <span className="exp-reason">
              <span className="ok">pattern not recurred over 30 sessions</span> ·{" "}
              <span className="ok">tests green</span>
            </span>
            <span className="vchip is-adopted">adopted</span>
          </li>
          <li>
            <span className="exp-name">cache-warm-on-start</span>
            <span className="exp-cp-tag">+10 sess</span>
            <span className="exp-reason">
              <span className="err">added 800ms cold start</span> · reverted at session 6
            </span>
            <span className="vchip is-regressed">regressed</span>
          </li>
        </ul>

        <div className="verdict-legend" role="list">
          <span className="vleg-label">verdict states ›</span>
          <span className="vchip is-adopted" role="listitem">adopted</span>
          <span className="vchip is-regressed" role="listitem">regressed</span>
          <span className="vchip is-partial" role="listitem">partial</span>
          <span className="vchip is-ignored" role="listitem">ignored</span>
          <span className="vchip is-no-longer-needed" role="listitem">no_longer_needed</span>
        </div>
      </section>
    </section>
  );
}
