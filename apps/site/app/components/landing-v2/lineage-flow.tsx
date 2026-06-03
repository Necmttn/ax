"use client";
import { useEffect, useRef } from "react";
import { Link } from "@tanstack/react-router";

// Wired, always-present sources. Subagents are NOT here - they are spawned
// transiently by claude/codex (see SUBAGENT_PARENTS + spawnSubagent).
type SrcKey = "claude" | "codex" | "git";
type ChipKey = SrcKey | "subagent";

const SRC_KEYS: SrcKey[] = ["claude", "codex", "git"];
const SUBAGENT_PARENTS: SrcKey[] = ["claude", "codex"];

type VocabItem = { p: string; l: () => string };

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] ?? arr[0]!;
}

const SUBAGENT_TYPES = [
  "Explore",
  "Plan",
  "codebase-locator",
  "general-purpose",
  "gsd-executor",
];

// What the graph sends BACK to the agents - concrete, applied improvements.
// This is the return leg that closes the feedback loop.
const INTERVENTION_VOCAB: VocabItem[] = [
  { p: "skill", l: () => pick(["+recall", "+retro", "+verify"]) },
  { p: "guidance", l: () => "test cmd → pnpm" },
  { p: "hook", l: () => pick(["pre_commit", "stop-gate"]) },
  { p: "fix", l: () => "npm → pnpm test" },
  { p: "ignore", l: () => pick(["dist/", ".generated/"]) },
  { p: "rule", l: () => "CLAUDE.md +1" },
  { p: "prune", l: () => "stale rule" },
];

const VOCAB: Record<ChipKey, VocabItem[]> = {
  claude: [
    {
      p: "turn",
      l: () => String(49200 + Math.floor(Math.random() * 120)) + ":user",
    },
    { p: "tool_call", l: () => "Bash" },
    { p: "tool_call", l: () => "Edit" },
    { p: "tool_call", l: () => "Task" },
    { p: "intent", l: () => "question" },
    { p: "intent", l: () => "correction" },
  ],
  codex: [
    { p: "codex", l: () => "exec_command" },
    { p: "codex", l: () => "write_stdin" },
    { p: "codex", l: () => "update_plan" },
    { p: "codex", l: () => "spawn_agent" },
  ],
  subagent: [
    { p: "dispatch", l: () => pick(SUBAGENT_TYPES) },
    {
      p: "loop",
      l: () =>
        pick([
          "plan → execute",
          "red → green → refactor",
          "find → verify",
          "discover → transform",
        ]),
    },
    { p: "parallel", l: () => "×" + String(2 + Math.floor(Math.random() * 5)) },
    { p: "subagent", l: () => pick(["stop", "return"]) },
  ],
  git: [
    {
      p: "commit",
      l: () => {
        const hex = "0123456789abcdef";
        let s = "";
        for (let i = 0; i < 7; i++) s += hex[Math.floor(Math.random() * 16)];
        return s;
      },
    },
    { p: "hook", l: () => "pre_tool_use" },
    { p: "hook", l: () => "post_tool_use" },
    { p: "hook", l: () => "stop" },
    { p: "hook", l: () => "subagent_stop" },
    {
      p: "file",
      l: () => {
        const paths = [
          "src/improve/lifecycle.ts",
          "src/ingest/transcripts.ts",
          "src/ingest/codex.ts",
          "schema/skills.surql",
          "src/cli/improve.ts",
          "docs/adr/0007-live-traces-as-progress-channel.md",
        ];
        return paths[Math.floor(Math.random() * paths.length)] ?? paths[0]!;
      },
    },
  ],
};

// Per-absorbed-event growth. Subagent loops run inside a session, so they add
// turns, not new sessions.
const CHIP_WEIGHT: Record<ChipKey, { sessions: number; turns: number }> = {
  claude: { sessions: 1, turns: 80 },
  codex: { sessions: 1, turns: 60 },
  subagent: { sessions: 0, turns: 45 },
  git: { sessions: 0, turns: 25 },
};

const SRC_CADENCE: Record<SrcKey, { min: number; max: number }> = {
  claude: { min: 800, max: 1500 },
  codex: { min: 1100, max: 2000 },
  git: { min: 900, max: 1800 },
};

// How often a parent spawns a transient subagent.
const SUBAGENT_SPAWN = { min: 3200, max: 6000 };

// Realistic current snapshot - counters START here and only climb. Also the
// static value shown under reduced-motion.
const BASELINE = { sessions: 4773, turns: 369132, fts: 5.9 };

const TRAVEL_MS_MIN = 620;
const TRAVEL_MS_MAX = 880;
const EMIT_FLASH_MS = 240;
const ABSORB_MS = 260;

export function LineageFlow() {
  const sectionRef = useRef<HTMLElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const wiresRef = useRef<SVGSVGElement | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const sinkRef = useRef<HTMLDivElement | null>(null);
  const outRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLSpanElement | null>(null);

  const srcClaudeRef = useRef<HTMLDivElement | null>(null);
  const srcCodexRef = useRef<HTMLDivElement | null>(null);
  const srcGitRef = useRef<HTMLDivElement | null>(null);

  const ctrSessionsRef = useRef<HTMLSpanElement | null>(null);
  const ctrTurnsRef = useRef<HTMLSpanElement | null>(null);
  const ctrFtsRef = useRef<HTMLSpanElement | null>(null);
  const ctrAppliedRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const section = sectionRef.current;
    const stage = stageRef.current;
    const grid = gridRef.current;
    const wires = wiresRef.current;
    const layer = layerRef.current;
    const sink = sinkRef.current;
    const out = outRef.current;
    const pill = pillRef.current;
    if (!section || !stage || !grid || !wires || !layer || !sink || !out || !pill) {
      return;
    }

    const srcEls: Record<SrcKey, HTMLDivElement | null> = {
      claude: srcClaudeRef.current,
      codex: srcCodexRef.current,
      git: srcGitRef.current,
    };
    if (!srcEls.claude || !srcEls.codex || !srcEls.git) return;

    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    // Counters seed at the realistic baseline and only ever go up.
    const live = { ...BASELINE };
    let applied = 128; // improvements applied back to the agents

    function paintApplied() {
      if (ctrAppliedRef.current) ctrAppliedRef.current.textContent = String(applied);
    }

    function fmt(n: number) {
      if (n >= 1000) return Math.floor(n).toLocaleString("en-US");
      return String(Math.floor(n));
    }
    function paintCtrs() {
      if (ctrSessionsRef.current)
        ctrSessionsRef.current.textContent = fmt(live.sessions);
      if (ctrTurnsRef.current)
        ctrTurnsRef.current.textContent = fmt(live.turns);
      if (ctrFtsRef.current)
        ctrFtsRef.current.textContent = live.fts.toFixed(1);
    }

    function pickEvent(src: ChipKey) {
      const pool = VOCAB[src];
      const item = pool[Math.floor(Math.random() * pool.length)] ?? pool[0]!;
      return { prefix: item.p, label: item.l() };
    }

    function rectIn(el: Element, parent: Element) {
      const r = el.getBoundingClientRect();
      const p = parent.getBoundingClientRect();
      return {
        left: r.left - p.left,
        top: r.top - p.top,
        right: r.right - p.left,
        bottom: r.bottom - p.top,
        width: r.width,
        height: r.height,
      };
    }

    function anchors() {
      const a: {
        src: Record<SrcKey, { x: number; y: number; el: HTMLElement }>;
        sink: { x: number; y: number; xCenter: number; xRight: number };
        out: { x: number; y: number };
      } = {
        src: {} as Record<SrcKey, { x: number; y: number; el: HTMLElement }>,
        sink: { x: 0, y: 0, xCenter: 0, xRight: 0 },
        out: { x: 0, y: 0 },
      };
      SRC_KEYS.forEach((k) => {
        const el = srcEls[k]!;
        const rb = rectIn(el, stage!);
        a.src[k] = { x: rb.right - 2, y: rb.top + rb.height / 2, el };
      });
      const sb = rectIn(sink!, stage!);
      a.sink = {
        x: sb.left + 6,
        y: sb.top + sb.height / 2,
        xCenter: sb.left + sb.width / 2,
        xRight: sb.right - 6,
      };
      const ob = rectIn(out!, stage!);
      a.out = { x: ob.left + 6, y: ob.top + ob.height / 2 };
      return a;
    }

    function drawWires() {
      const a = anchors();
      const gb = grid!.getBoundingClientRect();
      wires!.setAttribute("viewBox", "0 0 " + gb.width + " " + gb.height);
      wires!.setAttribute("width", String(gb.width));
      wires!.setAttribute("height", String(gb.height));
      const gridOffsetTop =
        grid!.getBoundingClientRect().top - stage!.getBoundingClientRect().top;
      const gridOffsetLeft =
        grid!.getBoundingClientRect().left - stage!.getBoundingClientRect().left;

      function P(x: number, y: number): [number, number] {
        return [x - gridOffsetLeft, y - gridOffsetTop];
      }
      let ps = "";
      SRC_KEYS.forEach((k) => {
        const s = P(a.src[k].x, a.src[k].y);
        const d = P(a.sink.x, a.sink.y);
        const midX = (s[0] + d[0]) / 2;
        ps +=
          "M" +
          s[0] +
          "," +
          s[1] +
          " C" +
          midX +
          "," +
          s[1] +
          " " +
          midX +
          "," +
          d[1] +
          " " +
          d[0] +
          "," +
          d[1] +
          " ";
      });
      const so = P(a.sink.xRight, a.sink.y);
      const od = P(a.out.x, a.out.y);
      const outWire =
        "M" + so[0] + "," + so[1] + " L" + od[0] + "," + od[1];

      wires!.innerHTML =
        '<path d="' +
        ps +
        '" />' +
        '<path class="out-wire" d="' +
        outWire +
        '" />';
    }

    const state = {
      paused: true,
      frozen: false,
      visible: false,
      timers: [] as Array<ReturnType<typeof setTimeout>>,
    };

    let outPulseId: ReturnType<typeof setInterval> | null = null;

    function setPill(s: "playing" | "paused") {
      pill!.setAttribute("data-state", s);
      pill!.textContent = s === "playing" ? "auto · playing" : "auto · paused";
    }

    // Fly one event chip from (startX,startY) to the sink, bump counters on
    // arrival. Used by both fixed sources and transient subagents.
    function travelChip(kind: ChipKey, startX: number, startY: number) {
      const a = anchors();
      const dest = a.sink;

      const ev = pickEvent(kind);
      const chip = document.createElement("div");
      chip.className = "event-chip";
      chip.setAttribute("data-src", kind);
      chip.innerHTML =
        '<span class="lbl-prefix">' + ev.prefix + ":</span>" + ev.label;
      layer!.appendChild(chip);

      const endX = dest.x;
      const endY = dest.y;

      const ch = chip.offsetHeight;
      // Anchor by the chip's LEFT edge at both ends so motion is always
      // source (left) -> graph (right), regardless of chip width.
      chip.style.transform =
        "translate3d(" + (startX + 4) + "px," + (startY - ch / 2) + "px,0)";
      chip.style.opacity = "0";

      const travel =
        TRAVEL_MS_MIN + Math.random() * (TRAVEL_MS_MAX - TRAVEL_MS_MIN);

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          chip.style.transition =
            "transform " +
            travel +
            "ms cubic-bezier(.55,.05,.35,1), opacity 240ms ease";
          chip.style.opacity = "1";
          chip.style.transform =
            "translate3d(" +
            (endX - 10) +
            "px," +
            (endY - ch / 2) +
            "px,0)";
        });
      });

      setTimeout(() => {
        sink!.classList.add("absorb");
        setTimeout(() => sink!.classList.remove("absorb"), ABSORB_MS);

        // Counters only climb - no ceiling.
        const w = CHIP_WEIGHT[kind];
        live.sessions += w.sessions + (Math.random() < 0.35 ? 1 : 0);
        live.turns += w.turns + Math.floor(Math.random() * 70);
        const jitter = (Math.random() - 0.5) * 1.4;
        live.fts = Math.max(
          4.1,
          Math.min(11.0, live.fts * 0.7 + (BASELINE.fts + jitter) * 0.3)
        );
        paintCtrs();

        chip.style.transition = "opacity 200ms ease";
        chip.style.opacity = "0";
      }, travel + 20);

      setTimeout(() => {
        if (chip.parentNode) chip.parentNode.removeChild(chip);
      }, travel + 280);
    }

    function emit(src: SrcKey) {
      if (state.paused || state.frozen) return;
      const a = anchors();
      const origin = a.src[src];
      if (!origin) return;
      origin.el.classList.add("emit");
      setTimeout(() => origin.el.classList.remove("emit"), EMIT_FLASH_MS);
      travelChip(src, origin.x, origin.y);
    }

    // A parent agent spawns a transient subagent: a small node pops in beside
    // the parent, fires a few loop events into the graph, then disappears.
    function spawnSubagent() {
      if (state.paused || state.frozen) return;
      const parent = pick(SUBAGENT_PARENTS);
      const a = anchors();
      const p = a.src[parent];
      if (!p) return;

      // flash the parent - it just spawned this loop
      p.el.classList.add("emit");
      setTimeout(() => p.el.classList.remove("emit"), EMIT_FLASH_MS);

      const popX = p.x + 14;
      const popY = p.y + 24;

      const pop = document.createElement("div");
      pop.className = "subagent-pop";
      pop.setAttribute("data-parent", parent);
      pop.innerHTML =
        '<span class="sa-dot"></span>subagent · ' + pick(SUBAGENT_TYPES);
      layer!.appendChild(pop);
      pop.style.transform =
        "translate3d(" + popX + "px," + popY + "px,0) scale(.6)";
      pop.style.opacity = "0";

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          pop.style.transition = "transform 220ms ease, opacity 220ms ease";
          pop.style.opacity = "1";
          pop.style.transform =
            "translate3d(" + popX + "px," + popY + "px,0) scale(1)";
        });
      });

      // emit loop chips from the pop's LEFT edge so they travel toward the
      // graph (right), not back over the parent.
      const fromX = popX + 6;
      const fromY = popY + 9;

      // fire 2–3 loop chips from the pop toward the sink
      const bursts = 2 + Math.floor(Math.random() * 2);
      for (let i = 0; i < bursts; i++) {
        setTimeout(() => {
          if (state.paused || state.frozen) return;
          travelChip("subagent", fromX, fromY);
        }, 260 + i * 360);
      }

      const life = 360 + bursts * 360 + 500;
      setTimeout(() => {
        pop.style.transition = "transform 240ms ease, opacity 240ms ease";
        pop.style.opacity = "0";
        pop.style.transform =
          "translate3d(" + popX + "px," + popY + "px,0) scale(.6)";
      }, life);
      setTimeout(() => {
        if (pop.parentNode) pop.parentNode.removeChild(pop);
      }, life + 280);
    }

    function scheduleSource(src: SrcKey) {
      function loop() {
        if (state.paused || state.frozen) return;
        emit(src);
        const w = SRC_CADENCE[src];
        const next = w.min + Math.random() * (w.max - w.min);
        const t = setTimeout(loop, next);
        state.timers.push(t);
      }
      const startDelay = 200 + Math.random() * 600;
      const t0 = setTimeout(loop, startDelay);
      state.timers.push(t0);
    }

    function scheduleSubagents() {
      function loop() {
        if (state.paused || state.frozen) return;
        spawnSubagent();
        const next =
          SUBAGENT_SPAWN.min +
          Math.random() * (SUBAGENT_SPAWN.max - SUBAGENT_SPAWN.min);
        const t = setTimeout(loop, next);
        state.timers.push(t);
      }
      const t0 = setTimeout(loop, 1600 + Math.random() * 1800);
      state.timers.push(t0);
    }

    // The return leg: an applied improvement flies from the interventions node
    // back to one of the agents, which flashes - it just got better.
    function emitImprovement() {
      if (state.paused || state.frozen) return;
      const a = anchors();
      const target = pick(SRC_KEYS);
      const tgt = a.src[target];
      if (!tgt) return;

      out!.classList.add("pulse");
      setTimeout(() => out!.classList.remove("pulse"), 700);

      const item = pick(INTERVENTION_VOCAB);
      const chip = document.createElement("div");
      chip.className = "improve-chip";
      chip.innerHTML =
        '<span class="lbl-prefix">' + item.p + ":</span>" + item.l();
      layer!.appendChild(chip);

      const ch = chip.offsetHeight;
      const startX = a.out.x; // interventions, far right
      const startY = a.out.y;
      const endX = tgt.x - 40; // land on the agent, far left
      const endY = tgt.y;

      chip.style.transform =
        "translate3d(" + (startX + 4) + "px," + (startY - ch / 2) + "px,0)";
      chip.style.opacity = "0";

      const travel = 720 + Math.random() * 220;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          chip.style.transition =
            "transform " +
            travel +
            "ms cubic-bezier(.55,.05,.35,1), opacity 240ms ease";
          chip.style.opacity = "1";
          chip.style.transform =
            "translate3d(" + endX + "px," + (endY - ch / 2) + "px,0)";
        });
      });

      setTimeout(() => {
        tgt.el.classList.add("improved");
        setTimeout(() => tgt.el.classList.remove("improved"), 760);
        applied += 1;
        paintApplied();
        chip.style.transition = "opacity 220ms ease";
        chip.style.opacity = "0";
      }, travel + 20);

      setTimeout(() => {
        if (chip.parentNode) chip.parentNode.removeChild(chip);
      }, travel + 320);
    }

    function scheduleImprovements() {
      function loop() {
        if (state.paused || state.frozen) return;
        emitImprovement();
        const next = 3800 + Math.random() * 3200;
        const t = setTimeout(loop, next);
        state.timers.push(t);
      }
      const t0 = setTimeout(loop, 2600 + Math.random() * 1600);
      state.timers.push(t0);
    }

    function clearTimers() {
      state.timers.forEach((t) => clearTimeout(t));
      state.timers = [];
    }

    function startOutPulse() {
      if (outPulseId != null) return;
      outPulseId = setInterval(() => {
        if (!document.body.contains(out!)) return;
        out!.classList.add("pulse");
        setTimeout(() => out!.classList.remove("pulse"), 700);
      }, 4200);
    }
    function stopOutPulse() {
      if (outPulseId != null) {
        clearInterval(outPulseId);
        outPulseId = null;
      }
    }

    function play() {
      if (!state.paused || state.frozen) return;
      state.paused = false;
      setPill("playing");
      startOutPulse();
      SRC_KEYS.forEach(scheduleSource);
      scheduleSubagents();
      scheduleImprovements();
    }
    function pause() {
      state.paused = true;
      clearTimers();
      stopOutPulse();
      if (!state.frozen) setPill("paused");
    }

    // Reduced-motion: show a static realistic snapshot, never animate.
    function freezeStatic() {
      live.sessions = BASELINE.sessions;
      live.turns = BASELINE.turns;
      live.fts = BASELINE.fts;
      paintCtrs();
      state.frozen = true;
      setPill("paused");
    }

    // bootstrap
    drawWires();
    paintCtrs();
    paintApplied();

    let io: IntersectionObserver | null = null;

    if (reduced) {
      freezeStatic();
    } else {
      io = new IntersectionObserver(
        (entries) => {
          entries.forEach((e) => {
            state.visible = e.isIntersecting;
            if (e.isIntersecting) play();
            else pause();
          });
        },
        { threshold: 0.35 }
      );
      io.observe(section);
    }

    let rzT: ReturnType<typeof setTimeout> | null = null;
    function onResize() {
      if (rzT) clearTimeout(rzT);
      rzT = setTimeout(drawWires, 80);
    }
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      if (rzT) clearTimeout(rzT);
      try {
        io?.disconnect();
      } catch {
        /* noop */
      }
      clearTimers();
      stopOutPulse();
      // also clear any chip / pop nodes left over
      if (layer) layer.innerHTML = "";
    };
  }, []);

  return (
    <section className="lineage" id="lineage" ref={sectionRef}>
      <div className="lineage-wrap">
        <div className="lineage-head">
          <p className="lineage-cap">
            <b>the pipeline</b> <span className="dim">·</span> what feeds the
            graph
          </p>
          <span
            className="auto-pill"
            id="autoPill"
            data-state="paused"
            ref={pillRef}
          >
            auto · paused
          </span>
        </div>

        <div className="lineage-stage" id="stage" ref={stageRef}>
          <div className="lineage-grid" id="grid" ref={gridRef}>
            {/* sources column */}
            <div className="sources">
              <div
                className="src-box"
                data-src="claude"
                id="src-claude"
                ref={srcClaudeRef}
              >
                <div className="src-title">claude transcripts</div>
                <div className="src-sub">~/.claude/projects</div>
              </div>
              <div
                className="src-box"
                data-src="codex"
                id="src-codex"
                ref={srcCodexRef}
              >
                <div className="src-title">codex sessions</div>
                <div className="src-sub">~/.codex/sessions</div>
              </div>
              <div
                className="src-box"
                data-src="git"
                id="src-git"
                ref={srcGitRef}
              >
                <div className="src-title">git + hook fires</div>
                <div className="src-sub">repo + ~/.claude/hooks</div>
              </div>
            </div>

            {/* spacer column 1 */}
            <div></div>

            {/* sink column */}
            <div className="sink-col">
              <div className="sink-box" id="sink" ref={sinkRef}>
                <div className="sink-title">typed local graph</div>
                <div className="sink-host">surrealdb · 127.0.0.1</div>
                <div className="sink-counter">
                  <span id="ctr-sessions" ref={ctrSessionsRef}>
                    4,773
                  </span>{" "}
                  sessions &middot;{" "}
                  <span id="ctr-turns" ref={ctrTurnsRef}>
                    369,132
                  </span>{" "}
                  turns
                  <br />
                  FTS median{" "}
                  <span className="fts" id="ctr-fts" ref={ctrFtsRef}>
                    5.9
                  </span>
                  ms
                </div>
              </div>
            </div>

            {/* spacer column 2 */}
            <div></div>

            {/* output column */}
            <div className="out-col">
              <div className="out-box" id="out" ref={outRef}>
                interventions
                <span className="out-sub">
                  ranked · safety-contracted · brief-only
                </span>
                <span className="out-applied">
                  <b ref={ctrAppliedRef}>128</b> applied &rarr; agents
                </span>
              </div>
            </div>

            {/* connector wires */}
            <svg
              className="wires"
              id="wires"
              preserveAspectRatio="none"
              aria-hidden="true"
              ref={wiresRef}
            ></svg>
          </div>

          {/* chip travel layer */}
          <div
            className="chip-layer"
            id="chipLayer"
            aria-hidden="true"
            ref={layerRef}
          ></div>
        </div>

        <p className="lineage-foot">
          every event &rarr; typed graph &rarr; ranked interventions. local
          SurrealDB at <code>127.0.0.1</code>.{" "}
          <Link to="/features">see /features for the schema &rarr;</Link>
          <span className="forms">
            six forms: <b>skill</b> &middot; <b>guidance</b> &middot;{" "}
            <b>subagent</b> &middot; <b>hook</b> &middot; <b>automation</b>{" "}
            &middot; <b>harness_check</b>
          </span>
        </p>
      </div>
    </section>
  );
}
