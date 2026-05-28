export function Chapter4Example() {
  return (
    <section className="section">
      <h2>The example that convinced me.</h2>

      <p>
        It was small and stupid, which is exactly why it convinced me.
      </p>

      <p>
        I do not like agents working on main. I want a clean main and a
        worktree per task. So I did the obvious thing and wrote it into my{" "}
        <code>CLAUDE.md</code> and <code>AGENTS.md</code>: always branch,
        never touch main, keep the root clean.
      </p>

      <p>
        It failed constantly. Under a full context window the agent simply
        lost that line. I would catch it three sessions later, working on
        main again, and spend the next ten minutes moving the work off.
        Same correction, over and over, scattered across weeks of chats.
      </p>
    </section>
  );
}

export function Chapter4ExampleContinued() {
  return (
    <section className="section">
      <p>
        The fix was not a firmer rule. I had already tried the firmer rule.
        The fix was to move the rule down the stack.
      </p>

      <p>
        When I ingested the transcripts and ran a retro across them, the
        pattern was obvious in aggregate in a way it never was session to
        session: this rule does not survive context pressure. So the
        answer was to stop asking nicely and add a hook at the tool layer
        that blocks writes on main unless I explicitly allow it.
      </p>

      <p>
        After that, main stays clean. Not because the agent got more
        disciplined, but because I stopped relying on its discipline.
      </p>
    </section>
  );
}
