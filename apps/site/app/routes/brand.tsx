import { createFileRoute, notFound } from "@tanstack/react-router";
import { MDXContent } from "@content-collections/mdx/react";
import { allPages } from "content-collections";
import { mdxComponents } from "~/components/mdx-components";
import { DocShell } from "~/components/doc-shell";

export const Route = createFileRoute("/brand")({
  head: () => ({
    meta: [
      { title: "Brand - ax" },
      { name: "description", content: "ax brand guidelines: voice, wordmark, and palette." },
    ],
  }),
  loader: () => {
    const page = allPages.find((p) => p.slug === "brand");
    if (!page) throw notFound();
    return { page };
  },
  component: () => {
    const { page } = Route.useLoaderData();
    return (
      <DocShell eyebrow="brand">
        <MDXContent code={page.body} components={mdxComponents} />
      </DocShell>
    );
  },
});
