"use client";
import { useEffect, useRef } from "react";

const PROPOSALS = [
  {
    score: "16.03",
    pct: 92,
    kind: "skill",
    id: "skill__508c34566d2f1d85",
    rate: "26/wk",
    title: "Post-feature verification checklist",
    evidence: "Feature closure needs stronger same-file follow-up verification.",
  },
  {
    score: "11.93",
    pct: 68,
    kind: "skill",
    id: "skill__53cc564505d4c1f9",
    rate: "8/wk",
    title: "Graph query dogfood checklist",
    evidence:
      "Query builders can pass string tests while returning slow or low-signal output.",
  },
  {
    score: "8.90",
    pct: 51,
    kind: "skill",
    id: "skill__292666ce747117ee",
    rate: "3/wk",
    title: "SurrealDB schema change guardrail",
    evidence: "Schema changes need a tighter migration/apply/query verification loop.",
  },
];

export function ImproveLoopShowcase() {
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reduce) return;

    const bars = Array.from(root.querySelectorAll<HTMLElement>(".score-bar > div"));
    const original: Array<{ el: HTMLElement; width: string }> = [];
    bars.forEach((b) => {
      original.push({ el: b, width: b.style.width });
      b.style.width = "0%";
    });

    const raf = requestAnimationFrame(() => {
      original.forEach(({ el, width }) => {
        el.style.transition = "width 700ms cubic-bezier(.2,.7,.2,1)";
        el.style.width = width;
      });
    });

    return () => {
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <section
      id="improve-loop"
      className="showcase-improve-loop"
      ref={rootRef}
      aria-label="Improve loop showcase"
    >
      <p className="eyebrow">the graph talks back · improve <span className="receipt-tag is-real">from our own graph · 2026-06</span></p>
      <h2>
        Proposals mined from <em>your own</em> transcripts.
      </h2>
      <p className="lede">
        <span className="cmd">ax improve recommend</span> scores improvement proposals out of
        your transcript graph - each one with an evidence trail and a backtested projected
        value. Accept one and it becomes a brief an agent acts on. Lint reconciles what
        actually got applied. Verdicts confirm it or retire it.
      </p>

      {/* ============ TOP PROPOSAL ============ */}
      <article className="top-proposal" aria-label="top proposal">
        <header className="tp-head">
          <span className="score">17.49</span>
          <span className="kind is-hook">hook</span>
          <span className="pid">hook__17b5aaf6aade53e5</span>
          <span className="conf">high · 39/wk</span>
          <span className="origin">origin: system</span>
        </header>
        <h4 className="tp-title">Route mechanical subagent dispatches to cheaper models</h4>
        <p className="tp-evidence">
          <span className="lk">evidence</span> 39 model-less dispatches on fable/opus matched
          mechanical routing classes in the last 2d; est <b>$209.59</b> redirectable. Top
          classes: well-specified-impl ($95.27), bug-fix ($44.59), spec-review ($32.57).
        </p>
        <p className="tp-apply">
          <span className="lk">apply</span>{" "}
          <code>axctl improve accept hook__17b5aaf6aade53e5</code>
        </p>
      </article>

      {/* ============ REST OF THE LIST ============ */}
      <div className="proposals" role="list">
        {PROPOSALS.map((p) => (
          <div className="proposal" role="listitem" key={p.id}>
            <span className="score">{p.score}</span>
            <span className="score-bar" aria-hidden="true">
              <div style={{ width: `${p.pct}%` }} />
            </span>
            <span className={`kind is-${p.kind}`}>{p.kind}</span>
            <span className="title">{p.title}</span>
            <span className="rate">high · {p.rate}</span>
            <span className="evidence">{p.evidence}</span>
          </div>
        ))}
      </div>

      {/* ============ THE LOOP ============ */}
      <div className="section-head">
        <h3>Accept is not the end - it's the experiment</h3>
        <div className="meta">recommend → accept → apply → lint → verdict</div>
      </div>

      <section className="loop" aria-label="improve loop">
        <span className="node">
          <code>recommend</code>
          <em>scored, with evidence</em>
        </span>
        <span className="arrow" aria-hidden="true">→</span>
        <span className="node">
          <code>accept</code>
          <em>.ax/tasks/&lt;id&gt;.md brief</em>
        </span>
        <span className="arrow" aria-hidden="true">→</span>
        <span className="node">
          <code>agent applies</code>
          <em>like any task file</em>
        </span>
        <span className="arrow" aria-hidden="true">→</span>
        <span className="node">
          <code>lint</code>
          <em>reconciles guidance</em>
        </span>
        <span className="arrow" aria-hidden="true">→</span>
        <span className="node">
          <code>verdict</code>
          <em>confirms or retires</em>
        </span>
      </section>

      <p className="loop-note">
        Agents write back too - <code>ax improve propose</code> /{" "}
        <code>ax improve analyze</code> let a session file its own proposal mid-run; origin
        badges keep agent-derived and system-derived suggestions distinguishable.
      </p>

      {/* ============ META RECEIPT ============ */}
      <section className="insight">
        <div className="ratio-num">
          #1<span className="x">↑</span>
        </div>
        <div className="body">
          <strong>The top proposal above is the first showcase on this page.</strong> The
          graph mined "route mechanical dispatches to cheaper models" out of its own
          transcripts - $209.59 redirectable in two days - before it existed as a feature.
          We accepted the brief; it shipped as <a href="#dispatch-routing">dispatch routing</a>.
          <span className="src">
            the loop eating its own output · run <code>ax improve recommend</code> for yours
          </span>
        </div>
      </section>

      {/* ============ CAPTION ============ */}
      <section className="caption">
        <div className="col">
          <div className="h">where the numbers come from</div>
          Scores blend frequency, severity, and the impact engine's backtested projected
          value - what the proposal would have saved or caught over your actual recent
          history, not a hypothetical.
        </div>
        <div className="col">
          <div className="h">runs on your machine</div>
          Mined from the local graph, applied to your own agent files. Nothing auto-edits:
          accept emits a brief, an agent does the work, <code>ax improve lint</code> checks
          it landed. The whole deck - proposals, impact, and past bets measured at +3/+10/+30
          sessions - lives in the studio improve dashboard: <code>ax serve</code>.
        </div>
      </section>
    </section>
  );
}
