"use client";
import { useEffect, useRef } from "react";

type SrcKey = "claude" | "codex" | "git";

type VocabItem = { p: string; l: () => string };

const VOCAB: Record<SrcKey, VocabItem[]> = {
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

const CHIP_WEIGHT: Record<SrcKey, { sessions: number; turns: number }> = {
  claude: { sessions: 12, turns: 4200 },
  codex: { sessions: 22, turns: 2900 },
  git: { sessions: 0, turns: 1100 },
};

const SRC_CADENCE: Record<SrcKey, { min: number; max: number }> = {
  claude: { min: 800, max: 1500 },
  codex: { min: 1100, max: 2000 },
  git: { min: 900, max: 1800 },
};

const FINAL = { sessions: 4773, turns: 369132, fts: 5.9 };

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

    const qp =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search)
        : null;
    const jumpFinal = qp?.get("final") === "1";

    const live = { sessions: 0, turns: 0, fts: 0 };

    function fmt(n: number) {
      if (n >= 1000) return n.toLocaleString("en-US");
      return String(n);
    }
    function paintCtrs() {
      if (ctrSessionsRef.current)
        ctrSessionsRef.current.textContent = fmt(live.sessions);
      if (ctrTurnsRef.current)
        ctrTurnsRef.current.textContent = fmt(live.turns);
      if (ctrFtsRef.current)
        ctrFtsRef.current.textContent = live.fts.toFixed(1);
    }

    function pickEvent(src: SrcKey) {
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
      (Object.keys(srcEls) as SrcKey[]).forEach((k) => {
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
      (["claude", "codex", "git"] as SrcKey[]).forEach((k) => {
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
      done: false,
      visible: false,
      emitted: 0,
      maxEmits: 26,
      timers: [] as Array<ReturnType<typeof setTimeout> | { clear: () => void }>,
    };

    function setPill(s: "playing" | "done" | "paused") {
      pill!.setAttribute("data-state", s);
      pill!.textContent =
        s === "playing"
          ? "auto · playing"
          : s === "done"
            ? "auto · done"
            : "auto · paused";
    }

    function emit(src: SrcKey) {
      if (state.paused || state.done) return;
      const a = anchors();
      const origin = a.src[src];
      const dest = a.sink;
      if (!origin || !dest) return;

      origin.el.classList.add("emit");
      setTimeout(() => origin.el.classList.remove("emit"), EMIT_FLASH_MS);

      const ev = pickEvent(src);
      const chip = document.createElement("div");
      chip.className = "event-chip";
      chip.setAttribute("data-src", src);
      chip.innerHTML =
        '<span class="lbl-prefix">' + ev.prefix + ":</span>" + ev.label;
      layer!.appendChild(chip);

      const startX = origin.x;
      const startY = origin.y;
      const endX = dest.x;
      const endY = dest.y;

      const cw = chip.offsetWidth;
      const ch = chip.offsetHeight;
      chip.style.transform =
        "translate3d(" +
        (startX + 4) +
        "px," +
        (startY - ch / 2) +
        "px,0)";
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
            (endX - cw - 6) +
            "px," +
            (endY - ch / 2) +
            "px,0)";
        });
      });

      setTimeout(() => {
        sink!.classList.add("absorb");
        setTimeout(() => sink!.classList.remove("absorb"), ABSORB_MS);

        const w = CHIP_WEIGHT[src];
        live.sessions = Math.min(
          FINAL.sessions,
          live.sessions + w.sessions + Math.floor(Math.random() * 8)
        );
        live.turns = Math.min(
          FINAL.turns,
          live.turns + w.turns + Math.floor(Math.random() * 900)
        );
        const jitter = (Math.random() - 0.5) * 1.4;
        if (live.fts === 0) live.fts = 9.2;
        live.fts = Math.max(
          4.1,
          Math.min(11.0, live.fts * 0.65 + (FINAL.fts + jitter) * 0.35)
        );
        paintCtrs();

        chip.style.transition = "opacity 200ms ease";
        chip.style.opacity = "0";
      }, travel + 20);

      setTimeout(() => {
        if (chip.parentNode) chip.parentNode.removeChild(chip);
      }, travel + 280);
    }

    function scheduleSource(src: SrcKey) {
      function loop() {
        if (state.paused || state.done) return;
        emit(src);
        state.emitted++;
        if (state.emitted >= state.maxEmits) {
          finish();
          return;
        }
        const w = SRC_CADENCE[src];
        const next = w.min + Math.random() * (w.max - w.min);
        const t = setTimeout(loop, next);
        state.timers.push(t);
      }
      const startDelay = 200 + Math.random() * 600;
      const t0 = setTimeout(loop, startDelay);
      state.timers.push(t0);
    }

    function play() {
      if (!state.paused || state.done) return;
      state.paused = false;
      setPill("playing");
      (["claude", "codex", "git"] as SrcKey[]).forEach(scheduleSource);
    }
    function pause() {
      state.paused = true;
      state.timers.forEach((t) => {
        if (typeof t === "number") clearTimeout(t);
      });
      state.timers = [];
      if (!state.done) setPill("paused");
    }
    function finish() {
      state.done = true;
      state.timers.forEach((t) => {
        if (typeof t === "number") clearTimeout(t);
      });
      state.timers = [];
      live.sessions = FINAL.sessions;
      live.turns = FINAL.turns;
      live.fts = FINAL.fts;
      paintCtrs();
      out!.classList.add("pulse");
      setTimeout(() => out!.classList.remove("pulse"), 700);
      setPill("done");
      const pulseT = setInterval(() => {
        if (!document.body.contains(out!)) {
          clearInterval(pulseT);
          return;
        }
        out!.classList.add("pulse");
        setTimeout(() => out!.classList.remove("pulse"), 700);
      }, 5200);
      state.timers.push({ clear: () => clearInterval(pulseT) });
    }

    function jumpToFinal() {
      live.sessions = FINAL.sessions;
      live.turns = FINAL.turns;
      live.fts = FINAL.fts;
      paintCtrs();
      state.done = true;
      setPill("done");
    }

    // bootstrap
    drawWires();
    paintCtrs();

    let io: IntersectionObserver | null = null;

    if (reduced || jumpFinal) {
      jumpToFinal();
    } else {
      io = new IntersectionObserver(
        (entries) => {
          entries.forEach((e) => {
            state.visible = e.isIntersecting;
            if (state.done) return;
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
      state.timers.forEach((t) => {
        if (typeof t === "number") clearTimeout(t);
        else if (t && typeof (t as { clear: () => void }).clear === "function") {
          (t as { clear: () => void }).clear();
        }
      });
      state.timers = [];
      // also clear any chip nodes left over
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
                    0
                  </span>{" "}
                  sessions &middot;{" "}
                  <span id="ctr-turns" ref={ctrTurnsRef}>
                    0
                  </span>{" "}
                  turns
                  <br />
                  FTS median{" "}
                  <span className="fts" id="ctr-fts" ref={ctrFtsRef}>
                    0.0
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
          <a href="/features">see /features for the schema &rarr;</a>
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
