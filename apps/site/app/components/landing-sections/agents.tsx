const PROVIDERS = [
  {
    name: "Claude Code",
    source: "~/.claude/projects",
    detail: "transcripts, tool calls, TodoWrite plans, subagents, hooks",
    state: "deep",
  },
  {
    name: "Codex",
    source: "~/.codex/sessions",
    detail: "sessions, function calls, plan updates, provider events",
    state: "deep",
  },
  {
    name: "Pi",
    source: "local JSONL",
    detail: "tree events, tool calls, tool results, token usage",
    state: "new",
  },
  {
    name: "OpenCode",
    source: "local SQLite",
    detail: "sessions and messages from observed local schemas",
    state: "new",
  },
  {
    name: "Cursor",
    source: "state.vscdb",
    detail: "composer and Agent chats from Cursor's local storage",
    state: "new",
  },
] as const;

export function AgentsSection() {
  return (
    <section id="agents">
      <p className="eyebrow">agent coverage</p>
      <h2>One graph across the agents you actually use.</h2>
      <p>
        <code>ax</code> now ingests Claude Code, Codex, Pi, OpenCode, and
        Cursor into the same local provider-event graph. Different transcript
        formats, same questions: what happened, what tools fired, what failed,
        and what should change next.
      </p>

      <div className="provider-ledger" aria-label="Supported local agent providers">
        {PROVIDERS.map((provider) => (
          <article className="provider-row" key={provider.name}>
            <div>
              <strong>{provider.name}</strong>
              <span>{provider.source}</span>
            </div>
            <p>{provider.detail}</p>
            <em data-state={provider.state}>{provider.state}</em>
          </article>
        ))}
      </div>

      <p className="provider-note">
        Local-first means no hosted account, no transcript upload, no vendor
        dashboard. The watcher reads the files already on your machine and
        SurrealDB keeps the graph on <code>127.0.0.1</code>.
      </p>
    </section>
  );
}
