import { createFileRoute, Link } from "@tanstack/react-router";
import { SiteHeader } from "~/components/landing-sections/site-header";
import { SiteFooter } from "~/components/landing-sections/site-footer";
import {
  BRAND_SWATCHES,
  SERIF_SCALE,
  EYEBROW_SAMPLES,
  VOICE_RULES,
  VOICE_EXAMPLES,
  TYPE_STACKS,
  NAMING_CANON,
  MOTIFS,
} from "./-brand.data";

export const Route = createFileRoute("/brand")({
  head: () => ({
    meta: [
      { title: "Brand - ax" },
      {
        name: "description",
        content:
          "The ax brand, shown not told: the typeset wordmark, the ink-on-paper palette as live swatches, the serif and mono scale, the live pulse, and the voice contract.",
      },
    ],
  }),
  component: BrandSpecimen,
});

/** A labelled specimen frame: caption above, the live thing below. */
function Specimen({
  label,
  meta,
  children,
}: {
  label: string;
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <figure className="brand-specimen">
      <figcaption className="brand-specimen__cap">
        <span className="brand-specimen__label">{label}</span>
        {meta && <span className="brand-specimen__meta">{meta}</span>}
      </figcaption>
      <div className="brand-specimen__body">{children}</div>
    </figure>
  );
}

function BrandSpecimen() {
  return (
    <>
      <SiteHeader />
      <main className="doc-main brand-page">
        <nav className="doc-crumb" aria-label="breadcrumb">
          <Link to="/docs">← Docs</Link>
        </nav>

        <header className="doc-head">
          <p className="eyebrow">$ the brand is the typography</p>
          <h1>Brand</h1>
          <p className="lede">
            No logo, no glyph. ax is set in Georgia on paper, measured in mono,
            and proven with real numbers. This page demonstrates its own rules -
            the specimens below are the live treatments, not pictures of them.
          </p>
        </header>

        {/* ---- Wordmark ---- */}
        <section className="brand-section" id="wordmark">
          <header className="brand-section__head">
            <p className="brand-section__eyebrow">$ the wordmark</p>
            <h2 className="brand-section__title">ax, agent experience</h2>
            <p className="brand-section__blurb">
              Lowercase <code>ax</code> in Georgia serif, paired with the mono
              tag. <strong>ax</strong> is the project; <code>axctl</code> is the
              npm package name - visitor copy always says ax.
            </p>
          </header>

          <Specimen label="Wordmark" meta="Georgia · 36px · -1px tracking">
            <span className="brand-wordmark-demo">
              <span className="brand-wordmark-demo__mark">ax</span>
              <span className="brand-wordmark-demo__tag">agent experience</span>
            </span>
          </Specimen>

          <ul className="brand-notes">
            <li>
              <strong>ax</strong> - lowercase, Georgia serif, 36px in the
              masthead. No uppercase, no abbreviation.
            </li>
            <li>
              <strong>agent experience</strong> - uppercase mono, 10px,
              letter-spacing 0.16em, baseline-aligned and muted.
            </li>
            <li>A 10px gap separates the two on screen; a single space in text.</li>
          </ul>
        </section>

        {/* ---- Palette ---- */}
        <section className="brand-section" id="palette">
          <header className="brand-section__head">
            <p className="brand-section__eyebrow">$ ink on paper</p>
            <h2 className="brand-section__title">Palette</h2>
            <p className="brand-section__blurb">
              Monochrome by default; color only when it carries information.
              These swatches render from the live tokens in{" "}
              <code>globals.css</code> :root.
            </p>
          </header>

          <div className="brand-swatches">
            {BRAND_SWATCHES.map((s) => (
              <div
                key={s.token}
                className={`brand-swatch${s.mono ? " brand-swatch--mono" : ""}`}
              >
                <span
                  className="brand-swatch__chip"
                  style={{ background: `var(${s.token})` }}
                  aria-hidden="true"
                />
                <div className="brand-swatch__meta">
                  <code className="brand-swatch__token">{s.token}</code>
                  <code className="brand-swatch__hex">{s.hex}</code>
                  <span className="brand-swatch__role">{s.role}</span>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ---- Motifs (incl. live pulse) ---- */}
        <section className="brand-section" id="motifs">
          <header className="brand-section__head">
            <p className="brand-section__eyebrow">$ how it carries meaning</p>
            <h2 className="brand-section__title">Motifs</h2>
            <p className="brand-section__blurb">
              Receipts is the core idea. The rest keeps the surface honest:
              real numbers, hairline rules, one live pulse.
            </p>
          </header>

          <Specimen label="The live pulse" meta="green dot · 1.6s ease-in-out · once per surface">
            <span className="live brand-live-demo" title="the agent experience layer is alive">
              live
            </span>
          </Specimen>

          <Specimen label="Hairline rules" meta="1px --line · 2px --ink cap">
            <div className="brand-rule-demo">
              <span className="brand-rule-demo__hair" />
              <span className="brand-rule-demo__hair" />
              <span className="brand-rule-demo__ink" />
            </div>
          </Specimen>

          <div className="brand-cards">
            {MOTIFS.map((m) => (
              <article key={m.title} className="brand-card">
                <h3 className="brand-card__title">{m.title}</h3>
                <p className="brand-card__body">{m.body}</p>
              </article>
            ))}
          </div>

          <p className="brand-section__foot">
            The home page (<Link to="/">/</Link>) and{" "}
            <Link to="/origin">/origin</Link> are the canonical executions:
            proposal cards with redirectable-dollar figures and a measured-bets
            strip checkpointed at +3 / +10 / +30 sessions.
          </p>
        </section>

        {/* ---- Typography ---- */}
        <section className="brand-section" id="typography">
          <header className="brand-section__head">
            <p className="brand-section__eyebrow">$ serif headline, mono eyebrow</p>
            <h2 className="brand-section__title">Typography</h2>
            <p className="brand-section__blurb">
              Three stacks, each with a job. Serif for headlines, mono for the
              machine voice, sans for prose.
            </p>
          </header>

          <Specimen label="Serif scale" meta="Georgia · live at real size">
            <div className="brand-scale">
              {SERIF_SCALE.map((row) => (
                <div key={row.label} className="brand-scale__row">
                  <span
                    className="brand-scale__sample"
                    style={{ fontSize: `${row.px}px` }}
                  >
                    {row.sample}
                  </span>
                  <span className="brand-scale__note">
                    <code>{row.px}px</code> · {row.label} - {row.use}
                  </span>
                </div>
              ))}
            </div>
          </Specimen>

          <Specimen label="Mono $-eyebrow" meta="ui-monospace · the section lead">
            <div className="brand-eyebrows">
              {EYEBROW_SAMPLES.map((e) => (
                <span key={e} className="brand-eyebrows__item">
                  {e}
                </span>
              ))}
            </div>
          </Specimen>

          <dl className="brand-stacks">
            {TYPE_STACKS.map((t) => (
              <div key={t.cssVar} className="brand-stacks__row">
                <dt>
                  <code>{t.cssVar}</code>
                  <span className="brand-stacks__name">{t.stack}</span>
                </dt>
                <dd>{t.use}</dd>
              </div>
            ))}
          </dl>
        </section>

        {/* ---- Voice ---- */}
        <section className="brand-section" id="voice">
          <header className="brand-section__head">
            <p className="brand-section__eyebrow">$ the voice contract</p>
            <h2 className="brand-section__title">Voice</h2>
            <p className="brand-section__blurb">
              Terse, evidence-first, second person. State what's true, then move
              on.
            </p>
          </header>

          <dl className="brand-voice">
            {VOICE_RULES.map((v) => (
              <div key={v.label} className="brand-voice__row">
                <dt>{v.label}</dt>
                <dd>{v.rule}</dd>
              </div>
            ))}
          </dl>

          <div className="brand-examples">
            {VOICE_EXAMPLES.map((ex) => (
              <div key={ex.say} className="brand-example">
                <p className="brand-example__say">{ex.say}</p>
                <p className="brand-example__instead">
                  <span className="brand-example__tag">instead of</span>
                  {ex.instead}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* ---- Naming canon ---- */}
        <section className="brand-section" id="naming">
          <header className="brand-section__head">
            <p className="brand-section__eyebrow">$ ax &lt;verb&gt;</p>
            <h2 className="brand-section__title">Naming</h2>
            <p className="brand-section__blurb">
              User-facing commands read <code>ax &lt;verb&gt;</code>. The full
              vocabulary lives in <Link to="/docs/language">the language
              reference</Link>.
            </p>
          </header>

          <dl className="brand-naming">
            {NAMING_CANON.map((n) => (
              <div key={n.command} className="brand-naming__row">
                <dt>
                  <code>{n.command}</code>
                  {n.status === "roadmap" && (
                    <span className="brand-naming__tag">tracked next</span>
                  )}
                </dt>
                <dd>{n.desc}</dd>
              </div>
            ))}
          </dl>
        </section>

        <p className="brand-page__foot">
          Contributing? Naming, scrubbing, and commit conventions for the repo
          live in{" "}
          <a
            href="https://github.com/Necmttn/ax/blob/main/CONTRIBUTING.md"
            target="_blank"
            rel="noopener noreferrer"
          >
            CONTRIBUTING.md
          </a>
          .
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
