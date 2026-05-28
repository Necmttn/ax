export function Chapter5Governance() {
  return (
    <section className="section">
      <p className="eyebrow">Governance</p>
      <h2>Enforced at runtime, not by prompt.</h2>

      <p>
        Agents are actors in your system. They need the same controls as
        human contributors - identity, permissions, audit trails. Treating
        them as autocomplete with extra steps is how you ship the wrong
        kind of autonomy.
      </p>

      <p>
        Governance enforced by a system prompt - "please do not delete
        files", "always work on a worktree" - is a suggestion. Governance
        enforced at the execution layer - deny lists, scoped credentials,
        deterministic command blocking - is actual governance. Without
        it, security teams veto autonomous agents entirely. And they are
        right to.
      </p>

      <p>
        The push-down-the-stack move from the previous section <em>is</em>{" "}
        this. Prose drifts. The hook does not. Enforcement is the only
        signal that survives context pressure, scale, and the agent's own
        confidence that it knows better.
      </p>
    </section>
  );
}
