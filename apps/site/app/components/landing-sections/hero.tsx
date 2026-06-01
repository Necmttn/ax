import { Link } from "@tanstack/react-router";

export function HeroSection() {
  return (
    <section className="hero">
      <p className="eyebrow">the retro loop · for AI coding agents</p>
      <h1>
        Reflection is the<br />
        <em>missing</em> layer.
      </h1>
      <p className="lede">
        <code>ax</code> is the reflection step the agent stack lost. A
        local typed graph of every session, with retros, experiments, and
        verdicts that close the loop your sub-agents drop on the floor.
        Runs on your laptop. MIT.
      </p>

      <div className="hero-proof" aria-label="ax first run proof">
        <div className="hero-terminal" aria-label="Example ax command output">
          <div className="hero-terminal-chrome">
            <span></span>
            <span></span>
            <span></span>
            <em>~/Projects/app · ax first run</em>
          </div>
          <code>
            <span><b>$</b> axctl ingest --since=7</span>
            <span className="term-muted">indexed 91 sessions · 18,424 turns · 3,802 tool calls</span>
            <span className="term-muted">skills 288 · commits 142 · local graph 127.0.0.1</span>
            <span aria-hidden="true">&nbsp;</span>
            <span><b>$</b> axctl recall &quot;auth middleware failed&quot;</span>
            <span className="term-ok">4 matching sessions · same file pair · same verify miss</span>
            <span aria-hidden="true">&nbsp;</span>
            <span><b>$</b> axctl retro pending</span>
            <span className="term-warn">3 sessions need review · 1 repeats a known failure</span>
            <span className="term-muted">proposal: post-feature-verify skill</span>
            <span aria-hidden="true">&nbsp;</span>
            <span><b>$</b> axctl improve verdict post-feature-verify</span>
            <span className="term-ok">adopted · +30 sessions · 0 repeat incidents</span>
          </code>
        </div>

        <div className="proof-run" aria-label="ax first run sequence">
          <div className="proof-step">
            <span className="proof-num">01</span>
            <strong>ingest</strong>
            <p>Read the logs already on your laptop.</p>
          </div>
          <div className="proof-step">
            <span className="proof-num">02</span>
            <strong>recall</strong>
            <p>Find the prior failure before the agent repeats it.</p>
          </div>
          <div className="proof-step">
            <span className="proof-num">03</span>
            <strong>retro</strong>
            <p>Turn what happened into a structured next bet.</p>
          </div>
          <div className="proof-step">
            <span className="proof-num">04</span>
            <strong>verdict</strong>
            <p>Keep the change only if future sessions prove it.</p>
          </div>
        </div>
      </div>

      <div className="claims">
        <span>retro at every session-end</span>
        <span>Claude · Codex · Pi · OpenCode · Cursor</span>
        <span>experiments with +3 / +10 / +30 session verdicts</span>
        <span>100% local</span>
      </div>

      <div className="install-block">
        <p className="install-label">install in 30 seconds</p>
        <pre className="install">
          <code>
            <span className="prompt">$</span>{" "}
            curl -fsSL https://raw.githubusercontent.com/Necmttn/ax/main/install.sh | bash
          </code>
        </pre>
        <p className="install-meta">
          macOS first &middot; Linux for CLI &middot; runs on your laptop &middot;{" "}
          <a href="#install">nix install &rarr;</a>
        </p>
      </div>

      <div className="cta">
        <Link className="btn" to="/origin">Read the origin &nbsp;→</Link>
        <a className="btn-secondary" href="https://github.com/Necmttn/ax" target="_blank" rel="noopener noreferrer">View on GitHub</a>
      </div>
    </section>
  );
}
