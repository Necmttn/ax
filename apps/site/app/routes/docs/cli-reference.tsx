import { createFileRoute, Link } from "@tanstack/react-router";
import { SiteHeader } from "~/components/landing-sections/site-header";
import { SiteFooter } from "~/components/landing-sections/site-footer";
import { CLI_GROUPS, type CliCommand } from "./-cli-reference.data";

export const Route = createFileRoute("/docs/cli-reference")({
  head: () => ({
    meta: [
      { title: "CLI reference - ax" },
      {
        name: "description",
        content:
          "Every ax subcommand, grouped by job: query the graph, see where the money goes, review proposals, guard the harness, publish your profile.",
      },
    ],
  }),
  component: CliReference,
});

/** Anchor id for a command, used by the sticky index + section headings. */
const cmdId = (name: string) => `cmd-${name}`;

function CommandCard({ command }: { command: CliCommand }) {
  return (
    <article id={cmdId(command.name)} className="cliref-card">
      <header className="cliref-card__head">
        <h3 className="cliref-card__name">
          ax {command.name}
          {command.sub && command.sub.length > 0 && (
            <span className="cliref-card__subs">
              {command.sub.map((s) => (
                <span key={s} className="cliref-card__sub">
                  {s}
                </span>
              ))}
            </span>
          )}
        </h3>
        <p className="cliref-card__job">{command.job}</p>
      </header>

      <pre className="cliref-card__sig">
        <code>{command.signature}</code>
      </pre>

      {command.flags.length > 0 && (
        <dl className="cliref-card__flags">
          {command.flags.map((f) => (
            <div key={f.flag} className="cliref-card__flag">
              <dt>{f.flag}</dt>
              <dd>{f.desc}</dd>
            </div>
          ))}
        </dl>
      )}

      <pre className="cliref-card__receipt">
        <code>{command.receipt}</code>
      </pre>

      {command.detail && command.detail.length > 0 && (
        <details className="cliref-card__detail">
          <summary>Flags &amp; sub-commands</summary>
          <ul>
            {command.detail.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}

function CliReference() {
  return (
    <>
      <SiteHeader />
      <main className="doc-main cliref">
        <nav className="doc-crumb" aria-label="breadcrumb">
          <Link to="/docs">← Docs</Link>
        </nav>

        <header className="doc-head">
          <p className="eyebrow">$ ax --help</p>
          <h1>CLI reference</h1>
          <p className="lede">
            One entry per <code>ax</code> subcommand, grouped by job. Each card
            has the signature, its key flags, and one real output receipt.
            Receipts over vibes.
          </p>
        </header>

        <div className="cliref-layout">
          <aside className="cliref-index" aria-label="command index">
            <p className="cliref-index__label">commands</p>
            <nav>
              {CLI_GROUPS.map((group) => (
                <div key={group.eyebrow} className="cliref-index__group">
                  <p className="cliref-index__eyebrow">{group.eyebrow}</p>
                  <ul>
                    {group.commands.map((c) => (
                      <li key={c.name}>
                        <a href={`#${cmdId(c.name)}`}>ax {c.name}</a>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </nav>
          </aside>

          <div className="cliref-body">
            {CLI_GROUPS.map((group) => (
              <section key={group.eyebrow} className="cliref-group">
                <header className="cliref-group__head">
                  <p className="cliref-group__eyebrow">{group.eyebrow}</p>
                  <h2 className="cliref-group__title">{group.title}</h2>
                  <p className="cliref-group__blurb">{group.blurb}</p>
                </header>
                <div className="cliref-group__cards">
                  {group.commands.map((c) => (
                    <CommandCard key={c.name} command={c} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
