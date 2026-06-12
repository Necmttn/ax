"use client";
import { useEffect, useRef } from "react";

const SOURCES = [
  {
    name: "codex",
    sess: 57,
    fails: 467,
    episodes: 23,
    pass: 22,
    landed: "+330,730/-150,779",
    edits: "+286/-142",
    repair: "+58/-25",
    // composition of added LOC
    landedPct: 99.6,
    editPct: 0.25,
    repairPct: 0.15,
    repairLabel: "<0.1%",
  },
  {
    name: "claude-subagent",
    sess: 71,
    fails: 95,
    episodes: 29,
    pass: 13,
    landed: "+23,979/-4,157",
    edits: "+13,508/-2,199",
    repair: "+981/-274",
    landedPct: 62.3,
    editPct: 35.1,
    repairPct: 2.6,
    repairLabel: "2.6%",
  },
  {
    name: "claude",
    sess: 14,
    fails: 17,
    episodes: 17,
    pass: 3,
    landed: "+117,641/-32,784",
    edits: "+36,455/-9,172",
    repair: "+3,867/-1,550",
    landedPct: 74.5,
    editPct: 23.1,
    repairPct: 2.4,
    repairLabel: "2.4%",
  },
];

export function ChurnShowcase() {
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reduce) return;

    const bars = Array.from(root.querySelectorAll<HTMLElement>(".comp-bar > span"));
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
      id="churn"
      className="showcase-churn"
      ref={rootRef}
      aria-label="Verification churn showcase"
    >
      <p className="eyebrow">who's thrashing · churn</p>
      <h2>
        Landed, edited, <em>repaired</em> - by source.
      </h2>
      <p className="lede">
        Lines of code is a vanity metric until you split it.{" "}
        <span className="cmd">ax sessions churn --here</span> classifies 30 days of writes
        into landed vs edit vs repair LOC per provider, counts failed checks, and groups the
        failures into episodes - so "which sessions thrash" has a number.
      </p>

      {/* ============ COMPOSITION BARS ============ */}
      <div className="section-head">
        <h3>Composition of added LOC · 30d</h3>
        <div className="meta">~/Projects/ax · claude / claude-subagent / codex</div>
      </div>

      <section className="comp" aria-label="LOC composition by source">
        {SOURCES.map((s) => (
          <div className="comp-row" key={s.name}>
            <span className="name">{s.name}</span>
            <span className="comp-bar" aria-hidden="true">
              <span className="landed" style={{ width: `${s.landedPct}%` }} />
              <span className="edit" style={{ width: `${s.editPct}%` }} />
              <span className="repair" style={{ width: `${s.repairPct}%` }} />
            </span>
            <span className="repair-share">repair {s.repairLabel}</span>
          </div>
        ))}
        <div className="comp-key">
          <span>
            <span className="sw landed" /> landed · survived as written
          </span>
          <span>
            <span className="sw edit" /> edit · reworked later
          </span>
          <span>
            <span className="sw repair" /> repair · fixing a failed check
          </span>
        </div>
        <p className="comp-note">
          The repair sliver is the point - <strong>a tiny repair share means checks catch
          problems before they ship</strong>. The edit band is where the real rework hides:
          claude-subagent reworks a third of everything it writes.
        </p>
      </section>

      {/* ============ THE TABLE ============ */}
      <div className="ledger" role="table" aria-label="churn by source">
        <div className="row head" role="row">
          <span>source</span>
          <span className="num">sess</span>
          <span className="num">fails</span>
          <span className="num">episodes</span>
          <span className="num">pass</span>
          <span className="num">landed</span>
          <span className="num">edits</span>
          <span className="num">repair</span>
        </div>
        {SOURCES.map((s) => (
          <div className="row" role="row" key={s.name}>
            <span className="src">{s.name}</span>
            <span className="num">{s.sess}</span>
            <span className="num fails">{s.fails}</span>
            <span className="num">{s.episodes}</span>
            <span className="num pass">{s.pass}</span>
            <span className="num">{s.landed}</span>
            <span className="num">{s.edits}</span>
            <span className="num repair">{s.repair}</span>
          </div>
        ))}
        <div className="ledger-foot">
          ax sessions churn --here · 30d window · LOC shown as +added/-removed
        </div>
      </div>

      {/* ============ EPISODE DIAGRAM ============ */}
      <div className="section-head">
        <h3>What an episode is</h3>
        <div className="meta">failure opens · same-family pass closes · 30min expiry</div>
      </div>

      <section className="episode" aria-label="episode lifecycle">
        <span className="ep-node open">
          <b>✗</b>
          <span className="ep-label">check fails</span>
          <span className="ep-sub">episode opens</span>
        </span>
        <span className="ep-track" aria-hidden="true" />
        <span className="ep-node more">
          <b>✗ ✗</b>
          <span className="ep-label">same-family failures</span>
          <span className="ep-sub">join the open episode</span>
        </span>
        <span className="ep-track" aria-hidden="true" />
        <span className="ep-node close">
          <b>✓</b>
          <span className="ep-label">same-family pass</span>
          <span className="ep-sub">episode closes</span>
        </span>
        <span className="ep-track dashed" aria-hidden="true" />
        <span className="ep-node expire">
          <b>⏱</b>
          <span className="ep-label">30 min silence</span>
          <span className="ep-sub">episode expires</span>
        </span>
      </section>

      {/* ============ INSIGHT ============ */}
      <section className="insight">
        <div className="ratio-num">
          467<span className="x">✗</span>
        </div>
        <div className="body">
          <strong>codex failed 467 checks in 30 days</strong> - 8.2 per session - and still
          landed 330k LOC with under 0.1% repair share. The failures cluster into just 23
          episodes: it thrashes in short windows against the test suite, then lands clean.
          <span className="src">
            claude-subagent is the opposite shape · 1.3 fails/session, 35% edit share
          </span>
        </div>
      </section>

      {/* ============ CAPTION ============ */}
      <section className="caption">
        <div className="col">
          <div className="h">where the numbers come from</div>
          Every <code>tool_call</code> that runs a check (tests, typecheck, lint, build) is
          classified pass/fail by family. LOC written after a failure, touching the same
          files, counts as repair; later rework of landed lines counts as edit.
        </div>
        <div className="col">
          <div className="h">runs on your machine</div>
          Same local graph as everything else - scope with <code>--here</code>, a specific{" "}
          <code>--project</code>, or one <code>--source</code>. 30d window by default,{" "}
          <code>--since=N</code> to change it.
        </div>
      </section>
    </section>
  );
}
