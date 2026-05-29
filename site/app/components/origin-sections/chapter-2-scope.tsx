export function Chapter2Scope() {
  return (
    <section className="section">
      <h2>Scope grew. Feedback collapsed.</h2>

      <p>
        Chat agents came next. You stopped pressing <kbd>tab</kbd> and started
        describing: build me this. The agent planned, executed, showed
        you the result, and you reacted in natural language. Still a
        loop, just slower and fuzzier. The original contract was simple
        - you chatted, you watched, you reacted - and intelligence was
        literally a human reading output.
      </p>

      <p>
        Then a whole orchestration layer grew on top of the agent. Plan
        a task, break it down, iterate against checks, advance when the
        checks pass. The names changed quarterly. The shape did not.
      </p>

      <aside className="framework-list" aria-label="frameworks that grew on top of the per-turn loop">
        <span className="framework-list-label">orchestration layer, last 18 months</span>
        <ul>
          <li><span className="fw-name">ralph loop</span><span className="fw-note">plan → tasks → iterate → checks</span></li>
          <li><span className="fw-name">gsd / get-shit-done</span><span className="fw-note">single-prompt to merged PR</span></li>
          <li><span className="fw-name">spec ops</span><span className="fw-note">spec-driven dev, agent fills the spec</span></li>
          <li><span className="fw-name">sub-agent fan-out</span><span className="fw-note">Task tool, parallel worktrees</span></li>
          <li><span className="fw-name">autopilots / scheduled agents</span><span className="fw-note">no human in the turn at all</span></li>
        </ul>
      </aside>

      <p>
        Each of these is another layer between the human and the output.
        They make the agent more capable per session. They make the
        per-session signal sparser. The trade is consistent across this
        list: more autonomy in, less reaction out.
      </p>

      <p>
        Not every layer subtracts signal. Some push it in.
      </p>

      <p>
        The interview-style skills — Matt Peacock’s{" "}
        <code>grillme</code> is the sharpest example — turn the
        agent into a debugger of your own intent. Before any code runs,
        the model grills you for scope, terminology, decision-tree
        branches, the ADR you should have already written. The output is
        a tighter spec and a durable artifact, not a faster turn. I use
        it. It works.
      </p>

      <p>
        The orchestration is the same shape; the direction of signal
        flow is opposite. Pulling human signal into the front of the
        loop is good. Closing the back of the loop — what
        happened after the agent ran, what should change next time
        — is the part still missing.
      </p>

      <p>
        Across the four generations, the overall trend held. Capability
        went up every time. Per-session human feedback got sparser every
        time. The harness was traded for autonomy, one generation at a
        time.
      </p>

      <p>
        The feedback loop was not a nice-to-have. It was the thing that
        made the prior generation good. Pull the human out and you do
        not just lose supervision; you lose the signal that taught the
        behavior. Replace it with a self-improvement loop that has no
        grounding and the agent will happily reflect itself into
        nonsense.
      </p>
    </section>
  );
}
