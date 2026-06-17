import { Link } from "@tanstack/react-router";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <nav className="footer-sitemap" aria-label="Footer">
        <div className="footer-col">
          <div className="footer-col-head">Product</div>
          <Link to="/features">Features</Link>
          <Link to="/routing">Routing</Link>
          <Link to="/showcases">Showcases</Link>
          <Link to="/changelog">Changelog</Link>
        </div>
        <div className="footer-col">
          <div className="footer-col-head">Story</div>
          <Link to="/origin">Origin</Link>
          <Link to="/manifesto">Manifesto</Link>
        </div>
        <div className="footer-col">
          <div className="footer-col-head">Community</div>
          <Link to="/leaders">Leaders</Link>
          <a href="https://github.com/Necmttn/ax" target="_blank" rel="noopener noreferrer">GitHub</a>
          <a href="https://discord.gg/E4R88Cvr5R" target="_blank" rel="noopener noreferrer">Discord</a>
        </div>
        <div className="footer-col">
          <div className="footer-col-head">Docs</div>
          <Link to="/" hash="install">Install</Link>
          <Link to="/docs/cli-reference">CLI reference</Link>
          <Link to="/docs/language">Concepts</Link>
        </div>
      </nav>

      <div className="footer-base">
        <div className="footer-base-links">
          <Link to="/teams">For teams</Link>
          <span aria-hidden="true">·</span>
          <Link to="/registry">Registry</Link>
          <span aria-hidden="true">·</span>
          <Link to="/brand">Brand</Link>
        </div>
        <div className="footer-base-meta">
          AGPL-3.0 licensed &nbsp;·&nbsp; 2026 &nbsp;·&nbsp; the missing layer
        </div>
      </div>
    </footer>
  );
}
