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
`axctl daemon status`, `axctl ingest`.

### ax studio

The live dashboard at `axctl serve`. Use the studio name in prose
("open ax studio at `127.0.0.1:8520`"), use the command name in
instructions (`axctl serve --port=8520`).

### ax pilot

The installable agent skill (`skills/axctl/SKILL.md`). What runs inside Claude
Code / Codex to query the graph mid-session.

### ax retro

The retrospective workflow (`skills/ax-retro/SKILL.md`). What closes
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
insights. SurrealDB underneath, but the abstraction is "the ax-graph".

### ax-score

The composite taste metric for skills, computed across recency,
frequency, and clean-run rate. Exposed by `axctl skills taste`.

### ax-signal

A derived observation extracted from raw ingest. Examples:
`friction_event`, `diagnostic_event`, `recommendation`. Plural:
ax-signals.

### ax-loop

The self-improvement cycle: **ingest** (capture what happened) →
**signal** (derive meaning) → **act** (ground the next session). When
you say "close the loop", you mean a signal turned into a future
action.

## Verbs

| Term | Meaning |
|---|---|
| **ax it** | Triage a skill or session. "I axed those three unused skills." |
| **ground** | Pre-flight an agent with project context. "Always ground before non-trivial repo work." |
| **wrap** | Generate the annual recap. "ax wrapped" the verb form. |

## Forbidden / collision-prone terms

| Don't say | Say instead | Why |
|---|---|---|
| "agent memory" | "ax-graph" or "agent experience" | Memory is a subset of AX; using it cedes positioning to Letta/MemGPT/Mem0. |
| "observability platform" | "agent experience layer" | Observability is a piece; AXL is bigger. |
| "telemetry" | "evidence" or "signal" | Telemetry implies just collection. Evidence implies grounded, queryable. |
| "AI memory" | "AX layer" | "AI memory" is everyone's term - owns nothing. |
| "context engine" | "ax-graph" | Generic and crowded. |

## Versioning the language

This file is the source of truth. If you find yourself coining a new
term in code or docs, **add it here first**. Terms that aren't in this
file aren't part of the brand.
