import { createFileRoute, notFound } from "@tanstack/react-router";
import { MDXContent } from "@content-collections/mdx/react";
import { allPages } from "content-collections";
import { mdxComponents } from "~/components/mdx-components";
import { DocShell } from "~/components/doc-shell";

export const Route = createFileRoute("/docs/cli-reference")({
  head: () => ({
    meta: [
      { title: "CLI reference - ax" },
      { name: "description", content: "Command reference for the ax CLI." },
    ],
  }),
  loader: () => {
    const page = allPages.find((p) => p.slug === "insights-cli-reference");
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
