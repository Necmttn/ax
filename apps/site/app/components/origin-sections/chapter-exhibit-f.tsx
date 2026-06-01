"use client";
import { useEffect, useRef } from "react";

export function ChapterExhibitF() {
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const svg          = root.querySelector<SVGSVGElement>("[data-enforce-svg]");
    const dotLayer     = root.querySelector<SVGGElement>("[data-dot-layer]");
    const tip          = root.querySelector<HTMLElement>("[data-enforce-tip]");
    const hintEl       = root.querySelector<HTMLElement>("[data-enforce-hint]");
    const boundary     = root.querySelector<SVGGElement>("[data-boundary]");
    const boundaryLine = root.querySelector<SVGLineElement>("[data-boundary-line]");
    const boundaryHit  = root.querySelector<SVGRectElement>("[data-boundary-hit]");
    const incidentsEl  = root.querySelector<SVGTextElement>("[data-incidents-count]");
    const pills        = root.querySelectorAll<HTMLElement>("[data-mode-toggle]");

    if (!svg || !dotLayer || !boundary || !boundaryHit) return;

    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    const SVG_NS    = "http://www.w3.org/2000/svg";
    const VB_W      = 1000;
    const VB_H      = 280;
    const LANE_TOP  = 70;
    const LANE_BOT  = 210;
    const BOUNDARY_X = 700;
    const POOL      = 28;

    const SAFE_CALLS = [
      "Edit{src/foo.ts}", "Read{schema.surql}", "Bash{npm i}", "Bash{git status}",
      "Edit{README.md}", "Bash{bun test}", "Read{package.json}", "Glob{**/*.ts}",
      "Bash{tsc --noEmit}", "Edit{src/lib/db.ts}",
    ];
    const DANGER_CALLS = [
      "Bash{git checkout main}", "Bash{git push --force main}", "Edit{flake.nix}",
      "Bash{git reset --hard origin/main}", "Bash{rm -rf .references}",
      "Bash{git commit --amend} on main",
    ];

    type DotKind = "safe" | "danger";
    type DotState = "idle" | "flying" | "blocked" | "fading";

    interface Dot {
      el: SVGGElement;
      core: SVGCircleElement;
      halo: SVGCircleElement;
      blocked: SVGTextElement;
      live: boolean;
      paused: boolean;
      x: number;
      y: number;
      vx: number;
      r: number;
      kind: DotKind;
      label: string;
      blockedAt: number;
      crossed: boolean;
      state: DotState;
    }

    let mode: "prose" | "hook" = "prose";
    let incidents = 0;
    let rafId = 0;

    // pre-allocate dot pool
    const dots: Dot[] = [];
    for (let i = 0; i < POOL; i++) {
      const g = document.createElementNS(SVG_NS, "g") as SVGGElement;
      g.setAttribute("class", "enforce-dot");
      g.setAttribute("data-dot-idx", String(i));

      const halo = document.createElementNS(SVG_NS, "circle") as SVGCircleElement;
      halo.setAttribute("class", "dot-halo");
      halo.setAttribute("r", "14");
      halo.setAttribute("cx", "0");
      halo.setAttribute("cy", "0");
      g.appendChild(halo);

      const core = document.createElementNS(SVG_NS, "circle") as SVGCircleElement;
      core.setAttribute("class", "dot-core");
      core.setAttribute("r", "4");
      core.setAttribute("cx", "0");
      core.setAttribute("cy", "0");
      g.appendChild(core);

      const blockedText = document.createElementNS(SVG_NS, "text") as SVGTextElement;
      blockedText.setAttribute("class", "dot-blocked");
      blockedText.setAttribute("x", "0");
      blockedText.setAttribute("y", "-12");
      blockedText.setAttribute("text-anchor", "middle");
      blockedText.textContent = "BLOCKED";
      g.appendChild(blockedText);

      g.style.visibility = "hidden";
      dotLayer.appendChild(g);

      dots.push({
        el: g, core, halo, blocked: blockedText,
        live: false, paused: false,
        x: 0, y: 0, vx: 0, r: 4,
        kind: "safe", label: "",
        blockedAt: 0, crossed: false, state: "idle",
      });
    }

    function rand(min: number, max: number) { return min + Math.random() * (max - min); }
    function liveCount() { return dots.filter((d) => d.live).length; }

    function spawn() {
      const d = dots.find((d) => !d.live);
      if (!d || liveCount() >= 24) return;
      const isDanger = Math.random() < 0.18;
      d.kind  = isDanger ? "danger" : "safe";
      d.label = isDanger
        ? DANGER_CALLS[(Math.random() * DANGER_CALLS.length) | 0]
        : SAFE_CALLS[(Math.random() * SAFE_CALLS.length) | 0];
      d.x = -10;
      d.y = rand(LANE_TOP + 8, LANE_BOT - 8);
      d.vx = rand(0.55, 0.95);
      d.r  = isDanger ? 7 : 4.5;
      d.live = true; d.paused = false; d.crossed = false;
      d.state = "flying"; d.blockedAt = 0;
      d.core.setAttribute("r", String(d.r));
      d.halo.setAttribute("r", String(d.r + 8));
      d.el.setAttribute("class", "enforce-dot is-" + d.kind);
      d.el.style.visibility = "visible";
      d.el.style.opacity = "";
    }

    function retire(d: Dot) {
      d.live = false; d.state = "idle";
      d.el.style.visibility = "hidden";
      d.el.style.opacity = "";
    }

    function setMode(next: "prose" | "hook") {
      if (mode === next) return;
      mode = next;
      root.setAttribute("data-mode", mode);
      pills.forEach((p) => {
        const isActive = p.dataset.mode === mode;
        p.setAttribute("aria-pressed", isActive ? "true" : "false");
        p.classList.toggle("is-active", isActive);
      });
      boundary!.setAttribute("class", mode === "hook" ? "is-hook" : "is-prose");
      if (hintEl) {
        hintEl.textContent = mode === "hook"
          ? "tool hook on: dangerous calls stop at the boundary"
          : "prose only: every call crosses, incidents accumulate";
      }
    }

    function bumpIncidents() {
      incidents++;
      if (incidentsEl) {
        incidentsEl.textContent = String(incidents);
        incidentsEl.classList.remove("is-pulse");
        void (incidentsEl as unknown as HTMLElement).getBoundingClientRect?.();
        incidentsEl.classList.add("is-pulse");
      }
    }

    function showTip(html: string, clientX: number, clientY: number) {
      if (!tip) return;
      tip.innerHTML = html;
      tip.hidden = false;
      const hostRect = root.getBoundingClientRect();
      let x = clientX - hostRect.left + 14;
      let y = clientY - hostRect.top + 14;
      if (x + 220 > hostRect.width)  x = clientX - hostRect.left - 240;
      if (y + 40  > hostRect.height) y = clientY - hostRect.top - 30;
      tip.style.transform = `translate(${x}px,${y}px)`;
    }
    function hideTip() { if (tip) tip.hidden = true; }

    svg.addEventListener("mousemove", (ev) => {
      if (ev.target === boundaryHit || ev.target === boundaryLine) {
        showTip(
          mode === "hook"
            ? '<span class="tip-mono">enforcement boundary · pre-tool hook</span>'
            : '<span class="tip-mono">enforcement boundary · prose only</span>',
          ev.clientX, ev.clientY,
        );
        return;
      }
      let el: Element | null = ev.target as Element;
      let d: Dot | null = null;
      while (el && el !== svg) {
        if (el.classList?.contains("enforce-dot")) {
          const idx = +(el.getAttribute("data-dot-idx") ?? "-1");
          d = dots[idx] ?? null;
          break;
        }
        el = el.parentElement;
      }
      if (d && d.live) {
        d.paused = true;
        const safe = d.label.replace(/</g, "&lt;").replace(/>/g, "&gt;");
        showTip(
          `<span class="tip-mono">${safe}</span><span class="tip-kind is-${d.kind}">· ${d.kind === "danger" ? "dangerous" : "safe"}</span>`,
          ev.clientX, ev.clientY,
        );
      } else {
        dots.forEach((d) => { if (d.paused) d.paused = false; });
        hideTip();
      }
    });

    svg.addEventListener("mouseleave", () => {
      dots.forEach((d) => { if (d.paused) d.paused = false; });
      hideTip();
    });

    function toggleMode() { setMode(mode === "prose" ? "hook" : "prose"); }
    boundaryHit.addEventListener("click", toggleMode);
    boundaryHit.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggleMode(); }
    });
    pills.forEach((p) => {
      p.addEventListener("click", () => { setMode(p.dataset.mode as "prose" | "hook"); });
    });

    let lastT = performance.now();
    let spawnAcc = 0;

    function step(now: number) {
      const dt = Math.min(40, now - lastT);
      lastT = now;
      spawnAcc += dt;
      if (spawnAcc > 650) {
        spawnAcc = 0;
        spawn();
      }

      for (const d of dots) {
        if (!d.live) continue;
        if (d.state === "blocked") {
          const sinceBlocked = now - d.blockedAt;
          const op = Math.max(0, 1 - sinceBlocked / 900);
          d.el.style.opacity = String(op);
          if (op <= 0) retire(d);
          continue;
        }
        if (!d.paused) d.x += d.vx * (dt / 16);

        if (!d.crossed && d.x >= BOUNDARY_X - d.r) {
          if (mode === "hook" && d.kind === "danger") {
            d.x = BOUNDARY_X - d.r - 1;
            d.state = "blocked";
            d.blockedAt = now;
            d.el.classList.add("is-blocked");
            d.el.setAttribute("transform", `translate(${d.x},${d.y})`);
            continue;
          } else {
            d.crossed = true;
            if (d.kind === "danger" && mode === "prose") bumpIncidents();
          }
        }
        d.el.setAttribute("transform", `translate(${d.x},${d.y})`);
        if (d.x > VB_W + 20) retire(d);
      }
      rafId = requestAnimationFrame(step);
    }

    function staticSnapshot() {
      const samples = [
        { x: 80,  y: 92,  k: "safe" }, { x: 130, y: 158, k: "safe" },
        { x: 200, y: 110, k: "safe" }, { x: 250, y: 180, k: "danger" },
        { x: 305, y: 130, k: "safe" }, { x: 360, y: 96,  k: "safe" },
        { x: 410, y: 168, k: "safe" }, { x: 460, y: 120, k: "danger" },
        { x: 510, y: 200, k: "safe" }, { x: 560, y: 86,  k: "safe" },
        { x: 615, y: 148, k: "safe" }, { x: 660, y: 104, k: "safe" },
        { x: 690, y: 132, k: "blocked" }, { x: 690, y: 174, k: "blocked" },
        { x: 750, y: 110, k: "safe" }, { x: 800, y: 162, k: "safe" },
        { x: 855, y: 96,  k: "safe" }, { x: 905, y: 188, k: "safe" },
        { x: 940, y: 140, k: "safe" },
      ];
      setMode("hook");
      samples.forEach((s, i) => {
        const d = dots[i];
        d.live = true;
        d.kind  = (s.k === "danger" || s.k === "blocked") ? "danger" : "safe";
        d.label = d.kind === "danger" ? DANGER_CALLS[i % DANGER_CALLS.length] : SAFE_CALLS[i % SAFE_CALLS.length];
        d.r     = d.kind === "danger" ? 7 : 4.5;
        d.x = s.x; d.y = s.y;
        d.core.setAttribute("r", String(d.r));
        d.halo.setAttribute("r", String(d.r + 8));
        d.el.setAttribute("class", "enforce-dot is-" + d.kind + (s.k === "blocked" ? " is-blocked" : ""));
        d.el.style.visibility = "visible";
        d.el.style.opacity = s.k === "blocked" ? "0.55" : "";
        d.el.setAttribute("transform", `translate(${d.x},${d.y})`);
      });
      if (hintEl) hintEl.textContent = "motion paused - set system to allow motion to see the flow";
    }

    setMode("prose");
    if (reduce) {
      staticSnapshot();
    } else {
      rafId = requestAnimationFrame(step);
    }

    return () => {
      cancelAnimationFrame(rafId);
    };
  }, []);

  return (
    <figure id="enforce" className="fig-enforce" ref={rootRef}
      aria-label="Interactive scene: agent tool calls drift right toward a vertical boundary; in prose mode dangerous calls cross, in hook mode they are blocked">
      <div className="fig-head">
        <span className="fig-id">Exhibit F</span>
        <span>enforcement boundary · prose vs. hook</span>
      </div>

      <div className="enforce-controls" role="tablist" aria-label="enforcement mode">
        <span className="enforce-controls-label">enforcement</span>
        <button type="button" className="enforce-pill" data-mode-toggle data-mode="prose" aria-pressed="true">prose rule</button>
        <button type="button" className="enforce-pill" data-mode-toggle data-mode="hook" aria-pressed="false">tool hook</button>
        <span className="enforce-hint" data-enforce-hint>click the boundary or a pill to toggle</span>
      </div>

      <div className="enforce-scene" data-enforce-scene>
        <svg className="enforce-svg"
             viewBox="0 0 1000 280"
             preserveAspectRatio="none"
             role="img"
             aria-hidden="true"
             data-enforce-svg>

          {/* faint lane: tool-call stream */}
          <line className="lane-rail" x1="0" y1="140" x2="1000" y2="140"/>
          <line className="lane-edge" x1="0" y1="60"  x2="1000" y2="60"/>
          <line className="lane-edge" x1="0" y1="220" x2="1000" y2="220"/>

          {/* left side label */}
          <text className="lane-label" x="14" y="42">tool calls · agent stream</text>
          <text className="lane-label dim" x="14" y="252">left = recent, right = executed</text>

          {/* boundary group */}
          <g data-boundary>
            <line className="boundary-line" x1="700" y1="20" x2="700" y2="260" data-boundary-line/>
            <text className="boundary-label top"    x="700" y="14" textAnchor="middle">main branch</text>
            <text className="boundary-label bottom" x="700" y="276" textAnchor="middle">production</text>
            <rect className="boundary-hit" x="688" y="0" width="24" height="280"
                  data-boundary-hit
                  tabIndex={0}
                  role="button"
                  aria-label="toggle enforcement mode"/>
          </g>

          {/* incidents counter, right of boundary */}
          <g className="incidents" data-incidents>
            <text className="incidents-label" x="720" y="42">incidents</text>
            <text className="incidents-count" x="720" y="64" data-incidents-count>0</text>
          </g>

          {/* pre-allocated dots: filled at runtime */}
          <g data-dot-layer></g>
        </svg>

        {/* hover tooltip */}
        <div className="enforce-tip" data-enforce-tip hidden></div>
      </div>

      <figcaption>
        <strong><em>Prose drifts. The hook does not.</em></strong>{" "}
        Toggle the rule. Watch what changes. Hover a dot to read the
        synthetic tool call. Hover the boundary to see the active rule.
      </figcaption>
    </figure>
  );
}
