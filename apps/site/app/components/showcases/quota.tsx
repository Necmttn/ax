"use client";
import { useEffect, useRef } from "react";

const WINDOWS = [
  { name: "5h", used: 64, resets: "04:29", tone: "warm" },
  { name: "7d", used: 63, resets: "04:59", tone: "warm" },
  { name: "7d sonnet", used: 5, resets: "04:59", tone: "ok" },
] as const;

export function QuotaShowcase() {
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reduce) return;

    const bars = Array.from(root.querySelectorAll<HTMLElement>(".meter .fill"));
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
      id="quota"
      className="showcase-quota"
      ref={rootRef}
      aria-label="Plan quota showcase"
    >
      <p className="eyebrow">know the envelope · quota</p>
      <h2>
        Your plan limits, <em>live</em>, everywhere you look.
      </h2>
      <p className="lede">
        Claude tells you about your usage limit when you hit it.{" "}
        <span className="cmd">ax quota</span> reads the same usage endpoint the Claude app
        does - your 5-hour and 7-day rolling windows, live, with the OAuth token you already
        have. No new login, no DB, nothing leaves your machine but the one call Claude
        already makes.
      </p>

      {/* ============ METERS ============ */}
      <section className="meters" aria-label="plan usage windows">
        {WINDOWS.map((w) => (
          <div className="meter-row" key={w.name}>
            <span className="name">{w.name}</span>
            <span className="meter" data-tone={w.tone}>
              <span className="fill" style={{ width: `${w.used}%` }} />
            </span>
            <span className="used">{w.used}%</span>
            <span className="resets">resets {w.resets}</span>
          </div>
        ))}
        <div className="meter-row extra">
          <span className="name">extra</span>
          <span className="off">off · no overage billing past the windows</span>
        </div>
      </section>

      {/* ============ SURFACES ============ */}
      <div className="section-head">
        <h3>One cached read, three surfaces</h3>
        <div className="meta">~/.ax/quota-cache.json · 60s ttl</div>
      </div>

      <section className="surfaces">
        {/* CLI */}
        <article className="surface">
          <header className="surface-head">
            <span className="where">terminal</span>
            <code>ax quota</code>
          </header>
          <pre className="term" aria-label="ax quota output">
            <span className="t-prompt">~ $</span> <span className="t-cmd">ax quota</span>
            {"\n\n"}
            <span className="t-muted">window       used  resets</span>
            {"\n"}
            {"5h            "}
            <span className="t-warm">64%</span>
            {"  04:29\n"}
            {"7d            "}
            <span className="t-warm">63%</span>
            {"  04:59\n"}
            {"7d sonnet      "}
            <span className="t-ok">5%</span>
            {"  04:59\n"}
            {"extra         "}
            <span className="t-muted">off</span>
            {"\n\n"}
            <span className="t-muted">(fetched 0s ago, live)</span>
          </pre>
        </article>

        {/* statusline */}
        <article className="surface">
          <header className="surface-head">
            <span className="where">claude code statusline</span>
            <code>ax quota --statusline</code>
          </header>
          <div className="statusline" aria-label="statusline mock">
            <span className="sl-left">~/Projects/ax · sonnet-4-6</span>
            <span className="sl-right">5h 64% → 04:29 · 7d 63%</span>
          </div>
          <p className="surface-note">
            One plain line for the <code className="inline">statusLine</code> command. Poll
            every render - it's the cache answering, not the API.
          </p>
        </article>

        {/* menubar */}
        <article className="surface">
          <header className="surface-head">
            <span className="where">macOS menubar</span>
            <code>ax quota --swiftbar</code>
          </header>
          <div className="menubar" aria-label="menubar mock">
            <span className="mb-item ax">◕ 64%</span>
            <span className="mb-item dim">⌥</span>
            <span className="mb-item dim">⚙</span>
            <span className="mb-item">Fri 09:41</span>
          </div>
          <p className="surface-note">
            A SwiftBar/xbar plugin body - the burn rate lives next to the clock. Fetch
            failures degrade to the stale cache, never a crash in the menubar.
          </p>
        </article>
      </section>

      {/* ============ CAPTION ============ */}
      <section className="caption">
        <div className="col">
          <div className="h">where the numbers come from</div>
          The same <code>api.anthropic.com/api/oauth/usage</code> endpoint the Claude app
          polls, read with your existing Claude Code OAuth token - macOS Keychain first,{" "}
          <code>~/.claude/.credentials.json</code> fallback. ax never refreshes the token.
        </div>
        <div className="col">
          <div className="h">runs on your machine</div>
          No SurrealDB involved at all - this is the one ax command with zero graph. Responses
          cache at <code>~/.ax/quota-cache.json</code> (60s TTL) so statusline and menubar can
          poll freely without hammering the endpoint.
        </div>
      </section>
    </section>
  );
}
