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

      <div className="claims">
        <span>retro at every session-end</span>
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
        <a className="btn" href="/origin">Read the origin &nbsp;→</a>
        <a className="btn-secondary" href="https://github.com/Necmttn/ax">View on GitHub</a>
      </div>
    </section>
  );
}
