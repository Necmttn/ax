import { createFileRoute, Link } from "@tanstack/react-router";
import { allAdrs } from "content-collections";
import { SiteHeader } from "~/components/landing-sections/site-header";
import { SiteFooter } from "~/components/landing-sections/site-footer";

export const Route = createFileRoute("/docs/")({
  head: () => ({
    meta: [
      { title: "Docs - ax" },
      {
        name: "description",
        content:
          "Learn the language and look up any command. Guides for every shipped loop plus the full CLI reference.",
      },
    ],
  }),
  loader: () => ({
    adrs: [...allAdrs].sort((a, b) => a.slug.localeCompare(b.slug)),
  }),
  component: DocsIndex,
});

type Card = {
  to: string;
  params?: Record<string, string>;
  kicker: string;
  title: string;
  blurb: string;
};

const GUIDES: Card[] = [
  {
    to: "/features",
    kicker: "guide",
    title: "The improve deck",
    blurb:
      "Mined proposals reviewed one at a time, an impact engine, and the experiments strip - past bets, measured.",
  },
  {
    to: "/routing",
    kicker: "guide",
    title: "Cost routing",
    blurb:
      "ax dispatches and ax routing tune|compile|show route mechanical work to cheaper models. Receipts, not vibes.",
  },
  {
    to: "/features",
    kicker: "guide",
    title: "Hooks SDK",
    blurb:
      "Author typed Effect TS hooks once, run them on Claude Code and Codex. Deterministic guards, fail-open.",
  },
  {
    to: "/leaders",
    kicker: "guide",
    title: "Profiles & community",
    blurb:
      "ax profile publish posts a public gist; /u/<login> and /leaders render the registered boards.",
  },
  {
    to: "/features",
    kicker: "guide",
    title: "MCP server",
    blurb:
      "ax mcp exposes ten read-only graph queries over stdio so an agent can query your history in-context.",
  },
  {
    to: "/features",
    kicker: "guide",
    title: "Quota, recall & churn",
    blurb:
      "ax quota tracks live plan usage; ax recall searches turns, commits and skills; ax sessions churn measures verification churn.",
  },
];

const REFERENCE: Card[] = [
  {
    to: "/docs/cli-reference",
    kicker: "reference",
    title: "CLI reference",
    blurb: "Every ax command, flag, and scoped query you can run from the terminal.",
  },
  {
    to: "/docs/language",
    kicker: "reference",
    title: "Language",
    blurb: "The shared vocabulary - sessions, turns, roles, verdicts, and how they connect.",
  },
  {
    to: "/docs/architecture",
    kicker: "reference",
    title: "Architecture",
    blurb: "The graph shape, the derived tables, and the typed readers built on top - for the curious.",
  },
  {
    to: "/changelog",
    kicker: "releases",
    title: "Changelog",
    blurb: "Release announcements in product language, plus the generated commit log.",
  },
];

function CardGrid({ cards }: { cards: Card[] }) {
  return (
    <div className="docs-grid">
      {cards.map((item, i) => (
        <Link
          key={`${item.to}-${i}`}
          to={item.to}
          params={item.params}
          className="docs-card"
        >
          <span className="docs-card-kicker">{item.kicker}</span>
          <span className="docs-card-title">{item.title}</span>
          <span className="docs-card-blurb">{item.blurb}</span>
          <span className="docs-card-arrow" aria-hidden="true">→</span>
        </Link>
      ))}
    </div>
  );
}

function DocsIndex() {
  const { adrs } = Route.useLoaderData();
  return (
    <>
      <SiteHeader />
      <main className="docs-page">
        <header className="docs-hero">
          <p className="eyebrow">documentation</p>
          <h1>
            Learn the language, <em>look up any command</em>.
          </h1>
          <p className="lede">
            The guides behind each shipped loop, then the full command
            reference.
          </p>
        </header>

        <section className="docs-section">
          <div className="section-kicker">guides</div>
          <CardGrid cards={GUIDES} />
        </section>

        <section className="docs-section">
          <div className="section-kicker">reference</div>
          <CardGrid cards={REFERENCE} />
        </section>

        <section className="docs-section docs-quiet">
          <details className="docs-quiet-records">
            <summary>
              Engineering records →
              <span className="docs-quiet-note">
                {adrs.length} internal architecture decision records
              </span>
            </summary>
            <ul className="docs-adr-list">
              {adrs.map((adr) => (
                <li key={adr.slug}>
                  <Link to="/docs/adr/$slug" params={{ slug: adr.slug }}>
                    <span className="adr-slug">
                      {adr.slug.replace(/^(\d+)-.*/, "$1")}
                    </span>
                    <span className="adr-title">{adr.title}</span>
                    <span className="adr-arrow" aria-hidden="true">→</span>
                  </Link>
                </li>
              ))}
            </ul>
          </details>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
