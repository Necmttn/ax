import { defineCollection, defineConfig } from "@content-collections/core";
import { compileMDX } from "@content-collections/mdx";
import rehypePrettyCode from "rehype-pretty-code";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import remarkGfm from "remark-gfm";
import { z } from "zod";
import type { Options } from "@content-collections/mdx";

const mdxOptions: Options = {
  remarkPlugins: [remarkGfm],
  rehypePlugins: [
    rehypeSlug,
    [rehypePrettyCode, { theme: "github-dark" }],
    [rehypeAutolinkHeadings, { behavior: "wrap" }],
  ],
};

const adrs = defineCollection({
  name: "adrs",
  directory: "../docs/adr",
  include: "*.md",
  schema: z.object({
    title: z.string().optional(),
    content: z.string(),
  }),
  transform: async (doc, ctx) => {
    const body = await compileMDX(ctx, doc, mdxOptions);
    const slug = doc._meta.fileName.replace(/\.md$/, "");
    const title = doc.title ?? slug.replace(/^\d+-/, "").replace(/-/g, " ");
    return { ...doc, slug, title, body };
  },
});

const pages = defineCollection({
  name: "pages",
  directory: "../docs",
  include: ["manifesto.md", "brand.md", "language.md", "insights-cli-reference.md"],
  schema: z.object({
    content: z.string(),
  }),
  transform: async (doc, ctx) => {
    const body = await compileMDX(ctx, doc, mdxOptions);
    const slug = doc._meta.fileName.replace(/\.md$/, "");
    return { ...doc, slug, body };
  },
});

export default defineConfig({ content: [adrs, pages] });
