import { Link } from "@tanstack/react-router";

export function SiteHeader() {
  return (
    <header className="site-head">
      <Link to="/" className="brand" aria-label="ax home">
        <span className="wordmark">ax</span>
        <span className="brand-tag">agent experience</span>
      </Link>
      <span className="live" title="agent experience layer is alive">live</span>
      <nav className="top-nav">
        <Link to="/features">Features</Link>
        <Link to="/showcases">Showcases</Link>
        <Link to="/how-it-works">How</Link>
        <Link to="/docs">Docs</Link>
        <Link to="/origin">Origin</Link>
        <a className="primary" href="https://github.com/Necmttn/ax" target="_blank" rel="noopener noreferrer">GitHub →</a>
      </nav>
    </header>
  );
}
