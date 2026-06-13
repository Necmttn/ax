import { createFileRoute, notFound } from "@tanstack/react-router";
import { MDXContent } from "@content-collections/mdx/react";
import { allHowItWorks } from "content-collections";
import { mdxComponents } from "~/components/mdx-components";
import { DocShell } from "~/components/doc-shell";

// The architecture reference: the schema/table inventory, the @rationale
// extractor mechanics, and the rest of the ingest internals. Demoted here from
// /how-it-works (now the visual product narrative). Renders the
// how-ax-sees-your-work MDX via the existing allHowItWorks collection.
export const Route = createFileRoute("/docs/architecture")({
  head: () => ({
    meta: [
      { title: "Architecture reference - ax" },
      {
        name: "description",
        content:
          "The shape of the ax graph, the derived tables, and the typed readers built on top. For the curious - the product narrative lives at /how-it-works.",
      },
    ],
  }),
  loader: () => {
    const page = allHowItWorks[0];
    if (!page) throw notFound();
    return { page };
  },
  component: () => {
    const { page } = Route.useLoaderData();
    return (
      <DocShell eyebrow="architecture reference">
        <MDXContent code={page.body} components={mdxComponents} />
      </DocShell>
    );
  },
});
