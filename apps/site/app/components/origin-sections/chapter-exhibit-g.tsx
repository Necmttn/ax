"use client";
import { useEffect, useRef } from "react";

export function ChapterExhibitG() {
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    const track      = root.querySelector<HTMLElement>("[data-pressure-track]");
    const handle     = root.querySelector<HTMLElement>("[data-pressure-handle]");
    const barFill    = root.querySelector<HTMLElement>("[data-pressure-fill]");
    const currentEl  = root.querySelector<HTMLElement>("[data-pressure-current]");
    const survivedEl = root.querySelector<HTMLElement>("[data-pressure-survived]");
    const pill       = root.querySelector<HTMLElement>("[data-pressure-pill]");
    const pillLabel  = root.querySelector<HTMLElement>("[data-pressure-label]");
    const resetBtn   = root.querySelector<HTMLElement>("[data-pressure-reset]");
    const rules      = root.querySelectorAll<HTMLElement>("[data-pressure-status]");

    if (!track || !handle) return;

    // tokens (4k..200k, log scale for display)
    const MIN = 4, MAX = 200;
    let currentK = MIN;
    let dragging  = false;
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

    function kToPct(k: number) {
      return ((k - MIN) / (MAX - MIN)) * 100;
    }

    function pctToK(pct: number) {
      return MIN + (pct / 100) * (MAX - MIN);
    }

    function formatK(k: number) {
      return `${Math.round(k)}k`;
    }

    function countSurvived(k: number) {
      let n = 0;
      root.querySelectorAll<HTMLElement>("[data-drop]").forEach((rule) => {
        const drop = parseInt(rule.getAttribute("data-drop") ?? "999", 10);
        if (k < drop) n++;
      });
      return n;
    }

    function setPosition(k: number) {
      if (k < MIN) k = MIN;
      if (k > MAX) k = MAX;
      currentK = k;
      const pct = kToPct(k);

      handle!.style.left = `${pct}%`;
      barFill!.style.width = `${pct}%`;
      if (currentEl) currentEl.textContent = formatK(k);
      track!.setAttribute("aria-valuenow", String(Math.round(k)));

      // update each rule
      root.querySelectorAll<HTMLElement>("[data-pressure-rule]").forEach((ruleEl) => {
        const drop     = parseInt(ruleEl.getAttribute("data-drop") ?? "999", 10);
        const kind     = ruleEl.getAttribute("data-kind") ?? "prose";
        const statusEl = ruleEl.querySelector<HTMLElement>("[data-pressure-status]");
        if (!statusEl) return;

        if (kind === "hook") {
          // hooks never drop
          return;
        }

        if (k >= drop) {
          if (kind === "prose") {
            ruleEl.setAttribute("data-state", "dropped");
            statusEl.textContent = "dropped";
          } else if (kind === "skill") {
            ruleEl.setAttribute("data-state", "degraded");
            statusEl.textContent = "degraded";
          }
        } else {
          ruleEl.removeAttribute("data-state");
          if (kind === "skill") {
            statusEl.textContent = "held";
          } else {
            statusEl.textContent = "held";
          }
        }
      });

      const survived  = countSurvived(k);
      const total     = root.querySelectorAll("[data-drop]").length;
      if (survivedEl) {
        survivedEl.textContent = String(survived);
        survivedEl.classList.toggle("is-max", survived === total);
        survivedEl.classList.remove("is-pulse");
        void survivedEl.offsetWidth;
        survivedEl.classList.add("is-pulse");
      }
    }

    // ── Drag track ───────────────────────────────────────────────────────────
    function clientXToK(clientX: number) {
      const rect = track!.getBoundingClientRect();
      const pct  = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
      return pctToK(pct);
    }

    track.addEventListener("pointerdown", (ev) => {
      takeover();
      dragging = true;
      handle!.classList.add("is-dragging");
      handle!.setPointerCapture(ev.pointerId);
      setPosition(clientXToK(ev.clientX));
      ev.preventDefault();
    });

    track.addEventListener("pointermove", (ev) => {
      if (!dragging) return;
      setPosition(clientXToK(ev.clientX));
    });

    track.addEventListener("pointerup", (ev) => {
      if (!dragging) return;
      dragging = false;
      handle!.classList.remove("is-dragging");
      try { handle!.releasePointerCapture(ev.pointerId); } catch (_) {}
      setPosition(clientXToK(ev.clientX));
    });

    track.addEventListener("pointercancel", () => {
      dragging = false;
      handle!.classList.remove("is-dragging");
    });

    // Keyboard
    track.addEventListener("keydown", (ev) => {
      takeover();
      const step = (MAX - MIN) / 20;
      if (ev.key === "ArrowRight" || ev.key === "ArrowUp")   { setPosition(currentK + step); ev.preventDefault(); }
      if (ev.key === "ArrowLeft"  || ev.key === "ArrowDown") { setPosition(currentK - step); ev.preventDefault(); }
      if (ev.key === "Home") { setPosition(MIN); ev.preventDefault(); }
      if (ev.key === "End")  { setPosition(MAX); ev.preventDefault(); }
    });

    resetBtn?.addEventListener("click", () => {
      clearPending();
      userTookOver = false;
      autoPlaying  = false;
      setPosition(MIN);
      setPillState("idle", "auto · idle");
      if (!reduce) {
        const id = setTimeout(() => { if (!userTookOver) runAutoplay(); }, 1200);
        pendingTimers.push(id);
      }
    });

    function takeover() {
      if (userTookOver) return;
      userTookOver = true;
      autoPlaying  = false;
      clearPending();
      setPillState("manual", "manual");
    }

    // ── Autoplay ─────────────────────────────────────────────────────────────
    async function runAutoplay() {
      if (userTookOver || reduce) return;
      autoPlaying = true;
      setPillState("playing", "auto · playing");

      const wait = (ms: number) => new Promise<void>((resolve) => {
        const id = setTimeout(() => {
          pendingTimers = pendingTimers.filter((t) => t !== id);
          resolve();
        }, ms);
        pendingTimers.push(id);
      });

      const tween = (from: number, to: number, durMs: number) => new Promise<void>((resolve) => {
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

      await wait(600);
      if (userTookOver) return;
      await tween(MIN, 100, 2200);
      if (userTookOver) return;
      await wait(800);
      if (userTookOver) return;
      await tween(100, MAX, 1800);
      if (userTookOver) return;

      autoPlaying = false;
      setPillState("done", "auto · done");
    }

    root.addEventListener("pointerdown", (ev) => {
      if ((ev.target as Element).closest("[data-pressure-reset]")) return;
      if ((ev.target as Element).closest("[data-pressure-track]")) return;
      if (autoPlaying) takeover();
    }, true);

    // Boot
    if (reduce) {
      root.setAttribute("data-static", "1");
      setPillState("reduce", "motion paused");
      setPosition(MAX);
      const cap = document.createElement("div");
      cap.className = "static-caption";
      cap.textContent = "motion paused - full context window shown";
      root.querySelector("[data-pressure-wrap]")?.appendChild(cap);
    } else {
      setPosition(MIN);
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
    <figure className="fig-pressure" ref={rootRef}
      aria-label="Interactive simulator: drag the context-window slider to watch prose rules drop, skills degrade, and hooks stay locked">
      <div className="fig-head">
        <span className="fig-id">Exhibit G</span>
        <span>context pressure · what survives a full window</span>
        <button type="button" className="auto-pill" data-pressure-pill data-state="idle" aria-label="autoplay status">
          <span className="auto-dot" aria-hidden="true"></span><span className="auto-label" data-pressure-label>auto · idle</span>
        </button>
        <button type="button" className="reset" data-pressure-reset aria-label="reset simulator">reset</button>
      </div>

      <div className="pressure-wrap" data-pressure-wrap>

        <div className="pressure-meter">
          <div className="pressure-meter-head">
            <span className="pm-label">context used</span>
            <span className="pm-readout"><span className="pm-current" data-pressure-current>4k</span> <span className="pm-sep">/</span> <span className="pm-max">200k</span></span>
          </div>
          <div className="pressure-bar" data-pressure-bar>
            <div className="pressure-bar-fill" data-pressure-fill style={{width: "0%"}}></div>
          </div>
          <div className="pressure-track" data-pressure-track tabIndex={0} role="slider" aria-valuemin={4} aria-valuemax={200} aria-valuenow={4} aria-label="context window in thousands of tokens">
            <div className="pressure-ticks" aria-hidden="true">
              <span className="ptick" style={{left: "0%"}}>4k</span>
              <span className="ptick" style={{left: "14.29%"}}>32k</span>
              <span className="ptick" style={{left: "30.61%"}}>64k</span>
              <span className="ptick" style={{left: "63.27%"}}>128k</span>
              <span className="ptick" style={{left: "100%"}}>200k</span>
            </div>
            <div className="pressure-handle" data-pressure-handle style={{left: "0%"}} aria-hidden="true"></div>
          </div>
        </div>

        <div className="pressure-list-head">
          <span className="plh-title">retained in context</span>
          <span className="plh-survived"><span className="plh-label">survived</span> <span className="plh-num" data-pressure-survived>9</span><span className="plh-of">/9</span></span>
        </div>

        <div className="pressure-rules" data-pressure-rules>
          <div className="pressure-rule" data-pressure-rule data-kind="prose" data-id="no-main" data-drop="60">
            <span className="pr-kind">[prose]</span>
            <span className="pr-text">never work on main, always branch into a worktree</span>
            <span className="pr-status" data-pressure-status>held</span>
          </div>
          <div className="pressure-rule" data-pressure-rule data-kind="prose" data-id="typecheck" data-drop="75">
            <span className="pr-kind">[prose]</span>
            <span className="pr-text">always run typecheck before commit</span>
            <span className="pr-status" data-pressure-status>held</span>
          </div>
          <div className="pressure-rule" data-pressure-rule data-kind="prose" data-id="small-commits" data-drop="95">
            <span className="pr-kind">[prose]</span>
            <span className="pr-text">prefer small commits with conventional messages</span>
            <span className="pr-status" data-pressure-status>held</span>
          </div>
          <div className="pressure-rule" data-pressure-rule data-kind="prose" data-id="terse-comments" data-drop="120">
            <span className="pr-kind">[prose]</span>
            <span className="pr-text">prefer terse comments only when the why is non-obvious</span>
            <span className="pr-status" data-pressure-status>held</span>
          </div>
          <div className="pressure-rule" data-pressure-rule data-kind="skill" data-id="worktree-first" data-drop="150">
            <span className="pr-kind">[skill]</span>
            <span className="pr-text">worktree-first · invoked when intent matches new branch / task</span>
            <span className="pr-status" data-pressure-status>held</span>
          </div>
          <div className="pressure-rule" data-pressure-rule data-kind="skill" data-id="tdd-first" data-drop="170">
            <span className="pr-kind">[skill]</span>
            <span className="pr-text">tdd-first · write the failing test before the fix</span>
            <span className="pr-status" data-pressure-status>held</span>
          </div>
          <div className="pressure-rule" data-pressure-rule data-kind="hook" data-id="block-main" data-drop="999">
            <span className="pr-kind">[hook]</span>
            <span className="pr-text">pre-tool: block writes on main unless explicitly allowed</span>
            <span className="pr-status" data-pressure-status><span className="pr-lock" aria-hidden="true"></span>locked</span>
          </div>
          <div className="pressure-rule" data-pressure-rule data-kind="hook" data-id="block-force-push" data-drop="999">
            <span className="pr-kind">[hook]</span>
            <span className="pr-text">pre-tool: block <code>git push --force</code> on protected branches</span>
            <span className="pr-status" data-pressure-status><span className="pr-lock" aria-hidden="true"></span>locked</span>
          </div>
          <div className="pressure-rule" data-pressure-rule data-kind="hook" data-id="scoped-creds" data-drop="999">
            <span className="pr-kind">[hook]</span>
            <span className="pr-text">runtime: scoped credentials only, no ambient secrets</span>
            <span className="pr-status" data-pressure-status><span className="pr-lock" aria-hidden="true"></span>locked</span>
          </div>
        </div>
      </div>

      <figcaption>
        <strong>Prose is the first thing the model forgets.</strong>{" "}
        Drag the slider. Watch prose rules fade as the window fills,
        skills degrade to "followed when invoked," and hooks stay
        locked at the tool layer. Thresholds are illustrative —
        anchored to observed retention across transcripts, exact values
        vary by session length and prompt density.
      </figcaption>
    </figure>
  );
}
