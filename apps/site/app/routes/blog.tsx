import { createFileRoute, Link } from "@tanstack/react-router";
import { allBlogs } from "content-collections";
import { SiteFooter } from "~/components/landing-sections/site-footer";
import { SiteHeader } from "~/components/landing-sections/site-header";

export const Route = createFileRoute("/blog")({
  head: () => ({
    meta: [
      { title: "Blog - ax" },
      {
        name: "description",
        content:
          "Field notes on agent cost, routing, and telemetry - measured from real transcripts, not surveyed.",
      },
    ],
  }),
  loader: () => ({
    posts: [...allBlogs]
      .filter((p) => !p.draft)
      .sort((a, b) => b.date.localeCompare(a.date)),
  }),
  component: BlogIndex,
});

function fmtDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${months[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

function BlogIndex() {
  const { posts } = Route.useLoaderData();
  return (
    <>
      <SiteHeader />
      <main className="blog-index">
        <header className="blog-index-head">
          <p className="eyebrow">field notes</p>
          <h1>
            What the <em>transcripts</em> say.
          </h1>
          <p className="lede">
            Essays on agent cost, routing, and telemetry - every number
            measured from real sessions on one machine, not surveyed.
          </p>
        </header>

        {posts.length === 0 ? (
          <p className="muted">No posts yet.</p>
        ) : (
          <div className="blog-list">
            {posts.map((post) => (
              <article key={post.slug} className="blog-entry">
                <div className="blog-meta">
                  <time dateTime={post.date}>{fmtDate(post.date)}</time>
                  {post.tags && post.tags.length > 0 ? (
                    <span className="blog-tags">
                      {post.tags.slice(0, 3).map((t) => (
                        <span key={t} className="blog-tag">{t}</span>
                      ))}
                    </span>
                  ) : null}
                </div>
                <h2>
                  <Link to="/blog/$slug" params={{ slug: post.slug }}>
                    {post.title}
                  </Link>
                </h2>
                <p className="blog-excerpt">{post.excerpt}</p>
                <Link
                  to="/blog/$slug"
                  params={{ slug: post.slug }}
                  className="blog-entry-link"
                >
                  Read →
                </Link>
              </article>
            ))}
          </div>
        )}
      </main>
      <SiteFooter />
    </>
  );
}
