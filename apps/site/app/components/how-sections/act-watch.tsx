import { PROVIDERS } from "~/components/landing-v2/supports-strip";

// ACT 1 - WATCH. The five harnesses as a designed row of transcript sources
// feeding one local graph. Static, designed (no animation) - the LIVE badge
// carries the "it's running right now" energy.

type Source = {
  key: string;
  name: string;
  path: string;
  kind: string;
};

// Mirrors apps/axctl/src/ingest/* - every harness ax parses, with its on-disk
// home. Names match AgentProviderName exactly.
const SOURCES: Source[] = [
  { key: "claude", name: "Claude Code", path: "~/.claude/projects", kind: "jsonl transcripts" },
  { key: "codex", name: "Codex", path: "~/.codex/sessions", kind: "jsonl sessions" },
  { key: "pi", name: "Pi", path: "~/.pi/agent/sessions", kind: "jsonl sessions" },
  { key: "opencode", name: "OpenCode", path: "opencode store", kind: "sqlite store" },
  { key: "cursor", name: "Cursor", path: "cursor store", kind: "sqlite store" },
];

function iconFor(key: string) {
  return PROVIDERS.find((p) => p.key === key)?.svg ?? null;
}

export function ActWatch() {
  return (
    <section className="how-act how-act--watch">
      <div className="how-act-inner">
        <header className="how-act-head">
          <p className="how-eyebrow">$ 01 · watch</p>
          <h2 className="how-headline">
            Five harnesses. One local graph.
          </h2>
          <p className="how-dek">
            ax reads the transcripts your coding agents already write to disk
            &mdash; nothing to instrument, nothing to send anywhere. A parser
            per harness folds every run into the same typed graph on your own
            machine.
          </p>
        </header>

        <div className="how-watch-fig" aria-label="five harness sources feeding one local graph">
          <ul className="how-watch-sources" role="list">
            {SOURCES.map((s) => (
              <li key={s.key} className={`how-src how-src--${s.key}`}>
                <span className="how-src-icon" aria-hidden="true">
                  {iconFor(s.key)}
                </span>
                <span className="how-src-meta">
                  <span className="how-src-name">{s.name}</span>
                  <span className="how-src-path">{s.path}</span>
                </span>
                <span className="how-src-kind">{s.kind}</span>
              </li>
            ))}
          </ul>

          <div className="how-watch-bridge" aria-hidden="true">
            <svg viewBox="0 0 120 360" preserveAspectRatio="none" className="how-watch-wires">
              {/* one wire per source, fanning into the single sink port */}
              {[36, 100, 180, 260, 324].map((y, i) => (
                <path
                  key={i}
                  d={`M0 ${y} C60 ${y} 60 180 120 180`}
                  fill="none"
                  stroke="var(--line)"
                  strokeWidth="1.25"
                />
              ))}
            </svg>
          </div>

          <div className="how-watch-sink">
            <div className="how-sink-card">
              <span className="how-sink-badge">
                <span className="how-sink-dot" aria-hidden="true" />
                LIVE
              </span>
              <span className="how-sink-title">typed local graph</span>
              <span className="how-sink-host">surrealdb &middot; 127.0.0.1:8521</span>
              <span className="how-sink-sub">
                a background watcher ingests new runs the moment they land
              </span>
            </div>
          </div>
        </div>

        <p className="how-act-note">
          The watcher tails your session dirs and ingests in the background
          &mdash; the loop is pull-based, never a per-turn hook that blocks your
          agent.
        </p>
      </div>
    </section>
  );
}
