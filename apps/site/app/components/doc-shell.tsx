import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { SiteHeader } from "~/components/landing-sections/site-header";
import { SiteFooter } from "~/components/landing-sections/site-footer";

type DocShellProps = {
  eyebrow?: string;
  title?: string;
  /** Optional short standfirst rendered under the title. */
  lede?: string;
  children: ReactNode;
};

/**
 * Shared chrome for long-form / MDX documents (manifesto, how-it-works,
 * brand, CLI reference, ADRs). Provides the site header/footer, a consistent
 * editorial header, a back-to-docs crumb, and the `.prose` typography scope so
 * every documentation page reads the same.
 */
export function DocShell({ eyebrow, title, lede, children }: DocShellProps) {
  return (
    <>
      <SiteHeader />
      <main className="doc-main">
        <nav className="doc-crumb" aria-label="breadcrumb">
          <Link to="/docs">← Docs</Link>
        </nav>
        {(eyebrow || title || lede) && (
          <header className="doc-head">
            {eyebrow && <p className="eyebrow">{eyebrow}</p>}
            {title && <h1>{title}</h1>}
            {lede && <p className="lede">{lede}</p>}
          </header>
        )}
        <article className="prose">{children}</article>
      </main>
      <SiteFooter />
    </>
  );
}
