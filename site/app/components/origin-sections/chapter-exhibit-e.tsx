"use client";
import { useEffect, useRef } from "react";

/**
 * Exhibit E - retro → proposal → experiment → verdict (interactive pipeline)
 * Simplified port: drag/drop + scrubber + autoplay sequence
 */
export function ChapterExhibitE() {
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    const retroBody = root.querySelector<HTMLElement>('[data-drop="retros"]');
    const propBody  = root.querySelector<HTMLElement>('[data-drop="proposals"]');
    const expBody   = root.querySelector<HTMLElement>('[data-drop="experiments"]');
    const verdBody  = root.querySelector<HTMLElement>('[data-drop="verdicts"]');
    const rail      = root.querySelector<HTMLElement>("[data-scrubber-rail]");
    const handle    = root.querySelector<HTMLElement>("[data-scrubber-handle]");
    const fillBar   = root.querySelector<HTMLElement>("[data-scrubber-fill]");
    const readout   = root.querySelector<HTMLElement>("[data-scrubber-readout]");
    const resetBtn  = root.querySelector<HTMLElement>("[data-pipeline-reset]");
    const ticks     = root.querySelectorAll<HTMLElement>(".scrubber-tick");
    const pill      = root.querySelector<HTMLElement>("[data-auto-pill]");
    const pillLabel = root.querySelector<HTMLElement>("[data-auto-label]");

    if (!retroBody || !propBody || !expBody || !verdBody || !rail || !handle) return;

    type ItemState = "pending" | "proposal" | "experiment" | "rejected";

    const SEED = [
      {
        id: "main-hook",
        retroTitle: "ran on main",
        retroLines: ['<span class="lk">retro</span> 05-24', 'failed=<span class="lv-err">"ran on main"</span>', '<span class="lk">→</span> use-hook'],
        propTitle: "add pre-tool hook: block writes on main",
        propMeta: "PreToolUse · bash",
        expName: "main-branch-hook",
        verdict: "kept",
        verdictLabel: "KEPT",
        verdictMeta: "merged 2026-05-22",
        ticks: { 7: '<span class="lk">t+7</span> 12 sessions clean', 30: '<span class="lk">t+30</span> 0 incidents', 90: '<span class="lk">t+90</span> <span style="color:var(--green)">verdict=kept</span>' },
      },
      {
        id: "oxlint-swap",
        retroTitle: "oxlint slower than promised",
        retroLines: ['<span class="lk">retro</span> 05-12', 'claimed=<span class="lv-err">"10x faster"</span>', '<span class="lk">→</span> swap-in-ci'],
        propTitle: "swap eslint → oxlint in CI",
        propMeta: "CI · lint stage",
        expName: "oxlint-swap",
        verdict: "regressed",
        verdictLabel: "REGRESSED",
        verdictMeta: "reverted 2026-05-15",
        ticks: { 7: '<span class="lk">t+7</span> 3 false positives', 30: '<span class="lk">t+30</span> 1 missed rule', 90: '<span class="lk">t+90</span> <span class="lv-err">reverted</span>' },
      },
      {
        id: "parallel-task",
        retroTitle: "fan-out flaky",
        retroLines: ['<span class="lk">retro</span> 05-18', 'failed=<span class="lv-err">"sub-agent stall"</span>', '<span class="lk">→</span> new-skill'],
        propTitle: "skill: parallel-task-helper",
        propMeta: "fan-out helper",
        expName: "parallel-task",
        verdict: "self-resolved",
        verdictLabel: "SELF-RESOLVED",
        verdictMeta: "Task tool defaults changed",
        ticks: { 7: '<span class="lk">t+7</span> 4 invocations', 30: '<span class="lk">t+30</span> 0 invocations', 90: "<span class=\"lk\">t+90</span> upstream patched" },
      },
    ];

    const state: Record<string, ItemState> = {};
    let position = 0;
    let rejected = 0;
    let pendingTimers: ReturnType<typeof setTimeout>[] = [];
    let pendingRafs: number[] = [];
    let userTookOver = false;
    let autoPlaying = false;
    const laneStart: Record<string, string> = {};

    function clearPending() {
      pendingTimers.forEach(clearTimeout);
      pendingRafs.forEach(cancelAnimationFrame);
      pendingTimers = [];
      pendingRafs = [];
    }

    function setPillState(s: string, text: string) {
      pill?.setAttribute("data-state", s);
      if (pillLabel) pillLabel.textContent = text;
    }

    function getItem(id: string) {
      return SEED.find((s) => s.id === id)!;
    }

    function clearEl(el: HTMLElement) {
      while (el.firstChild) el.removeChild(el.firstChild);
    }

    // ── Build cards ──────────────────────────────────────────────────────────

    function makeRetroCard(item: typeof SEED[0]) {
      const card = document.createElement("div");
      card.className = "retro-card";
      card.setAttribute("data-id", item.id);
      card.setAttribute("role", "button");
      card.setAttribute("tabindex", "0");
      card.setAttribute("aria-label", `retro: ${item.retroTitle}`);

      const x = document.createElement("button");
      x.type = "button";
      x.className = "reject-x";
      x.setAttribute("aria-label", "reject retro");
      x.textContent = "×";
      card.appendChild(x);

      const title = document.createElement("div");
      title.className = "card-title";
      title.textContent = item.retroTitle;
      card.appendChild(title);

      const ev = document.createElement("div");
      ev.className = "card-evidence";
      ev.innerHTML = item.retroLines.join("<br>");
      card.appendChild(ev);

      const actions = document.createElement("div");
      actions.className = "card-actions";
      const accept = document.createElement("button");
      accept.type = "button";
      accept.className = "accept";
      accept.textContent = "accept";
      actions.appendChild(accept);
      card.appendChild(actions);

      x.addEventListener("click", (ev) => { ev.stopPropagation(); rejectItem(item.id); });
      accept.addEventListener("click", (ev) => { ev.stopPropagation(); promote(item.id); });

      // click to promote on mobile
      card.addEventListener("click", (ev) => {
        if ((ev.target as Element).closest("button")) return;
        if (window.matchMedia("(max-width: 720px)").matches) promote(item.id);
      });
      card.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          if ((ev.target as Element).closest("button")) return;
          ev.preventDefault();
          promote(item.id);
        }
      });

      return card;
    }

    function makeProposalCard(item: typeof SEED[0]) {
      const card = document.createElement("div");
      card.className = "proposal-card";
      card.setAttribute("data-id", item.id);

      const title = document.createElement("div");
      title.className = "card-title";
      title.innerHTML = item.propTitle;
      card.appendChild(title);

      const meta = document.createElement("div");
      meta.className = "card-evidence";
      meta.innerHTML = item.propMeta;
      card.appendChild(meta);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "start-exp";
      btn.textContent = "start experiment";
      btn.addEventListener("click", () => startExperiment(item.id));
      card.appendChild(btn);

      return card;
    }

    function makeExpLane(item: typeof SEED[0]) {
      const lane = document.createElement("div");
      lane.className = "exp-lane";
      lane.setAttribute("data-id", item.id);

      const name = document.createElement("div");
      name.className = "exp-name";
      name.textContent = item.expName;
      lane.appendChild(name);

      const railEl = document.createElement("div");
      railEl.className = "exp-rail";
      const fillEl = document.createElement("div");
      fillEl.className = "exp-fill";
      railEl.appendChild(fillEl);
      [0, 7, 30, 90].forEach((cp) => {
        const dot = document.createElement("div");
        dot.className = "exp-cp";
        dot.setAttribute("data-cp", String(cp));
        railEl.appendChild(dot);
      });
      lane.appendChild(railEl);

      const evEl = document.createElement("div");
      evEl.className = "exp-evidence";
      [7, 30, 90].forEach((cp) => {
        const tick = document.createElement("div");
        tick.className = "ev-tick";
        tick.setAttribute("data-cp", String(cp));
        tick.innerHTML = (item.ticks as Record<number, string>)[cp];
        evEl.appendChild(tick);
      });
      lane.appendChild(evEl);

      return lane;
    }

    function makeVerdictSlot(item: typeof SEED[0]) {
      const slot = document.createElement("div");
      slot.className = "verdict-slot";
      slot.setAttribute("data-id", item.id);

      const vpill = document.createElement("span");
      vpill.className = "verdict-pill";
      vpill.setAttribute("data-kind", item.verdict);
      vpill.textContent = item.verdictLabel;
      slot.appendChild(vpill);

      const meta = document.createElement("div");
      meta.className = "verdict-meta";
      meta.textContent = item.verdictMeta;
      meta.style.opacity = "0";
      slot.appendChild(meta);

      return slot;
    }

    // ── State transitions ────────────────────────────────────────────────────

    function promote(id: string) {
      if (state[id] !== "pending") return;
      state[id] = "proposal";
      const old = retroBody!.querySelector(`.retro-card[data-id="${id}"]`);
      if (old) {
        old.classList.add("is-leaving");
        setTimeout(() => { if (old.parentNode) old.parentNode.removeChild(old); }, 220);
      }
      propBody!.appendChild(makeProposalCard(getItem(id)));
      refreshEmpties();
    }

    function rejectItem(id: string) {
      if (state[id] !== "pending") return;
      state[id] = "rejected";
      rejected++;
      const old = retroBody!.querySelector(`.retro-card[data-id="${id}"]`);
      if (old) {
        old.classList.add("is-leaving");
        setTimeout(() => { if (old.parentNode) old.parentNode.removeChild(old); }, 220);
      }
      refreshEmpties();
    }

    function startExperiment(id: string) {
      if (state[id] !== "proposal") return;
      state[id] = "experiment";
      const propCard = propBody!.querySelector(`.proposal-card[data-id="${id}"]`);
      if (propCard) {
        propCard.classList.add("is-leaving");
        setTimeout(() => { if (propCard.parentNode) propCard.parentNode.removeChild(propCard); }, 220);
      }
      expBody!.appendChild(makeExpLane(getItem(id)));
      verdBody!.appendChild(makeVerdictSlot(getItem(id)));
      refreshEmpties();
      renderScrubber();
    }

    function refreshEmpties() {
      let pending = 0;
      SEED.forEach((s) => { if (state[s.id] === "pending") pending++; });
      const countEl = root.querySelector("[data-count-retros]");
      if (countEl) countEl.textContent = `${pending} / week`;

      const emptyProp = root.querySelector('[data-empty="proposals"]');
      if (emptyProp) emptyProp.style.display = propBody!.querySelector(".proposal-card") ? "none" : "";
      const emptyExp = root.querySelector('[data-empty="experiments"]');
      if (emptyExp) emptyExp.style.display = expBody!.querySelector(".exp-lane") ? "none" : "";
      const emptyVerd = root.querySelector('[data-empty="verdicts"]');
      if (emptyVerd) emptyVerd.style.display = verdBody!.querySelector(".verdict-slot") ? "none" : "";
    }

    // ── Scrubber ─────────────────────────────────────────────────────────────

    function setPosition(p: number) {
      if (p < 0) p = 0;
      if (p > 1) p = 1;
      position = p;
      handle!.style.left = `${p * 100}%`;
      fillBar!.style.width = `${p * 100}%`;
      handle!.setAttribute("aria-valuenow", String(Math.round(p * 90)));
      renderScrubber();
    }

    function dayLabel(p: number) {
      const d = Math.round(p * 90);
      if (d === 0) return "t+0 · now";
      if (d < 7)   return `t+${d} · early`;
      if (d < 30)  return `t+${d} · week ${Math.ceil(d / 7)}`;
      if (d < 90)  return `t+${d} · tracking`;
      return "t+90 · verdict";
    }

    function renderScrubber() {
      if (readout) readout.textContent = dayLabel(position);

      expBody!.querySelectorAll<HTMLElement>(".exp-lane").forEach((lane) => {
        const id       = lane.getAttribute("data-id")!;
        const isLocked = laneStart[id] === "locked";
        const lanePos  = isLocked ? 1 : position;

        const fill = lane.querySelector<HTMLElement>(".exp-fill");
        if (fill) fill.style.width = `${lanePos * 100}%`;

        lane.querySelectorAll<HTMLElement>(".exp-cp").forEach((dot) => {
          const cp = parseInt(dot.getAttribute("data-cp") ?? "0", 10) / 90;
          dot.classList.toggle("is-passed", lanePos >= cp - 0.001);
        });
        lane.querySelectorAll<HTMLElement>(".ev-tick").forEach((tick) => {
          const cp = parseInt(tick.getAttribute("data-cp") ?? "0", 10) / 90;
          tick.classList.toggle("is-shown", lanePos >= cp - 0.001);
        });

        const slot = verdBody!.querySelector<HTMLElement>(`.verdict-slot[data-id="${id}"]`);
        if (slot) {
          const vpill = slot.querySelector<HTMLElement>(".verdict-pill");
          const meta  = slot.querySelector<HTMLElement>(".verdict-meta");
          const show  = lanePos >= 1 - 0.001;
          vpill?.classList.toggle("is-shown", show);
          if (meta) meta.style.opacity = show ? "1" : "0";
        }
      });
    }

    function pointerToPosition(clientX: number) {
      const rect = rail!.getBoundingClientRect();
      return (clientX - rect.left) / rect.width;
    }

    let dragging = false;
    handle.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      dragging = true;
      handle.classList.add("is-dragging");
      handle.setPointerCapture(ev.pointerId);
    });
    handle.addEventListener("pointermove", (ev) => {
      if (!dragging) return;
      setPosition(pointerToPosition(ev.clientX));
    });
    handle.addEventListener("pointerup", (ev) => {
      dragging = false;
      handle.classList.remove("is-dragging");
      try { handle.releasePointerCapture(ev.pointerId); } catch (_) {}
    });
    handle.addEventListener("pointercancel", () => {
      dragging = false;
      handle.classList.remove("is-dragging");
    });
    rail.addEventListener("pointerdown", (ev) => {
      if (ev.target === handle) return;
      setPosition(pointerToPosition(ev.clientX));
      dragging = true;
      try { handle.setPointerCapture(ev.pointerId); } catch (_) {}
      handle.classList.add("is-dragging");
    });
    handle.addEventListener("keydown", (ev) => {
      const step = 1 / 18;
      if (ev.key === "ArrowRight" || ev.key === "ArrowUp")   { ev.preventDefault(); setPosition(position + step); }
      if (ev.key === "ArrowLeft"  || ev.key === "ArrowDown") { ev.preventDefault(); setPosition(position - step); }
      if (ev.key === "Home") { ev.preventDefault(); setPosition(0); }
      if (ev.key === "End")  { ev.preventDefault(); setPosition(1); }
    });
    ticks.forEach((t) => {
      t.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const d = +(t.getAttribute("data-tick") ?? "0");
        setPosition(d / 90);
      });
    });

    // ── Seed / reset ─────────────────────────────────────────────────────────

    function seed() {
      clearEl(retroBody!);
      clearEl(propBody!);
      clearEl(expBody!);
      clearEl(verdBody!);

      [["proposals", "drag a retro here"], ["experiments", "start an experiment"], ["verdicts", "resolve at t+90"]].forEach(([col, text]) => {
        const bodyEl = root.querySelector<HTMLElement>(`[data-drop="${col}"]`);
        const em = document.createElement("div");
        em.className = "col-empty";
        em.setAttribute("data-empty", col);
        em.textContent = text;
        bodyEl?.appendChild(em);
      });

      SEED.forEach((item) => {
        state[item.id] = "pending";
        retroBody!.appendChild(makeRetroCard(item));
      });
      rejected = 0;
      Object.keys(laneStart).forEach((k) => delete laneStart[k]);
      setPosition(0);
      refreshEmpties();
    }

    function staticEnd() {
      root.setAttribute("data-static", "1");
      clearEl(retroBody!);
      clearEl(propBody!);
      clearEl(expBody!);
      clearEl(verdBody!);
      SEED.forEach((item) => {
        state[item.id] = "experiment";
        expBody!.appendChild(makeExpLane(item));
        verdBody!.appendChild(makeVerdictSlot(item));
      });
      const drained = document.createElement("div");
      drained.className = "col-empty";
      drained.textContent = "drained this week";
      retroBody!.appendChild(drained);
      setPosition(1);
      refreshEmpties();
    }

    function takeover() {
      if (userTookOver) return;
      userTookOver = true;
      autoPlaying  = false;
      clearPending();
      setPillState("manual", "manual");
    }

    // ── Autoplay sequence ─────────────────────────────────────────────────────

    function wait(ms: number): Promise<void> {
      return new Promise((resolve) => {
        const id = setTimeout(() => {
          pendingTimers = pendingTimers.filter((t) => t !== id);
          resolve();
        }, ms);
        pendingTimers.push(id);
      });
    }

    function tweenPos(from: number, to: number, durMs: number): Promise<void> {
      return new Promise((resolve) => {
        if (userTookOver) { resolve(); return; }
        const t0 = performance.now();
        function frame(now: number) {
          if (userTookOver) { resolve(); return; }
          let t = (now - t0) / durMs;
          if (t >= 1) t = 1;
          const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
          setPosition(from + (to - from) * eased);
          if (t < 1) {
            const rid = requestAnimationFrame(frame);
            pendingRafs.push(rid);
          } else {
            resolve();
          }
        }
        const rid = requestAnimationFrame(frame);
        pendingRafs.push(rid);
      });
    }

    async function playItem(item: typeof SEED[0], isLast: boolean) {
      if (userTookOver) return;

      // highlight card
      const card = retroBody!.querySelector<HTMLElement>(`.retro-card[data-id="${item.id}"]`);
      if (card) {
        card.classList.add("is-pointing");
        await wait(600);
        card.classList.remove("is-pointing");
      }
      if (userTookOver) return;

      // promote
      promote(item.id);
      await wait(400);
      if (userTookOver) return;

      // hold so reader can see proposal
      await wait(1600);
      if (userTookOver) return;

      // pulse start-exp button
      const propCard = propBody!.querySelector<HTMLElement>(`.proposal-card[data-id="${item.id}"]`);
      const btn = propCard?.querySelector<HTMLElement>(".start-exp");
      if (btn) {
        btn.classList.add("is-pulse");
        const c = setTimeout(() => btn.classList.remove("is-pulse"), 700);
        pendingTimers.push(c);
      }
      await wait(350);
      if (userTookOver) return;

      // start experiment
      startExperiment(item.id);
      await wait(300);
      if (userTookOver) return;

      // scrubber t+0 → t+90
      laneStart[item.id] = "active";
      setPosition(0);
      await tweenPos(0, 1, 3500);
      if (userTookOver) return;

      laneStart[item.id] = "locked";
      renderScrubber();
      await wait(isLast ? 200 : 800);
    }

    async function runAutoplay() {
      if (userTookOver || reduce) return;
      autoPlaying = true;
      setPillState("playing", "auto · playing");

      for (let i = 0; i < SEED.length; i++) {
        if (userTookOver) return;
        await playItem(SEED[i], i === SEED.length - 1);
      }

      if (userTookOver) return;
      setPosition(1);
      SEED.forEach((s) => { laneStart[s.id] = "locked"; });
      renderScrubber();

      autoPlaying = false;
      setPillState("done", "auto · done");
    }

    resetBtn?.addEventListener("click", () => {
      clearPending();
      autoPlaying  = false;
      userTookOver = false;
      seed();
      setPillState("idle", "auto · idle");
      if (!reduce) {
        const id = setTimeout(() => { if (!userTookOver && !autoPlaying) runAutoplay(); }, 1500);
        pendingTimers.push(id);
      } else {
        setPillState("reduce", "motion paused");
      }
    });

    root.addEventListener("pointerdown", (ev) => {
      if ((ev.target as Element).closest("[data-pipeline-reset]")) return;
      if (userTookOver) return;
      if (!autoPlaying && pendingTimers.length === 0) return;
      takeover();
    }, true);

    // Boot
    if (reduce) {
      staticEnd();
      setPillState("reduce", "motion paused");
    } else {
      seed();
      setPillState("idle", "auto · idle");
      let io: IntersectionObserver | null = null;
      let fired = false;
      if ("IntersectionObserver" in window) {
        io = new IntersectionObserver((entries) => {
          entries.forEach((e) => {
            if (e.isIntersecting && !fired && !userTookOver && !autoPlaying) {
              fired = true;
              io?.disconnect();
              io = null;
              const id = setTimeout(() => { if (!userTookOver && !autoPlaying) runAutoplay(); }, 1500);
              pendingTimers.push(id);
            }
          });
        }, { threshold: 0.4 });
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
    <figure id="pipeline" className="fig-pipeline" ref={rootRef}
      aria-label="Interactive four-column pipeline: drag a retro into proposals, start an experiment, then drag the scrubber to t+90 to lock a verdict">
      <div className="fig-head">
        <span className="fig-id">Exhibit E</span>
        <span>retro → proposal → experiment → verdict</span>
        <button type="button" className="auto-pill" data-auto-pill data-state="idle" aria-label="autoplay status">
          <span className="auto-dot" aria-hidden="true"></span><span className="auto-label" data-auto-label>auto · idle</span>
        </button>
        <button type="button" className="reset" data-pipeline-reset aria-label="reset pipeline">reset</button>
      </div>

      <div className="pipeline-grid" data-pipeline-grid>
        <div className="pipeline-col" data-col="retros">
          <div className="col-head"><span className="col-num">01</span>retros<span className="col-meta" data-count-retros>3 / week</span></div>
          <div className="col-body" data-drop="retros"></div>
        </div>
        <div className="pipeline-col" data-col="proposals">
          <div className="col-head"><span className="col-num">02</span>proposals<span className="col-meta">queued</span></div>
          <div className="col-body" data-drop="proposals">
            <div className="col-empty" data-empty="proposals">drag a retro here</div>
          </div>
        </div>
        <div className="pipeline-col" data-col="experiments">
          <div className="col-head"><span className="col-num">03</span>experiments<span className="col-meta">running</span></div>
          <div className="col-body" data-drop="experiments">
            <div className="col-empty" data-empty="experiments">start an experiment</div>
          </div>
        </div>
        <div className="pipeline-col" data-col="verdicts">
          <div className="col-head"><span className="col-num">04</span>verdicts<span className="col-meta" data-count-rejected>locked</span></div>
          <div className="col-body" data-drop="verdicts">
            <div className="col-empty" data-empty="verdicts">resolve at t+90</div>
          </div>
        </div>
      </div>

      <div className="pipeline-scrubber" data-pipeline-scrubber data-position="0" aria-label="scrubber: drag from now to t+90">
        <div className="scrubber-rail" data-scrubber-rail>
          <div className="scrubber-fill" data-scrubber-fill></div>
          <button type="button" className="scrubber-tick" data-tick="0"  style={{left: "0%"}}      aria-label="now"><span>t+0</span></button>
          <button type="button" className="scrubber-tick" data-tick="7"  style={{left: "33.333%"}} aria-label="t plus 7 days"><span>t+7</span></button>
          <button type="button" className="scrubber-tick" data-tick="30" style={{left: "66.666%"}} aria-label="t plus 30 days"><span>t+30</span></button>
          <button type="button" className="scrubber-tick" data-tick="90" style={{left: "100%"}}    aria-label="t plus 90 days"><span>t+90</span></button>
          <div className="scrubber-handle" data-scrubber-handle style={{left: "0%"}} tabIndex={0} role="slider" aria-valuemin={0} aria-valuemax={90} aria-valuenow={0} aria-label="time scrubber"></div>
        </div>
        <div className="scrubber-readout" data-scrubber-readout>t+0 · now</div>
      </div>

      <figcaption>
        <strong>The loop only closes when the graph can tell you, from backing data, that the change earned its place.</strong>{" "}
        The user still decides - drag a retro into proposals or off the board entirely. Then drive time forward
        and watch what the evidence says. <em>Kept</em>: still firing, no regressions. <em>Regressed</em>: bugfix
        PRs followed. <em>Self-resolved</em>: the underlying pattern stopped showing up before the fix mattered.
      </figcaption>
    </figure>
  );
}
