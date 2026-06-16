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
  directory: "../../docs/adr",
  include: "*.md",
  // `content` is the raw markdown (required by @content-collections/mdx
  // 0.15+ to silence the implicit-content deprecation). Downstream
  // consumers should use `body` (compiled MDX), not `content`.
  schema: z.object({
    title: z.string().optional(),
    content: z.string(),
  }),
  transform: async (doc, ctx) => {
    const body = await compileMDX(ctx, doc, mdxOptions);
    const slug = doc._meta.fileName.replace(/\.md$/, "");
    const title = doc.title ?? slug
      .replace(/^\d+-/, "")
      .replace(/-/g, " ")
      .replace(/^\w/, (c) => c.toUpperCase());
    return { ...doc, slug, title, body };
  },
});

const releaseAnnouncements = defineCollection({
  name: "releaseAnnouncements",
  directory: "../../docs/releases",
  include: "v*.md",
  schema: z.object({
    version: z.string(),
    date: z.string(),
    title: z.string(),
    summary: z.string(),
    content: z.string(),
  }),
  transform: async (doc, ctx) => {
    const body = await compileMDX(ctx, doc, mdxOptions);
    const slug = doc._meta.fileName.replace(/\.md$/, "");
    return { ...doc, slug, body };
  },
});

const changelog = defineCollection({
  name: "changelog",
  directory: "../..",
  include: "CHANGELOG.md",
  schema: z.object({
    content: z.string(),
  }),
  transform: async (doc, ctx) => {
    const body = await compileMDX(ctx, doc, mdxOptions);
    return { ...doc, slug: "changelog", body };
  },
});

const howItWorks = defineCollection({
  name: "howItWorks",
  directory: "../../docs",
  include: "how-ax-sees-your-work.mdx",
  schema: z.object({
    content: z.string(),
  }),
  transform: async (doc, ctx) => {
    // Inline-fetch the Task 6 generated partial and splice it where the
    // source MDX has a <StageRationales /> placeholder. Survives a missing
    // generated file (empty injection) so a cold checkout before the
    // extractor runs doesn't crash MDX compile.
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    // Resolve from process.cwd() (which is apps/site/ for both `bun run dev`
    // and `bun run build`) using the same relative path as this
    // collection's `directory` config. Can't use `import.meta.url` because
    // content-collections compiles this config into
    // `.content-collections/cache/`, which would mis-anchor the lookup.
    // `doc._meta.filePath` is the bare filename in this version
    // (verified in `.content-collections/generated/allHowItWorks.js`),
    // so dirname() on it alone returns "." and doesn't help either.
    const generatedPath = join(
      process.cwd(),
      "..",
      "..",
      "docs",
      "how-ax-sees-your-work.generated.mdx",
    );
    let generated = "";
    try {
      generated = await readFile(generatedPath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        // Real IO/permissions/encoding failure - surface it. ENOENT is the
        // legitimate "cold checkout, extractor hasn't fired" case.
        console.warn(
          `[howItWorks] could not read generated partial at ${generatedPath}: ${(err as Error).message}`,
        );
      }
    }
    const placeholder = /<StageRationales\s*\/>/;
    if (!placeholder.test(doc.content)) {
      console.warn(
        "[howItWorks] <StageRationales /> placeholder not found in MDX - generated stage section will not appear",
      );
    }
    const merged = doc.content.replace(placeholder, generated);
    const body = await compileMDX(ctx, { ...doc, content: merged }, mdxOptions);
    return { ...doc, body };
  },
});

const blog = defineCollection({
  name: "blog",
  directory: "content/blog",
  include: "*.md",
  schema: z.object({
    title: z.string(),
    date: z.string(),
    excerpt: z.string(),
    tags: z.array(z.string()).optional(),
    draft: z.boolean().optional(),
    content: z.string(),
  }),
  transform: async (doc, ctx) => {
    const body = await compileMDX(ctx, doc, mdxOptions);
    const slug = doc._meta.fileName.replace(/\.md$/, "");
    return { ...doc, slug, body };
  },
});

export default defineConfig({ content: [adrs, howItWorks, releaseAnnouncements, changelog, blog] });
