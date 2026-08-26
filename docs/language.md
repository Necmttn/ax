# ax language

The vocabulary of the agent experience layer. Use these terms exactly
as defined here - in commits, code, docs, and conversation. Naming is
the work.

For the domain glossary (Repository vs. Checkout vs. Worktree vs.
Workspace), see [`CONTEXT.md`](../CONTEXT.md). This file is about the
**brand-level** vocabulary.

## The category

### Agent Experience (AX)

The discipline of measuring, shaping, and improving what an AI coding
agent perceives, remembers, and acts on across sessions. Direct analog
of Developer Experience (DX) for human engineers.

> *Use:* "AX is to AI agents what DX is to humans."
> *Don't say:* "agentic UX", "agent UX", "AI experience" - those mean
> different things in adjacent communities.

### Agent Experience Layer (AXL)

A software layer that owns the AX surface - ingest, storage, query,
and agent-readable interfaces over the evidence of prior agent
behavior. `ax` is the reference implementation.

> *Use:* "an Agent Experience Layer needs typed evidence, multi-agent
> ingest, and an agent-readable interface."
> *Don't say:* "agent memory" alone - memory is a piece, AXL is the
> whole surface.

## The product surface

### `ax`

The project. Lowercase always. The whole thing.

### `axctl`

The CLI binary. Use when the technical layer matters. `axctl install`,
`axctl studio`, `axctl ingest`.

### ax studio

The live dashboard at `axctl studio`. Use the studio name in prose
("open ax studio at `127.0.0.1:1738`"), use the command name in
instructions (`axctl studio --port=1738`). The service stops after its browser
client disconnects.

### ax pilot

The install + verify skill (`skills/setup/SKILL.md`, displayed as
`ax:setup`). What runs inside Claude Code / Codex to bring a new machine
up to speed.

### ax retro

The retrospective workflow (`skills/retro/SKILL.md`, displayed as
`ax:retro`). What closes
the self-improvement loop on observed evidence.

### ax doctor

System-health CLI (`axctl doctor`). What the user runs when something
feels wrong.

### ax wrapped

Annual recap surface. Dashboard route `/wrapped` plus the underlying
data product. Year-end shareable view.

## Primitives in the graph

### ax-graph

The typed evidence store. Sessions, turns, tool calls, plans, skills,
repositories, checkouts, commits, files, friction, diagnostics,
insights, **retros, proposals, experiments, verdicts**. Local DB
underneath, but the abstraction is "the ax-graph".

### retro

A structured reflection collected during an on-demand review. Four
fields by default: **tried** (what the agent attempted), **worked**
(what landed), **failed** (what didn't), **next** (the experiment to
run next). Free-form is opt-in via `ax retro --free-form`.

> *Use:* "the `/retro` skill pulls sessions that need review."
> *Don't say:* "session summary" - that's lossy. The retro is a
> bet on the next session, not a recap.

### reviewed

A typed graph edge (`session -> reviewed -> retro`) that records that
a session has been retro'd. `ax retro pending` queries `WHERE
count(->reviewed) = 0` to drain the backlog of un-reviewed sessions;
`ax retro emit` writes the edge alongside the retro row so re-emit
stays idempotent.

> *Use:* "the `/retro` skill drains everything without a `reviewed`
> edge - that's the backlog the user spends weekly Opus quota on."
> *Don't say:* "the retro foreign key" - we have one, but the edge is
> the load-bearing primitive; the FK is duplicate state we keep for
> compatibility with `ax retro emit` callers that don't traverse the
> graph.

### proposal

A friction pattern derived from accumulated retros + raw signal.
Each proposal has a *form* (skill / hook / guidance / automation /
subagent), a *trigger* (when it would fire), a *behavior* (what it
would do), and a *dedupe_sig* (so the same pattern doesn't re-propose
forever). Triaged via `ax improve list | accept | reject`.

### experiment

What an accepted proposal becomes. An experiment has a *form*, an
*artifact* (the scaffolded skill / hook / etc.), and checkpoints after
3, 10, and 30 sessions. Tracked in the graph; queried via
`ax improve verdict`.

### verdict

The outcome locked at a checkpoint. Five values:
**adopted** (the artifact is doing real work),
**ignored** (it was created but never invoked),
**regressed** (it made things worse),
**partial** (mixed signal),
**no_longer_needed** (the underlying pattern self-resolved).

### ax-score

The composite taste metric for skills: an ALL-TIME score (not a 30-day
or recency-weighted metric) computed from invocations, same-session
corrections, correlated commits, and proposal-edge counts.
Clean-run rate does not affect the score. Exact formula and column
legend are printed by `axctl skills taste`
(`apps/axctl/src/queries/skill-taste-score.ts`).

### ax-signal

A derived observation extracted from raw ingest. Examples:
`friction_event`, `diagnostic_event`, `recommendation`. Plural:
ax-signals.

### ax-loop

The closed self-improvement cycle: **retro** (the user reviews a session) →
**proposal** (friction pattern surfaces) →
**experiment** (artifact scaffolded, ran) → **verdict** (outcome
locked) → next session reads what worked. When you say "close the
loop", you mean one full pass from retro to verdict.

## Verbs

| Term | Meaning |
|---|---|
| **ax it** | Triage a skill or session. "I axed those three unused skills." |
| **retro** | Review a session and collect a structured reflection. Verb and noun: "review this session", "I have three pending retros." |
| **propose** | Surface a friction pattern as a candidate skill/hook/guidance. "Six retros propose the same hook this week." |
| **lock a verdict** | Confirm the outcome of an experiment at checkpoint. "I locked the schema-guardrail verdict as `adopted`." |
| **ground** | Pre-flight an agent with project context. "Always ground before non-trivial repo work." |
| **wrap** | Generate the annual recap. "ax wrapped" the verb form. |

## Forbidden / collision-prone terms

| Don't say | Say instead | Why |
|---|---|---|
| "agent memory" | "the retro loop" / "ax-graph" | Memory is a subset; positioning ax as memory cedes ground to Letta/MemGPT/Mem0. |
| "observability platform" | "the retro loop" | Observability watches; ax reflects + acts. |
| "telemetry" | "evidence" or "retro" | Telemetry implies just collection. Retro implies reflection + a bet on next. |
| "AI memory" | "agent experience" / "the retro loop" | "AI memory" is everyone's term - owns nothing. |
| "session summary" | "retro" | Summary is lossy; retro is structured + actionable. |
| "context engine" | "ax-graph" | Generic and crowded. |
| "reflection / reflexion" alone | "retro" | Reflexion is the academic anchor; "retro" is the product surface. |

## Versioning the language

This file is the source of truth. If you find yourself coining a new
term in code or docs, **add it here first**. Terms that aren't in this
file aren't part of the brand.
