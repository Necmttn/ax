import { createFileRoute, notFound } from "@tanstack/react-router";
import { MDXContent } from "@content-collections/mdx/react";
import { allAdrs, type Adr } from "content-collections";
import { mdxComponents } from "~/components/mdx-components";
import { DocShell } from "~/components/doc-shell";

type AdrLoaderData = { adr: Adr };

function loadAdr({ params }: { params: { slug: string } }): AdrLoaderData {
  const adr = allAdrs.find((a) => a.slug === params.slug);
  if (!adr) throw notFound();
  return { adr };
}

export const Route = createFileRoute("/docs/adr/$slug")({
  head: ({ loaderData }) => ({
    meta: [
      {
        title: `${(loaderData as AdrLoaderData | undefined)?.adr.title ?? "ADR"} - ax`,
      },
      // ADRs are internal engineering records, not visitor-facing docs.
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  loader: loadAdr,
  component: AdrPage,
});

function AdrPage() {
  const { adr } = Route.useLoaderData() as AdrLoaderData;
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
