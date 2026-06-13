// ACT 4 - PROPOSE. The mined patterns become ranked proposals you review one
// at a time. Reuses the improve-deck proposal-card visual language from
// landing-v2/dashboard-preview.tsx (.nx-* classes), framed inside a browser
// chrome pointed at the local dashboard.

export function ActPropose() {
  return (
    <section className="how-act how-act--propose">
      <div className="how-act-inner">
        <header className="how-act-head">
          <p className="how-eyebrow">$ 04 · propose</p>
          <h2 className="how-headline">
            One small fix at a time. You decide.
          </h2>
          <p className="how-dek">
            Each pattern becomes a ranked proposal &mdash; a concrete,
            repo-specific change with the receipt attached. Nothing is applied
            for you. You review the brief, accept the ones worth trying, and
            skip the rest.
          </p>
        </header>

        <div
          className="landing-v2 browser how-propose-browser"
          role="img"
          aria-label="ax dashboard Improve view at 127.0.0.1:1738 - a ranked proposal card"
        >
          <div className="browser-bar">
            <div className="browser-dots">
              <span></span>
              <span></span>
              <span></span>
            </div>
            <div className="browser-url">127.0.0.1:1738</div>
            <div className="browser-spacer"></div>
          </div>

          <div className="dash dash--improve how-propose-dash">
            <div className="nx-head">
              <div>
                <p className="nx-eyebrow">$ what&apos;s next</p>
                <p className="nx-title">20 actions waiting</p>
                <p className="nx-sub">
                  Mined from your sessions &mdash; savings to route, fixes that
                  recur, verdicts due.
                </p>
              </div>
              <span className="nx-brief">copy analysis brief</span>
            </div>

            <div className="nx-grid how-propose-grid">
              <article className="nx-card">
                <p className="nx-tag">$ proposal</p>
                <h3 className="nx-card-title">~$605 redirectable</h3>
                <p className="nx-card-desc">
                  252 model-less dispatches on expensive models matched
                  mechanical routing classes.
                </p>
                <p className="nx-fix">
                  <b>FIX &rarr; NEW HOOK:</b> route mechanical subagent
                  dispatches to cheaper models
                </p>
                <div className="nx-actions">
                  <span className="nx-btn">REVIEW &rarr;</span>
                  <span className="nx-copy">copy brief</span>
                </div>
              </article>

              <article className="nx-card">
                <p className="nx-tag">$ proposal</p>
                <h3 className="nx-card-title">26&times; recurring</h3>
                <p className="nx-card-desc">
                  Feature closure needs stronger same-file follow-up
                  verification.
                </p>
                <p className="nx-fix">
                  <b>FIX &rarr; NEW SKILL:</b> post-feature verification
                  checklist
                </p>
                <div className="nx-actions">
                  <span className="nx-btn">REVIEW &rarr;</span>
                  <span className="nx-copy">copy brief</span>
                </div>
              </article>
            </div>

            <p className="nx-foot">+18 more in the registry below</p>
          </div>
        </div>

        <p className="how-act-note">
          Accept a proposal and ax writes a brief into{" "}
          <code>.ax/tasks/</code> &mdash; you act on it like any other task,
          then reconcile. The fix is yours; the graph just found it.
        </p>
      </div>
    </section>
  );
}
