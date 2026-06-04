import { createFileRoute, Link } from "@tanstack/react-router";
import { allAdrs, allPages } from "content-collections";
import { SiteHeader } from "~/components/landing-sections/site-header";
import { SiteFooter } from "~/components/landing-sections/site-footer";

export const Route = createFileRoute("/docs/")({
  head: () => ({
    meta: [
      { title: "Docs - ax" },
      { name: "description", content: "Reference, guides, and architecture decision records for ax." },
    ],
  }),
  loader: () => ({
    adrs: [...allAdrs].sort((a, b) => a.slug.localeCompare(b.slug)),
    pageCount: allPages.length,
  }),
  component: DocsIndex,
});

const REFERENCE = [
  {
    to: "/how-it-works" as const,
    kicker: "guide",
    title: "How ax sees your work",
    blurb: "From raw transcripts to a typed graph - the ingest pipeline, stage by stage.",
  },
  {
    to: "/docs/language" as const,
    kicker: "reference",
    title: "Language",
    blurb: "The shared vocabulary - sessions, turns, roles, verdicts, and how they connect.",
  },
  {
    to: "/docs/cli-reference" as const,
    kicker: "reference",
    title: "CLI reference",
    blurb: "Every ax command, flag, and scoped query you can run from the terminal.",
  },
  {
    to: "/changelog" as const,
    kicker: "releases",
    title: "Changelog",
    blurb: "Release announcements in product language, plus the generated commit log.",
  },
  {
    to: "/manifesto" as const,
    kicker: "position paper",
    title: "Manifesto",
    blurb: "Why the agent experience layer needs to exist at all.",
  },
  {
    to: "/brand" as const,
    kicker: "brand",
    title: "Brand",
    blurb: "Voice, wordmark, and palette for anyone referencing ax.",
  },
];

function DocsIndex() {
  const { adrs } = Route.useLoaderData();
  return (
    <>
      <SiteHeader />
      <main className="docs-page">
        <header className="docs-hero">
          <p className="eyebrow">documentation</p>
          <h1>
            Everything ax <em>knows how to tell you</em>.
          </h1>
          <p className="lede">
            Reference for the CLI and the graph language, the guides behind the
            pipeline, and the architecture decisions that got us here.
          </p>
        </header>

        <section className="docs-section">
          <div className="section-kicker">reference &amp; guides</div>
          <div className="docs-grid">
            {REFERENCE.map((item) => (
              <Link key={item.to} to={item.to} className="docs-card">
                <span className="docs-card-kicker">{item.kicker}</span>
                <span className="docs-card-title">{item.title}</span>
                <span className="docs-card-blurb">{item.blurb}</span>
                <span className="docs-card-arrow" aria-hidden="true">→</span>
              </Link>
            ))}
          </div>
        </section>

        <section className="docs-section">
          <div className="section-kicker">architecture decision records</div>
          <ul className="docs-adr-list">
            {adrs.map((adr) => (
              <li key={adr.slug}>
                <Link to="/docs/adr/$slug" params={{ slug: adr.slug }}>
                  <span className="adr-slug">{adr.slug.replace(/^(\d+)-.*/, "ADR $1")}</span>
                  <span className="adr-title">{adr.title}</span>
                  <span className="adr-arrow" aria-hidden="true">→</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
