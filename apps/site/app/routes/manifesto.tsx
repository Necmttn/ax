import { createFileRoute, notFound } from "@tanstack/react-router";
import { MDXContent } from "@content-collections/mdx/react";
import { allPages } from "content-collections";
import { mdxComponents } from "~/components/mdx-components";

export const Route = createFileRoute("/manifesto")({
  loader: () => {
    const page = allPages.find((p) => p.slug === "manifesto");
    if (!page) throw notFound();
    return { page };
  },
  component: () => {
    const { page } = Route.useLoaderData();
    return (
      <main className="max-w-3xl mx-auto p-8">
        <article>
          <MDXContent code={page.body} components={mdxComponents} />
        </article>
      </main>
    );
  },
});
