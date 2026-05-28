"use client";
import { useEffect, useRef } from "react";

export function HowSection() {
  return (
    <section id="how">
      <p className="eyebrow">the loop closes.</p>
      <h2>One cycle. Every session.</h2>
      <p>
        The retro is iter zero, not the finish line. What one session
        notices becomes the next session&#39;s proposal; what the experiment
        earns becomes the verdict the graph remembers. The shape below is
        the shape of the work &mdash; not a funnel, a loop.
      </p>
      <p>
        Run a session, end with a retro, accept the proposal worth
        trying, and let the experiment ride to its checkpoint. The next
        session opens with that verdict already on the table. Nothing
        you wrote yesterday gets thrown out.
      </p>

      <div className="fig-shell">
        <LoopFigure />
      </div>

      <p>
        <a className="fig-link" href="/origin#pipeline">
          read: retro is only the first step <span className="arr">→</span>
        </a>
      </p>
    </section>
  );
}

function LoopFigure() {
  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const stage   = root.querySelector<HTMLElement>("[data-loop-stage]");
    const token   = root.querySelector<SVGRectElement>("[data-loop-token]");
    const ldEye   = root.querySelector<HTMLElement>("[data-ld-eyebrow]");
    const ldLine  = root.querySelector<HTMLElement>("[data-ld-line]");
    const ldNext  = root.querySelector<HTMLElement>("[data-ld-next]");
    const pill    = root.querySelector<HTMLElement>("[data-loop-pill]");
    const pillLbl = root.querySelector<HTMLElement>("[data-loop-label]");
    const resetBt = root.querySelector<HTMLElement>("[data-loop-reset]");
    const nodes   = root.querySelectorAll<HTMLElement>(".loop-node");

    if (!stage || !token || !ldEye || !ldLine || !ldNext || !pill || !pillLbl || !resetBt) return;

    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    const POS: Record<string, { angle: number; x: number; y: number }> = {
      retro:      { angle: -90, x: 240, y:  80 },
      proposal:   { angle:   0, x: 400, y: 240 },
      experiment: { angle:  90, x: 240, y: 400 },
      verdict:    { angle: 180, x:  80, y: 240 },
    };

    const ORDER = ["retro", "proposal", "experiment", "verdict"];

    const DETAIL: Record<string, { eye: string; line: string; next: string }> = {
      retro: {
        eye:  "session 4129 · iter 0",
        line: 'failed=<span class="ld-err">"ran on main"</span>',
        next: "next=use-hook",
      },
      proposal: {
        eye:  "pre-tool hook · bash",
        line: "add pre-tool hook: block writes on main",
        next: "queued · bet=high",
      },
      experiment: {
        eye:  "main-branch-hook · running",
        line: "lane open @ t+0",
        next: "checkpoints +3 / +10 / +30 sessions",
      },
      verdict: {
        eye:  "+30 sess · locked",
        line: '<span class="ld-kept">KEPT</span> · 0 incidents',
        next: "merged 2026-05-22",
      },
    };

    let current = "retro";
    let userTookOver = false;
    let rafId = 0;
    const pendingTimers: ReturnType<typeof setTimeout>[] = [];

    function setPill(state: string) {
      pill!.setAttribute("data-state", state);
      const map: Record<string, string> = {
        playing: "auto · playing",
        manual:  "manual",
        done:    "auto · done",
        reduce:  "motion paused",
      };
      pillLbl!.textContent = map[state] ?? "auto · idle";
    }

    function renderDetail(node: string) {
      const d = DETAIL[node];
      if (!d) return;
      ldEye!.innerHTML  = d.eye;
      ldLine!.innerHTML = d.line;
      ldNext!.innerHTML = d.next;
      nodes.forEach((n) => {
        n.classList.toggle("is-active", n.getAttribute("data-node") === node);
      });
    }

    function moveToken(x: number, y: number) {
      token!.setAttribute("transform", `translate(${x},${y})`);
    }

    function jumpTo(node: string) {
      const p = POS[node];
      if (!p) return;
      current = node;
      moveToken(p.x, p.y);
      renderDetail(node);
    }

    function setAngle(angleDeg: number) {
      const rad = (angleDeg * Math.PI) / 180;
      const cx = 240, cy = 240, r = 160;
      moveToken(cx + r * Math.cos(rad), cy + r * Math.sin(rad));
    }

    function clearPending() {
      pendingTimers.forEach((id) => clearTimeout(id));
      pendingTimers.length = 0;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    }

    function takeover() {
      if (userTookOver) return;
      userTookOver = true;
      clearPending();
      setPill("manual");
    }

    function runSequence() {
      if (userTookOver || reduce) return;
      setPill("playing");
      const SEG_MS  = 1400;
      const HOLD_MS = 800;

      function segment(idx: number) {
        if (userTookOver) return;
        const fromName = ORDER[idx];
        const toName   = ORDER[(idx + 1) % 4];
        jumpTo(fromName);

        let fromAng = POS[fromName].angle;
        let toAng   = POS[toName].angle;
        if (toAng < fromAng) toAng += 360;

        const t0 = performance.now();

        function frame(now: number) {
          if (userTookOver) return;
          let t = (now - t0) / SEG_MS;
          if (t >= 1) t = 1;
          const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
          const ang = fromAng + (toAng - fromAng) * eased;
          setAngle(ang);
          if (t < 1) {
            rafId = requestAnimationFrame(frame);
          } else {
            jumpTo(toName);
            const nextIdx = (idx + 1) % 4;
            const tid = setTimeout(() => { segment(nextIdx); }, HOLD_MS);
            pendingTimers.push(tid);
          }
        }
        rafId = requestAnimationFrame(frame);
      }

      jumpTo("retro");
      const tid = setTimeout(() => { segment(0); }, HOLD_MS);
      pendingTimers.push(tid);
    }

    function staticEnd() {
      jumpTo("retro");
      let cap = root.querySelector<HTMLElement>(".loop-static-cap");
      if (!cap) {
        cap = document.createElement("div");
        cap.className = "loop-static-cap";
        cap.textContent = "motion paused - the loop runs in your terminal";
        stage!.appendChild(cap);
      }
    }

    // Listeners
    nodes.forEach((n) => {
      n.addEventListener("click", () => {
        takeover();
        jumpTo(n.getAttribute("data-node") ?? "retro");
      });
      n.addEventListener("mouseenter", () => {
        if (!userTookOver) return;
        renderDetail(n.getAttribute("data-node") ?? "retro");
      });
      n.addEventListener("mouseleave", () => {
        if (!userTookOver) return;
        renderDetail(current);
      });
    });

    root.addEventListener("pointerdown", (ev) => {
      if ((ev.target as Element).closest("[data-loop-reset]")) return;
      takeover();
    }, true);

    resetBt.addEventListener("click", () => {
      userTookOver = false;
      clearPending();
      jumpTo("retro");
      setPill("idle");
      if (!reduce) {
        const tid = setTimeout(() => { if (!userTookOver) runSequence(); }, 1500);
        pendingTimers.push(tid);
      } else {
        staticEnd();
        setPill("reduce");
      }
    });

    // Boot
    jumpTo("retro");
    setPill("idle");

    if (reduce) {
      setPill("reduce");
      staticEnd();
    } else if ("IntersectionObserver" in window) {
      let fired = false;
      const io = new IntersectionObserver((entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting && !fired && !userTookOver) {
            fired = true;
            io.disconnect();
            const tid = setTimeout(() => { if (!userTookOver) runSequence(); }, 1500);
            pendingTimers.push(tid);
          }
        });
      }, { threshold: 0.4 });
      io.observe(root);
    } else {
      const tid = setTimeout(() => { if (!userTookOver) runSequence(); }, 1500);
      pendingTimers.push(tid);
    }

    return () => {
      clearPending();
    };
  }, []);

  return (
    <figure className="fig-loop" aria-label="Animated ring: a token travels clockwise through retro, proposal, experiment, verdict, completing the loop" ref={rootRef as React.RefObject<HTMLElement>}>
      <div className="fig-head">
        <span className="fig-id">Loop</span>
        <span>retro &rarr; proposal &rarr; experiment &rarr; verdict &rarr;</span>
        <button type="button" className="auto-pill" data-loop-pill data-state="idle" aria-label="autoplay status">
          <span className="auto-dot" aria-hidden="true"></span>
          <span className="auto-label" data-loop-label>auto · idle</span>
        </button>
        <button type="button" className="reset" data-loop-reset aria-label="reset loop">reset</button>
      </div>

      <div className="loop-stage" data-loop-stage>
        <svg className="loop-svg" viewBox="0 0 480 480" role="img" aria-hidden="true">
          <defs>
            <marker id="loopArrow" viewBox="0 0 10 10" refX="6" refY="5"
                    markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--ink)" />
            </marker>
          </defs>
          <circle className="loop-ring" cx="240" cy="240" r="160"
                  fill="none" stroke="var(--line)" strokeWidth="1" />
          <g className="loop-arrows" stroke="var(--ink)" strokeWidth="1" fill="none">
            <line x1="350.7" y1="111.5" x2="358.7" y2="119.5" markerEnd="url(#loopArrow)" />
            <line x1="358.7" y1="360.5" x2="350.7" y2="368.5" markerEnd="url(#loopArrow)" />
            <line x1="129.3" y1="368.5" x2="121.3" y2="360.5" markerEnd="url(#loopArrow)" />
            <line x1="121.3" y1="119.5" x2="129.3" y2="111.5" markerEnd="url(#loopArrow)" />
          </g>
          <rect className="loop-token" data-loop-token
                x="-5" y="-5" width="10" height="10"
                transform="translate(240,80)" />
        </svg>

        <button type="button" className="loop-node" data-node="retro" aria-label="retro node">
          <span className="node-num">01</span>
          <span className="node-name">retro</span>
          <span className="node-cap">what failed, what&#39;s next</span>
        </button>
        <button type="button" className="loop-node" data-node="proposal" aria-label="proposal node">
          <span className="node-num">02</span>
          <span className="node-name">proposal</span>
          <span className="node-cap">the bet worth trying</span>
        </button>
        <button type="button" className="loop-node" data-node="experiment" aria-label="experiment node">
          <span className="node-num">03</span>
          <span className="node-name">experiment</span>
          <span className="node-cap">+3 / +10 / +30 sessions</span>
        </button>
        <button type="button" className="loop-node" data-node="verdict" aria-label="verdict node">
          <span className="node-num">04</span>
          <span className="node-name">verdict</span>
          <span className="node-cap">kept · regressed · self-resolved</span>
        </button>

        <div className="loop-detail" data-loop-detail>
          <div className="ld-eyebrow" data-ld-eyebrow>session 4129 · iter 0</div>
          <div className="ld-line" data-ld-line>failed=<span className="ld-err">&quot;ran on main&quot;</span></div>
          <div className="ld-next" data-ld-next>next=use-hook</div>
        </div>
      </div>

      <figcaption>
        <strong>The retro is the start of the next session, not the
        end of the last one.</strong>{" "}
        The token closes the ring once per cycle. Click a node to jump
        the inspector. Hover to peek without breaking the flow.
      </figcaption>
    </figure>
  );
}
