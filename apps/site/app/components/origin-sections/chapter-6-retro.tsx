export function Chapter6Retro() {
  return (
    <section className="section">
      <h2>Retro is only the first step.</h2>

      <p>
        This is why reflection on its own is not enough, and why{" "}
        <code>ax</code> is not just a journal of retros. A retro is a
        hypothesis. Left alone, hypotheses drift.
      </p>

      <p>
        After each session, the agent leaves a small structured note:
        what was tried, what worked, what failed, what should change next
        time. Across a week, those notes accumulate. Then a bigger
        self-reflection pass runs over the retros and the graph: find
        repeated friction, propose harness changes, estimate what they
        would save, and ask which experiments to start.
      </p>

      <p>
        The user still decides. The graph decides what is worth asking
        about. Every accepted fix becomes an experiment with checkpoints
        at t+7, t+30, and t+90.
      </p>

      <aside className="framework-list" aria-label="five requirements the retro loop has to meet">
        <span className="framework-list-label">what the loop has to do</span>
        <ul>
          <li><span className="fw-name">01 · fire at the right time</span><span className="fw-note">the Stop hook on session-end is the only moment the agent still has its context. five seconds later it is gone.</span></li>
          <li><span className="fw-name">02 · structured by default</span><span className="fw-note">json with four fields — tried, worked, failed, next. free-form is an escape hatch, not the default.</span></li>
          <li><span className="fw-name">03 · cover sub-agents</span><span className="fw-note">main-session retros are nice. sub-agent retros are the unlock. the hook has to fire for them too.</span></li>
          <li><span className="fw-name">04 · become a proposal</span><span className="fw-note">“that worked, do it more” is not useful. the retro feeds a deduplicated queue you accept, reject, or skip.</span></li>
          <li><span className="fw-name">05 · become an experiment</span><span className="fw-note">accepted proposals get scaffolded as real artifacts. checkpoints at t+7, t+30, t+90 close the verdict.</span></li>
        </ul>
      </aside>
    </section>
  );
}

export function Chapter6RetroContinued() {
  return (
    <section className="section">
      <p>
        Otherwise you are improving on vibes, which is the precise failure
        mode <code>ax</code> is trying to avoid.
      </p>
    </section>
  );
}
