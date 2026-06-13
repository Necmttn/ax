// HERO - opens the how-it-works narrative. Sets the five-act frame:
// watch -> graph -> mine -> propose -> measure.

const STEPS = ["watch", "graph", "mine", "propose", "measure"];

export function ActHero() {
  return (
    <section className="how-act how-act--hero">
      <div className="how-act-inner">
        <p className="how-eyebrow">$ how it works</p>
        <h1 className="how-hero-title">
          What happens to your sessions,
          <br />
          and what you get <em>back</em>.
        </h1>
        <p className="how-hero-lede">
          ax watches every run your coding agents make, turns the history into a
          typed local graph, mines the mistakes you keep repeating, and hands
          them back as small fixes you review one at a time &mdash; then measures
          whether they worked.
        </p>

        <ol className="how-hero-steps" aria-label="the five acts">
          {STEPS.map((s, i) => (
            <li key={s} className="how-hero-step">
              <span className="how-hero-step-num">{String(i + 1).padStart(2, "0")}</span>
              <span className="how-hero-step-name">{s}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
