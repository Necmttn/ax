# Claude Code's Dynamic Workflows: the model writes its own harness

Claude Code's dynamic Workflows are easy to underrate. This isn't `/goal` but longer, and it isn't "run a few subagents and verify." It's Claude generating an entire agent harness on demand, then running it.

Give it a big task. Claude plans the workflow, writes the orchestration, fans work out across tens to hundreds of subagents, then checks the results before reporting back. The agent isn't just doing the work - it's *building the system that does the work*, and it writes that system itself, per task.

## The primitives

The orchestration script Claude writes uses a small set of building blocks:

- `agent(prompt)` - spawn a subagent
- `parallel([...])` - fan out and wait for all
- `pipeline(items, ...stages)` - stream work through stages
- `phase()` / `log()` - emit live progress

Everything else is plain JavaScript: loops, filters, maps, conditionals. The script is real control flow, not a config file.

## Typed output is the unlock

The feature that makes this usable is typed output. Pass a JSON schema to `agent()` and the runtime validates the response - the subagent is forced to return that exact shape, retrying until it matches.

No parsing walls of text. Every subagent hands back structured data the script can route, rank, or filter:

```js
const triaged = await parallel(issues.map((n) => () =>
  agent(`triage issue #${n}`, { schema: TRIAGE_SCHEMA })
))
```

Eleven issues become eleven agents running at once, each returning `{ priority, effort, nextStep }`. Then one more agent ranks them into a board.

## The conductor is self-written

Here's the part people miss: `agent()`, `parallel()`, and `pipeline()` aren't libraries the script imports. The runtime injects them.

The script is a conductor - plain JS for control flow, with globals that reach back into the harness to spawn live Claudes. And the conductor is written by Claude itself. The model writes the program that controls the model.

## Why it matters for codebases

For code, this is the whole game. Bug hunts, migrations, audits, refactors - anything that decomposes across files or modules - becomes a fleet problem instead of a single-agent slog.

The wins over the old single-agent loop:

- Each subagent gets a fresh context
- Work runs in parallel
- Findings get independently verified
- Long tasks stop living inside one bloated conversation

It's the missing `/clear` primitive, scaled.

## Static trees vs. generated trees

The clearest way to think about it: `ralph`, GSD, and hand-stacked `.md` task files are hand-written harnesses. Dynamic workflows are generated harnesses. Same category - one is pre-baked, one is synthesized at runtime.

The sharpest primitive in that generated harness is `pipeline()`. Items move through stages with no global barrier - item A can be on stage 3 while item B is still on stage 1. Wall-clock becomes the slowest single chain, not the sum of every stage. Most multi-step agent work should probably be shaped this way.

## The catch

This isn't free magic. A dynamic workflow can burn meaningfully more usage than a normal Claude Code session. The practical play is to start with scoped tasks and graduate to the big migrations once you trust the shape.

## The direction

AI coding is moving from "model writes code" to "model writes the harness that coordinates models writing and verifying code." That's a new scaling axis:

> base model compute × thinking compute × **generated harness compute**

---

*None of this is documented well - I pieced a lot of it together by reading the runtime's own traces. That's what I'm building: **ax**, a local telemetry graph for your coding agents. It ingests every transcript so you can see what your agents actually do. → [ax.necmttn.com](https://ax.necmttn.com)*
