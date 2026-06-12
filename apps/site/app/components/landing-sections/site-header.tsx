import { Link } from "@tanstack/react-router";

export function SiteHeader() {
  return (
    <header className="site-head">
      <div className="brand-cluster">
        <Link to="/" className="brand" aria-label="ax home">
          <span className="wordmark">ax</span>
          <span className="brand-tag">agent experience</span>
        </Link>
        <span className="status-cluster">
          <span className="live" title="agent experience layer is alive">live</span>
          <Link
            to="/changelog"
            className="version-badge"
            title={`ax v${__AX_VERSION__} - see changelog`}
          >
            v{__AX_VERSION__}
          </Link>
        </span>
      </div>

      {/* CSS-only mobile menu toggle (no JS / prerender-safe) */}
      <input type="checkbox" id="nav-toggle" className="nav-toggle" aria-hidden="true" />
      <label htmlFor="nav-toggle" className="nav-burger" aria-label="Toggle navigation menu">
        <span />
        <span />
        <span />
      </label>

      <nav className="top-nav">
        <Link to="/features">Features</Link>
        <Link to="/showcases">Showcases</Link>
        <Link to="/leaders">Leaders</Link>
        <Link to="/how-it-works">How</Link>
        <Link to="/docs">Docs</Link>
        <Link to="/changelog">Changelog</Link>
        <Link to="/origin">Origin</Link>
        <a className="primary" href="https://github.com/Necmttn/ax" target="_blank" rel="noopener noreferrer">GitHub →</a>
      </nav>
    </header>
  );
}
