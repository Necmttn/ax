import { Link } from "@tanstack/react-router";

type IconProps = { className?: string };

function LicenseIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 14a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" />
      <path d="M9.5 13.2 8 21l4-2 4 2-1.5-7.8" />
    </svg>
  );
}

function TypeIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7V5h16v2" />
      <path d="M12 5v14" />
      <path d="M9 19h6" />
    </svg>
  );
}

function LocalIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <ellipse cx="12" cy="5.5" rx="7" ry="2.5" />
      <path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13" />
      <path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" />
    </svg>
  );
}

function ForkIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="5" r="2.5" />
      <circle cx="18" cy="5" r="2.5" />
      <circle cx="12" cy="19" r="2.5" />
      <path d="M6 7.5v3c0 1.7 1.3 3 3 3h6c1.7 0 3-1.3 3-3v-3" />
      <path d="M12 13.5v3" />
    </svg>
  );
}

function GitHubIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49 0-.24-.01-.88-.01-1.73-2.78.62-3.37-1.37-3.37-1.37-.46-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.05 1.53 1.05.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.36-2.22-.26-4.55-1.14-4.55-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.27 2.75 1.05a9.36 9.36 0 0 1 5 0c1.91-1.32 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.48-.01 2.82 0 .27.18.6.69.49A10.02 10.02 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z" />
    </svg>
  );
}

function DiscordIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M20.32 4.94A19.5 19.5 0 0 0 15.45 3.4a.07.07 0 0 0-.08.04c-.21.38-.44.87-.6 1.25a18 18 0 0 0-5.4 0c-.17-.39-.4-.87-.62-1.25a.07.07 0 0 0-.07-.04A19.4 19.4 0 0 0 3.7 4.94a.07.07 0 0 0-.03.03C.57 9.6-.28 14.13.14 18.6a.08.08 0 0 0 .03.05 19.6 19.6 0 0 0 5.9 2.98.07.07 0 0 0 .08-.03c.45-.62.86-1.28 1.2-1.96a.07.07 0 0 0-.04-.1c-.64-.24-1.25-.54-1.84-.87a.07.07 0 0 1 0-.12c.12-.1.25-.2.36-.29a.07.07 0 0 1 .07-.01c3.86 1.76 8.03 1.76 11.85 0a.07.07 0 0 1 .08.01c.12.1.24.2.37.3a.07.07 0 0 1-.01.11c-.59.34-1.2.63-1.84.87a.07.07 0 0 0-.04.1c.35.68.76 1.34 1.2 1.96a.07.07 0 0 0 .08.03 19.5 19.5 0 0 0 5.91-2.98.07.07 0 0 0 .03-.05c.5-5.17-.84-9.66-3.54-13.63a.06.06 0 0 0-.03-.03ZM8.02 15.88c-1.17 0-2.13-1.07-2.13-2.38 0-1.31.94-2.38 2.13-2.38 1.2 0 2.15 1.08 2.13 2.38 0 1.31-.94 2.38-2.13 2.38Zm7.97 0c-1.17 0-2.13-1.07-2.13-2.38 0-1.31.94-2.38 2.13-2.38 1.2 0 2.15 1.08 2.13 2.38 0 1.31-.93 2.38-2.13 2.38Z" />
    </svg>
  );
}

function DocsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H17a2 2 0 0 1 2 2v15.5a.5.5 0 0 1-.74.44A4 4 0 0 0 16.5 20H6.5A1.5 1.5 0 0 1 5 18.5Z" />
      <path d="M5 17.5A1.5 1.5 0 0 1 6.5 16H19" />
      <path d="M9 7.5h6M9 11h4" />
    </svg>
  );
}

const proofCards = [
  {
    title: "AGPL-3.0",
    detail: "Free & open · commercial license available",
    accent: "ink" as const,
    Icon: LicenseIcon,
  },
  {
    title: "TypeScript",
    detail: "End-to-end, strictly typed",
    accent: "blue" as const,
    Icon: TypeIcon,
  },
  {
    title: "Local-first",
    detail: "SurrealDB on 127.0.0.1",
    accent: "green" as const,
    Icon: LocalIcon,
  },
  {
    title: "Forkable",
    detail: "Hack the loop, ship a PR",
    accent: "ink" as const,
    Icon: ForkIcon,
  },
];

export function OpenSourceSection() {
  return (
    <section className="open-source" aria-labelledby="open-source-title">
      <div className="open-source-head">
        <span className="eyebrow">open source</span>
        <h2 id="open-source-title">
          If it shapes your agent, you should be able to fork it.
        </h2>
        <p>
          AGPL-3.0. Local-first. Typed end to end. Every signal lives in files
          and a database you own&nbsp;&mdash; no cloud, no lock-in. Commercial
          license available if you need it.
        </p>
      </div>

      <div className="open-source-grid">
        <div className="oss-terminal" aria-label="Repository setup commands">
          <div className="oss-terminal-bar">
            <div className="browser-dots" aria-hidden="true">
              <span></span>
              <span></span>
              <span></span>
            </div>
            <span>~/code</span>
          </div>
          <div className="oss-terminal-body">
            <div className="oss-line">
              <span className="prompt">$</span>
              <code>gh repo clone Necmttn/ax</code>
            </div>
            <div className="oss-line muted">
              <span></span>
              <code>Cloned ax into ./ax</code>
            </div>
            <div className="oss-line">
              <span className="prompt">$</span>
              <code>cd ax &amp;&amp; bun install</code>
            </div>
            <div className="oss-line muted">
              <span></span>
              <code>1 284 packages installed in 4.2s</code>
            </div>
            <div className="oss-line">
              <span className="prompt">$</span>
              <code>ax daemon start</code>
            </div>
            <div className="oss-line muted">
              <span></span>
              <code>ax dashboard &rarr; http://127.0.0.1:1738</code>
            </div>
            <div className="oss-line">
              <span className="prompt">$</span>
              <span className="oss-caret" aria-hidden="true"></span>
            </div>
          </div>
        </div>

        <div className="oss-proof-grid" aria-label="Open source proof points">
          {proofCards.map(({ title, detail, accent, Icon }) => (
            <div className={`oss-proof-card accent-${accent}`} key={title}>
              <span className="oss-proof-icon" aria-hidden="true">
                <Icon />
              </span>
              <h3>{title}</h3>
              <p>{detail}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="oss-actions" aria-label="Open source links">
        <a className="oss-action primary" href="https://github.com/Necmttn/ax" target="_blank" rel="noopener noreferrer">
          <GitHubIcon className="oss-action-glyph" />
          Star on GitHub <span className="oss-action-arrow" aria-hidden="true">&rarr;</span>
        </a>
        <a className="oss-action" href="https://github.com/Necmttn/ax/fork" target="_blank" rel="noopener noreferrer">
          <ForkIcon className="oss-action-glyph" />
          Fork the repo <span className="oss-action-arrow" aria-hidden="true">&rarr;</span>
        </a>
        <a className="oss-action" href="https://discord.gg/E4R88Cvr5R" target="_blank" rel="noopener noreferrer">
          <DiscordIcon className="oss-action-glyph" />
          Join the Discord <span className="oss-action-arrow" aria-hidden="true">&rarr;</span>
        </a>
        <Link className="oss-action" to="/docs">
          <DocsIcon className="oss-action-glyph" />
          Read the docs <span className="oss-action-arrow" aria-hidden="true">&rarr;</span>
        </Link>
      </div>
    </section>
  );
}
