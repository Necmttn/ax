import { createFileRoute, notFound } from "@tanstack/react-router";
import { MDXContent } from "@content-collections/mdx/react";
import { allHowItWorks } from "content-collections";
import { mdxComponents } from "~/components/mdx-components";
import { DocShell } from "~/components/doc-shell";

export const Route = createFileRoute("/how-it-works")({
  head: () => ({
    meta: [
      { title: "How ax sees your work - ax" },
      { name: "description", content: "How ax ingests transcripts, builds the graph, and derives stages." },
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
      <DocShell eyebrow="how it works">
        <MDXContent code={page.body} components={mdxComponents} />
      </DocShell>
    );
  },
});
