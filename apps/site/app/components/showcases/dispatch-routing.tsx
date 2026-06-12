"use client";
import { useEffect, useRef } from "react";
import { Link } from "@tanstack/react-router";

const ROWS = [
  {
    ts: "06-10 13:30",
    type: "general-purpose",
    desc: "Implement Task 3: session map strip",
    suggest: "claude-sonnet-4-6",
    child: "$50.26",
    save: "$35.18",
    pct: 100,
  },
  {
    ts: "06-11 07:41",
    type: "general-purpose",
    desc: "Fix ingest run lifecycle",
    suggest: "claude-sonnet-4-6",
    child: "$30.98",
    save: "$21.69",
    pct: 62,
  },
  {
    ts: "06-10 07:09",
    type: "general-purpose",
    desc: "Add deep span instrumentation",
    suggest: "claude-sonnet-4-6",
    child: "$26.41",
    save: "$18.49",
    pct: 53,
  },
  {
    ts: "06-10 15:32",
    type: "general-purpose",
    desc: "Implement P2-T16 skills",
    suggest: "claude-sonnet-4-6",
    child: "$16.29",
    save: "$11.40",
    pct: 32,
  },
  {
    ts: "06-11 07:42",
    type: "general-purpose",
    desc: "Sweep stale 8520 port refs",
    suggest: "claude-haiku-4-5",
    child: "$8.56",
    save: "$7.70",
    pct: 22,
  },
  {
    ts: "06-12 06:44",
    type: "codebase-analyzer",
    desc: "Extract contracts for plan",
    suggest: "claude-sonnet-4-6",
    child: "$6.75",
    save: "$4.73",
    pct: 13,
  },
];

export function DispatchRoutingShowcase() {
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reduce) return;

    const bars = Array.from(root.querySelectorAll<HTMLElement>(".save-bar > div"));
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
      id="dispatch-routing"
      className="showcase-dispatch-routing"
      ref={rootRef}
      aria-label="Dispatch routing showcase"
    >
      <p className="eyebrow">route the intern work · dispatches</p>
      <h2>
        Stop paying frontier rates for <em>mechanical</em> dispatches.
      </h2>
      <p className="lede">
        Every sub-task your agent spawns inherits your most expensive model unless something
        says otherwise. <span className="cmd">ax dispatches --candidates</span> finds the
        dispatches that ran on fable or opus but matched a mechanical routing class - and
        reprices each one against the cheaper model, from the tokens it actually burned.
      </p>

      {/* ============ HERO STATS ============ */}
      <section className="stats" aria-label="hero stats">
        <div className="stat" data-kind="receipt">
          <div className="label">biggest single receipt</div>
          <div className="big">
            $35<span className="unit">.18</span>
          </div>
          <div className="delta">one dispatch · $50.26 on inherit → sonnet</div>
          <div className="submeta">"Implement Task 3: session map strip"</div>
        </div>

        <div className="stat" data-kind="redirect">
          <div className="label">redirectable · last 2d</div>
          <div className="big">
            $209<span className="unit">.59</span>
          </div>
          <div className="delta">39 model-less dispatches on fable/opus</div>
          <div className="submeta">matched mechanical routing classes</div>
        </div>

        <div className="stat" data-kind="harness">
          <div className="label">where the fix fires</div>
          <div className="big">
            2<span className="unit">harnesses</span>
          </div>
          <div className="delta">route-dispatch hook · at dispatch time</div>
          <div className="submeta">claude code + codex</div>
        </div>
      </section>

      {/* ============ LEDGER ============ */}
      <div className="section-head">
        <h3>Top candidates, repriced</h3>
        <div className="meta">ax dispatches --candidates --days=14</div>
      </div>

      <div className="ledger" role="table" aria-label="candidate dispatches">
        <div className="row head" role="row">
          <span>ts</span>
          <span>agent_type</span>
          <span>description</span>
          <span>suggest</span>
          <span className="num">child cost</span>
          <span className="num">est savings</span>
          <span aria-hidden="true" />
        </div>
        {ROWS.map((r) => (
          <div className="row" role="row" key={r.ts + r.desc}>
            <span className="ts">{r.ts}</span>
            <span className="type">{r.type}</span>
            <span className="desc">{r.desc}</span>
            <span className="suggest">{r.suggest}</span>
            <span className="num child">{r.child}</span>
            <span className="num save">{r.save}</span>
            <span className="save-bar" aria-hidden="true">
              <div style={{ width: `${r.pct}%` }} />
            </span>
          </div>
        ))}
        <div className="ledger-foot">
          top 6 of dozens of candidates in 14d · <b>$99.29</b> est. savings on these rows
          alone · "inherit" means no model was specified, so the dispatch rode the expensive
          default
        </div>
      </div>

      {/* ============ PIPELINE ============ */}
      <section className="pipe" aria-label="routing pipeline">
        <div className="step">
          <div className="step-head">
            <span className="n">01</span>
            <span className="verb">find</span>
          </div>
          <code>ax dispatches --candidates</code>
          <p>
            Inherited an expensive model + matched a mechanical class. Each row carries a
            suggested model and the dollars it would have saved.
          </p>
        </div>
        <div className="step">
          <div className="step-head">
            <span className="n">02</span>
            <span className="verb">compile</span>
          </div>
          <code>ax routing compile</code>
          <p>
            Writes the class table to <code className="inline">~/.ax/hooks/routing-table.json</code> -
            merge-preserving, your own classes survive a regenerate.
          </p>
        </div>
        <div className="step">
          <div className="step-head">
            <span className="n">03</span>
            <span className="verb">fire</span>
          </div>
          <code>route-dispatch hook</code>
          <p>
            Suggests the cheaper model at dispatch time, in Claude Code <em>and</em> Codex.
            The next "Fix ingest run lifecycle" rides sonnet, not fable.
          </p>
        </div>
      </section>

      <p className="tune-note">
        <span className="tag">tune</span> <code>ax routing tune</code> mines the unmatched
        expensive dispatches into new classes - two-token prefix clustering, ≥3 members.
        Mechanical classes auto-apply; judgment-flagged ones (review / design / plan / audit)
        only ship via an emitted brief and an agent backtest.
      </p>

      {/* ============ CAPTION ============ */}
      <section className="caption">
        <div className="col">
          <div className="h">where the numbers come from</div>
          Every dispatch row joins the parent <code>tool_call</code> to the child session it
          spawned. Savings are repriced from the tokens the child actually burned - not a
          projection, a receipt.
        </div>
        <div className="col">
          <div className="h">there's a whole page on this</div>
          The leak, the loop, and 30 days of verbatim receipts from one machine:{" "}
          <Link to="/routing" className="more">
            ax · routing →
          </Link>
        </div>
      </section>
    </section>
  );
}
