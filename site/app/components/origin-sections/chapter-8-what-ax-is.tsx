export function Chapter8WhatAxIs() {
  return (
    <section className="section">
      <h2>What <em>ax</em> is.</h2>

      <p>
        The stack in 2026 has compute, tools, logs, and a pile of memory
        bolt-ons. It still does not have a reflection step. I know this
        because I was the reflection step.
      </p>

      <p>
        For months I was the one noticing the same friction across
        sessions, deciding what to change, and checking weeks later
        whether it helped. <code>ax</code> is me automating the loop I
        was already closing by hand.
      </p>

      <p>
        It ingests Claude Code and Codex transcripts, tool calls, skills,
        hooks, corrections, and local git history into a typed graph on
        your laptop. It asks for session retros while context is still
        warm. It lets bigger retros surface repeated friction. It turns
        proposed fixes into experiments and asks for verdicts later.
      </p>

      <p>
        The goal is not to build a vague memory product. The goal is to
        build the agent experience layer: the local system that measures
        what the agent did, reflects on it, proposes improvements, and
        checks whether those improvements actually helped.
      </p>

      <p>
        If you are building agent infrastructure inside an AI lab right
        now - and I know you are - you are building some
        version of this. Your version will be better-funded, more
        polished, deeper-integrated. It should be. What it will not be
        is open, local-first, and shape-of-the-problem first. That is
        what an open reference does: it shapes the problem statement
        before the closed implementations lock in proprietary
        vocabularies.
      </p>

      <p>
        If you want to try it, it is{" "}
        <a href="https://github.com/Necmttn/ax">on GitHub</a>, MIT
        licensed, and runs on your laptop. Then tell me where the shape
        is wrong.
      </p>
    </section>
  );
}
