import { createFileRoute, notFound } from "@tanstack/react-router";
import { MDXContent } from "@content-collections/mdx/react";
import { allPages } from "content-collections";
import { mdxComponents } from "~/components/mdx-components";
import { DocShell } from "~/components/doc-shell";

export const Route = createFileRoute("/manifesto")({
  head: () => ({
    meta: [
      { title: "Manifesto - ax" },
      { name: "description", content: "Why ax exists - the agent experience layer." },
    ],
  }),
  loader: () => {
    const page = allPages.find((p) => p.slug === "manifesto");
    if (!page) throw notFound();
    return { page };
  },
  component: () => {
    const { page } = Route.useLoaderData();
    return (
      <DocShell eyebrow="position paper">
        <MDXContent code={page.body} components={mdxComponents} />
      </DocShell>
    );
  },
});
