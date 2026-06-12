import { Link } from "@tanstack/react-router";

export function RoutingPage() {
  return (
    <main className="features-page routing-page">
      {/* ============= hero ============= */}
      <section className="hero">
        <span className="eyebrow">cost routing &middot; new in ax</span>
        <h1>
          Your frontier model is doing <em>intern work.</em>
        </h1>
        <p className="lede">
          Any subagent dispatch that doesn&rsquo;t pin a model inherits the expensive one. ax
          measures the leak, nudges at dispatch time, tunes a routing table from your own
          history, and verifies the savings &mdash; all on your laptop.
        </p>
        <p className="rt-receipts-label">
          what the leak looks like on one real machine running ax &middot; 14 days of receipts
        </p>
        <div className="scale">
          <div className="stat">
            <span className="v">$19,270</span>
            <span className="k">agent spend &middot; 14 days</span>
          </div>
          <div className="stat">
            <span className="v">663</span>
            <span className="k">subagent dispatches</span>
          </div>
          <div className="stat">
            <span className="v">75%</span>
            <span className="k">inherited the frontier model</span>
          </div>
          <div className="stat">
            <span className="v">28:1</span>
            <span className="k">expensive-to-cheap spend</span>
          </div>
        </div>
        <p className="rt-hero-note">
          $2,301 of subagent spend on fable/opus vs $83 on sonnet, on this machine. Run{" "}
          <code>ax cost split</code> to see yours.
        </p>
      </section>

      {/* ============= 01 the loop ============= */}
      <section id="loop">
        <div className="section-head">
          <span className="section-num">01 / The loop</span>
          <h2>
            Measure. Nudge. Tune. <em>Verify.</em>
          </h2>
          <p className="section-lede">
            Four commands close the loop &mdash; see where your inherited dispatches hide, get
            warned before the next one, mine your history for routing classes, then reprice
            against the tokens your dispatches actually burned.
          </p>
        </div>

        <div className="rt-loop">
          <div className="rt-step">
            <div className="rt-step-head">
              <span className="rt-step-num">01</span>
              <span className="rt-step-verb">measure</span>
            </div>
            <code className="rt-step-cmd">ax cost split --days=7</code>
            <p className="rt-step-body">
              Breaks your spend into main loop vs subagents, by model. The 28:1 above came
              out of this table &mdash; run it to see your ratio.
            </p>
          </div>

          <div className="rt-step">
            <div className="rt-step-head">
              <span className="rt-step-num">02</span>
              <span className="rt-step-verb">nudge</span>
            </div>
            <code className="rt-step-cmd">
              ax hooks install ~/.ax/hooks/route-dispatch.ts --providers=claude
            </code>
            <p className="rt-step-body">
              The <code className="inline">route-dispatch</code> hook warns at dispatch time
              when one of your mechanical dispatches forgets to pin a model.
            </p>
          </div>

          <div className="rt-step new">
            <div className="rt-step-head">
              <span className="rt-step-num">03</span>
              <span className="rt-step-verb">tune</span>
            </div>
            <code className="rt-step-cmd">ax routing tune</code>
            <p className="rt-step-body">
              Mines <em>your</em> dispatch history for new routing classes. Deterministic
              clustering &mdash; no LLM in the loop.
            </p>
          </div>

          <div className="rt-step">
            <div className="rt-step-head">
              <span className="rt-step-num">04</span>
              <span className="rt-step-verb">verify</span>
            </div>
            <code className="rt-step-cmd">ax dispatches --candidates</code>
            <p className="rt-step-body">
              Reprices every expensive inherited dispatch from the real token buckets it
              burned. Your savings, not projections.
            </p>
          </div>
        </div>
      </section>

      {/* ============= 02 on real data ============= */}
      <section id="numbers">
        <div className="section-head">
          <span className="section-num">02 / The receipts</span>
          <h2>
            One machine, 30 days, <em>verbatim.</em>
          </h2>
          <p className="section-lede">
            20 routing classes mined, $591.57 of addressable spend, $512.91 flagged once the
            table applied &mdash; the same machine as the numbers above.{" "}
            <code className="inline">ax routing tune --dry-run</code> prints yours in one
            command.
          </p>
        </div>

        <div className="rt-term">
          <div className="bar">
            <span className="dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span className="filename">~/Projects/ax</span>
            <span style={{ marginLeft: "auto" }}>zsh</span>
          </div>
          <pre>
            <span className="p">$</span> <span className="cmd">ax routing tune --dry-run --days=30</span>
            {"\n\n"}
            <span className="fig">20 proposals</span>
            {"  addressable spend: "}
            <span className="fig">$591.57</span>
            {"  (30 days)\n"}
            <span className="dim">
              apply non-judgment: ax routing tune --days=30   brief: ax routing tune --emit-brief
            </span>
            {"\n\n"}
            <span className="p">$</span> <span className="cmd">ax dispatches --candidates --days=14</span>
            {"\n\n"}
            {"total est savings: "}
            <span className="fig">$512.9076</span>
            {"\n"}
            {"top classes: well-specified-impl ("}
            <span className="fig">$222.78</span>
            {"), spec-review ("}
            <span className="fig">$69.75</span>
            {"), bug-fix ("}
            <span className="fig">$62.08</span>
            {")"}
          </pre>
        </div>

        <p className="rt-fine">
          Honest numbers, on purpose: &ldquo;addressable spend&rdquo; is what the flagged
          dispatches actually cost over the window &mdash; yours included. ax reprices
          retrospectively from real token buckets and never reports fabricated projected
          savings.
        </p>
      </section>

      {/* ============= 03 the safety rule ============= */}
      <section id="safety">
        <div className="section-head">
          <span className="section-num">03 / The safety rule</span>
          <h2>
            Judgment work <em>never</em> tiers down.
          </h2>
          <p className="section-lede">
            Your obvious objection: won&rsquo;t quality drop? No &mdash; the miner refuses to
            auto-route anything that needs taste. Your reviews, your design calls, your
            plans stay on the frontier model.
          </p>
        </div>

        <div className="rt-lanes">
          <div className="rt-lane is-down">
            <h3>
              <span className="dot" /> tiers down automatically
            </h3>
            <ul>
              <li>
                File search &amp; repo recon <span className="dim">(billed at opus rates today)</span>
              </li>
              <li>
                Well-specified implementation <span className="dim">(the spec did the thinking)</span>
              </li>
              <li>
                Bug fixes with a repro <span className="dim">(mechanical once located)</span>
              </li>
              <li>
                Verification &amp; test runs <span className="dim">(pass/fail, not judgment)</span>
              </li>
            </ul>
          </div>
          <div className="rt-lane is-frontier">
            <h3>
              <span className="dot" /> stays on the frontier model
            </h3>
            <ul>
              <li>
                Code review <span className="dim">(quality gate, never auto-routed)</span>
              </li>
              <li>
                Design &amp; UX <span className="dim">(taste does not tier down)</span>
              </li>
              <li>
                Planning &amp; architecture <span className="dim">(the expensive mistakes)</span>
              </li>
              <li>
                Audits <span className="dim">(the thing checking the cheap work)</span>
              </li>
            </ul>
          </div>
        </div>

        <div className="rt-brief-note">
          <b>Judgment proposals ship as a brief, not a change.</b> When the miner detects a
          judgment-shaped class, it routes the proposal through a written brief your agent
          adversarially backtests against your own history before anything applies. Quality
          stays on the frontier model; only mechanical work moves.
        </div>
      </section>

      {/* ============= cta ============= */}
      <section className="rt-cta" id="install">
        <h2>
          Route the expensive model where it <em>earns its keep.</em>
        </h2>
        <p>
          Everything runs local. Your transcripts never leave your machine.
        </p>
        <div className="rt-install">
          <code>
            <span className="p">$</span> curl -fsSL https://ax.necmttn.com/install | bash
          </code>
          <code>
            <span className="p">$</span> ax routing tune
          </code>
        </div>
        <div className="rt-cta-links">
          <a
            className="rt-gh"
            href="https://github.com/Necmttn/ax"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub &rarr;
          </a>
          <Link to="/features">everything else under the hood &rarr;</Link>
        </div>
      </section>
    </main>
  );
}
