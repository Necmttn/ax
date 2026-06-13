import { createFileRoute } from "@tanstack/react-router";
import { DocShell } from "~/components/doc-shell";
import { GLOSSARY_GROUPS, type GlossaryTerm } from "./-language.data";

export const Route = createFileRoute("/docs/language")({
  head: () => ({
    meta: [
      { title: "Language - ax" },
      {
        name: "description",
        content:
          "The shared vocabulary ax uses to describe agent work: AX, the improve loop, cost routing, profiles and the surface agents read back.",
      },
    ],
  }),
  component: Language,
});

function TermCard({ entry }: { entry: GlossaryTerm }) {
  return (
    <article className="gloss-card">
      <p className="gloss-card__term">
        <span className="gloss-card__dollar" aria-hidden="true">
          $
        </span>
        {entry.term}
        {entry.expansion && (
          <span className="gloss-card__exp">{entry.expansion}</span>
        )}
      </p>
      <p className="gloss-card__def">{entry.definition}</p>
      <p className="gloss-card__usage">
        <span className="gloss-card__usage-label">in the wild</span>
        {entry.usage}
      </p>
    </article>
  );
}

function Language() {
  return (
    <DocShell
      eyebrow="$ ax language"
      title="Language"
      lede="The shared vocabulary ax uses to describe agent work. Each term: what it means, and how it reads in real copy."
    >
      <div className="gloss">
        {GLOSSARY_GROUPS.map((group) => (
          <section key={group.eyebrow} className="gloss-group">
            <header className="gloss-group__head">
              <p className="gloss-group__eyebrow">{group.eyebrow}</p>
              <h2 className="gloss-group__title">{group.title}</h2>
            </header>
            <div className="gloss-group__cards">
              {group.terms.map((t) => (
                <TermCard key={t.term} entry={t} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </DocShell>
  );
}
