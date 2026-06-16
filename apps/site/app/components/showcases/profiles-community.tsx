"use client";
import { Link } from "@tanstack/react-router";

const BOARD_ROWS = [
  { rank: 1, login: "@you", value: "1.8B", unit: "tokens" },
  { rank: 2, login: "@abuilder", value: "1.2B", unit: "tokens" },
  { rank: 3, login: "@cferreira", value: "940M", unit: "tokens" },
] as const;

const MCP_TOOLS = [
  "recall",
  "sessions_around",
  "session_show",
  "skills_weighted",
  "skills_by_role",
  "skills_roles",
  "roles",
  "improve_recommend",
  "improve_show",
  "improve_list",
] as const;

export function ProfilesCommunityShowcase() {
  return (
    <section
      id="profiles-community"
      className="showcase-profiles"
      aria-label="Profiles and community showcase"
    >
      <p className="eyebrow">receipts, public · profiles</p>
      <h2>
        Publish what you <em>actually</em> ran.
      </h2>
      <p className="lede">
        <span className="cmd">ax profile publish</span> turns your local graph into a public
        gist - counts, dates, trends, the skills and hooks you really lean on. No transcripts,
        no code, no paths. The nightly compile ranks everyone who opted in.
      </p>

      <div className="split">
        {/* board */}
        <article className="surface" aria-label="leaderboard preview">
          <header className="surface-head">
            <span className="where">leaderboard</span>
            <code>/leaders</code>
          </header>
          <table className="mini-board">
            <thead>
              <tr><th>#</th><th>user</th><th>tokens</th></tr>
            </thead>
            <tbody>
              {BOARD_ROWS.map((r) => (
                <tr key={r.login}>
                  <td>{r.rank}</td>
                  <td>{r.login}</td>
                  <td>{r.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="surface-note">
            Boards rebuild nightly from registered gists. Trending skills filter out personal{" "}
            <code className="inline">local:*</code> skills - a skill only trends once 2+ builders
            publish it. See <Link to="/leaders">the live boards →</Link>
          </p>
        </article>

        {/* what gets published */}
        <article className="surface" aria-label="published profile shape">
          <header className="surface-head">
            <span className="where">~/.ax</span>
            <code>ax-profile.json</code>
          </header>
          <pre className="term" aria-label="published profile json">{`{
  "v": 1,
  "github": "you",
  "window_days": 30,
  "stats": {
    "sessions": 412,
    "streak_days": 9,
    "tokens": { "total": 1.8e9 },
    "cost_usd": 605
  },
  "rig": {
    "skills": [
      { "name": "superpowers:tdd", "runs": 88 }
    ],
    "hooks": ["enforce-worktree"],
    "routing_table": true
  }
}`}</pre>
          <p className="surface-note">
            Aggregates only - the exact JSON is shown to you for consent before the first
            publish. Your <Link to="/u/$login" params={{ login: "you" }} search={{ vs: undefined }}>profile page</Link> renders it live.
          </p>
        </article>
      </div>

      {/* ============ MCP ============ */}
      <div className="section-head">
        <h3>Hand the graph to an agent</h3>
        <div className="meta">ax mcp · stdio · 17 read-only tools</div>
      </div>

      <article className="surface mcp-card" aria-label="MCP server">
        <header className="surface-head">
          <span className="where">model context protocol</span>
          <code>ax mcp</code>
        </header>
        <p className="surface-note">
          <code>ax mcp</code> runs a stdio MCP server exposing ax&apos;s read-only queries as
          17 tools, so an agent can interrogate your graph in-context - recall a past session,
          pull weighted skills, read a proposal - mid-task. Mutating ops are deliberately not
          exposed.
        </p>
        <ul className="tool-grid">
          {MCP_TOOLS.map((t) => (
            <li key={t}><code>{t}</code></li>
          ))}
        </ul>
      </article>

      {/* ============ CAPTION ============ */}
      <section className="caption">
        <div className="col">
          <div className="h">consent first, always</div>
          The first publish shows you the exact JSON and asks. State lives in{" "}
          <code>~/.ax/profile-publish.json</code>; <code>ax profile unpublish</code> deletes the
          gist and resets it. Nothing leaves your machine until you say yes.
        </div>
        <div className="col">
          <div className="h">runs on your machine</div>
          The MCP server has no native deps and never mutates - it&apos;s the same query layer the
          CLI uses, handed to whatever agent you point at it. The graph stays local; only the
          answers cross the wire.
        </div>
      </section>
    </section>
  );
}
