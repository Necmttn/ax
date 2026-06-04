import { createFileRoute, notFound } from "@tanstack/react-router";
import { MDXContent } from "@content-collections/mdx/react";
import { allAdrs } from "content-collections";
import { mdxComponents } from "~/components/mdx-components";
import { DocShell } from "~/components/doc-shell";

export const Route = createFileRoute("/docs/adr/$slug")({
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.adr.title ?? "ADR"} - ax` }],
  }),
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
    <DocShell eyebrow="architecture decision record" title={adr.title}>
      <MDXContent code={adr.body} components={mdxComponents} />
    </DocShell>
  );
}
