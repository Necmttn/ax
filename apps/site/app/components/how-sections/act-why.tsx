import { Link } from "@tanstack/react-router";

// CLOSING - "Why this shape" editorial, tightened to ~half the old length.
// Two convictions: local-first (rendered as a 127.0.0.1 chip - it IS a
// receipt) and graph-not-vector. Ends with an install CTA + /routing + /features.
// Never links the ADR index.

const INSTALL_CMD = "curl -fsSL ax.necmttn.com/install | sh";

export function ActWhy() {
  return (
    <section className="how-act how-act--why">
      <div className="how-act-inner">
        <header className="how-act-head">
          <p className="how-eyebrow">$ why this shape</p>
          <h2 className="how-headline">Two convictions, one design.</h2>
        </header>

        <div className="how-why-grid">
          <article className="how-why-card">
            <span className="how-why-chip">
              <span className="how-why-chip-dot" aria-hidden="true" />
              127.0.0.1:8521
            </span>
            <h3 className="how-why-title">Local-first by construction.</h3>
            <p className="how-why-body">
              The graph runs on your machine. Nothing is transmitted, no key is
              required to read your own history, and you can inspect or delete
              any of it. The subject matter &mdash; what you tried, what failed,
              what to try next &mdash; only belongs in one place.
            </p>
          </article>

          <article className="how-why-card">
            <span className="how-why-chip how-why-chip--mono">
              <code>RELATE</code>
            </span>
            <h3 className="how-why-title">A graph, not a vector index.</h3>
            <p className="how-why-body">
              The questions worth asking are relational: which tool calls
              preceded this correction, does this skill show up in the sessions
              that ship. A similarity search loses that connective tissue. An
              edge between a session and a commit keeps it as a fact.
            </p>
          </article>
        </div>

        <div className="how-cta">
          <p className="how-cta-eyebrow">install in 30 seconds</p>
          <code className="how-cta-cmd">{INSTALL_CMD}</code>
          <div className="how-cta-links">
            <Link to="/routing" className="how-cta-link">
              See cost routing &rarr;
            </Link>
            <Link to="/features" className="how-cta-link">
              Every feature &rarr;
            </Link>
          </div>
        </div>

        <p className="how-curious">
          For the curious: the table inventory, the <code>@rationale</code>{" "}
          extractor, and the rest of the ingest internals live in the{" "}
          <Link to="/docs/architecture">architecture reference &rarr;</Link>
        </p>
      </div>
    </section>
  );
}
