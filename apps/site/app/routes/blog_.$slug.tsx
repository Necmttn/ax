import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { MDXContent } from "@content-collections/mdx/react";
import { allBlogs } from "content-collections";
import { mdxComponents } from "~/components/mdx-components";
import { SiteFooter } from "~/components/landing-sections/site-footer";
import { SiteHeader } from "~/components/landing-sections/site-header";

const SITE_ORIGIN = "https://ax.necmttn.com";
// Bump to bust cached OG renders when the blog card template changes.
const OG_BLOG_REV = 1;

function ogImageUrl(slug: string, title: string, date: string): string {
  const q = new URLSearchParams({
    title,
    date,
    r: String(OG_BLOG_REV),
  });
  return `${SITE_ORIGIN}/og-blog/${slug}?${q.toString()}`;
}

function fmtDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${months[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

export const Route = createFileRoute("/blog_/$slug")({
  // NOTE: like every dynamic content-collections route in this app
  // (docs/adr.$slug, changelog_.$version), the strict site typecheck does not
  // thread loaderData's type into `head` - it reads as `never`. Accepted,
  // pre-existing repo-wide pattern; the build/runtime are correct. Matching the
  // adr-style optional-chain shape here for consistency.
  head: ({ loaderData }) => {
    const post = loaderData?.post;
    if (!post) return { meta: [{ title: "Blog - ax" }] };
    const og = ogImageUrl(post.slug, post.title, post.date);
    return {
      meta: [
        { title: `${post.title} - ax` },
        { name: "description", content: post.excerpt },
        { property: "og:type", content: "article" },
        { property: "og:title", content: post.title },
        { property: "og:description", content: post.excerpt },
        { property: "og:image", content: og },
        { property: "og:image:width", content: "1200" },
        { property: "og:image:height", content: "630" },
        { name: "twitter:card", content: "summary_large_image" },
        { name: "twitter:title", content: post.title },
        { name: "twitter:description", content: post.excerpt },
        { name: "twitter:image", content: og },
      ],
    };
  },
  loader: ({ params }) => {
    const post = allBlogs.find((p) => p.slug === params.slug);
    if (!post) throw notFound();
    return { post };
  },
  component: BlogPost,
});

function BlogPost() {
  const { post } = Route.useLoaderData();
  // The markdown body carries its own H1, so we render only a date eyebrow
  // above it - no second, competing headline.
  return (
    <>
      <SiteHeader />
      <main className="doc-main blog-post">
        <nav className="doc-crumb" aria-label="breadcrumb">
          <Link to="/blog">← Blog</Link>
        </nav>
        <p className="blog-post-date">{fmtDate(post.date)}</p>
        <article className="prose">
          <MDXContent code={post.body} components={mdxComponents} />
        </article>
      </main>
      <SiteFooter />
    </>
  );
}
