# The missing layer

*A manifesto for Agent Experience.*

---

## Four layers govern one session

Coding-agent quality mostly comes from four layers. I made that case
elsewhere ([10× Your Coding Agent by Fixing Its Environment](https://necmttn.com/blog/10x-coding-agent)),
the short version is:

- **Perception** - what the agent can search and notice. Gitignore-aware
  retrieval, scoped greps, structured tool results.
- **Representation** - how legible the code, diffs, and outputs are.
  `bat`, `delta`, `jq` instead of giant blobs.
- **Verification** - how fast the codebase pushes back. Typed
  interfaces, fast linters, sub-second feedback.
- **Boundary** - what the agent can safely touch. Worktrees, hunk
  staging, three-way merge markers.

*Most coding-agent failures are not model failures. They are context
failures created by the environment the agent operates in.* Get those
four right and the same model that looks incompetent in one repo
looks brilliant in another.

## What governs *every* session?

Nothing, today. That is the hole.

The four layers describe what is true inside one run. Reset the
conversation and you lose all of it. Your agent re-reads the same
files. Re-discovers the same broken commands. Re-invokes the same
skills you told it to stop using last week. Re-learns the
verification recipe for your project. Every single time.

Look at any production agent setup in 2026. You have models -
Claude 4.7, GPT-5, the open-weights crowd. You have inference
platforms. You have a tool layer: shells, editors, MCP servers, IDEs.
You have memory bolt-ons: a vector store, maybe Letta, maybe a long
context window. You have observability - LangSmith, Langfuse, Phoenix
- telling you what the agent did at the API level.

Now ask: **what does the agent *know about itself* the second time
you open a session?**

The stack has compute. It has memory in the rolling-context sense.
It has tools. It has logs. It does not have an **experience layer**.

A fifth layer needs to exist - one that carries the four across
sessions, captures what the environment said the last hundred times
the agent worked in this repo, and surfaces that back when it matters.
That layer is **agent experience**.

## A note on the term

Other writers have used "Agent Experience" to mean the *website's*
friendliness to agent visitors - agent-as-user-of-product. That's a
real and useful thing. It is not what this manifesto is about.

Here, AX is the *agent's* experience of doing its own work - what it
perceives across sessions, what it remembers, what it acts on. Two
directions of the same word: outward-facing (does my site work for
agents) and inward-facing (does my agent's surface work for itself).
Both will exist. This manifesto is about the inward one.

## What experience means

Borrow the analogy from humans. A senior engineer joins a new team.
On day one, they're useless. By month six, they're shipping. Why?
They've accumulated *experience* - implicit knowledge of which tools
fail, which conventions matter, which colleagues to ask, which paths
are dead ends. The accumulation isn't memory in the LLM sense. It's
structured: graph-shaped, evidence-grounded, queryable, *theirs*.

This is what Developer Experience (DX) tools nurture for humans -
shorter feedback loops, faster onboarding, clearer error messages,
better defaults. The whole field exists because we figured out that
human productivity is bottlenecked by the experience surface, not raw
intelligence.

Agents are now bottlenecked by the same thing. They have the
intelligence. They lack the experience surface.

I call this the **Agent Experience Layer**.

## What it needs to be

An Agent Experience Layer is not "agent memory". Memory is a piece of
it - the part that holds raw facts. AXL is the whole surface where
prior behavior becomes future capability. Specifically, it needs:

1. **Typed evidence**, not embeddings.
   Sessions, turns, tool calls, skills, files, commits, friction -
   each a first-class type with schema. Queryable like a database,
   not searched like a haystack.

2. **Multi-agent ingest.**
   Claude Code is one agent. Codex is another. Internal harness hooks
   are a third. They all produce evidence; the layer reads all of it.
   Single-agent memory tools have already lost.

3. **Agent-readable interface.**
   The agent doesn't open a dashboard. It calls a function. The layer
   exposes typed queries the agent can invoke mid-session -
   `project context`, `recall`, `verify`, `friction recent` - and
   gets back structured JSON.

4. **Local-first, user-owned.**
   This is the user's behavior history. Their prompts. Their bugs.
   Their code. It does not leave the machine. The privacy stance is
   the moat: the more sensitive the data, the more value the layer
   provides, the less anyone can sell it.

5. **The self-improvement loop, closed.**
   Ingest → signal → act → ingest. Friction in last week's session
   becomes a verification check in this week's pre-flight. A skill
   that never fires gets archived. A correction the user kept making
   becomes guidance. The loop is the product.

That's the spec. Five lines. Nobody is shipping all of it.

## What ax is

`ax` is the reference implementation. Bun runtime. SurrealDB graph.
Effect pipelines. React dashboard. MIT licensed. Runs on your laptop.
160 skills indexed, 1,100+ sessions, 40k tool invocations on my
machine right now. Eight commands cover the surface. The agent skill
plugs into Claude Code and Codex.

It exists because I needed it. I'm publishing it because the category
needs a flag in the ground.

If you're building agent infrastructure inside an AI lab right now -
and I know you are - you're building some version of this. Your
version will be better-funded, more polished, deeper-integrated. It
should be. What it won't be is open, local-first, and shape-of-the-
problem first. That's what an open reference does - it shapes the
problem statement before the closed implementations lock in
proprietary vocabularies.

The next decade of agent work runs through this layer. The naming
matters. The shape matters. The privacy stance matters.

## What's next

Read the [README](../README.md), install `ax`, point it at your
`~/.claude/projects/` and `~/.codex/sessions/`, and look at what
falls out. Tell me what's wrong with the schema - there are nineteen
ADRs in `docs/adr/` arguing with my past self about exactly that.

If you want to argue with the framing, open an issue. If you want to
extend it, read [`CONTRIBUTING.md`](../CONTRIBUTING.md). If you want
to fork it under your lab's name, that's what MIT means - but you
might as well stay and help shape the open category instead.

The stack is missing a layer. Let's build it.

- [Necmettin Karakaya](https://github.com/Necmttn), 2026
