"use client";
import { useEffect, useRef } from "react";

export function ChangeSection() {
  return (
    <section id="change">
      <p className="eyebrow">from notice to change.</p>
      <h2>You curate. Claude executes. ax remembers.</h2>
      <p>
        The graph cuts both ways. After a session ends, the subagent
        emits a retro and ranks interventions against past failures.
        When a session ships clean, you can ask the agent to replay it
        &mdash; the graph hands back the takeaways, and a skill gets
        synthesized so the next refactor lands the same way. Both
        flows wrap every edit in a marker. The verdict locks at +30 sessions.
      </p>

      <div className="fig-shell">
        <TerminalFigure />
      </div>

      <p>
        <a className="fig-link" href="https://github.com/Necmttn/ax/blob/main/README.md#grounded-agent-files" target="_blank" rel="noopener noreferrer">
          read: grounded agent files reference <span className="arr">→</span>
        </a>
      </p>
    </section>
  );
}

export function TerminalFigure() {
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const pill    = root.querySelector<HTMLElement>("[data-term-pill]");
    const pillLbl = root.querySelector<HTMLElement>("[data-term-label]");
    const resetBt = root.querySelector<HTMLElement>("[data-term-reset]");
    const panes   = Array.from(root.querySelectorAll<HTMLElement>("[data-term]"));
    const tabs    = Array.from(root.querySelectorAll<HTMLElement>(".term-tab"));

    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let userTookOver = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    function activePane(): HTMLElement | null {
      return root.querySelector(".term-pane[data-active]");
    }

    function setPill(state: string) {
      if (!pill) return;
      pill.setAttribute("data-state", state);
      const map: Record<string, string> = {
        playing: "auto · playing",
        manual:  "manual",
        done:    "auto · done",
        reduce:  "motion paused",
      };
      if (pillLbl) pillLbl.textContent = map[state] ?? "auto · idle";
    }

    function clearTimers() {
      timers.forEach((id) => clearTimeout(id));
      timers.length = 0;
    }

    function resetPane(pane: HTMLElement | null) {
      if (!pane) return;
      pane.querySelectorAll(".term-line").forEach((ln) => ln.classList.remove("is-visible"));
    }

    function showAllInPane(pane: HTMLElement | null) {
      if (!pane) return;
      pane.querySelectorAll(".term-line").forEach((ln) => ln.classList.add("is-visible"));
    }

    function streamPane(pane: HTMLElement, onDone?: () => void) {
      const lines = Array.from(pane.querySelectorAll<HTMLElement>(".term-line"));
      let t = 0;
      lines.forEach((ln, idx) => {
        const delay = parseInt(ln.getAttribute("data-delay") ?? "300", 10);
        t += delay;
        const id = setTimeout(() => {
          if (userTookOver) return;
          if (!pane.hasAttribute("data-active")) return;
          ln.classList.add("is-visible");
          if (idx === lines.length - 1 && onDone) onDone();
        }, t);
        timers.push(id);
      });
    }

    function runSequence() {
      if (userTookOver || reduce) return;
      setPill("playing");
      const pane = activePane();
      if (!pane) return;
      streamPane(pane, () => {
        if (!userTookOver) setPill("done");
      });
    }

    function switchTo(name: string) {
      clearTimers();
      userTookOver = false;
      tabs.forEach((t) => {
        const active = t.getAttribute("data-tab") === name;
        if (active) {
          t.setAttribute("data-active", "");
          t.setAttribute("aria-selected", "true");
        } else {
          t.removeAttribute("data-active");
          t.setAttribute("aria-selected", "false");
        }
      });
      panes.forEach((p) => {
        const active = p.getAttribute("data-term") === name;
        if (active) {
          p.setAttribute("data-active", "");
          p.removeAttribute("hidden");
          resetPane(p);
        } else {
          p.removeAttribute("data-active");
          p.setAttribute("hidden", "");
        }
      });
      if (reduce) {
        showAllInPane(activePane());
        setPill("reduce");
        return;
      }
      setPill("idle");
      runSequence();
    }

    function takeover() {
      if (userTookOver) return;
      userTookOver = true;
      clearTimers();
      showAllInPane(activePane());
      setPill("manual");
    }

    tabs.forEach((t) => {
      t.addEventListener("click", () => {
        const name = t.getAttribute("data-tab");
        if (name) switchTo(name);
      });
    });

    if (resetBt) {
      resetBt.addEventListener("click", () => {
        userTookOver = false;
        resetPane(activePane());
        setPill("idle");
        runSequence();
      });
    }

    root.addEventListener("click", (e) => {
      if ((e.target as Element).closest("[data-term-reset]")) return;
      if ((e.target as Element).closest("[data-term-pill]")) return;
      if ((e.target as Element).closest(".term-tab")) return;
      takeover();
    });

    if (pill) {
      pill.addEventListener("click", () => {
        if (pill.getAttribute("data-state") === "playing") {
          takeover();
        } else {
          userTookOver = false;
          resetPane(activePane());
          setPill("idle");
          runSequence();
        }
      });
    }

    let io: IntersectionObserver | null = null;
    if (reduce) {
      showAllInPane(activePane());
      setPill("reduce");
    } else if ("IntersectionObserver" in window) {
      io = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !userTookOver) {
            io?.disconnect();
            io = null;
            runSequence();
          }
        });
      }, { threshold: 0.35 });
      io.observe(root);
      setPill("idle");
    } else {
      runSequence();
      setPill("idle");
    }

    return () => {
      clearTimers();
      io?.disconnect();
    };
  }, []);

  return (
    <figure className="fig-terminal" aria-label="Two mock terminal sessions showing the same flow in Claude Code and Codex" ref={rootRef}>
      <div className="fig-head">
        <span className="fig-id">Session</span>
        <span>claude code · codex · same flow</span>
        <button type="button" className="auto-pill" data-term-pill data-state="idle" aria-label="autoplay status">
          <span className="auto-dot" aria-hidden="true"></span>
          <span className="auto-label" data-term-label>auto · idle</span>
        </button>
        <button type="button" className="reset" data-term-reset aria-label="reset terminals">reset</button>
      </div>

      <div className="term-frame term-tabbed">
        <div className="term-chrome">
          <span className="term-dot term-dot-r"></span>
          <span className="term-dot term-dot-y"></span>
          <span className="term-dot term-dot-g"></span>
          <div className="term-tabs" role="tablist">
            <button className="term-tab term-tab-claude" data-tab="claude" data-active aria-selected="true" role="tab" type="button">retro · claude</button>
            <button className="term-tab term-tab-codex" data-tab="codex" aria-selected="false" role="tab" type="button">retro · codex</button>
            <button className="term-tab term-tab-claude" data-tab="workflow" aria-selected="false" role="tab" type="button">workflow synth</button>
          </div>
        </div>

        {/* Claude pane */}
        <div className="term-pane term-claude" data-term="claude" data-active role="tabpanel" aria-label="Claude Code session">
          <div className="term-banner" aria-hidden="true">
            <pre className="term-logo claude-logo"> ▐<span className="cc-fill">▛███▜</span>▌    <span className="cc-name">Claude Code</span>  <span className="cc-meta">v2.1.153</span>{"\n"}▝<span className="cc-fill">▜█████</span>▛▘   <span className="cc-meta">Opus 4.7 · high effort</span>{"\n"}   ▘▘  ▝▝   <span className="cc-meta">~/Projects/ax</span></pre>
            <div className="term-rule"></div>
          </div>
          <div className="term-body" data-term-body>
            <div className="term-line" data-step="say"    data-delay="200"><span className="t-sys">[ session 4129 wrapping — stop hook fires ]</span></div>
            <div className="term-line" data-step="tool"   data-delay="800">  <span className="t-bullet">⏺</span> Bash(<span className="t-cmd">axctl retro emit --session=4129</span>)</div>
            <div className="term-line" data-step="out"    data-delay="500">    <span className="t-arm">⎿</span>  tried=8 · worked=6 · failed=3 · next=2</div>
            <div className="term-line" data-step="out"    data-delay="180">       failed: <span className="t-err">2 fixes landed after feature in src/ingest/transcripts.ts</span></div>
            <div className="term-line" data-step="out"    data-delay="180">       failed: <span className="t-err">main-branch edit attempted (advisory ignored)</span></div>
            <div className="term-line" data-step="tool"   data-delay="900">  <span className="t-bullet">⏺</span> Task(<span className="t-cmd">reflect-session-4129</span>)</div>
            <div className="term-line" data-step="out"    data-delay="500">    <span className="t-arm">⎿</span>  subagent clustering retros + skill_candidate evidence…</div>
            <div className="term-line" data-step="tool"   data-delay="800">  <span className="t-bullet">⏺</span> Bash(<span className="t-cmd">axctl retro reflect --since=7d</span>)</div>
            <div className="term-line" data-step="out"    data-delay="500">    <span className="t-arm">⎿</span>  3 proposals ranked:</div>
            <div className="term-line" data-step="out"    data-delay="180">       1. feature→fix chains, same file <span className="t-num">26x</span>  <span className="t-arrow">→</span> <span className="t-id">post-feature-verify</span>      <span className="t-num">hi</span></div>
            <div className="term-line" data-step="out"    data-delay="180">       2. main-branch edits, advisory only <span className="t-num">7x</span> <span className="t-arrow">→</span> <span className="t-id">main-branch-guardrail</span>    <span className="t-num">lo</span></div>
            <div className="term-line" data-step="out"    data-delay="180">       3. ingest regressions, same file <span className="t-num">3x</span>   <span className="t-arrow">→</span> <span className="t-id">ingest-regression</span>          <span className="t-num">hi</span></div>
            <div className="term-line" data-step="say"    data-delay="900">  Top: <span className="t-id">post-feature-verify</span> - 26 fix-chains in 7d. Accept?</div>
            <div className="term-line" data-step="prompt" data-delay="1100"><span className="t-prompt">❯</span> y</div>
            <div className="term-line" data-step="tool"   data-delay="700">  <span className="t-bullet">⏺</span> Bash(<span className="t-cmd">axctl improve accept skill__508c34566d2f1d85 --with-agent</span>)</div>
            <div className="term-line" data-step="out"    data-delay="500">    <span className="t-arm">⎿</span>  scaffolded ~/.claude/skills/post-feature-verify/</div>
            <div className="term-line" data-step="out"    data-delay="350">       spawning claude subagent…</div>
            <div className="term-line" data-step="tool"   data-delay="700">  <span className="t-bullet">⏺</span> Edit(<span className="t-file">~/.claude/skills/post-feature-verify/SKILL.md</span>)</div>
            <div className="term-line t-diff" data-step="out" data-delay="450">    <span className="t-arm">⎿</span>  <span className="t-diff-meta">+18 -0 lines</span></div>
            <div className="term-line t-diff" data-step="out" data-delay="140">       <span className="t-add">+ &lt;!--ax:skill-508c34566d2f--&gt;</span></div>
            <div className="term-line t-diff" data-step="out" data-delay="120">       <span className="t-add">+ ---</span></div>
            <div className="term-line t-diff" data-step="out" data-delay="120">       <span className="t-add">+ name: post-feature-verify</span></div>
            <div className="term-line t-diff" data-step="out" data-delay="120">       <span className="t-add">+ description: query fix-chain history before closure</span></div>
            <div className="term-line t-diff" data-step="out" data-delay="120">       <span className="t-add">+ trigger: feature commits followed by overlapping fixes</span></div>
            <div className="term-line t-diff" data-step="out" data-delay="120">       <span className="t-add">+ ---</span></div>
            <div className="term-line t-diff" data-step="out" data-delay="120">       <span className="t-add">+ &lt;!--/ax:skill-508c34566d2f--&gt;</span></div>
            <div className="term-line" data-step="out"    data-delay="350"><span className="t-ok">       marker landed</span> · verdict pending at +30 sessions</div>
            <div className="term-line" data-step="say"    data-delay="800">  Done. Next session opens with the +3-session checkpoint.</div>
          </div>
          <div className="term-input claude-input" aria-hidden="true">
            <div className="term-rule"></div>
            <div className="term-input-row">
              <span className="t-prompt">❯</span><span className="t-placeholder">  Try &quot;use the ax marker for new skills&quot;</span>
            </div>
            <div className="term-rule"></div>
          </div>
          <div className="term-statusbar claude-status" aria-hidden="true">
            <span className="cs-mode">⏵⏵ auto mode on</span>
            <span className="cs-sep">·</span>
            <span className="cs-hint">shift+tab to cycle</span>
            <span className="cs-sep">·</span>
            <span className="cs-effort"><span className="cs-dot"></span> high</span>
          </div>
        </div>

        {/* Codex pane */}
        <div className="term-pane term-codex" data-term="codex" role="tabpanel" aria-label="Codex CLI session" hidden>
          <div className="term-banner" aria-hidden="true">
            <pre className="term-logo codex-logo"><span className="cx-spark">✨</span> <span className="cx-name">OpenAI Codex</span> <span className="cx-meta">v0.133.0</span>{"\n"}   <span className="cx-meta">gpt-5-codex · ~/Projects/ax</span></pre>
            <div className="term-rule"></div>
          </div>
          <div className="term-body" data-term-body>
            <div className="term-line" data-step="say"    data-delay="200"><span className="t-sys">[ session 4129 ending - auto retro ]</span></div>
            <div className="term-line" data-step="say"    data-delay="800"><span className="t-cx-cdx">codex</span><span className="t-cx-msg"> emitting retro on session end</span></div>
            <div className="term-line" data-step="tool"   data-delay="500">  <span className="t-shell">$</span> <span className="t-cmd">axctl retro emit --session=4129</span></div>
            <div className="term-line" data-step="out"    data-delay="500">  <span className="t-arrow">›</span> tried=8 · worked=6 · failed=3 · next=2</div>
            <div className="term-line" data-step="out"    data-delay="180">    failed: <span className="t-err">2 fixes landed after feature in src/ingest/transcripts.ts</span></div>
            <div className="term-line" data-step="out"    data-delay="180">    failed: <span className="t-err">main-branch edit attempted (advisory ignored)</span></div>
            <div className="term-line" data-step="say"    data-delay="900"><span className="t-cx-cdx">codex</span><span className="t-cx-msg"> subagent clustering retros + skill_candidate evidence…</span></div>
            <div className="term-line" data-step="tool"   data-delay="700">  <span className="t-shell">$</span> <span className="t-cmd">axctl retro reflect --since=7d</span></div>
            <div className="term-line" data-step="out"    data-delay="500">  <span className="t-arrow">›</span> 3 proposals ranked:</div>
            <div className="term-line" data-step="out"    data-delay="180">    1. feature→fix chains, same file <span className="t-num">26x</span>  <span className="t-arrow">→</span> <span className="t-id">post-feature-verify</span>      <span className="t-num">hi</span></div>
            <div className="term-line" data-step="out"    data-delay="180">    2. main-branch edits, advisory only <span className="t-num">7x</span> <span className="t-arrow">→</span> <span className="t-id">main-branch-guardrail</span>    <span className="t-num">lo</span></div>
            <div className="term-line" data-step="out"    data-delay="180">    3. ingest regressions, same file <span className="t-num">3x</span>   <span className="t-arrow">→</span> <span className="t-id">ingest-regression</span>          <span className="t-num">hi</span></div>
            <div className="term-line" data-step="say"    data-delay="900"><span className="t-cx-cdx">codex</span><span className="t-cx-msg"> top: post-feature-verify - 26 fix-chains in 7d. accept?</span></div>
            <div className="term-line" data-step="prompt" data-delay="1100"><span className="t-cx-user">user</span><span className="t-cx-msg"> y</span></div>
            <div className="term-line" data-step="tool"   data-delay="700">  <span className="t-shell">$</span> <span className="t-cmd">axctl improve accept skill__508c34566d2f1d85 --with-agent</span></div>
            <div className="term-line" data-step="out"    data-delay="500">  <span className="t-arrow">›</span> scaffolded · spawning claude subagent</div>
            <div className="term-line" data-step="tool"   data-delay="600">  <span className="t-edit">✎ edit</span> <span className="t-file">SKILL.md</span> <span className="t-diff-meta">(+18 -0)</span></div>
            <div className="term-line t-diff" data-step="out" data-delay="140">    <span className="t-add">+ &lt;!--ax:skill-508c34566d2f--&gt;</span></div>
            <div className="term-line t-diff" data-step="out" data-delay="120">    <span className="t-add">+ ---</span></div>
            <div className="term-line t-diff" data-step="out" data-delay="120">    <span className="t-add">+ name: post-feature-verify</span></div>
            <div className="term-line t-diff" data-step="out" data-delay="120">    <span className="t-add">+ description: query fix-chain history before closure</span></div>
            <div className="term-line t-diff" data-step="out" data-delay="120">    <span className="t-add">+ trigger: feature commits followed by overlapping fixes</span></div>
            <div className="term-line t-diff" data-step="out" data-delay="120">    <span className="t-add">+ ---</span></div>
            <div className="term-line t-diff" data-step="out" data-delay="120">    <span className="t-add">+ &lt;!--/ax:skill-508c34566d2f--&gt;</span></div>
            <div className="term-line" data-step="out"    data-delay="220"><span className="t-ok">  › marker landed</span> · verdict pending at +30 sessions</div>
            <div className="term-line" data-step="say"    data-delay="800"><span className="t-cx-cdx">codex</span><span className="t-cx-msg"> done. verdict locks at +30 sessions.</span></div>
          </div>
          <div className="term-input codex-input" aria-hidden="true">
            <div className="cx-input-box">
              <span className="t-prompt">❯</span><span className="t-placeholder">  ask codex anything…</span>
            </div>
          </div>
          <div className="term-statusbar codex-status" aria-hidden="true">
            <span className="cs-mode">⏎ send</span>
            <span className="cs-sep">·</span>
            <span className="cs-hint">ctrl+c to quit</span>
            <span className="cs-sep">·</span>
            <span className="cs-effort"><span className="cs-dot cx"></span> sandbox</span>
          </div>
        </div>

        {/* Workflow synth pane */}
        <div className="term-pane term-claude" data-term="workflow" role="tabpanel" aria-label="Workflow synthesis from a clean session" hidden>
          <div className="term-banner" aria-hidden="true">
            <pre className="term-logo claude-logo"> ▐<span className="cc-fill">▛███▜</span>▌    <span className="cc-name">Claude Code</span>  <span className="cc-meta">v2.1.153</span>{"\n"}▝<span className="cc-fill">▜█████</span>▛▘   <span className="cc-meta">Opus 4.7 · high effort</span>{"\n"}   ▘▘  ▝▝   <span className="cc-meta">~/Projects/ax</span></pre>
            <div className="term-rule"></div>
          </div>
          <div className="term-body" data-term-body>
            <div className="term-line" data-step="prompt" data-delay="200"><span className="t-prompt">❯</span> build a workflow from how I shipped the live-traces vendoring last week - that was clean</div>
            <div className="term-line" data-step="say"    data-delay="900">  Looking up that session in your ax graph.</div>
            <div className="term-line" data-step="tool"   data-delay="700">  <span className="t-bullet">⏺</span> Bash(<span className="t-cmd">axctl insights sessions --query=&quot;live-traces vendoring&quot; --limit=1</span>)</div>
            <div className="term-line" data-step="out"    data-delay="500">    <span className="t-arm">⎿</span>  session <span className="t-id">0e9c5a1</span> · 2026-05-21 · live-traces vendored into ax</div>
            <div className="term-line" data-step="out"    data-delay="180">       turns=38 · tool_calls=104 · failures=<span className="t-num">0</span> · corrections=<span className="t-num">0</span></div>
            <div className="term-line" data-step="out"    data-delay="180">       closure: <span className="t-ok">feature_only</span> (no fixes in 7d)</div>
            <div className="term-line" data-step="out"    data-delay="180">       produced: 1 PR · 8 commits · 12 files touched</div>
            <div className="term-line" data-step="tool"   data-delay="800">  <span className="t-bullet">⏺</span> Bash(<span className="t-cmd">axctl recall --session=0e9c5a1 --top=5</span>)</div>
            <div className="term-line" data-step="out"    data-delay="500">    <span className="t-arm">⎿</span>  takeaways:</div>
            <div className="term-line" data-step="out"    data-delay="180">       <span className="t-arrow">•</span> plan-mode opened the session (12 turns before first edit)</div>
            <div className="term-line" data-step="out"    data-delay="180">       <span className="t-arrow">•</span> TDD applied: tests authored before each .ts module landed</div>
            <div className="term-line" data-step="out"    data-delay="180">       <span className="t-arrow">•</span> verify-before-commit fired <span className="t-num">8x</span> (build + typecheck per commit)</div>
            <div className="term-line" data-step="out"    data-delay="180">       <span className="t-arrow">•</span> narrow-pr-scope kept each commit &lt; 200 LOC</div>
            <div className="term-line" data-step="out"    data-delay="180">       <span className="t-arrow">•</span> zero rollbacks in 7d post-merge</div>
            <div className="term-line" data-step="tool"   data-delay="800">  <span className="t-bullet">⏺</span> Bash(<span className="t-cmd">axctl skills pairs superpowers:writing-plans --since=session=0e9c5a1</span>)</div>
            <div className="term-line" data-step="out"    data-delay="500">    <span className="t-arm">⎿</span>  3 strong pairs from that session:</div>
            <div className="term-line" data-step="out"    data-delay="180">       1. writing-plans <span className="t-arrow">→</span> test-driven-development     <span className="t-num">12x</span> in-session</div>
            <div className="term-line" data-step="out"    data-delay="180">       2. test-driven <span className="t-arrow">→</span> verification-before-completion <span className="t-num">8x</span>  in-session</div>
            <div className="term-line" data-step="out"    data-delay="180">       3. verification <span className="t-arrow">→</span> narrow-pr-scope                <span className="t-num">3x</span>  in-session</div>
            <div className="term-line" data-step="say"    data-delay="900">  Synthesize into a workflow skill?</div>
            <div className="term-line" data-step="prompt" data-delay="1200"><span className="t-prompt">❯</span> yes, name it <span className="t-id">clean-feature-ship</span></div>
            <div className="term-line" data-step="tool"   data-delay="700">  <span className="t-bullet">⏺</span> Task(<span className="t-cmd">synth-workflow-from-0e9c5a1</span>)</div>
            <div className="term-line" data-step="out"    data-delay="500">    <span className="t-arm">⎿</span>  subagent reading session evidence + skill_candidate links…</div>
            <div className="term-line" data-step="tool"   data-delay="700">  <span className="t-bullet">⏺</span> Edit(<span className="t-file">~/.claude/skills/clean-feature-ship/SKILL.md</span>)</div>
            <div className="term-line t-diff" data-step="out" data-delay="450">    <span className="t-arm">⎿</span>  <span className="t-diff-meta">+28 -0 lines</span></div>
            <div className="term-line t-diff" data-step="out" data-delay="140">       <span className="t-add">+ &lt;!--ax:workflow-0e9c5a1--&gt;</span></div>
            <div className="term-line t-diff" data-step="out" data-delay="120">       <span className="t-add">+ ---</span></div>
            <div className="term-line t-diff" data-step="out" data-delay="120">       <span className="t-add">+ name: clean-feature-ship</span></div>
            <div className="term-line t-diff" data-step="out" data-delay="120">       <span className="t-add">+ description: replays session 0e9c5a1 - closure==feature_only, 0 rollbacks</span></div>
            <div className="term-line t-diff" data-step="out" data-delay="120">       <span className="t-add">+ source: session 0e9c5a1 · 8 commits · 7d post-merge clean</span></div>
            <div className="term-line t-diff" data-step="out" data-delay="120">       <span className="t-add">+ phases: plan → tdd → verify-commit → narrow-pr</span></div>
            <div className="term-line t-diff" data-step="out" data-delay="120">       <span className="t-add">+ ---</span></div>
            <div className="term-line t-diff" data-step="out" data-delay="120">       <span className="t-add">+ &lt;!--/ax:workflow-0e9c5a1--&gt;</span></div>
            <div className="term-line" data-step="out"    data-delay="350"><span className="t-ok">       marker landed</span> · workflow synthesized</div>
            <div className="term-line" data-step="say"    data-delay="800">  Done. Invoke with <code>/workflow clean-feature-ship</code> before the next refactor.</div>
          </div>
          <div className="term-input claude-input" aria-hidden="true">
            <div className="term-rule"></div>
            <div className="term-input-row">
              <span className="t-prompt">❯</span><span className="t-placeholder">  Try &quot;build a workflow from session 0e9c5a1&quot;</span>
            </div>
            <div className="term-rule"></div>
          </div>
          <div className="term-statusbar claude-status" aria-hidden="true">
            <span className="cs-mode">⏵⏵ auto mode on</span>
            <span className="cs-sep">·</span>
            <span className="cs-hint">shift+tab to cycle</span>
            <span className="cs-sep">·</span>
            <span className="cs-effort"><span className="cs-dot"></span> high</span>
          </div>
        </div>
      </div>

      <figcaption>
        <strong>Failure prevention, success replay — one graph.</strong>{" "}
        The first two tabs show the post-session retro flow in
        Claude Code and Codex. The third synthesizes a workflow
        skill from a previous clean session by reading evidence
        the graph already has.
      </figcaption>
    </figure>
  );
}
