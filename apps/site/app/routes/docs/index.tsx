import { createFileRoute, Link } from "@tanstack/react-router";
import { allAdrs, allPages } from "content-collections";

export const Route = createFileRoute("/docs/")({
  loader: () => ({
    adrs: [...allAdrs].sort((a, b) => a.slug.localeCompare(b.slug)),
    pageCount: allPages.length,
  }),
  component: DocsIndex,
});

function DocsIndex() {
  const { adrs } = Route.useLoaderData();
  return (
    <main className="max-w-3xl mx-auto p-8">
      <h1 className="text-3xl font-semibold mb-8">Docs</h1>

      <section className="mb-12">
        <h2 className="text-xl font-semibold mb-4">Reference</h2>
        <ul className="space-y-2">
          <li><Link to="/docs/language" className="underline">Language</Link></li>
          <li><Link to="/docs/cli-reference" className="underline">CLI reference</Link></li>
          <li><Link to="/changelog" className="underline">Changelog</Link></li>
          <li><Link to="/manifesto" className="underline">Manifesto</Link></li>
          <li><Link to="/brand" className="underline">Brand</Link></li>
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-semibold mb-4">Architecture Decision Records</h2>
        <ul className="space-y-2">
          {adrs.map((adr) => (
            <li key={adr.slug}>
              <Link to="/docs/adr/$slug" params={{ slug: adr.slug }} className="underline">
                {adr.title}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
