"use client";
import { useEffect, useRef } from "react";

const SKILLS = [
  /* row 1 */
  { name: "superpowers",          lit: true,  fires: 14, last: "05-26" },
  { name: "gsd",                  lit: false, fires:  0, last: "-"     },
  { name: "multica",              lit: false, fires:  0, last: "-"     },
  { name: "worktree-first",       lit: true,  fires:  9, last: "05-25" },
  /* row 2 */
  { name: "tdd-first",            lit: false, fires:  0, last: "-"     },
  { name: "ax-retro",             lit: true,  fires: 23, last: "05-26" },
  { name: "codex-companion",      lit: false, fires:  0, last: "-"     },
  { name: "retro-emit",           lit: false, fires:  0, last: "-"     },
  /* row 3 */
  { name: "grillme",              lit: true,  fires:  4, last: "05-24" },
  { name: "spec-ops",             lit: false, fires:  0, last: "-"     },
  { name: "parallel-task-helper", lit: true,  fires:  7, last: "05-25" },
  { name: "scope-bot",            lit: false, fires:  0, last: "-"     },
  /* row 4 */
  { name: "brainstorming",        lit: true,  fires:  3, last: "05-23" },
  { name: "debugging",            lit: false, fires:  0, last: "-"     },
  { name: "write-a-skill",        lit: true,  fires:  2, last: "05-22" },
  { name: "ralph",                lit: false, fires:  0, last: "-"     },
  /* row 5 */
  { name: "executing-plans",      lit: true,  fires: 11, last: "05-26" },
  { name: "dispatching-parallel", lit: true,  fires:  6, last: "05-25" },
  { name: "retro-meta",           lit: true,  fires:  5, last: "05-24" },
  { name: "verify",               lit: true,  fires:  8, last: "05-25" },
] as const;

const SWEEP = [0, 3, 5, 8, 10, 12, 14, 16, 17, 18];
const FINAL_FLUSH = [19];

export function DemoSection() {
  return (
    <section id="demo">
      <p className="eyebrow">what you actually use.</p>
      <h2>Installed isn&#39;t used.</h2>
      <p>
        You have twenty skills wired into your agent. Eleven of them
        fired this week. Nine sat there. <code>ax</code> tells you which
        is which &mdash; from your real session log, not from the{" "}
        <code>plugins.json</code> you forgot you edited.
      </p>
      <p>
        The heatmap below is a synthetic week. Dim tiles are dead
        weight. Lit tiles are the ones the agent actually reached for.
        The count on the right is the answer to &quot;what&#39;s earning its
        place in my <code>CLAUDE.md</code>.&quot;
      </p>

      <div className="fig-shell">
        <HeatmapFigure />
      </div>

      <p>
        <a className="fig-link" href="/origin">
          read: the origin behind the layer <span className="arr">→</span>
        </a>
      </p>
    </section>
  );
}

function HeatmapFigure() {
  const rootRef = useRef<HTMLElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const grid = gridRef.current;
    if (!root || !grid) return;

    const counter = root.querySelector<HTMLElement>("[data-heat-counter]");
    const curEl   = root.querySelector<HTMLElement>("[data-heat-current]");
    const totEl   = root.querySelector<HTMLElement>("[data-heat-total]");
    const deadEl  = root.querySelector<HTMLElement>("[data-heat-dead-num]");
    const tip     = root.querySelector<HTMLElement>("[data-heat-tip]");
    const pill    = root.querySelector<HTMLElement>("[data-heat-pill]");
    const pillLbl = root.querySelector<HTMLElement>("[data-heat-label]");
    const resetBt = root.querySelector<HTMLElement>("[data-heat-reset]");

    if (!tip || !pill || !pillLbl || !resetBt) return;

    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let litCount = 0;
    let userTookOver = false;
    let rafId = 0;
    const pendingTimers: ReturnType<typeof setTimeout>[] = [];

    // Build tiles
    SKILLS.forEach((s, i) => {
      const t = document.createElement("button");
      t.type = "button";
      t.className = "heat-tile";
      t.setAttribute("data-skill", s.name);
      t.setAttribute("data-idx", String(i));
      t.setAttribute("data-fires", "0");
      t.setAttribute("data-final", String(s.fires));
      t.setAttribute("data-last", s.last);
      t.setAttribute("data-lit", "false");
      t.setAttribute("aria-label", `${s.name} skill tile`);

      const dot = document.createElement("span");
      dot.className = "tile-dot";
      t.appendChild(dot);

      const name = document.createElement("span");
      name.className = "tile-name";
      name.textContent = s.name;
      t.appendChild(name);

      const fires = document.createElement("span");
      fires.className = "tile-fires";
      fires.setAttribute("data-tile-fires", "");
      fires.textContent = "0×";
      t.appendChild(fires);

      grid.appendChild(t);
    });

    const tiles = grid.querySelectorAll<HTMLElement>(".heat-tile");
    if (totEl) totEl.textContent = String(SKILLS.length);

    function setPill(state: string) {
      pill!.setAttribute("data-state", state);
      const map: Record<string, string> = {
        playing: "auto · playing",
        manual:  "manual",
        done:    "auto · done",
        reduce:  "motion paused",
      };
      if (pillLbl) pillLbl.innerHTML = map[state] ?? "auto · idle";
    }

    function clearPending() {
      pendingTimers.forEach((id) => clearTimeout(id));
      pendingTimers.length = 0;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    }

    function lightTile(idx: number, animate: boolean) {
      const s = SKILLS[idx];
      const tile = tiles[idx];
      if (!s || !tile) return;
      if (tile.getAttribute("data-lit") === "true") return;
      tile.setAttribute("data-lit", "true");
      const fireEl = tile.querySelector<HTMLElement>("[data-tile-fires]");
      const final = s.fires;
      if (animate && fireEl) {
        const start = performance.now();
        const dur = 380;
        function step(now: number) {
          const t = Math.min((now - start) / dur, 1);
          const v = Math.round(final * t);
          fireEl!.textContent = `${v}×`;
          tile.setAttribute("data-fires", String(v));
          if (t < 1) {
            rafId = requestAnimationFrame(step);
          } else {
            fireEl!.textContent = `${final}×`;
            tile.setAttribute("data-fires", String(final));
          }
        }
        requestAnimationFrame(step);
      } else if (fireEl) {
        fireEl.textContent = `${final}×`;
        tile.setAttribute("data-fires", String(final));
      }
      litCount++;
      if (curEl) curEl.textContent = String(litCount);
      if (counter) counter.setAttribute("data-current", String(litCount));
    }

    function unlightAll() {
      tiles.forEach((tile) => {
        tile.setAttribute("data-lit", "false");
        tile.setAttribute("data-fires", "0");
        const fireEl = tile.querySelector<HTMLElement>("[data-tile-fires]");
        if (fireEl) fireEl.textContent = "0×";
      });
      litCount = 0;
      if (curEl) curEl.textContent = "0";
      if (counter) counter.setAttribute("data-current", "0");
      if (deadEl) deadEl.textContent = "0";
    }

    function finishDeadCount() {
      const dead = SKILLS.filter((s) => !s.lit).length;
      if (deadEl) deadEl.textContent = String(dead);
    }

    function runSequence() {
      if (userTookOver || reduce) return;
      setPill("playing");
      const step = 500;
      const allOrder = [...SWEEP, ...FINAL_FLUSH];
      allOrder.forEach((idx, i) => {
        const tid = setTimeout(() => {
          if (userTookOver) return;
          lightTile(idx, true);
          if (i === allOrder.length - 1) {
            const endTid = setTimeout(() => {
              if (userTookOver) return;
              finishDeadCount();
              setPill("done");
            }, 800);
            pendingTimers.push(endTid);
          }
        }, step * i);
        pendingTimers.push(tid);
      });
    }

    function takeover() {
      if (userTookOver) return;
      userTookOver = true;
      clearPending();
      setPill("manual");
    }

    function staticEnd() {
      [...SWEEP, ...FINAL_FLUSH].forEach((idx) => lightTile(idx, false));
      finishDeadCount();
      let cap = root.querySelector<HTMLElement>(".heat-static-cap");
      if (!cap) {
        cap = document.createElement("div");
        cap.className = "heat-static-cap";
        cap.textContent = "motion paused - your actual skill usage, last 7 days";
        root.appendChild(cap);
      }
    }

    // Tile listeners (must happen after tiles are built)
    tiles.forEach((tile) => {
      tile.addEventListener("click", () => { takeover(); });
      tile.addEventListener("mouseenter", () => {
        const name  = tile.getAttribute("data-skill") ?? "";
        const fires = tile.getAttribute("data-final") ?? "0";
        const last  = tile.getAttribute("data-last") ?? "-";
        tip!.innerHTML = `<span class="tip-mono">${name}</span><span class="tip-meta">fires: ${fires} · last: ${last}</span>`;
        tip!.hidden = false;
        const hostRect = root.getBoundingClientRect();
        const r = tile.getBoundingClientRect();
        const x = (r.left - hostRect.left) + r.width / 2;
        const y = (r.top  - hostRect.top) - 8;
        tip!.style.transform = `translate(${x}px,${y}px)`;
      });
      tile.addEventListener("mouseleave", () => { tip!.hidden = true; });
    });

    root.addEventListener("pointerdown", (ev) => {
      if ((ev.target as Element).closest("[data-heat-reset]")) return;
      takeover();
    }, true);

    resetBt.addEventListener("click", () => {
      userTookOver = false;
      clearPending();
      unlightAll();
      tip.hidden = true;
      setPill("idle");
      if (!reduce) {
        const tid = setTimeout(() => { if (!userTookOver) runSequence(); }, 1500);
        pendingTimers.push(tid);
      } else {
        staticEnd();
        setPill("reduce");
      }
    });

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

    return () => { clearPending(); };
  }, []);

  return (
    <figure className="fig-heatmap" aria-label="Animated heatmap: 20 skill tiles, 11 light up as ax sweeps the week's usage" ref={rootRef as React.RefObject<HTMLElement>}>
      <div className="fig-head">
        <span className="fig-id">Heatmap</span>
        <span>installed skills · fires this week</span>
        <button type="button" className="auto-pill" data-heat-pill data-state="idle" aria-label="autoplay status">
          <span className="auto-dot" aria-hidden="true"></span>
          <span className="auto-label" data-heat-label>auto · idle</span>
        </button>
        <button type="button" className="reset" data-heat-reset aria-label="reset heatmap">reset</button>
      </div>

      <div className="heat-grid" data-heat-grid role="grid" aria-label="skill usage grid" ref={gridRef}></div>

      <div className="heat-summary">
        <div className="heat-counter" data-heat-counter data-current="0" data-total="20">
          <span className="hc-label">fires this week</span>
          <span className="hc-num"><span data-heat-current>0</span> / <span data-heat-total>20</span></span>
        </div>
        <div className="heat-dead" data-heat-dead>
          <span className="hd-label">dead weight</span>
          <span className="hd-num" data-heat-dead-num>0</span>
        </div>
        <div className="heat-tip" data-heat-tip hidden></div>
      </div>

      <figcaption>
        <strong>Installed isn&#39;t used. The graph knows which is which.</strong>{" "}
        Hover any tile for last-fire timestamp. Skills that never fired
        across the week are dead weight &mdash; candidates for the
        chopping block.
      </figcaption>
    </figure>
  );
}
