import { createFileRoute, notFound } from "@tanstack/react-router";
import { MDXContent } from "@content-collections/mdx/react";
import { allAdrs } from "content-collections";
import { mdxComponents } from "~/components/mdx-components";
import { DocShell } from "~/components/doc-shell";

export const Route = createFileRoute("/docs/adr/$slug")({
  head: ({ loaderData }) => ({
    meta: [
      { title: `${loaderData?.adr.title ?? "ADR"} - ax` },
      // ADRs are internal engineering records, not visitor-facing docs.
      { name: "robots", content: "noindex, nofollow" },
    ],
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
  // The markdown body carries its own H1, so DocShell renders no title here -
  // that avoids a second, slug-mangled headline competing with the real one.
  return (
    <DocShell eyebrow="architecture decision record">
      <p className="adr-preface">
        Internal working engineering record - kept for reference, not a
        user-facing guide.
      </p>
      <MDXContent code={adr.body} components={mdxComponents} />
    </DocShell>
  );
}
