/**
 * Curated manifesto content for /manifesto.
 *
 * Replaces the raw-markdown render of docs/manifesto.md (which is now
 * orphaned in the content collection per the WS2a de-conflict rule - a later
 * cleanup PR removes the .md). This module is the source of truth for the
 * manifesto page: the same long-form prose, brought up to product truth
 * (June 2026) - pull-based retro loop, AGPL-3.0, +3/+10/+30 session
 * checkpoints, real receipts - plus three designed editorial beats:
 *   1. a small loop diagram after "That's the spec"
 *   2. the five requirements as numbered editorial cards
 *   3. one real receipt pull-quote
 *
 * Genre is long-form prose; the design moments are additive, not a rebuild.
 * Styling lives in the `.prose` scope (globals.css) + the `.mf-*` section
 * appended there.
 *
 * Always "ax" in visitor copy, never "axctl".
 */

const REQUIREMENTS = [
  {
    n: "01",
    title: "Capture while context is warm",
    body:
      "The reflection has to land while the agent still has its context loaded. ax does this pull-based - a background watcher ingests sessions as they land, and /retro drains the pending ones using idle plan quota. No Stop hook wedged into the turn (it would fire per-turn and block the agent).",
  },
  {
    n: "02",
    title: "Structured by default",
    body:
      "Free-text retros don't compound. JSON with four fields - tried, worked, failed, next - lets the graph index, query, and diff each piece independently. Free-form is an escape hatch, not the default.",
  },
  {
    n: "03",
    title: "Cover sub-agents",
    body:
      "Main-session retros are nice. Sub-agent retros are the unlock. Sub-agents fan out, finish fast, and die with everything they learned. The loop has to reach them too, and the retro has to roll up to the parent session.",
  },
  {
    n: "04",
    title: "Become a proposal",
    body:
      "“That worked, do it more” isn't useful. “That worked, here is the skill / hook / guidance candidate that captures it, ranked by how often it would have fired” is. The retro feeds a deduplicated proposal queue you accept, reject, or skip.",
  },
  {
    n: "05",
    title: "Become an experiment",
    body:
      "Accepted proposals get scaffolded as real artifacts and tracked as experiments. Checkpoints at +3 / +10 / +30 sessions after accept close the verdict - sessions, not calendar days, so a weekend doesn't delay it and a productive afternoon doesn't rush it. Every verdict is itself signal for next time.",
  },
];

const LOOP_STEPS = ["ingest", "reflect", "propose", "experiment", "verdict"];

export function ManifestoContent() {
  return (
    <>
      <h1>The retro loop</h1>
      <p>
        <em>A manifesto for self-improving AI coding agents.</em>
      </p>

      <hr />

      <p>
        Every sub-agent you spawn finishes its work and disappears. Whatever it
        figured out - which command failed three times before the right one,
        which file actually mattered, which approach to skip next time - dies
        with it. The next sub-agent rediscovers it from scratch. Your own next
        session does too.
      </p>
      <p>
        This is not a memory problem. <em>Memory</em> is what you remember.{" "}
        <em>Retro</em> is what you reflect on, structure, and turn into the next
        bet. The agent stack has compute, tools, and logs. It does not have a
        reflection loop.
      </p>
      <p>
        <code>ax</code> is that loop. As sessions land, <code>ax</code> ingests
        them in the background and asks the agent for a structured retro: what
        was tried, what worked, what failed, what to try next. Each retro
        becomes an <em>experiment</em> in a typed local graph. Each experiment
        gets a verdict the next time the same situation appears. Over weeks, the
        graph carries the signal your sessions otherwise dropped on the floor.
      </p>
      <p>
        This is verbal self-reflection at the engineering layer. Reflexion for
        software. The closed loop is the product.
      </p>

      <h2>What&apos;s in the stack today</h2>
      <p>
        Look at any production AI-agent setup in 2026. You have the frontier
        models and the open-weights crowd. You have inference platforms. You
        have a tool layer: shells, editors, MCP servers, IDEs. You have memory
        bolt-ons: a vector store, maybe Letta, maybe just a long context window.
        You have observability at the API level - LangSmith, Langfuse, Phoenix -
        telling you what the agent did.
      </p>
      <p>
        What none of them have is a <em>reflection step</em>. Nothing in the
        stack asks the agent at end-of-session: <em>what did you learn?</em> and
        turns the answer into something the next session can read.
      </p>
      <p>
        The closest analog is the human side: code review, retros, postmortems.
        Engineers do them because <em>the act of structuring what happened</em>{" "}
        is what makes the next iteration better. Without it the team just does
        the same thing again.
      </p>
      <p>
        Agents are now in the same place. They have the intelligence. They lack
        the reflection loop.
      </p>

      <h2>What the loop has to do</h2>
      <p>A real retro loop for AI coding agents needs five things:</p>

      <ol className="mf-reqs" aria-label="five requirements the retro loop has to meet">
        {REQUIREMENTS.map((r) => (
          <li className="mf-req" key={r.n}>
            <span className="mf-req-n">{r.n}</span>
            <div className="mf-req-text">
              <strong>{r.title}</strong>
              <span>{r.body}</span>
            </div>
          </li>
        ))}
      </ol>

      <p>
        That&apos;s the spec. Ingest, reflect, propose, experiment, verdict -
        then the next session reads what worked.
      </p>

      <figure className="mf-loop" aria-label="the retro loop: ingest, reflect, propose, experiment, verdict, and back">
        <div className="mf-loop-track">
          {LOOP_STEPS.map((step, i) => (
            <span className="mf-loop-step" key={step}>
              <span className="mf-loop-dot" aria-hidden="true" />
              {step}
              {i < LOOP_STEPS.length - 1 && (
                <span className="mf-loop-arrow" aria-hidden="true">
                  &rarr;
                </span>
              )}
            </span>
          ))}
          <span className="mf-loop-return" aria-hidden="true">
            &#8617; next session reads what worked
          </span>
        </div>
      </figure>

      <h2>What <code>ax</code> is</h2>
      <p>
        <code>ax</code> is the reference implementation. Local typed graph,
        agent-readable queries, a React dashboard, AGPL-3.0 licensed. Runs on
        your laptop.
      </p>
      <p>
        It is past a journal of retros. The improve-first dashboard ranks
        proposals by projected value - one recent deck surfaced{" "}
        <strong>$605 in redirectable model spend</strong> and a recurring
        pattern worth <strong>26x</strong> its cost to fix. The cost-routing
        loop (<code>ax dispatches</code>, <code>ax routing tune</code>) moves
        mechanical sub-agent dispatches onto cheaper models and measures whether
        the routing actually landed. Accepted fixes become experiments with
        checkpoints at +3 / +10 / +30 sessions, so the dashboard can show you,
        from backing data, which past bets earned their place.
      </p>

      <blockquote className="mf-receipt">
        <p>add pre-tool hook: block writes on main &mdash; KEPT</p>
        <cite>experiment closed at +30 sessions &middot; 0 incidents</cite>
      </blockquote>

      <p>The surface is small on purpose:</p>
      <ul>
        <li>
          <code>ax install</code> sets up the local graph and the background
          watcher that tails your Claude Code and Codex transcript directories.
          One command, one time. No Stop hook - it would fire per turn and block
          the agent.
        </li>
        <li>
          <code>ax retro</code> (the slash-command skill) drains the pending
          sessions the watcher ingested, walking you through triage in Claude
          Code while idle plan quota does the reflection work.
        </li>
        <li>
          <code>ax improve list</code> shows the proposal queue derived from
          accumulated retros and friction signals.
        </li>
        <li>
          <code>ax improve accept | reject</code> triages it. Acceptance
          scaffolds the artifact and opens an experiment.
        </li>
        <li>
          <code>ax improve verdict</code> shows the checkpoint state and locks
          the outcome.
        </li>
        <li>
          <code>ax serve</code> opens the improve-first dashboard - proposal
          deck, impact engine, and the experiments strip of past bets, measured.
        </li>
      </ul>
      <p>
        That&apos;s the loop. Everything else - the typed graph, the search, the
        skill-taste scoring, the hooks SDK, the MCP server - is in service of it.
        Pieces of this ship elsewhere; nobody else ships the whole closed loop,
        local-first, on your laptop.
      </p>

      <h2>Why this matters now</h2>
      <p>
        The interesting agent work in 2026 - inside labs and out - is
        multi-agent. Sub-agent fan-out, role delegation, parallel worktrees.
        Every additional sub-agent multiplies the amount of evidence silently
        thrown away. The marginal cost of <em>not</em> closing the loop goes up
        with every Task tool call you make.
      </p>
      <p>
        The labs know this. Internal evals at OpenAI and Anthropic absolutely
        track this stuff. What&apos;s missing publicly is an open, local-first
        reference for what the loop should look like at the end-user side - on
        the developer&apos;s laptop, with their data, in their hands.
      </p>
      <p>
        <code>ax</code> exists because I needed it. I&apos;m publishing it
        because the shape of the loop matters more than the implementation, and
        the shape gets locked in early.
      </p>

      <h2>What&apos;s next</h2>
      <p>
        Read the{" "}
        <a href="https://github.com/Necmttn/ax" target="_blank" rel="noopener noreferrer">
          README on GitHub
        </a>
        . Install <code>ax</code>. Let it watch a week of your sessions. Run{" "}
        <code>ax retro</code> at the end of one. Look at what falls out.
      </p>
      <p>
        Then tell me what&apos;s wrong with the shape - the{" "}
        <a
          href="https://github.com/Necmttn/ax/tree/main/docs/adr"
          target="_blank"
          rel="noopener noreferrer"
        >
          ADRs in <code>docs/adr/</code>
        </a>{" "}
        argue with my past self about exactly that. If you want to argue with the
        framing, open an{" "}
        <a href="https://github.com/Necmttn/ax/issues" target="_blank" rel="noopener noreferrer">
          issue
        </a>
        . If you want to extend it,{" "}
        <a
          href="https://github.com/Necmttn/ax/blob/main/CONTRIBUTING.md"
          target="_blank"
          rel="noopener noreferrer"
        >
          read CONTRIBUTING.md
        </a>
        .
      </p>
      <p>
        If you&apos;re building agent infrastructure inside an AI lab right now -
        and I know you are - you&apos;re building some version of this. Your
        version will be better-funded, more polished, deeper-integrated. It
        should be. What it won&apos;t be is open, local-first, and
        shape-of-the-problem first. That&apos;s what an open reference does - it
        shapes the problem statement before the closed implementations lock in
        proprietary vocabularies.
      </p>
      <p>The stack is missing a reflection step. Let&apos;s build it.</p>
      <p>
        <a href="https://github.com/Necmttn" target="_blank" rel="noopener noreferrer">
          Necmettin Karakaya
        </a>
        , 2026
      </p>
    </>
  );
}
