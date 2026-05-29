"use client";
import { useEffect, useRef } from "react";

export function RecallShowcase() {
  const argRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const el = argRef.current;
    if (!el) return;

    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reduce) return;

    const full = '"auth middleware oauth refresh token"';
    let i = full.length;
    let phase: "idle" | "erase" | "type" = "idle";
    let timer: ReturnType<typeof setTimeout> | undefined;

    function tick() {
      if (!el) return;
      if (phase === "idle") {
        timer = setTimeout(() => { phase = "erase"; tick(); }, 3500);
        return;
      }
      if (phase === "erase") {
        i = Math.max(0, i - 1);
        el.textContent = full.slice(0, i);
        if (i === 0) {
          phase = "type";
          timer = setTimeout(tick, 350);
          return;
        }
        timer = setTimeout(tick, 22);
        return;
      }
      if (phase === "type") {
        i = Math.min(full.length, i + 1);
        el.textContent = full.slice(0, i);
        if (i === full.length) {
          phase = "idle";
          timer = setTimeout(tick, 200);
          return;
        }
        timer = setTimeout(tick, 38);
        return;
      }
    }

    timer = setTimeout(tick, 1800);

    return () => {
      if (timer) clearTimeout(timer);
    };
  }, []);

  const inlineCode: React.CSSProperties = {
    fontFamily: "var(--mono)",
    fontSize: "15px",
  };

  return (
    <section id="recall" className="showcase-recall">
      <p className="eyebrow">search the graph</p>
      <h2>
        Find what you shipped <em>last time you did this.</em>
      </h2>
      <p className="lede">
        <span>
          Every transcript ax has ever ingested is full-text searchable -
          Claude Code, Codex, every turn, every tool call, every reasoning text.
        </span>
        <span className="soft">
          {" "}Ranked excerpts come back with the session, the file,
          the commit, and whether it stuck.
        </span>
      </p>

      {/* CLI shape */}
      <div className="cli" aria-hidden="true">
        <span className="dots">
          <i className="dot r" />
          <i className="dot y" />
          <i className="dot g" />
        </span>
        <span className="prompt">~/Projects/ax</span>
        <span className="prompt">&gt;</span>
        <span className="cmd">axctl recall</span>
        <span className="arg" ref={argRef}>"auth middleware oauth refresh token"</span>
        <span className="caret" />
      </div>

      {/* search widget */}
      <div className="search" role="search">
        <span className="glyph" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" />
            <line x1="20" y1="20" x2="16.5" y2="16.5" />
          </svg>
        </span>
        <input
          id="q"
          type="text"
          defaultValue="auth middleware oauth refresh token"
          spellCheck={false}
          autoComplete="off"
        />
        <span className="kbd">
          <span>search</span> <b>⏎</b>
        </span>
      </div>

      <div className="meta-row">
        <div className="scope">
          <span className="chip">14,832 turns</span>
          <span className="chip">412 sessions</span>
          <span className="chip">claude + codex</span>
        </div>
        <div>4 matches · 38 ms</div>
      </div>

      {/* results */}
      <div className="results">
        {/* 1 */}
        <article className="result">
          <div className="rank">
            01
            <span className="score">0.94</span>
          </div>
          <div className="body">
            <p className="excerpt">
              Built the <mark>OAuth refresh token</mark> rotation. The
              {" "}<mark>middleware</mark> now checks expiry with <code style={inlineCode}>&lt;=</code>
              {" "}not <code style={inlineCode}>&lt;</code> after the bug we hit last quarter -
              tests cover the boundary tick and the clock-skew window.
            </p>
            <div className="prov">
              <span className="src">claude code</span>
              <span className="sep">·</span>
              <span className="sid">session 5a8e9c</span>
              <span className="sep">·</span>
              <span className="date">2026-05-21 · 14:02</span>
              <span className="sep">·</span>
              <span>~/Projects/ax</span>
              <span className="sep">·</span>
              <span className="path">src/auth/middleware.ts</span>
            </div>
            <div className="outcome adopted">
              <span className="arrow">→ shipped in</span>
              <span className="commit">8b3d1f4</span>
              <span className="verdict">adopted</span>
              <span className="t-since">t + 7d</span>
            </div>
          </div>
        </article>

        {/* 2 */}
        <article className="result">
          <div className="rank">
            02
            <span className="score">0.81</span>
          </div>
          <div className="body">
            <p className="excerpt">
              PR #847 - <mark>OAuth refresh</mark> path. Tests cover both expiry edge cases;
              the <mark>middleware</mark> guards against double-refresh by holding a
              per-tenant lock for the duration of the rotation.
            </p>
            <div className="prov">
              <span className="src">claude code</span>
              <span className="sep">·</span>
              <span className="sid">session 3c1d22</span>
              <span className="sep">·</span>
              <span className="date">2026-04-14 · 09:48</span>
              <span className="sep">·</span>
              <span>~/Projects/ax</span>
              <span className="sep">·</span>
              <span className="path">src/auth/refresh.ts</span>
            </div>
            <div className="outcome adopted">
              <span className="arrow">→ shipped in</span>
              <span className="commit">2e0a5cc</span>
              <span className="verdict">adopted</span>
              <span className="t-since">t + 30d</span>
            </div>
          </div>
        </article>

        {/* 3 */}
        <article className="result">
          <div className="rank">
            03
            <span className="score">0.72</span>
          </div>
          <div className="body">
            <p className="excerpt">
              Initial <mark>OAuth</mark> wiring. Note for future me: don't reuse the access
              {" "}<mark>token</mark> endpoint for <mark>refresh</mark> - separate route, separate
              rate limit, separate audit log.
            </p>
            <div className="prov">
              <span className="src codex">codex</span>
              <span className="sep">·</span>
              <span className="sid">session 7f4b88</span>
              <span className="sep">·</span>
              <span className="date">2026-03-02 · 22:11</span>
              <span className="sep">·</span>
              <span>~/Projects/ax</span>
              <span className="sep">·</span>
              <span className="path">src/auth/routes.ts</span>
            </div>
            <div className="outcome adopted-locked">
              <span className="arrow">→ shipped in</span>
              <span className="commit">9d1e0a2</span>
              <span className="verdict">adopted · locked</span>
              <span className="t-since">t + 90d</span>
            </div>
          </div>
        </article>

        {/* 4 (dim - rejected) */}
        <article className="result dim">
          <div className="rank">
            04
            <span className="score">0.41</span>
          </div>
          <div className="body">
            <p className="excerpt">
              Spike on <mark>OAuth</mark> session-binding inside the <mark>middleware</mark> -
              rejected, returned to the PR #420 approach. Leaving the diff in
              {" "}<code style={inlineCode}>scratch/</code> in case the threat
              model changes.
            </p>
            <div className="prov">
              <span className="src">claude code</span>
              <span className="sep">·</span>
              <span className="sid">session 1a2b33</span>
              <span className="sep">·</span>
              <span className="date">2025-12-08 · 16:30</span>
              <span className="sep">·</span>
              <span>~/Projects/ax</span>
              <span className="sep">·</span>
              <span className="path">scratch/oauth-bind.ts</span>
            </div>
            <div className="outcome rejected">
              <span className="arrow">→ rolled back</span>
              <span className="verdict">rejected</span>
              <span className="t-since">t + 2d</span>
            </div>
          </div>
        </article>
      </div>

      {/* caption */}
      <aside className="caption">
        <div className="label">how it works</div>
        <div>
          <p>
            Every Claude Code and Codex session ax ingests becomes a row in the unified
            graph - turn text, tool calls, reasoning, file edits, commit refs.
            {" "}<code>axctl recall</code> runs full-text search over that graph and ranks by
            {" "}<em>recency × relevance × outcome</em>.
          </p>
          <p>
            "Outcome" is the part no other agent layer has: whether the change shipped,
            was rolled back, or got locked in as a permanent pattern. You're not just
            searching what you wrote - you're searching what worked.
          </p>
        </div>
      </aside>

      <p className="foot">ax · local taste &amp; telemetry graph · prototype</p>
    </section>
  );
}
