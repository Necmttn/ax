"use client";
import { useEffect, useRef } from "react";

export function ChapterExhibitH() {
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    const vibesBody   = root.querySelector<HTMLElement>('[data-lane-body="vibes"]');
    const axBody      = root.querySelector<HTMLElement>('[data-lane-body="ax"]');
    const vibesFoot   = root.querySelector<HTMLElement>('[data-lane-foot="vibes"]');
    const axFoot      = root.querySelector<HTMLElement>('[data-lane-foot="ax"]');
    const vibesCount  = root.querySelector<HTMLElement>("[data-vibes-count]");
    const axKept      = root.querySelector<HTMLElement>("[data-ax-kept]");
    const axDropped   = root.querySelector<HTMLElement>("[data-ax-dropped]");
    const counter     = root.querySelector<HTMLElement>("[data-race-counter]");
    const fill        = root.querySelector<HTMLElement>("[data-race-fill]");
    const currentEl   = root.querySelector<HTMLElement>("[data-race-current]");
    const stepBtn     = root.querySelector<HTMLElement>("[data-race-step]");
    const runBtn      = root.querySelector<HTMLElement>("[data-race-run]");
    const resetBtn    = root.querySelector<HTMLElement>("[data-race-reset]");
    const pill        = root.querySelector<HTMLElement>("[data-race-pill]");
    const pillLabel   = root.querySelector<HTMLElement>("[data-race-label]");

    if (!vibesBody || !axBody) return;

    const VIBES_ROWS = [
      { text: "never use var - always const/let",  risk: 0, verdict: null },
      { text: "all functions must have JSDoc",      risk: 0, verdict: null },
      { text: "no inline styles ever",             risk: 0, verdict: null },
      { text: "ban all ternary operators",          risk: 0, verdict: null },
      { text: "classes over functions always",      risk: 0, verdict: null },
      { text: "one export per file",               risk: 0, verdict: null },
      { text: "no more than 3 params per function", risk: 0, verdict: null },
      { text: "no default exports",                risk: 0, verdict: null },
      { text: "ban arrow functions in classes",     risk: 0, verdict: null },
      { text: "always use .at(-1) not [length-1]", risk: 0, verdict: null },
      { text: "no reassigned variables",           risk: 1, verdict: null },
      { text: "all identifiers must be ≥6 chars",  risk: 1, verdict: null },
      { text: "no chaining ≥3 deep",               risk: 1, verdict: null },
      { text: "no early returns",                  risk: 1, verdict: null },
      { text: "all arrays must be sorted",         risk: 1, verdict: null },
      { text: "no nested ternaries - or ternaries", risk: 1, verdict: null },
      { text: "require type annotations everywhere", risk: 0, verdict: null },
      { text: "ban boolean parameters",            risk: 1, verdict: null },
      { text: "all maps over forEach",             risk: 0, verdict: null },
      { text: "require null checks at every call", risk: 1, verdict: null },
    ] as { text: string; risk: 0 | 1; verdict: string | null }[];

    const AX_ROWS = [
      { text: "add pre-tool hook: block writes on main",      verdict: "kept",          exp: "sess#4129 · 0 incidents" },
      { text: "swap eslint → oxlint in CI",                  verdict: "regressed",     exp: "reverted 2026-05-15" },
      { text: "skill: parallel-task-helper",                  verdict: "self-resolved", exp: "upstream patched" },
      { text: "tighten typecheck before commit",             verdict: "kept",          exp: "0 missed types" },
      { text: "tag classify briefs for unused skills",       verdict: "kept",          exp: "3 sessions clean" },
    ] as { text: string; verdict: string; exp: string }[];

    let n = 0;
    let vKept   = 0; // vibes: all accepted (no filter)
    let aKept   = 0;
    let aDropped = 0;
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

    function setPillState(state: string, text: string) {
      pill?.setAttribute("data-state", state);
      if (pillLabel) pillLabel.textContent = text;
    }

    function addVibesRow(i: number) {
      const row = VIBES_ROWS[i];
      if (!row) return;
      vKept++;
      const el = document.createElement("div");
      el.className = "race-row";
      if (row.risk) el.setAttribute("data-risk", "1");
      el.innerHTML = `
        <span class="row-iter">iter ${String(i + 1).padStart(2, "0")}</span>
        <span class="row-text">${row.text}${row.risk ? ' <span class="row-tag">risk</span>' : ""}</span>
      `;
      vibesBody!.appendChild(el);
      requestAnimationFrame(() => { el.classList.add("is-shown"); });
      if (vibesCount) vibesCount.textContent = String(vKept);
      if (vKept >= 15) root.setAttribute("data-lane-vibes-overflow", "1");
    }

    function addAxRow(i: number) {
      const row = AX_ROWS[i % AX_ROWS.length];
      const accepted = row.verdict === "kept" || row.verdict === "self-resolved";
      if (accepted) aKept++; else aDropped++;

      const el = document.createElement("div");
      el.className = `race-row${!accepted ? " data-kind-rejected" : ""}`;
      if (!accepted) el.setAttribute("data-kind", "rejected");
      el.innerHTML = `
        <span class="row-iter">iter ${String(i + 1).padStart(2, "0")}</span>
        <span class="row-text">${row.text}</span>
        <span class="race-verdict" data-kind="${row.verdict}">${row.verdict.toUpperCase()}</span>
      `;
      axBody!.appendChild(el);
      requestAnimationFrame(() => { el.classList.add("is-shown"); });
      if (axKept)     axKept.textContent    = String(aKept);
      if (axDropped)  axDropped.textContent = String(aDropped);
    }

    function step() {
      if (n >= 20) return;
      addVibesRow(n);
      if (n < AX_ROWS.length * 4) addAxRow(n);
      n++;
      if (fill)     fill.style.width = `${(n / 20) * 100}%`;
      if (currentEl) currentEl.textContent = String(n);
      counter?.setAttribute("data-n", String(n));
    }

    function reset() {
      clearPending();
      autoPlaying  = false;
      userTookOver = false;
      n = 0; vKept = 0; aKept = 0; aDropped = 0;
      while (vibesBody!.firstChild) vibesBody!.removeChild(vibesBody!.firstChild);
      while (axBody!.firstChild)    axBody!.removeChild(axBody!.firstChild);
      if (fill)     fill.style.width = "0%";
      if (currentEl) currentEl.textContent = "0";
      counter?.setAttribute("data-n", "0");
      if (vibesCount) vibesCount.textContent = "0";
      if (axKept)     axKept.textContent = "0";
      if (axDropped)  axDropped.textContent = "0";
      root.removeAttribute("data-lane-vibes-overflow");
      root.removeAttribute("data-playing");
      setPillState("idle", "auto · idle");
    }

    function run20() {
      const remaining = 20 - n;
      for (let i = 0; i < remaining; i++) step();
    }

    async function runAutoplay() {
      if (userTookOver || reduce) return;
      autoPlaying = true;
      root.setAttribute("data-playing", "1");
      setPillState("playing", "auto · playing");

      const wait = (ms: number) => new Promise<void>((resolve) => {
        const id = setTimeout(() => {
          pendingTimers = pendingTimers.filter((t) => t !== id);
          resolve();
        }, ms);
        pendingTimers.push(id);
      });

      for (let i = 0; i < 20; i++) {
        if (userTookOver) return;
        step();
        await wait(320);
      }

      autoPlaying = false;
      root.removeAttribute("data-playing");
      setPillState("done", "auto · done");
    }

    function takeover() {
      if (userTookOver) return;
      userTookOver = true;
      autoPlaying  = false;
      clearPending();
      root.removeAttribute("data-playing");
      setPillState("manual", "manual");
    }

    stepBtn?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      takeover();
      step();
    });

    runBtn?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      takeover();
      run20();
    });

    resetBtn?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      reset();
    });

    root.addEventListener("pointerdown", (ev) => {
      if ((ev.target as Element).closest("[data-race-reset]")) return;
      if ((ev.target as Element).closest("[data-race-step]")) return;
      if ((ev.target as Element).closest("[data-race-run]")) return;
      if (autoPlaying) takeover();
    }, true);

    if (reduce) {
      root.setAttribute("data-static", "1");
      setPillState("reduce", "motion paused");
      run20();
      const cap = document.createElement("div");
      cap.className = "static-caption";
      cap.textContent = "motion paused - end state of 20 iterations";
      root.querySelector("[data-race-counter]")?.appendChild(cap);
    } else {
      setPillState("idle", "auto · idle");
      // Pre-seed a few iterations so both lanes show content on first paint
      // instead of two empty panels until the section scrolls into view.
      for (let i = 0; i < 3; i++) step();
      let io: IntersectionObserver | null = null;
      let fired = false;
      if ("IntersectionObserver" in window) {
        io = new IntersectionObserver((entries) => {
          entries.forEach((e) => {
            if (e.isIntersecting && !fired && !userTookOver) {
              fired = true;
              io?.disconnect();
              io = null;
              runAutoplay();
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
    <figure className="fig-race" ref={rootRef}
      aria-label="Two agents iterate twenty times in parallel - the vibes lane drifts into nonsense, the ax lane runs every proposal through experiment and verdict and accepts only a few">
      <div className="fig-head">
        <span className="fig-id">Exhibit H</span>
        <span>grounded vs ungrounded · 20 iterations</span>
        <button type="button" className="auto-pill" data-race-pill data-state="idle" aria-label="autoplay status">
          <span className="auto-dot" aria-hidden="true"></span><span className="auto-label" data-race-label>auto · idle</span>
        </button>
        <button type="button" className="reset" data-race-reset aria-label="reset race">reset</button>
      </div>

      <div className="race-wrap" data-race-wrap>
        <div className="race-grid">

          <div className="race-lane" data-lane="vibes">
            <div className="lane-head">
              <span className="col-num">01</span>vibes loop
              <span className="lane-meta">no evidence, no verdict</span>
            </div>
            <div className="lane-body" data-lane-body="vibes"></div>
            <div className="lane-foot" data-lane-foot="vibes">
              <span className="lf-key">vibes</span>
              <span className="lf-val"><span data-vibes-count>0</span> rules</span>
              <span className="lf-sep">·</span>
              <span className="lf-val">0 reverted</span>
            </div>
          </div>

          <div className="race-lane" data-lane="ax">
            <div className="lane-head">
              <span className="col-num">02</span>ax loop <span className="lane-sub">(backed)</span>
              <span className="lane-meta">proposal → experiment → verdict</span>
            </div>
            <div className="lane-body" data-lane-body="ax"></div>
            <div className="lane-foot" data-lane-foot="ax">
              <span className="lf-key">ax</span>
              <span className="lf-val"><span data-ax-kept>0</span> kept</span>
              <span className="lf-sep">·</span>
              <span className="lf-val"><span data-ax-dropped>0</span> dropped</span>
            </div>
          </div>

        </div>

        <div className="race-counter" data-race-counter data-n="0">
          <div className="rc-bar"><div className="rc-fill" data-race-fill style={{width: "0%"}}></div></div>
          <div className="rc-readout">iter <span data-race-current>0</span><span className="rc-of">/20</span></div>
          <div className="rc-controls">
            <button type="button" className="step" data-race-step aria-label="advance one iteration">step</button>
            <button type="button" className="run20" data-race-run aria-label="run all twenty iterations">run 20</button>
          </div>
        </div>
      </div>

      <figcaption>
        <strong>Replace grounding with reflection alone and the loop drifts.</strong>{" "}
        Same twenty iterations, same week. The left agent only consults
        itself; rules pile up until they parody the original goal. The
        right agent runs every proposal against backing evidence and
        ships three.
      </figcaption>
    </figure>
  );
}
