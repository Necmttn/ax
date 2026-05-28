export function SiteHeader() {
  return (
    <header className="site-head">
      <div className="brand">
        <span className="wordmark">ax</span>
        <span className="brand-tag">agent experience</span>
      </div>
      <span className="live" title="agent experience layer is alive">live</span>
      <nav className="top-nav">
        <a href="#what">What</a>
        <a href="#how">How</a>
        <a href="#change">Change</a>
        <a href="#demo">Demo</a>
        <a href="#install">Install</a>
        <a href="/origin">Origin</a>
        <a className="primary" href="https://github.com/Necmttn/ax">GitHub →</a>
      </nav>
    </header>
  );
}
