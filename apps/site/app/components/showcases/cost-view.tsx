export function CostViewShowcase() {
  return (
    <section id="cost-view" className="showcase-cost-view">
      <div className="showcase-cost-view-inner">
        <p className="eyebrow">measure + tune, live</p>
        <h2>
          Your bill, <em>broken out and tunable.</em>
        </h2>
        <p className="lede">
          ax studio&apos;s <code>/cost</code> view renders the same numbers the
          CLI prints &mdash; the main-vs-subagent spend split, per-model cost,
          and the dispatch candidates worth routing down &mdash; live off your
          local graph. And routing is regex underneath, so it ships an
          interactive tuner: edit a class pattern, watch which past dispatches it
          catches (and which it shouldn&apos;t), flag false positives into an
          exclude list, and save &mdash; the route-dispatch hook picks it up live.
        </p>
        <figure className="showcase-cost-view-shot">
          <img
            src="/blog/studio-routing-tuner.png"
            alt="ax studio /cost view: main-thread routability bars and the interactive routing tuner with an editable regex pattern, suggested model, and exclude patterns over real dispatch history"
            loading="lazy"
          />
          <figcaption>
            ax studio &middot; <code>/cost</code> &mdash; main-thread routability
            and the interactive routing tuner
          </figcaption>
        </figure>
      </div>
    </section>
  );
}
