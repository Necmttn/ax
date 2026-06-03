import { Link } from "@tanstack/react-router";

export function FeaturesPage() {
  return (
    <main className="features-page">
      {/* ============= hero ============= */}
      <section className="hero">
        <span className="eyebrow">what&apos;s under the hood</span>
        <h1>
          What ax knows about <em>your agent.</em>
        </h1>
        <p className="lede">
          A tour of the data ax keeps on your laptop - the transcripts it indexes, the graph it builds,
          the stages it derives, the interventions it proposes, and the hooks it watches in real time.
        </p>
        <div className="scale">
          <div className="stat">
            <span className="v">369,132</span>
            <span className="k">turns indexed</span>
          </div>
          <div className="stat">
            <span className="v">4,773</span>
            <span className="k">sessions ingested</span>
          </div>
          <div className="stat">
            <span className="v">5.9ms</span>
            <span className="k">median FTS query</span>
          </div>
          <div className="stat">
            <span className="v">8 stages</span>
            <span className="k">derived per ingest</span>
          </div>
        </div>
        <div className="toc">
          <a href="#sources">01 Sources</a>
          <a href="#graph">02 The graph</a>
          <a href="#derive">03 Derive stages</a>
          <a href="#interventions">04 Interventions</a>
          <a href="#hooks">05 Hooks</a>
          <a href="#surfaces">06 Surfaces</a>
          <a href="#local">07 Local-first</a>
        </div>
      </section>

      {/* ============= 01 sources ============= */}
      <section id="sources">
        <div className="section-head">
          <span className="section-num">01 / Sources</span>
          <h2>Everything your agent already wrote down.</h2>
          <p className="section-lede">
            Your agent leaves a paper trail in five places. ax reads all of them.
          </p>
        </div>

        <div className="sources-diagram">
          <div className="src-tiles">
            <div className="src-tile">
              <span className="label">Claude transcripts</span>
              <span className="path">~/.claude/projects/*.jsonl</span>
            </div>
            <div className="src-tile">
              <span className="label">Codex sessions</span>
              <span className="path">~/.codex/sessions/*.jsonl</span>
            </div>
            <div className="src-tile">
              <span className="label">Git history</span>
              <span className="path">commits · file changes</span>
            </div>
            <div className="src-tile">
              <span className="label">Hook fires</span>
              <span className="path">pre-tool · post-tool · stop</span>
            </div>
            <div className="src-tile" style={{ gridColumn: "1 / -1" }}>
              <span className="label">Installed skills</span>
              <span className="path">~/.claude/skills/ · ~/.agents/skills/ · ~/.claude/plugins/cache/</span>
            </div>
          </div>

          <div className="src-arrow">
            <span>→</span>
            <span>→</span>
            <span>→</span>
          </div>

          <div className="src-graph">
            <svg width="76" height="76" viewBox="0 0 76 76" fill="none" aria-hidden="true">
              <circle cx="38" cy="14" r="6" fill="#0a0a0a" />
              <circle cx="14" cy="44" r="6" fill="#0a0a0a" />
              <circle cx="62" cy="44" r="6" fill="#0a0a0a" />
              <circle cx="26" cy="64" r="5" fill="#6b6b66" />
              <circle cx="50" cy="64" r="5" fill="#6b6b66" />
              <line x1="38" y1="14" x2="14" y2="44" stroke="#0a0a0a" strokeWidth="1.2" />
              <line x1="38" y1="14" x2="62" y2="44" stroke="#0a0a0a" strokeWidth="1.2" />
              <line x1="14" y1="44" x2="26" y2="64" stroke="#6b6b66" strokeWidth="1" />
              <line x1="14" y1="44" x2="50" y2="64" stroke="#6b6b66" strokeWidth="1" />
              <line x1="62" y1="44" x2="50" y2="64" stroke="#6b6b66" strokeWidth="1" />
              <line x1="62" y1="44" x2="26" y2="64" stroke="#6b6b66" strokeWidth="1" />
            </svg>
            <span className="gname">graph</span>
            <span className="gsub">SurrealDB · local</span>
          </div>
        </div>

        <div className="section-body">
          <p>
            A LaunchAgent (<code>com.necmttn.ax-watch</code>) tails your Claude and Codex transcript
            directories and runs <code>ax ingest --since=1</code> in the background within seconds of a
            new turn. A weekly cron does a deep-scan backfill for anything the watcher missed.
            Nothing is uploaded, queued, or phoned home - every read stays on the same filesystem
            your agent already writes to.
          </p>
        </div>

        <div className="cadence">
          <div className="item">
            <span className="k">live</span>
            <span className="v">
              <b>LaunchAgent</b> tails new turns, ingests in ~2s
            </span>
          </div>
          <div className="item">
            <span className="k">weekly</span>
            <span className="v">
              <b>cron</b> deep-scans for missed sessions + drift
            </span>
          </div>
        </div>
      </section>

      {/* ============= 02 graph ============= */}
      <section id="graph">
        <div className="section-head">
          <span className="section-num">02 / The graph</span>
          <h2>
            A typed graph of <em>who did what, where.</em>
          </h2>
          <p className="section-lede">
            Transcripts become nodes and edges. Sessions own turns. Turns invoke tools. Tools touch files.
            Files end up in commits.
          </p>
        </div>

        <div className="graph-wrap">
          <div className="ascii-graph">
            <span className="c">{`// schema sketch - SurrealDB v3, ns=ax, db=main`}</span>
            {`\n\n       `}
            <span className="n">session</span>
            {` ──owns──▶ `}
            <span className="n">turn</span>
            {` ──invoked──▶ `}
            <span className="n">tool_call</span>
            {`\n          │                  │                    │\n          │                  │                    ├──touched──▶ `}
            <span className="n">file</span>
            {`\n          │                  │                    └──fired────▶ `}
            <span className="n">hook_event</span>
            {`\n          │                  │\n          │                  └──addressed──▶ `}
            <span className="n">skill</span>
            {`\n          │\n          └──produced──▶ `}
            <span className="n">commit</span>
            {` ──changes──▶ `}
            <span className="n">file</span>
            {`\n\n       `}
            <span className="c">{`// relations are first-class - every edge is queryable`}</span>
          </div>

          <div className="graph-legend">
            <div className="legend-block">
              <div className="legend-title">Nodes - 6 of ~14</div>
              <div className="legend-list">
                <div className="row">
                  <code>session</code>
                  <span className="desc">one agent conversation, start → end</span>
                </div>
                <div className="row">
                  <code>turn</code>
                  <span className="desc">a single user-assistant exchange</span>
                </div>
                <div className="row">
                  <code>tool_call</code>
                  <span className="desc">Read, Edit, Bash, MCP - one invocation</span>
                </div>
                <div className="row">
                  <code>skill</code>
                  <span className="desc">an installed Claude/Agents skill</span>
                </div>
                <div className="row">
                  <code>file</code>
                  <span className="desc">a path the agent read or wrote</span>
                </div>
                <div className="row">
                  <code>commit</code>
                  <span className="desc">git commit attributed to a session</span>
                </div>
              </div>
            </div>
            <div className="legend-block">
              <div className="legend-title">Relations - 5</div>
              <div className="legend-list">
                <div className="row rel">
                  <code>invoked</code>
                  <span className="desc">turn → tool_call</span>
                </div>
                <div className="row rel">
                  <code>edited</code>
                  <span className="desc">tool_call → file (Edit/Write)</span>
                </div>
                <div className="row rel">
                  <code>touched</code>
                  <span className="desc">tool_call → file (Read)</span>
                </div>
                <div className="row rel">
                  <code>produced</code>
                  <span className="desc">session → commit</span>
                </div>
                <div className="row rel">
                  <code>addressed</code>
                  <span className="desc">turn → skill (mentioned/loaded)</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ============= 03 derive ============= */}
      <section id="derive">
        <div className="section-head">
          <span className="section-num">03 / Derive stages</span>
          <h2>
            Raw events become <em>findings.</em>
          </h2>
          <p className="section-lede">
            Once the graph is built, ax runs a chain of small derive stages. Each one writes back into
            the same database, so every later query can ask the typed question instead of the raw one.
          </p>
        </div>

        <div className="derive-grid">
          <div className="stage-card">
            <div className="stage-head">
              <span className="stage-name">closure</span>
              <span className="stage-tag">commit</span>
            </div>
            <div className="stage-purpose">Classifies each commit as feature-only or feature-then-fix.</div>
            <div className="stage-meta">
              writes <b>commit.closure</b>
            </div>
          </div>

          <div className="stage-card">
            <div className="stage-head">
              <span className="stage-name">skill_candidate</span>
              <span className="stage-tag">pattern</span>
            </div>
            <div className="stage-purpose">Finds fix-chain patterns worth packaging as a skill.</div>
            <div className="stage-meta">
              writes <b>skill_candidate</b>
            </div>
          </div>

          <div className="stage-card">
            <div className="stage-head">
              <span className="stage-name">session_health</span>
              <span className="stage-tag">session</span>
            </div>
            <div className="stage-purpose">Tokens, cache hit-rate, and context pressure per session.</div>
            <div className="stage-meta">
              writes <b>session.health</b>
            </div>
          </div>

          <div className="stage-card">
            <div className="stage-head">
              <span className="stage-name">friction_event</span>
              <span className="stage-tag">signal</span>
            </div>
            <div className="stage-purpose">Surfaces what failed, where, and how often.</div>
            <div className="stage-meta">
              writes <b>friction_event</b>
            </div>
          </div>

          <div className="stage-card">
            <div className="stage-head">
              <span className="stage-name">command_outcome</span>
              <span className="stage-tag">tool</span>
            </div>
            <div className="stage-purpose">Tags tool calls: success · expected-feedback · guardrail · failure.</div>
            <div className="stage-meta">
              writes <b>tool_call.outcome</b>
            </div>
          </div>

          <div className="stage-card">
            <div className="stage-head">
              <span className="stage-name">workflow_epoch</span>
              <span className="stage-tag">window</span>
            </div>
            <div className="stage-purpose">Splits your history into eras by toolset and workflow shape.</div>
            <div className="stage-meta">
              writes <b>workflow_epoch</b>
            </div>
          </div>

          <div className="stage-card new">
            <div className="stage-head">
              <span className="stage-name">harness_doctor</span>
              <span className="stage-tag">install</span>
            </div>
            <div className="stage-purpose">
              Audits installed skills, hooks, plists, and settings.json for drift, conflicts, dead weight.
            </div>
            <div className="stage-meta">
              writes <b>harness_finding</b>
            </div>
          </div>

          <div className="stage-card new">
            <div className="stage-head">
              <span className="stage-name">classifiers</span>
              <span className="stage-tag">harness</span>
            </div>
            <div className="stage-purpose">
              Pluggable graph classifiers that read derived rows and emit higher-order labels.
            </div>
            <div className="stage-meta">
              writes <b>classifier_result</b>
            </div>
          </div>
        </div>
      </section>

      {/* ============= 04 interventions ============= */}
      <section id="interventions">
        <div className="section-head">
          <span className="section-num">04 / Interventions</span>
          <h2>
            Proposals, lifecycle, <em>and safety gates.</em>
          </h2>
          <p className="section-lede">
            Patterns that recur in your graph turn into Intervention proposals. Each one moves through a
            tracked lifecycle, and any change to your harness ships with a written rollback contract.
          </p>
        </div>

        <div className="iv-wrap">
          <div>
            <div className="iv-forms-title">Six forms</div>
            <div className="iv-forms">
              <div className="iv-form">
                <span className="nm">skill</span>
                <span className="ds">a new SKILL.md packaging a repeated pattern</span>
              </div>
              <div className="iv-form">
                <span className="nm">guidance</span>
                <span className="ds">a line of instruction added to a grounded file</span>
              </div>
              <div className="iv-form">
                <span className="nm">subagent</span>
                <span className="ds">
                  a routed sub-agent under <code className="inline">~/.claude/agents/</code>
                </span>
              </div>
              <div className="iv-form">
                <span className="nm">hook</span>
                <span className="ds">
                  a pre/post-tool gate in <code className="inline">settings.json</code>
                </span>
              </div>
              <div className="iv-form">
                <span className="nm">automation</span>
                <span className="ds">a plist or cron entry that runs on a schedule</span>
              </div>
              <div className="iv-form">
                <span className="nm">harness_check</span>
                <span className="ds">a doctor assertion that proves the change still holds</span>
              </div>
            </div>
          </div>

          <div className="iv-safety">
            <div className="title">Intervention safety contract</div>
            <div className="rows">
              <div className="row">
                <code>recovery_path</code>
                <span className="desc">written rollback steps. Required on every hook + automation.</span>
              </div>
              <div className="row">
                <code>smoke_test_command</code>
                <span className="desc">one shell command that proves the agent still works after.</span>
              </div>
              <div className="row">
                <code>disable_command</code>
                <span className="desc">kill switch you can paste from memory in a panic.</span>
              </div>
              <div className="row">
                <code>failure_mode</code>
                <span className="desc">
                  <code>fail_open</code> (let through if hook errors) or <code>fail_closed</code>.
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="iv-lifecycle">
          <div className="title">Lifecycle - eight states, checkpointed against future sessions</div>
          <div className="iv-states">
            <span className="st">open</span>
            <span className="arrow">→</span>
            <span className="st">accepted</span>
            <span className="arrow">→</span>
            <span className="st">task_emitted</span>
            <span className="arrow">→</span>
            <span className="st">marker_landed</span>
            <span className="arrow">→</span>
            <span className="st checkpoint">+3 sessions</span>
            <span className="arrow">→</span>
            <span className="st checkpoint">+10 sessions</span>
            <span className="arrow">→</span>
            <span className="st checkpoint">+30 sessions</span>
            <span className="arrow">→</span>
            <span className="st final">locked_verdict</span>
          </div>
        </div>

        <div className="iv-manual-safe">
          <b>Manual-safe by commitment.</b> ax never edits <code className="inline">settings.json</code>,
          hooks, LaunchAgents, cron, or shell scripts directly. An accepted intervention emits a task
          brief at <code className="inline">.ax/tasks/&lt;id&gt;.md</code> with the safety contract on top.
          You - or your agent - apply it. <code className="inline">ax improve lint</code> reads the marker
          you left behind to reconcile the proposal back to accepted state.
        </div>

        <div className="iv-brief">
          <div className="bar">
            <span className="filename">.ax/tasks/hook_chk_skip_test_runner.md</span>
            <span style={{ marginLeft: "auto" }}>md</span>
          </div>
          <pre>
            <span className="hd">---</span>
            {"\n"}
            <span className="pn">form</span>: hook{"\n"}
            <span className="pn">experiment</span>: experiment:chk_skip_test_runner{"\n"}
            <span className="pn">recovery_path</span>:{" "}
            <span className="str">
              Remove the matching block from ~/.claude/settings.json,{"\n"}
              {"                  "}restart Claude Code, run smoke test.
            </span>
            {"\n"}
            <span className="pn">smoke_test_command</span>:{" "}
            <span className="str">bun test src/ingest/turns.test.ts</span>
            {"\n"}
            <span className="pn">disable_command</span>:{" "}
            <span className="str">
              jq &apos;del(.hooks.PreToolUse[] | select(.matcher==&quot;Bash&quot;))&apos; \{"\n"}
              {"                  "}~/.claude/settings.json &gt; /tmp/s.json &amp;&amp; mv /tmp/s.json ~/.claude/settings.json
            </span>
            {"\n"}
            <span className="pn">failure_mode</span>: fail_open{"\n"}
            <span className="hd">---</span>
            {"\n\n"}
            <span className="cm"># Hook: block `bun test` without the wrapper</span>
            {"\n\n"}
            Add to <span className="pn">~/.claude/settings.json</span> →{" "}
            <span className="pn">hooks.PreToolUse</span>:{"\n\n"}
            <span className="str">{`{
  "matcher": "Bash",
  "hooks": [{
    "type": "command",
    "command": "echo 'ax:chk_skip_test_runner' && ax-hook check-test-runner"
  }]
}`}</span>
            {"\n\n"}
            The <span className="pn">echo</span> line is the marker{" "}
            <span className="pn">ax improve lint</span> looks for.
          </pre>
        </div>
      </section>

      {/* ============= 05 hooks ============= */}
      <section id="hooks">
        <div className="section-head">
          <span className="section-num">05 / Hooks</span>
          <h2>
            Watch tool fires in <em>real time.</em>
          </h2>
          <p className="section-lede">
            Claude Code and Codex call hook handlers around every tool invocation. ax ships handlers that
            record each fire as a row, and lets you backtest a candidate hook against your last 7–30 days
            before turning it on for real.
          </p>
        </div>

        <div className="hooks-wrap">
          <div className="hook-code">
            <div className="bar">
              <span className="filename">~/.claude/hooks/ax-record.ts</span>
              <span style={{ marginLeft: "auto" }}>ts</span>
            </div>
            <pre>
              <span className="kw">import</span> {"{ recordHook } "}
              <span className="kw">from</span> <span className="str">&quot;ax/hooks&quot;</span>;{"\n\n"}
              <span className="kw">export default async function</span>{" "}
              <span className="fn">handler</span>(<span className="pn">event</span>) {"{"}
              {"\n  "}
              <span className="cm">{`// every pre-tool fire becomes one row`}</span>
              {"\n  "}
              <span className="kw">await</span> <span className="fn">recordHook</span>({"{"}
              {"\n    phase:   "}
              <span className="str">&quot;pre_tool&quot;</span>,{"\n    tool:    event.tool_name,\n    session: event.session_id,\n    inputs:  event.tool_input,\n    at:      "}
              <span className="kw">new</span> Date(),{"\n  });\n}"}
            </pre>
          </div>

          <div className="hook-bullets">
            <div className="hook-bullet">
              <div className="b-title">Phase coverage</div>
              <div className="b-body">
                <code className="inline">pre_tool</code>, <code className="inline">post_tool</code>, and{" "}
                <code className="inline">stop</code> are all captured. Hook rows link back to the{" "}
                <code className="inline">turn</code> and <code className="inline">tool_call</code> that fired them.
              </div>
            </div>
            <div className="hook-bullet">
              <div className="b-title">Inspect + backtest</div>
              <div className="b-body">
                <code className="inline">ax hooks</code> shows fire counts, marker reconciliation, and
                who-installed-what. <code className="inline">ax hooks backtest ./my-hook.ts --days 14</code>
                {" "}replays the last two weeks of tool calls through a candidate before you ship it.
              </div>
            </div>
            <div className="hook-bullet">
              <div className="b-title">No daemon, no socket</div>
              <div className="b-body">
                Hooks write directly to the local SurrealDB. If ax isn&apos;t running, the handler no-ops in
                under a millisecond - your agent never blocks on us.
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ============= 06 surfaces ============= */}
      <section id="surfaces">
        <div className="section-head">
          <span className="section-num">06 / Surfaces</span>
          <h2>
            One CLI, <em>seven verbs.</em>
          </h2>
          <p className="section-lede">
            Everything ax knows is reachable from <code className="inline">ax</code>. The dashboard and TUI
            are the same queries with different paint.
          </p>
        </div>

        <div className="cli-grid">
          <div className="cli-row">
            <span className="cmd">
              ax recall <span className="arg">&lt;q&gt;</span>
            </span>
            <span className="desc">BM25 full-text search across every user + assistant turn. Median 5.9ms.</span>
          </div>
          <div className="cli-row">
            <span className="cmd">ax context</span>
            <span className="desc">Builds a just-in-time context pack from the graph for the next session.</span>
          </div>
          <div className="cli-row">
            <span className="cmd">ax hooks</span>
            <span className="desc">Inspect installed hooks, fire counts, marker reconciliation, and backtest candidates.</span>
          </div>
          <div className="cli-row">
            <span className="cmd">ax doctor</span>
            <span className="desc">Harness health check - drift, conflicts, dead weight across skills + hooks + plists.</span>
          </div>
          <div className="cli-row">
            <span className="cmd">
              ax improve <span className="arg">list / show / accept / reject / lint / verdict / checkpoint</span>
            </span>
            <span className="desc">Walk the intervention queue. Accept emits a task brief; lint reconciles the marker.</span>
          </div>
          <div className="cli-row">
            <span className="cmd">ax serve</span>
            <span className="desc">
              Local web dashboard at <code className="inline">127.0.0.1:8520</code> with the same data the TUI sees.
            </span>
          </div>
          <div className="cli-row">
            <span className="cmd">ax tui</span>
            <span className="desc">Interactive terminal dashboard. Sessions, interventions, harness in one pane.</span>
          </div>
          <div className="cli-row">
            <span className="cmd">
              ax ingest <span className="arg">--since=N</span>
            </span>
            <span className="desc">What the LaunchAgent calls on every new transcript. Idempotent; safe to rerun.</span>
          </div>
        </div>
      </section>

      {/* ============= 07 local-first ============= */}
      <section id="local">
        <div className="section-head">
          <span className="section-num">07 / Local-first</span>
          <h2>
            One process, one database, <em>one laptop.</em>
          </h2>
          <p className="section-lede">
            ax is a single binary that runs as a LaunchAgent, talks only to localhost, and stores
            everything in a SurrealDB instance you own.
          </p>
        </div>

        <div className="local-grid">
          <div className="local-card">
            <span className="lc-eye">database</span>
            <span className="lc-val">127.0.0.1:8521</span>
            <span className="lc-desc">
              SurrealDB v3, schemafull. Namespace <code className="inline">ax</code>, db{" "}
              <code className="inline">main</code>.
            </span>
          </div>
          <div className="local-card">
            <span className="lc-eye">dashboard</span>
            <span className="lc-val">127.0.0.1:8520</span>
            <span className="lc-desc">Web UI for the graph, findings, and intervention queue. No auth - it&apos;s your loopback.</span>
          </div>
          <div className="local-card">
            <span className="lc-eye">daemon</span>
            <span className="lc-val">LaunchAgent</span>
            <span className="lc-desc">
              macOS + Linux, installed by <code className="inline">ax install</code>. Survives reboots.
            </span>
          </div>
          <div className="local-card">
            <span className="lc-eye">license</span>
            <span className="lc-val">MIT · single binary</span>
            <span className="lc-desc">
              Built with Bun. No cloud account, no telemetry egress.{" "}
              <code className="inline">brew uninstall ax</code> removes it.
            </span>
          </div>
        </div>

        <p className="local-quote">
          &ldquo;Your transcripts are already on your laptop. ax just reads them where they sit.&rdquo;
        </p>
      </section>

      {/* ============= footer cards ============= */}
      <section className="cards">
        <div className="cards-grid">
          <Link className="card" to="/how-it-works">
            <span className="card-title">How it works</span>
            <span className="card-foot">
              <span>read</span>
              <span className="arrow">→</span>
            </span>
          </Link>
          <Link className="card" to="/showcases">
            <span className="card-title">Showcases</span>
            <span className="card-foot">
              <span>browse</span>
              <span className="arrow">→</span>
            </span>
          </Link>
          <Link className="card" to="/origin">
            <span className="card-title">Origin</span>
            <span className="card-foot">
              <span>story</span>
              <span className="arrow">→</span>
            </span>
          </Link>
          <Link className="card" to="/docs">
            <span className="card-title">Docs</span>
            <span className="card-foot">
              <span>reference</span>
              <span className="arrow">→</span>
            </span>
          </Link>
        </div>
      </section>
    </main>
  );
}
