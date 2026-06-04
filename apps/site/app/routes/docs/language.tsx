import { createFileRoute, notFound } from "@tanstack/react-router";
import { MDXContent } from "@content-collections/mdx/react";
import { allPages } from "content-collections";
import { mdxComponents } from "~/components/mdx-components";
import { DocShell } from "~/components/doc-shell";

export const Route = createFileRoute("/docs/language")({
  head: () => ({
    meta: [
      { title: "Language - ax" },
      { name: "description", content: "The shared vocabulary ax uses to describe agent work." },
    ],
  }),
  loader: () => {
    const page = allPages.find((p) => p.slug === "language");
    if (!page) throw notFound();
    return { page };
  },
  component: () => {
    const { page } = Route.useLoaderData();
    return (
      <DocShell eyebrow="reference">
        <MDXContent code={page.body} components={mdxComponents} />
      </DocShell>
    );
  },
});
