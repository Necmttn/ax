import { createFileRoute, notFound } from "@tanstack/react-router";
import { MDXContent } from "@content-collections/mdx/react";
import { allAdrs } from "content-collections";
import { mdxComponents } from "~/components/mdx-components";

export const Route = createFileRoute("/docs/adr/$slug")({
  loader: ({ params }) => {
    const adr = allAdrs.find((a) => a.slug === params.slug);
    if (!adr) throw notFound();
    return { adr };
  },
  component: AdrPage,
});

function AdrPage() {
  const { adr } = Route.useLoaderData();
  return (
    <main className="max-w-3xl mx-auto p-8">
      <h1 className="text-3xl font-semibold mb-8">{adr.title}</h1>
      <article>
        <MDXContent code={adr.body} components={mdxComponents} />
      </article>
    </main>
  );
}
