# The retro loop

*A manifesto for self-improving AI coding agents.*

---

Every sub-agent you spawn finishes its work and disappears. Whatever
it figured out - which command failed three times before the right
one, which file actually mattered, which approach to skip next time -
dies with it. The next sub-agent rediscovers it from scratch. Your
own next session does too.

This is not a memory problem. *Memory* is what you remember.
*Retro* is what you reflect on, structure, and turn into the next
bet. The agent stack has compute, tools, and logs. It does not have
a reflection loop.

`ax` is that loop. Before any session ends - main or sub-agent - `ax`
asks the agent for a structured retro: what was tried, what worked,
what failed, what to try next. Each retro becomes an *experiment* in
a typed local graph. Each experiment gets a verdict the next time
the same situation appears. Over weeks, the graph carries the signal
your sessions otherwise dropped on the floor.

This is verbal self-reflection at the engineering layer. Reflexion
for software. The closed loop is the product.

## What's in the stack today

Look at any production AI-agent setup in 2026. You have models -
Claude 4.7, GPT-5, the open-weights crowd. You have inference
platforms. You have a tool layer: shells, editors, MCP servers, IDEs.
You have memory bolt-ons: a vector store, maybe Letta, maybe just a
long context window. You have observability at the API level -
LangSmith, Langfuse, Phoenix - telling you what the agent did.

What none of them have is a *reflection step*. Nothing in the stack
asks the agent at end-of-session: *what did you learn?* and turns the
answer into something the next session can read.

The closest analog is the human side: code review, retros, post-
mortems. Engineers do them because *the act of structuring what
happened* is what makes the next iteration better. Without it the
team just does the same thing again.

Agents are now in the same place. They have the intelligence. They
lack the reflection loop.

## What the loop has to do

A real retro loop for AI coding agents needs five things:

1. **Fire at the right time.**
   The Stop hook on session-end is the only moment the agent has all
   its context loaded. Five seconds later it's gone. The retro has
   to be enforced there, not opt-in.

2. **Structured by default.**
   Free-text retros don't compound. JSON with four fields - *tried*,
   *worked*, *failed*, *next* - lets the graph index, query, and
   diff each piece independently. Free-form is an opt-in escape
   hatch, not the default.

3. **Cover sub-agents.**
   Main-session retros are nice. Sub-agent retros are the unlock.
   Sub-agents fan out, finish fast, and die with everything they
   learned. The hook has to fire for them too, and the retro has
   to roll up to the parent session.

4. **Become a proposal.**
   *"That worked, do it more"* isn't useful. *"That worked, here is
   the skill / hook / guidance candidate that captures it, ranked by
   how often it would have fired"* is. The retro feeds a
   deduplicated proposal queue the user accepts, rejects, or skips.

5. **Become an experiment.**
   Accepted proposals get scaffolded as real artifacts and tracked
   as experiments. Checkpoints at +3 / +10 / +30 sessions after
   accept close the verdict: did this thing actually get used, did
   it improve outcomes, did it regress, did the pattern
   self-resolve. Sessions, not calendar days - a weekend doesn't
   delay the verdict, a productive afternoon doesn't rush it.
   Every verdict is itself signal for next time.

That's the spec. Ingest -> reflect -> propose -> experiment ->
verdict -> next session reads what worked. Nobody is shipping all of
it.

## What `ax` is

`ax` is the reference implementation. Local typed graph,
agent-readable queries, React dashboard, AGPL-3.0 licensed. Runs on your
laptop.

The surface is small on purpose:

- `ax install` wires the Stop hook into your Claude Code and Codex
  configs. One command, one time.
- `ax retro` is what the hook calls at session-end. The agent emits
  the JSON. `ax` indexes it.
- `ax improve list` shows the proposal queue derived from accumulated
  retros and friction signals.
- `ax improve accept | reject` triages it. Acceptance scaffolds the
  artifact and opens an experiment.
- `ax improve verdict` shows the checkpoint state and locks the
  outcome.
- `ax retro` (the slash-command skill) walks you through the same
  triage interactively in Claude Code.

That's the loop. Everything else - the dashboard, the typed graph,
the search, the skill-taste scoring - is in service of those six
commands.

## Why this matters now

The interesting agent work in 2026 - inside labs and out - is
multi-agent. Sub-agent fan-out, role delegation, parallel worktrees.
Every additional sub-agent multiplies the amount of evidence
silently thrown away. The marginal cost of *not* closing the loop
goes up with every Task tool call you make.

The labs know this. Internal evals at OpenAI and Anthropic
absolutely track this stuff. What's missing publicly is an open,
local-first reference for what the loop should look like at the
end-user side - on the developer's laptop, with their data, in
their hands.

`ax` exists because I needed it. I'm publishing it because the shape
of the loop matters more than the implementation, and the shape gets
locked in early.

## What's next

Read the [README](../README.md). Install `ax`. Let it watch a week
of your sessions. Run `ax retro` at the end of one. Look at what
falls out.

Then tell me what's wrong with the shape - there are nineteen ADRs in
[`docs/adr/`](adr/) arguing with my past self about exactly that. If
you want to argue with the framing, open an issue. If you want to
extend it, read [`CONTRIBUTING.md`](../CONTRIBUTING.md).

If you're building agent infrastructure inside an AI lab right now -
and I know you are - you're building some version of this. Your
version will be better-funded, more polished, deeper-integrated. It
should be. What it won't be is open, local-first, and shape-of-the-
problem first. That's what an open reference does - it shapes the
problem statement before the closed implementations lock in
proprietary vocabularies.

The stack is missing a reflection step. Let's build it.

- [Necmettin Karakaya](https://github.com/Necmttn), 2026
