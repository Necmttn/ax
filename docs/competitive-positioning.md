# competitive positioning notes

Working notes for nearby products and how `ax` should position against
them. Keep this factual, source-backed, and separate from public copy.

## rote by modiqo

Checked: 2026-05-30.

Sources:

- https://www.modiqo.ai/
- https://www.modiqo.ai/llms-full.txt
- https://www.modiqo.ai/glossary.txt
- https://www.modiqo.ai/pricing
- https://marketplace.visualstudio.com/items?itemName=Modiqo.rote
- https://www.prnewswire.com/news-releases/modiqo-raises-pre-seed-round-to-bring-deterministic-ai-workflows-to-enterprises-at-a-fraction-of-the-token-cost-302784345.html

### What they have

Rote is pitching itself as agent tool infrastructure: a local-first
execution layer for agents that use real tools. The product frame is
API/workflow reliability, not coding-agent reflection.

Public claims and primitives:

- shipping Q2 2026; pre-launch/waitlist language still present in their
  machine-readable docs.
- $3M pre-seed announced 2026-05-28, co-led by Heavybit and Seligman
  Ventures, with Irregular Expressions and angels participating.
- CLI installed via `curl -fsSL https://getrote.dev/install | bash`.
- local state under `~/.rote/`.
- adapters turn OpenAPI, Swagger, GraphQL, Google Discovery, MCP, and
  local JSON into callable tool surfaces with auth, permissions, and
  sensitivity metadata.
- traces record execution calls, sequencing, outcomes, latency, token
  cost, and evidence.
- crystallization converts successful traces into deterministic,
  versioned TypeScript flows / skills.
- recall searches known-good flows, described as BM25/Tantivy-backed.
- catalog / hub / registry share adapters and flows; local execution is
  free, paid coordination covers shared namespaces, governance, audit,
  retention, and org controls.
- governance primitives include a token vault and write guard for
  runtime classification of read / audit / confirm / deny calls.
- VS Code extension exists; Marketplace page showed 47 installs on
  2026-05-30 and describes adapter explorer, flow runner, workspace
  dashboard, registry browser, and trace/command views.

The most relevant claim: agents repeatedly rediscover working API
execution paths; Rote records a successful run and turns it into a
replayable, governed flow so the next run is cheaper and more stable.

### Overlap with ax

Shared pain:

- agents learn during a run and forget afterward.
- repeated rediscovery wastes tokens and time.
- local-first matters.
- evidence should come from what actually happened, not hand-written
  prompt lore.
- teams need durable artifacts, not chat history.

This is close enough that Rote validates the category. Their funding
announcement and site are useful evidence that "make agent wins durable"
is legible to infrastructure buyers.

### Difference

Rote starts at the tool execution layer. Its durable artifact is a
deterministic API/workflow flow. It wants to make external system calls
repeatable, governed, and cheaper.

`ax` starts at the agent experience layer. Its durable artifact is the
retro loop over the coding agent's own sessions: evidence graph,
structured retros, proposals, experiments, verdicts, skill triage, and
pre-flight grounding. It wants to make coding agents improve across
sessions by reflecting on the work they already did.

Concrete boundary:

| Question | Rote answer | ax answer |
|---|---|---|
| What is the substrate? | API/tool calls and execution workspaces. | Claude/Codex transcripts, skills, tools, commits, files, retros. |
| What gets saved? | Traces that become deterministic flows. | Evidence that becomes retros, proposals, experiments, verdicts. |
| What is replayed? | A known-good API workflow, often without an LLM. | The next agent's context and decisions are improved by prior evidence. |
| Who is the buyer? | Agent operator / AI ops / platform team with production workflow risk. | Developer or team using coding agents heavily enough to need feedback loops. |
| Main failure mode named | Rediscovery tax, drift, write risk, operable handoff. | Missing reflection loop, lost sub-agent learning, unmeasured skill/hook quality. |
| Monetization frame | Free local, paid coordination/governance. | Open local reference implementation; commercial frame undecided. |

### Positioning guidance

Do not fight them on "agent memory" or "replayable workflows." They are
using those terms for API execution, and the market is crowded there.

Own this sentence instead:

> `ax` is the retro loop for coding agents: it turns local agent history
> into structured retros, experiments, and verdicts the next session can
> act on.

Keep the public contrast terse:

- Rote makes tool execution repeatable.
- `ax` makes agent improvement repeatable.
- Rote remembers the call path.
- `ax` remembers the engineering lesson.
- Rote asks "how do we run this workflow again?"
- `ax` asks "what did the agent learn, did we encode it, and did it help?"

Copy implications:

- Lead with "retro loop", "agent experience", "typed evidence", and
  "verdicts"; avoid "agent memory" as the category.
- Keep "local-first" but tie it to developer trust and transcript
  evidence, not just execution cost.
- Emphasize sub-agents. Rote's public frame is broad agent workflows;
  `ax` has sharper language around sub-agent fan-out and learning lost
  at session-end.
- Emphasize outcome accounting: accepted proposals become experiments
  with verdicts. Rote has flow replay; `ax` has measured behavioral
  change over future sessions.
- For website/README copy, use "reflection step" and "retro" before
  "trace" or "memory." Trace is Rote's home turf.

### Product implications

Rote's strongest wedge is obvious utility: point at an API, get a
callable surface, capture a working flow. `ax` should make its wedge just
as concrete:

- `ax sessions here` and `ax recall` should be visibly fast and useful
  within the first five minutes.
- `ax retro pending` / `ax improve list` should show a crisp queue of
  evidence-backed decisions, not just observability.
- The dashboard should answer "what changed after we accepted this?"
  because that is the clearest distinction from a trace/replay product.
- Public examples should show a coding-agent failure getting turned into
  a skill/hook/guidance experiment and then receiving a verdict.

### Landing page lessons

Rote's landing page is clearer than its category framing because it makes
the mechanism concrete in the first screen: one line promise, one CLI
claim, then a visible progression from setup to ask to crystallize to
share to recall. It does not ask the reader to understand the whole
architecture before seeing the first successful run.

Lessons for `ax`:

- Put the concrete sequence earlier than the philosophy. The homepage
  should show `ingest -> recall -> retro -> verdict` before the longer
  explanation of the agent experience layer.
- Use command-shaped artifacts as proof. `axctl ingest --since=7`,
  `axctl recall "auth bug"`, and `+3 / +10 / +30 sessions` are stronger
  than another abstract sentence about compounding.
- Keep the first CTA operational. Rote's strongest copy is "type /rote";
  `ax` should keep "install, ingest, serve" visible and avoid making
  "read the origin" the only emotionally salient action.
- Add agent-readable distribution surfaces. Rote links a glossary and
  full machine index from the page; `ax` should consider `/llms.txt` and
  `/llms-full.txt` generated from README, language, CLI reference, and
  release docs.
- Make the before/after numeric. Rote uses time and token compression
  examples. `ax` should show a real "before: same failure repeated" and
  "after: accepted hook/skill got an adopted verdict" example when the
  data is available.

Applied immediately: the site hero now includes a first-run proof strip
with `ingest`, `recall`, `retro`, and `verdict` steps so the loop is
visible before the reader scrolls.

### Watch list

- Whether Rote ships broadly in Q2 2026 and how real the CLI is outside
  invite access.
- Whether they expand from API flows into coding-agent transcript
  reflection.
- Whether "Execution Context Engineering" becomes their category term.
- Their licensing posture: site docs mention commercial/community
  licenses and the Marketplace page names Business Source License 1.1.
- The shape of their hub/registry and whether community flows create a
  marketplace moat.
