import { createFileRoute, notFound } from "@tanstack/react-router";
import { MDXContent } from "@content-collections/mdx/react";
import { allHowItWorks } from "content-collections";
import { mdxComponents } from "~/components/mdx-components";

export const Route = createFileRoute("/how-it-works")({
  loader: () => {
    const page = allHowItWorks[0];
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
