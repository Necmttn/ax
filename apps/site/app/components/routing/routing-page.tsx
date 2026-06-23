import { Link } from "@tanstack/react-router";

export function RoutingPage() {
  return (
    <main className="features-page routing-page">
      {/* ============= hero ============= */}
      <section className="hero">
        <span className="eyebrow">cost routing &middot; since v0.27</span>
        <h1>
          Your frontier model is doing <em>intern work.</em>
        </h1>
        <p className="lede">
          You&rsquo;d think Claude Code already sends the routine work it spawns to cheaper
          models. It doesn&rsquo;t &mdash; every sub-task runs on your most expensive model
          unless something tells it which one to use, and your weekly usage limit dies in
          hours, not days. ax measures the leak, warns as it happens, learns the fix from
          your own history, and verifies the savings &mdash; all on your laptop.
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
            <span className="k">sub-tasks spawned</span>
          </div>
          <div className="stat">
            <span className="v">75%</span>
            <span className="k">ran on the expensive default</span>
          </div>
          <div className="stat">
            <span className="v">28:1</span>
            <span className="k">expensive-to-cheap spend</span>
          </div>
        </div>
        <p className="rt-hero-note">
          $2,301 of sub-task spend on fable/opus vs $83 on sonnet, on this machine. Run{" "}
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
            Four commands close the loop &mdash; see where the expensive defaults hide, get
            warned before the next one, learn the fix from what your agents actually do,
            then reprice against the tokens your sub-tasks actually burned.
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
              Breaks your spend into main session vs the sub-tasks your agent spawns, by
              model. The 28:1 above came out of this table &mdash; run it to see your ratio.
            </p>
          </div>

          <div className="rt-step">
            <div className="rt-step-head">
              <span className="rt-step-num">02</span>
              <span className="rt-step-verb">nudge</span>
            </div>
            <code className="rt-step-cmd rt-step-cmd--wrap">
              ax hooks install ~/.ax/hooks/route-dispatch.ts --providers=claude
            </code>
            <p className="rt-step-body">
              The <code className="inline">route-dispatch</code> hook warns in the moment,
              right as a routine sub-task is about to run on the expensive default.
            </p>
          </div>

          <div className="rt-step new">
            <div className="rt-step-head">
              <span className="rt-step-num">03</span>
              <span className="rt-step-verb">tune</span>
            </div>
            <code className="rt-step-cmd">ax routing tune</code>
            <p className="rt-step-body">
              Finds the routine work <em>you</em> keep overpaying for, from what your agents
              actually do. Deterministic pattern-matching &mdash; no AI guessing.
            </p>
          </div>

          <div className="rt-step">
            <div className="rt-step-head">
              <span className="rt-step-num">04</span>
              <span className="rt-step-verb">verify</span>
            </div>
            <code className="rt-step-cmd">ax dispatches --candidates</code>
            <p className="rt-step-body">
              Reprices every overbilled sub-task against what the cheaper model would have
              cost, from the actual tokens it burned. Your savings, not projections.
            </p>
          </div>
        </div>
      </section>

      {/* ============= 02 on real data ============= */}
      <section id="numbers">
        <div className="section-head">
          <span className="section-num">02 / The receipts</span>
          <h2>
            One machine, <em>verbatim.</em>
          </h2>
          <p className="section-lede">
            Over 30 days: 20 patterns of routine work found, $591.57 of addressable spend.
            Reprice the last 14 days against the cheaper model and $512.91 is recoverable
            &mdash; the same machine as the numbers above.{" "}
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
            <span className="fig">$512.91</span>
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
          sub-tasks actually cost over the window &mdash; yours included. ax reprices what
          already happened, from the actual tokens burned, and never reports fabricated
          projected savings.
        </p>
      </section>

      {/* ============= 03 the safety rule ============= */}
      <section id="safety">
        <div className="section-head">
          <span className="section-num">03 / The safety rule</span>
          <h2>
            Judgment work <em>never</em> gets nudged down.
          </h2>
          <p className="section-lede">
            Your obvious objection: won&rsquo;t quality drop? No &mdash; ax never even
            suggests tiering down anything that needs taste. Your reviews, your design
            calls, your plans stay on the frontier model.
          </p>
        </div>

        <div className="rt-lanes">
          <div className="rt-lane is-down">
            <h3>
              <span className="dot" /> flagged to tier down
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
                Code review <span className="dim">(quality gate, never flagged)</span>
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
          <b>ax advises &mdash; you route.</b> ax flags mechanical dispatches and nudges
          the cheaper model at dispatch time; your agent still makes the call (a Claude
          Code hook can&rsquo;t rewrite a dispatch, so it suggests, it doesn&rsquo;t
          enforce). Judgment-shaped work never gets nudged &mdash; it ships as a written
          brief your agent stress-tests against your own history before any class is added.
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
            <span className="p">$</span> ax ingest{" "}
            <span className="dim"># first run: build the graph from your history</span>
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
