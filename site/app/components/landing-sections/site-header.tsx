export function SiteHeader() {
  return (
    <header className="site-head">
      <div className="brand">
        <span className="wordmark">ax</span>
        <span className="brand-tag">agent experience</span>
      </div>
      <span className="live" title="agent experience layer is alive">live</span>
      <nav className="top-nav">
        <a href="/features">Features</a>
        <a href="/showcases">Showcases</a>
        <a href="/how-it-works">How</a>
        <a href="/docs">Docs</a>
        <a href="/origin">Origin</a>
        <a className="primary" href="https://github.com/Necmttn/ax" target="_blank" rel="noopener noreferrer">GitHub →</a>
      </nav>
    </header>
  );
}
