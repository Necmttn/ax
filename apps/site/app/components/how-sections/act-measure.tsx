// ACT 5 - MEASURE. Every accepted fix becomes a bet ax watches across your
// next sessions. Reuses the experiments-strip / nx-trace motif from the studio
// improve deck - checkpoints at +3 / +10 / +30 SESSIONS (never days). A bar
// that shrinks to zero is a confirmed win.

type Bet = {
  title: string;
  desc: string;
  verdict: string;
  state: "win" | "watching" | "regressed";
  checkpoints: { at: string; width: number }[];
};

const BETS: Bet[] = [
  {
    title: "route mechanical dispatches",
    desc: "the $605 proposal, accepted and shipped as a hook",
    verdict: "CONFIRMED WIN",
    state: "win",
    checkpoints: [
      { at: "+3", width: 88 },
      { at: "+10", width: 41 },
      { at: "+30", width: 6 },
    ],
  },
  {
    title: "same-file verification checklist",
    desc: "the 26x recurring fix - still inside its window",
    verdict: "WATCHING",
    state: "watching",
    checkpoints: [
      { at: "+3", width: 90 },
      { at: "+10", width: 58 },
      { at: "+30", width: 0 },
    ],
  },
];

export function ActMeasure() {
  return (
    <section className="how-act how-act--measure">
      <div className="how-act-inner">
        <header className="how-act-head">
          <p className="how-eyebrow">$ 05 · measure</p>
          <h2 className="how-headline">
            Did it actually work? ax keeps score.
          </h2>
          <p className="how-dek">
            A fix you can&apos;t measure is a guess. Every accepted proposal
            becomes a bet, and ax checks the same churn signal at &#43;3, &#43;10
            and &#43;30 sessions after you apply it. A trace bar that shrinks to
            zero is a confirmed win &mdash; receipts over vibes.
          </p>
        </header>

        <figure className="how-exp-fig">
          <div className="how-exp" role="img" aria-label="experiments strip - past bets measured at +3, +10, +30 session checkpoints">
            <div className="how-exp-head">
              <p className="how-exp-title">
                <span className="how-eyebrow">$ experiments</span> Past bets,
                measured
              </p>
              <span className="how-exp-meta">
                checkpoints at +3 / +10 / +30 sessions
              </span>
            </div>

            <ul className="how-exp-list" role="list">
              {BETS.map((bet) => (
                <li key={bet.title} className={`how-bet how-bet--${bet.state}`}>
                  <div className="how-bet-meta">
                    <span className="how-bet-title">{bet.title}</span>
                    <span className="how-bet-desc">{bet.desc}</span>
                    <span className={`how-bet-verdict how-bet-verdict--${bet.state}`}>
                      {bet.verdict}
                    </span>
                  </div>
                  <div className="how-bet-trace" aria-hidden="true">
                    {bet.checkpoints.map((cp) => (
                      <div className="how-trace-row" key={cp.at}>
                        <span className="how-trace-label">{cp.at}</span>
                        <span className="how-trace-track">
                          {cp.width > 0 ? (
                            <span
                              className={`how-trace-bar${
                                bet.state === "win" && cp.at === "+30"
                                  ? " how-trace-bar--win"
                                  : ""
                              }`}
                              style={{ width: `${cp.width}%` }}
                            />
                          ) : (
                            <span className="how-trace-pending">pending</span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </figure>
      </div>
    </section>
  );
}
