// ACT 3 - MINE. The graph reads back as receipts. A real recurring-mistake
// example with a real number, in the "26x recurring" register from the studio
// improve deck. Styled as a paper receipt, not a code dump.

export function ActMine() {
  return (
    <section className="how-act how-act--mine">
      <div className="how-act-inner">
        <header className="how-act-head">
          <p className="how-eyebrow">$ 03 · mine</p>
          <h2 className="how-headline">
            The same mistake, counted.
          </h2>
          <p className="how-dek">
            Once the graph holds enough runs, the patterns stop being anecdotes.
            ax measures verification churn &mdash; where a change lands, breaks,
            and gets repaired &mdash; and surfaces the family that keeps costing
            you the same way.
          </p>
        </header>

        <figure className="how-receipt-fig">
          <div className="how-receipt" role="img" aria-label="recurring-mistake receipt mined from session churn">
            <div className="how-receipt-head">
              <span className="how-receipt-cmd">$ ax sessions churn --here</span>
              <span className="how-receipt-win">last 30 days</span>
            </div>

            <div className="how-receipt-hero">
              <span className="how-receipt-num">26&times;</span>
              <span className="how-receipt-label">recurring</span>
            </div>

            <p className="how-receipt-claim">
              Feature work closes without re-verifying the file it just changed.
              Same family, again and again.
            </p>

            <dl className="how-receipt-rows">
              <div className="how-receipt-row">
                <dt>episodes opened</dt>
                <dd>26</dd>
              </div>
              <div className="how-receipt-row">
                <dt>repair LOC vs landed</dt>
                <dd>1.4&times;</dd>
              </div>
              <div className="how-receipt-row">
                <dt>median time-to-repair</dt>
                <dd>2 turns later</dd>
              </div>
              <div className="how-receipt-row how-receipt-row--accent">
                <dt>evidence</dt>
                <dd>cites_evidence &rarr; friction_event</dd>
              </div>
            </dl>

            <p className="how-receipt-foot">
              every number traces back to the turns and commits that produced it
            </p>
          </div>
        </figure>
      </div>
    </section>
  );
}
