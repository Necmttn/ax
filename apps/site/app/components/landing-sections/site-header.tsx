import { ForesightLink } from "@ax/foresight";

export function SiteHeader() {
  return (
    <header className="site-head">
      <div className="brand-cluster">
        <ForesightLink to="/" className="brand" aria-label="ax home">
          <span className="wordmark">ax</span>
          <span className="brand-tag">agent experience</span>
        </ForesightLink>
        <span className="status-cluster">
          <span className="live" title="agent experience layer is alive">live</span>
          <ForesightLink
            to="/changelog"
            className="version-badge"
            title={`ax v${__AX_VERSION__} - see changelog`}
          >
            v{__AX_VERSION__}
          </ForesightLink>
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
        <div className="nav-group">
          <button type="button" className="nav-group-btn" aria-haspopup="true">
            Product
            <svg className="nav-caret" viewBox="0 0 10 6" width="10" height="6" aria-hidden="true">
              <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <div className="nav-menu">
            <span className="nav-menu-label">Product</span>
            <ForesightLink to="/features">Features</ForesightLink>
            <ForesightLink to="/routing">Routing</ForesightLink>
            <ForesightLink to="/how-it-works">How it works</ForesightLink>
          </div>
        </div>

        <div className="nav-group">
          <button type="button" className="nav-group-btn" aria-haspopup="true">
            Community
            <svg className="nav-caret" viewBox="0 0 10 6" width="10" height="6" aria-hidden="true">
              <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <div className="nav-menu">
            <span className="nav-menu-label">Community</span>
            <ForesightLink to="/showcases">Showcases</ForesightLink>
            <ForesightLink to="/leaders">Leaders</ForesightLink>
            <ForesightLink to="/patterns">Patterns</ForesightLink>
          </div>
        </div>

        <ForesightLink to="/blog">Blog</ForesightLink>
        <ForesightLink to="/docs">Docs</ForesightLink>
        <a
          className="nav-icon"
          href="https://github.com/Necmttn/ax"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="ax on GitHub"
          title="ax on GitHub"
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
        </a>
        <ForesightLink className="primary" to="/" hash="install">Install</ForesightLink>
      </nav>
    </header>
  );
}
