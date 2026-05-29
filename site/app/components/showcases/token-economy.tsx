"use client";
import { useEffect, useRef } from "react";

export function TokenEconomyShowcase() {
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reduce) return;

    const bars = Array.from(
      root.querySelectorAll<HTMLElement>(
        ".epoch-row .bar > div, .session .cache-mini > div, .target .fill, .provider-strip > div",
      ),
    );

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
      id="token-economy"
      className="showcase-token-economy"
      ref={rootRef}
      aria-label="Token economy diagnostic showcase"
    >
      <p className="eyebrow">see the bleed · token-impact</p>
      <h2>
        Where your agent <em>context</em> goes.
      </h2>
      <p className="lede">
        Every agent user is bleeding money on cache misses they can&apos;t see.{" "}
        <span className="cmd">axctl insights token-impact --since=7d</span> joins your local
        claude + codex transcripts, reconciles provider metadata against transcript bytes,
        and shows the spend, the hit rate, and the workflows burning the budget.
      </p>

      {/* ============ HERO STATS ============ */}
      <section className="stats" aria-label="hero stats">
        <div className="stat" data-kind="tokens">
          <div className="label">tokens · 7d</div>
          <div className="big">
            14.2<span className="unit">M</span>
          </div>
          <div className="delta">
            <span className="up">▲ +20%</span> &nbsp;vs 11.8M last week
          </div>
          <div className="submeta">claude 8.5M · codex 5.7M</div>
        </div>

        <div className="stat" data-kind="spend">
          <div className="label">spend · 7d</div>
          <div className="big">
            $42<span className="unit">.18</span>
          </div>
          <div className="provider-strip" aria-hidden="true">
            <div className="seg-claude" style={{ width: "57.3%" }} />
            <div className="seg-codex" style={{ width: "42.7%" }} />
          </div>
          <div className="provider-legend">
            <span>
              <span className="swatch" style={{ background: "#d77757" }} />
              claude $24.18
            </span>
            <span>
              <span className="swatch" style={{ background: "var(--blue)" }} />
              codex $18.00
            </span>
          </div>
        </div>

        <div className="stat" data-kind="cache">
          <div className="label">cache hit · 7d</div>
          <div className="big">
            67<span className="unit">%</span>
          </div>
          <div className="target" aria-hidden="true">
            <div className="fill" />
            <div className="tick" title="target 80%" />
          </div>
          <div className="target-legend">
            <span className="up">▼ -4pp WoW</span>
            <span>target 80%</span>
          </div>
        </div>
      </section>

      {/* ============ BREAKDOWN ============ */}
      <div className="section-head">
        <h3>By workflow epoch &amp; expensive sessions</h3>
        <div className="meta">join: session_token_usage ⋈ session_health</div>
      </div>

      <section className="breakdown">
        {/* LEFT: workflow_epoch stacked bars */}
        <div>
          <div className="epoch-row" title="gsd: 5.96M tokens, 71% cached">
            <div className="name">
              <span className="badge" style={{ background: "var(--ink)" }} />
              gsd
            </div>
            <div className="bar">
              <div className="cached" style={{ width: "29.8%" }} />
              <div className="miss" style={{ width: "12.2%" }} />
            </div>
            <div className="pct">42%</div>
          </div>
          <div className="epoch-row" title="superpowers: 4.40M tokens, 78% cached">
            <div className="name">
              <span className="badge" style={{ background: "#5b5b56" }} />
              superpowers
            </div>
            <div className="bar">
              <div className="cached" style={{ width: "24.2%" }} />
              <div className="miss" style={{ width: "6.8%" }} />
            </div>
            <div className="pct">31%</div>
          </div>
          <div className="epoch-row" title="ad-hoc: 3.83M tokens, 48% cached">
            <div className="name">
              <span className="badge" style={{ background: "#aeaca3" }} />
              ad-hoc
            </div>
            <div className="bar">
              <div className="cached" style={{ width: "13.0%" }} />
              <div className="miss" style={{ width: "14.0%" }} />
            </div>
            <div className="pct">27%</div>
          </div>

          <div className="epoch-key">
            <span>
              <span className="sw" style={{ background: "var(--green)" }} />
              cached
            </span>
            <span>
              <span className="sw" style={{ background: "var(--red)" }} />
              cache miss (paid)
            </span>
          </div>

          <p className="epoch-note">
            Bar length = share of total tokens. Color split inside each bar = cached vs.
            paid for the same workload.{" "}
            <strong>ad-hoc is half the tokens of gsd but burns more dollars</strong> -
            fewer rituals, lower cache hit.
          </p>
        </div>

        {/* RIGHT: top expensive sessions */}
        <div>
          <div className="sessions">
            <div className="session">
              <div className="sid">session 9c2e44 · claude</div>
              <div className="right">
                <span className="tk">2.40M</span> tk
              </div>
              <div className="path">
                ~/Projects/ax <span className="arrow">›</span> src/ingest/transcripts.ts
                refactor
              </div>
              <div className="cache-mini">
                <div className="c" style={{ width: "41%" }} />
                <div className="m" style={{ width: "59%" }} />
              </div>
              <div className="ratio">
                <span>
                  cache hit <span className="bad">41%</span>
                </span>
                <span>$7.81 · 14 turns</span>
              </div>
            </div>

            <div className="session">
              <div className="sid">session 4f1ab0 · codex</div>
              <div className="right">
                <span className="tk">1.85M</span> tk
              </div>
              <div className="path">
                ~/Projects/ax <span className="arrow">›</span> insights CLI scaffold
              </div>
              <div className="cache-mini">
                <div className="c" style={{ width: "58%" }} />
                <div className="m" style={{ width: "42%" }} />
              </div>
              <div className="ratio">
                <span>
                  cache hit <span className="mid">58%</span>
                </span>
                <span>$5.94 · 22 turns</span>
              </div>
            </div>

            <div className="session">
              <div className="sid">session a07e91 · claude</div>
              <div className="right">
                <span className="tk">1.31M</span> tk
              </div>
              <div className="path">
                ~/Projects/ax <span className="arrow">›</span> schema v3 migration
              </div>
              <div className="cache-mini">
                <div className="c" style={{ width: "79%" }} />
                <div className="m" style={{ width: "21%" }} />
              </div>
              <div className="ratio">
                <span>
                  cache hit <span className="ok">79%</span>
                </span>
                <span>$3.12 · 9 turns</span>
              </div>
            </div>

            <div className="session">
              <div className="sid">session 2bf330 · codex</div>
              <div className="right">
                <span className="tk">1.07M</span> tk
              </div>
              <div className="path">
                ~/Projects/ax <span className="arrow">›</span> docs/landing rewrite
              </div>
              <div className="cache-mini">
                <div className="c" style={{ width: "36%" }} />
                <div className="m" style={{ width: "64%" }} />
              </div>
              <div className="ratio">
                <span>
                  cache hit <span className="bad">36%</span>
                </span>
                <span>$3.78 · 31 turns</span>
              </div>
            </div>

            <div className="session">
              <div className="sid">session 7d4c12 · claude</div>
              <div className="right">
                <span className="tk">0.92M</span> tk
              </div>
              <div className="path">
                ~/Projects/quera <span className="arrow">›</span> live-traces vendor
              </div>
              <div className="cache-mini">
                <div className="c" style={{ width: "74%" }} />
                <div className="m" style={{ width: "26%" }} />
              </div>
              <div className="ratio">
                <span>
                  cache hit <span className="ok">74%</span>
                </span>
                <span>$2.34 · 11 turns</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ============ INSIGHT ============ */}
      <section className="insight">
        <div className="ratio-num">
          3.2<span className="x">×</span>
        </div>
        <div className="body">
          <strong>codex burns 3.2× the context of claude code</strong> for equivalent
          work - same workflow_epoch, same repo, same outcome. Most of that is restated
          history per turn.
          <span className="src">
            workflow-impact says the gsd → superpowers migration is paying off · run{" "}
            <code>axctl insights workflow-impact</code> for the cohort comparison
          </span>
        </div>
      </section>

      {/* ============ CAPTION ============ */}
      <section className="caption">
        <div className="col">
          <div className="h">where the numbers come from</div>
          ax reads provider metadata - <code>cache_creation_input_tokens</code>,{" "}
          <code>cache_read_input_tokens</code>, <code>input_tokens</code>,{" "}
          <code>output_tokens</code> - and falls back to transcript-byte estimates when a
          turn predates cache reporting.
        </div>
        <div className="col">
          <div className="h">runs on your machine</div>
          Local SurrealDB instance. Typed Effect pipeline. No outbound calls, no upload.
          Sibling diagnostics: <span className="pill">cache-health</span>
          <span className="pill">workflow-impact</span>
          <span className="pill">skill-impact</span>
        </div>
      </section>
    </section>
  );
}
