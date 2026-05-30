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
        <a href="#agents">Agents</a>
        <a href="#how">How</a>
        <a href="#change">Change</a>
        <a href="#demo">Demo</a>
        <a href="#install">Install</a>
        <a href="/showcases">Showcases</a>
        <a href="/changelog">Changelog</a>
        {/* /origin route lands in Task 5; plain <a> for now */}
        <a href="/origin">Origin</a>
        <a className="primary" href="https://github.com/Necmttn/ax" target="_blank" rel="noopener noreferrer">GitHub →</a>
      </nav>
    </header>
  );
}
