import { createFileRoute, Link } from "@tanstack/react-router";
import { allChangelogs, allReleaseAnnouncements } from "content-collections";
import { MarkdownLite } from "~/components/release-markdown";
import { SiteFooter } from "~/components/landing-sections/site-footer";
import { SiteHeader } from "~/components/landing-sections/site-header";

export const Route = createFileRoute("/changelog")({
  head: () => ({
    meta: [
      { title: "Changelog - ax" },
      { name: "description", content: "Release announcements and generated changelog entries for ax." },
    ],
  }),
  loader: () => ({
    announcements: [...allReleaseAnnouncements].sort((a, b) => b.date.localeCompare(a.date)),
    changelog: allChangelogs[0] ?? null,
  }),
  component: ChangelogPage,
});

function ChangelogPage() {
  const { announcements, changelog } = Route.useLoaderData();
  const latest = announcements[0];
  const previousAnnouncements = latest
    ? announcements.filter((release) => release.version !== latest.version)
    : announcements;

  // Source of truth for "what shipped last" is the Release Please changelog,
  // not the hand-written announcement layer (which is curated and can lag).
  // Pull the newest version + date straight off the top of CHANGELOG.md so
  // the page always reflects the real latest release.
  const latestRelease = (() => {
    const m = changelog?.content.match(
      /##\s*\[?(\d+\.\d+\.\d+)\]?[^\n]*?\((\d{4}-\d{2}-\d{2})\)/,
    );
    return m ? { version: m[1], date: m[2] } : null;
  })();

  // The /changelog index used to inline the ENTIRE generated CHANGELOG.md
  // (every version, ~62k px). Show only the newest version's generated entry
  // here and point at GitHub for the full history; per-version pages already
  // render each version's generated block.
  const latestGeneratedEntry = (() => {
    const content = changelog?.content;
    if (!content) return null;
    const start = content.search(/^## /m);
    if (start < 0) return null;
    const rest = content.slice(start);
    const next = rest.slice(3).search(/^## /m);
    return next >= 0 ? rest.slice(0, next + 3).trim() : rest.trim();
  })();

  return (
    <>
      <SiteHeader />
      <main className="release-page">
        <section className="release-hero">
          <p className="eyebrow">release notes</p>
          <h1>
            Changes with <em>context</em>.
          </h1>
          <p className="lede">
            Every release, two ways: the story of what shipped, and the
            commit-level record behind it.
          </p>
          {latest ? (
            <p className="release-latest">
              <span className="release-latest-tag">latest release</span>
              <Link to="/changelog/$version" params={{ version: `v${latest.version}` }}>
                <b>v{latest.version}</b>
                <span className="release-latest-date">{latest.date}</span>
              </Link>
            </p>
          ) : latestRelease ? (
            <p className="release-latest">
              <span className="release-latest-tag">latest release</span>
              <a href="#generated">
                <b>v{latestRelease.version}</b>
                <span className="release-latest-date">{latestRelease.date}</span>
              </a>
            </p>
          ) : null}
          <div className="release-actions">
            <a href="#announcements">Announcements</a>
            <a href="#generated">Generated changelog</a>
          </div>
        </section>

        <section id="announcements" className="release-section">
          <div className="section-kicker">in-depth announcements</div>
          {latest ? (
            <article className="release-feature">
              <div className="release-meta">
                <span>v{latest.version}</span>
                <span>{latest.date}</span>
              </div>
              <h2>{latest.title}</h2>
              <p>{latest.summary}</p>
              <Link to="/changelog/$version" params={{ version: `v${latest.version}` }} className="release-anchor">
                Open release page →
              </Link>
            </article>
          ) : (
            <p className="muted">No release announcements have been published yet.</p>
          )}

          {previousAnnouncements.length > 0 ? (
            <div className="release-list">
              {previousAnnouncements.map((release) => (
                <article id={`v${release.version}`} key={release.version} className="release-entry">
                  <div className="release-meta">
                    <span>v{release.version}</span>
                    <span>{release.date}</span>
                  </div>
                  <h3>{release.title}</h3>
                  <p className="release-summary">{release.summary}</p>
                  <Link to="/changelog/$version" params={{ version: `v${release.version}` }} className="release-entry-link">
                    Open release page →
                  </Link>
                </article>
              ))}
            </div>
          ) : null}
        </section>

        <section id="generated" className="release-section">
          <div className="section-kicker">commit-level record</div>
          <details className="generated-changelog">
            <summary>
              <span>Latest generated entry{latestRelease ? ` · v${latestRelease.version}` : ""}</span>
              <small>generated by Release Please</small>
            </summary>
            <article>
              {latestGeneratedEntry ? (
                <MarkdownLite content={latestGeneratedEntry} />
              ) : (
                <p className="muted">CHANGELOG.md has not been generated yet.</p>
              )}
            </article>
          </details>
          <p className="release-generated-footer muted">
            Full commit-level history on{" "}
            <a href="https://github.com/Necmttn/ax/blob/main/CHANGELOG.md" target="_blank" rel="noreferrer">
              GitHub
            </a>
            .
          </p>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
