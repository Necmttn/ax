# axctl Context

`axctl` is a local agent telemetry and project-memory graph. It connects
agent sessions, tool use, files, repositories, commits, and derived knowledge so
agents can answer what happened before and why it matters now.

## Language

**Repository**:
A stable logical Git repository, identified by its normalized remote when one is available.
_Avoid_: repo path, root, project

**Checkout**:
A local filesystem materialization of a **Repository**, including normal clones and worktrees.
_Avoid_: root, repo path

**Worktree**:
A Git-managed kind of **Checkout** that shares history with another checkout of the same **Repository**.
_Avoid_: repository

**Repository Identity**:
The stable key used to recognise the same **Repository** across Checkouts and machines.
_Avoid_: checkout path

**Workspace**:
A non-Git folder where agents can work, but where durable commit-based outcome signals are unavailable.
_Avoid_: repository

**File**:
A logical path inside a **Repository**, or an absolute path inside a **Workspace** when no Repository exists.
_Avoid_: edited file, touched file, code file

**Change Set**:
A coherent unit of work that may touch multiple **Files** and can be recalled as a pattern for future work.
_Avoid_: commit, diff

**File Memory**:
A searchable per-**File** explanation or evidence packet within a **Change Set**.
_Avoid_: change context

**Session Insight**:
A model-derived summary or classification of an agent session, such as goal,
outcome, friction, helpfulness, and satisfaction signals.
_Avoid_: ground truth

**Derivation Engine**:
The agent-neutral logic that turns normalized sessions, edits, commits, and touched files into **Change Sets** and **File Memories**.
_Avoid_: Codex parser, adapter

**Ingest Stage**:
One named unit of the ingest run - skills, commands, claude, codex, subagents,
spawned, git, signals, outcomes, session-health, closure, learning-registry, or
harness. A stage declares the other stages it depends on.
_Avoid_: step, job

**Ingest Pipeline**:
The dependency-ordered execution of all selected **Ingest Stages**. The pipeline
owns ordering, parallelism, and per-stage error events; it does not own stage
logic. The derive-* stages remain the **Derivation Engine** subset.
_Avoid_: ingest script, runner

**Commit Signal**:
The quality of commit evidence for reconstructing durable agent work memory.
_Avoid_: commit lint

**Tracer Context**:
Code-structure context extracted lazily around changed or queried **Files**.
_Avoid_: full-repo static index

**Storage Backend**:
The SurrealDB persistence engine used by `axctl`, separate from product semantics.
_Avoid_: memory versioning model

**Current View**:
A materialized SurrealDB table view that exposes current records for ergonomic reads.
_Avoid_: canonical state

**Insights Surface**:
The dashboard, website, or app interface that turns graph evidence into visible
session, repository, file, friction, and recommendation insights.
_Avoid_: report export

**Turn**:
A single message in an agent session transcript: one user or assistant
JSONL record. The atomic unit of the transcript stream. A Turn may carry
zero or more **Tool Calls** in its content.
_Avoid_: message, exchange

**Tool Call**:
A single observed execution event, such as an agent builtin tool, CLI command,
MCP call, or skill invocation. A Tool Call belongs to exactly one **Turn**.
_Avoid_: invocation

**Friction Event**:
An observed or inferred failure, correction, retry, wrong approach, repeated
edit, tool problem, or environment blocker.
_Avoid_: diagnostic

**Feedback Event**:
A user response that conveys correction, approval, rejection, preference,
strategy, or satisfaction.
_Avoid_: friction

**Diagnostic Event**:
A structured technical finding from lint, typecheck, test, build, runtime, DB,
CI, or tool output.
_Avoid_: friction

**Guidance**:
An agent behavior control such as CLAUDE.md, AGENTS.md, Codex instructions,
settings, hooks, rules, skills, or commands.
_Avoid_: recommendation

**Guidance Revision**:
A specific observed revision of **Guidance**, with content hash and optional
commit, file, or filesystem evidence.
_Avoid_: current rule

**Guidance Scope**:
The boundary where a **Guidance** artifact applies, such as global, repository,
checkout, provider, skill, command, hook, or task type.
_Avoid_: location

**Intervention**:
A controlled, scoped behavior-change experiment that creates, edits, enables,
disables, or removes one or more **Guidance** artifacts.
_Avoid_: suggestion

**Intervention Observation**:
A measured before/after effect of an **Intervention** on targeted signals and
side effects.
_Avoid_: result

**Intervention Strength**:
The control level of an **Intervention**, from advisory guidance to hard
boundary enforcement.
_Avoid_: severity

**Guidance Source**:
The storage authority where **Guidance** is observed, such as a project
Repository, global dotfiles Repository, plugin cache, or untracked filesystem
location.
_Avoid_: config path

**Onboarding Checklist**:
A setup validation flow that makes `axctl` evidence reliable before deeper
insight or optimization workflows run.
_Avoid_: install steps

**Harness**:
The complete behavior-shaping setup around one or more agents, including
Guidance, tools, checks, integrations, workflows, and provider configuration.
_Avoid_: agent config

**Harness Hook Event**:
A native lifecycle event emitted by an agent harness, such as a pre-tool,
post-tool, session-start, prompt-submit, stop, or permission event.
_Avoid_: ax hook, hook fire

**Hook Command**:
A configured command invoked by a **Harness Hook Event**.
_Avoid_: hook event

**Feedback Case**:
A short-horizon evaluation of whether a Harness signal changed subsequent agent
behavior in the intended direction.
_Avoid_: hook result

**Feedback Case Type**:
A reusable definition of how to recognize and evaluate a class of **Feedback
Cases** for a user- or team-specific Harness signal.
_Avoid_: table type

**Case Authoring**:
The workflow that turns observed Local Evidence into a **Feedback Case Type**,
possibly with AI assistance and user approval.
_Avoid_: automatic inference

**Evaluation Rule**:
Versioned measurement logic that classifies **Feedback Cases** without changing
the underlying Guidance.
_Avoid_: guidance

**Agent Retrospective**:
A recurring evidence review that explains what agents did well or poorly,
proposes measured improvements, and tracks whether those changes helped.
_Avoid_: doctor

**Retrospective Candidate**:
A proposed improvement found in Local Evidence that may become an Intervention
after backtesting, scoping, and lifecycle setup.
_Avoid_: recommendation

**Autonomous Intervention Run**:
An agent-led improvement pass that can create, test, enable, pause, or revise
Interventions from Local Evidence with minimal user steering.
_Avoid_: recommendation report

**Recovery Path**:
A user-available way to disable or revert an Intervention even when the active
agent harness is broken by that Intervention.
_Avoid_: rollback note

**Agent Tooling**:
Developer tooling intentionally exposed to agents to improve perception,
representation, verification, or boundary control.
_Avoid_: dev tool

**Harness Layer**:
One of the behavior-shaping layers of a **Harness**: perception,
representation, verification, or boundary.
_Avoid_: category

**Harness Doctor**:
A setup and readiness diagnostic for the **Harness**, organized by Harness
Layer.
_Avoid_: insight

**Local Evidence**:
Private graph evidence observed on one user's machine or organization.
_Avoid_: telemetry

**Taste Signal**:
Evidence of a user's preferences, judgment, quality bar, or repeated choices
extracted from Local Evidence.
_Avoid_: preference

**Public Taste Card**:
A user-curated, shareable profile of engineering likes, dislikes, preferred
Stacks, avoided defaults, Workflows, and agent style.
_Avoid_: taste signal

**Know-How Pattern**:
A reusable agent-work technique or operating pattern distilled from evidence.
_Avoid_: tip

**Harness Learning**:
A curated, shareable learning about a Harness, Workflow, Guidance, or Harness
Tool, backed by evidence summaries rather than raw transcripts.
_Avoid_: feedback

**Shared Learning Hub**:
An opt-in collection of **Harness Learnings** contributed by users or teams.
_Avoid_: telemetry dump

**Learning Feedback**:
A structured response from an agent or user after applying a **Harness Learning**,
describing whether it worked, failed, or needs revision.
_Avoid_: comment

**Learning Registry**:
The controlled index of **Harness Learnings**, experiments, Learning Feedback,
status, owners, evidence, and review dates.
_Avoid_: lifecycle

**Share Candidate**:
A local **Harness Learning** that meets criteria for possible publication to the
Shared Learning Hub.
_Avoid_: auto-share

**Learning Match**:
An external **Harness Learning** found relevant to local evidence, Harness
configuration, or a user query.
_Avoid_: search result

**Adoption**:
The local application of an external **Harness Learning** as a tracked
Intervention or Guidance/Harness change.
_Avoid_: install

**Gotcha**:
A reusable warning about a tool, stack, workflow, or agent behavior that
prevents misapplying a **Harness Learning**.
_Avoid_: note

**Stack**:
A technology, platform, framework, runtime, or operating environment that
conditions whether a Harness Learning applies.
_Avoid_: tag

**Workflow**:
A repeatable operating pattern for agent work, such as browser QA, code review,
merge flow, CI healing, self-improve, subagent implementation, or spec-first
testing.
_Avoid_: task

## Relationships

- A **Repository** has one or more **Checkouts**.
- A **Checkout** belongs to exactly one **Repository**.
- A **Checkout** is a node in the graph, linked from **Repository**, because sessions, edits, diagnostics, and derivation may all refer to it.
- A **Worktree** is represented as a kind of **Checkout**, not as a separate top-level graph concept.
- A session should point directly to its **Repository** and **Checkout** when they are known; raw cwd remains observed metadata.
- A commit belongs to a **Repository** and may record the **Checkout** where it was observed during ingest.
- A **Repository Identity** is chosen from normalized remote, then initial commit SHA, then checkout-root hash as a machine-local fallback.
- `axctl` should encourage Git tracking because commits are a primary signal for connecting agent work to durable outcomes.
- A **Workspace** can have sessions, turns, and edits, but not commits or touched files until it becomes a **Repository**.
- A **File** is the shared join point for agent edits, commit touches, code IR, imports, and change knowledge.
- A **Change Set** includes one or more **File Memories**.
- A **File Memory** concerns exactly one **File**.
- A **File Memory** is a compact retrieval card, not a raw transcript, full diff, or source archive.
- A **File Memory** is generated deterministically from stored evidence first; LLM summaries are optional enrichment.
- Superseded **File Memories** are preserved for auditability rather than overwritten.
- A session can have **Session Insights** from external analyzers such as Claude `/insights`; these enrich retrieval and coaching but do not replace observed tool, edit, commit, and transcript evidence.
- A **Change Set** can connect to many **Files** to show what moved together during a unit of work.
- A **Change Set** can originate from a session, a commit, or a derived join between session activity and committed outcomes.
- A derived **Change Set** is preferred when it can connect intent, agent actions, touched files, and durable commit evidence.
- A commit should produce at most one commit-sourced **Change Set**, and a session should produce at most one provisional session-sourced **Change Set** by default.
- Superseded **Change Sets** are preserved for auditability rather than deleted.
- `produced` remains the direct session-to-commit outcome relation; **Change Set** relations are added alongside it for memory and grouping.
- Commit evidence is the preferred durable outcome signal; session-only **Change Sets** are provisional until connected to commits.
- `axctl` should coach **Commit Signal** quality through non-blocking diagnostics, not enforce commit workflow policy.
- The **Derivation Engine** belongs to `axctl`; Codex-specific code can feed it through adapters but should not define its domain model.
- **Tracer Context** is activity-first and lazy: extract around touched, edited, or queried Files before considering full-repo indexing.
- **Storage Backend** versioning must stay invisible to product semantics, user-facing queries, and tests.
- Node tables store durable identity; edge tables store relationship-specific evidence.
- Schema names should use single words when readable and snake_case when clarity wins; use `changeset` for **Change Set** and `file_memory` for **File Memory**.
- Use `code_finding` for code-structure findings so future non-code findings can use their own terms.
- **Current Views** are read surfaces over stored status fields; supersession edges remain canonical truth.
- The **Insights Surface** should make the graph legible to humans first, then let agents reuse the same queries for automated context.
- A **Turn** is the atomic unit of the transcript stream; it owns timestamp, role, raw text, and `semantic_role`/`message_kind`/`intent_kind` classifications.
- A **Tool Call** belongs to exactly one **Turn** and is observed by parsing tool_use blocks inside that Turn's content.
- **Tool Calls** are canonical execution evidence; edit, skill, command, MCP, and diagnostic signals should attach to Tool Calls when possible.
- Schema and storage use `turn` and `tool_call` as table names; UI and CLI surfaces may say "turn" because it is the now-canonical message-grain term.
- **Friction Events**, **Feedback Events**, and **Diagnostic Events** are evidence/events, while **Insights**, **Recommendations**, **Change Sets**, and **File Memories** are derived memory/product layer records.
- **Guidance** must be versioned so `axctl` can compare agent behavior before and after CLAUDE.md, AGENTS.md, hook, settings, or instruction changes.
- **Guidance** can be repo-local or global; **Guidance Scope** distinguishes where it applies rather than creating separate concepts for repo instructions, global skills, hooks, or commands.
- A **Guidance Source** can be local to a project or global to the user; global guidance should be tracked through a dotfiles Repository when possible.
- An **Intervention** materializes a recommendation into one or more **Guidance** changes, and should have scope, expected effect, review criteria, and cleanup rules.
- An **Intervention Observation** evaluates whether an **Intervention** changed targeted signals without introducing unacceptable side effects.
- Native **Harness Hook Events** and **Hook Commands** are stable Local Evidence because they describe the Harness behavior baseline.
- A **Harness Hook Event** and a **Hook Command** invocation should be modeled separately: one lifecycle event can invoke multiple commands, and each command can allow, block, modify input, inject context, notify, or no-op independently.
- A blocking **Hook Command** is not necessarily a failure; it may be positive boundary feedback, evaluated through a **Feedback Case** rather than the single event alone.
- A **Feedback Case** must be generic because Hook Commands and their intended meanings are user- and team-specific; worktree guards, lint gates, recall injections, and future community hooks are case types, not separate top-level concepts.
- **Case Authoring** should use existing transcripts and hook evidence to draft candidate **Feedback Case Types**, but promotion still needs user approval because hook intent is local taste and policy.
- An **Evaluation Rule** is separate from **Guidance**: Guidance changes agent behavior, while Evaluation Rules measure whether that behavior appears to help.
- Evaluation Rules should run deterministically by default for reproducible backtests; AI is primarily used to draft, explain, review ambiguous cases, and suggest refinements.
- An **Autonomous Intervention Run** may create hooks, skills, Evaluation Rules, and other Guidance changes, but each change remains an **Intervention** with evidence, scope, backtest results where possible, and a stop path.
- Autonomous changes to global harness settings are allowed only when they are tracked, revertable, and have a **Recovery Path** that does not depend on the broken agent successfully running its hooks.
- Global hook settings should point to an ax-managed intervention runner such as `axctl intervention run <id>` rather than embedding arbitrary generated shell directly; the runner owns timeout, smoke-test, fail policy, disable switches, and rollback metadata.
- Ax-managed intervention runners should fail open by default to preserve agent usability; fail-closed behavior is reserved for explicit high-risk boundary controls with smoke tests and a Recovery Path.
- When a Guidance Source is Git-tracked, an **Autonomous Intervention Run** should commit ax-managed Guidance changes separately from user work and record the commit, before/after hashes, and rollback command.
- **Intervention Observation** is local measured impact; **Learning Feedback** is structured feedback on a Harness Learning for possible revision or sharing.
- **Intervention Strength** lets `axctl` recommend the least forceful Harness change likely to work, then escalate only when observations show the behavior persists.
- Intervention Strength levels are advisory, workflow, automation, guardrail, and hard boundary.
- If advisory Guidance repeatedly fails for a high-value behavior, `axctl` can recommend a stronger Intervention such as a skill, command, preflight script, hook, policy, or branch protection.
- Stronger Interventions should track side effects such as false positives, latency, blocked legitimate work, or user bypasses.
- Escalation is a recommendation kind, not a separate domain concept: it proposes moving from a weaker Intervention Strength to a stronger one because observed behavior persisted.
- Escalation recommendations should be agent-actionable and approval-gated, so an agent can ask the user to apply the stronger control and then monitor the result.
- Escalation recommendations should consider both recurrence and risk severity; high-blast-radius violations can justify stronger controls with fewer observations than low-risk preferences.
- Risk is a dimension on Interventions, Harness Learnings, and recommendations, not a separate graph node in the first implementation.
- Risk dimensions should include kind and level, such as branch safety, production, data loss, privacy, cost, security, or workflow noise.
- **Interventions** should be scarce and lifecycle-managed; recommendations and skill candidates can be many, but active Interventions require explicit promotion.
- **Guidance Revisions** belong to **Guidance** and can be linked to the **Intervention** that created or changed them.
- A **Guidance Revision** records observed change evidence for a **Guidance** artifact, usually by linking a commit and **File** when available.
- A **Guidance Revision** may be part of an **Intervention**, but not every Guidance Revision is an intentional Intervention.
- A session can be compared against nearby **Guidance Revisions** by time, Checkout, Repository, provider, and scope even when the exact runtime Guidance Revision is uncertain.
- Project-local and global **Guidance** should both be scanned; when global guidance is Git-tracked, its commits become durable evidence for Guidance Revisions.
- Untracked global **Guidance** should still be ingested because it affects agent behavior, but `axctl` should mark its evidence quality as weak and recommend Git tracking.
- `axctl` should treat Git-tracked global guidance as a prerequisite for reliable proactive harness optimization, not as a hard requirement for ingestion.
- The **Onboarding Checklist** should validate project-local and global Guidance Sources, report untracked guidance, and recommend moving global guidance into a Git-tracked dotfiles Repository.
- The **Onboarding Checklist** should distinguish blocking setup issues from weak-evidence warnings so users can ingest immediately while improving evidence quality over time.
- A **Harness** includes **Guidance** but is broader than Guidance; linting, typechecking, tests, MCPs, CI, review tooling, browser QA tooling, and shipping tooling can all shape agent behavior.
- **Agent Tooling** can be optimized as part of the Harness when it improves or degrades the agent feedback loop.
- Replacing `tsc` with faster or sharper checks such as `tsgo`, `oxc`, or `rs lint` is a Harness change when the intent is to improve agent feedback and code quality.
- **Harness Layers** classify why a Harness change matters: perception improves what agents can find, representation improves what agents can parse, verification improves how quickly reality pushes back, and boundary improves what agents can safely touch.
- **Agent Tooling** is channel-agnostic; CLI tools, MCP servers, browser automation, APIs, CI systems, and local scripts can all be Agent Tooling when they shape the agent loop.
- **Harness Doctor** reports whether the environment is capable of good agent work; **Insights** report whether observed agent behavior improved or regressed.
- **Harness Doctor** is setup/config/evidence readiness; **Interventions** manage lifecycle; **Insights** measure empirical behavior and impact.
- An **Agent Retrospective** is different from **Harness Doctor**: Doctor checks readiness, while the retrospective reviews behavior over time and may run an **Autonomous Intervention Run**.
- Historical self-improve proposal sessions should be preserved as **Retrospective Candidates** so later retrospectives can backtest, activate, discard, or revise them instead of losing that prior work.
- Native hook observability should land before autonomous retrospective activation because **Harness Hook Events**, **Hook Commands**, and **Feedback Cases** provide the measurement substrate for safe Interventions.
- **Harness Doctor** should inspect global machine setup, global Guidance Sources, repo-local Guidance, package scripts, test/lint/typecheck commands, Git settings, worktree support, and CI configuration.
- A tool being installed globally is not enough; the active Repository should expose reliable commands or workflows that agents can discover and run.
- **Harness Doctor** should use observed Insights to report whether agents actually use available Agent Tooling and Guidance, not only whether those capabilities exist.
- **Harness Doctor** can recommend making underused or misused Harness capabilities more discoverable through scripts, Guidance, skills, or commands.
- **Local Evidence** stays private by default and is the source for Taste Signals, Know-How Patterns, and local Insights.
- A **Taste Signal** may become a local recommendation or contribute to a Know-How Pattern when it repeats across sessions or outcomes.
- A technology preference such as TanStack over Next.js or Hono over Express is a **Taste Signal** with preferred and avoided Stack references.
- Local or team **Taste Signals** can override Shared Learning Hub recommendations during Adoption; shared learnings suggest, but local taste controls what should be applied.
- **Taste Signals** can be explicit, inferred, codified in Guidance, or outcome-backed; provenance determines confidence and how strongly they should affect recommendations.
- Negative preferences are first-class **Taste Signals** because avoided tools, stacks, workflows, or behaviors often prevent wrong defaults.
- A **Public Taste Card** is a curated identity/share surface, not raw Taste Signal evidence.
- GitHub login may identify a user for a Public Taste Card, but publishing should be explicit rather than automatic.
- A **Public Taste Card** should start as an evidence-generated draft from local Taste Signals and Harness Learnings, then require user editing or approval before publishing.
- A **Public Taste Card** can link to shareable Harness Learnings for credibility, while allowing users to hide evidence links for a cleaner public profile.
- Public Taste Cards are a later hosted-hub surface; the first implementation should focus on local evidence, Harness Doctor, Guidance tracking, and Harness Learnings.
- A **Know-How Pattern** can be promoted into a **Harness Learning** when it is reusable beyond one session or repo.
- A **Harness Learning** is the shared unit for opt-in contribution; it should include evidence summaries and applicability conditions, not raw transcripts.
- The **Shared Learning Hub** should distribute curated Harness Learnings, not raw telemetry or unreviewed event dumps.
- A **Harness Learning** should describe the problem, reusable pattern, Harness Layer, applicability, counterconditions, evidence summary, observed effect, side effects, confidence, source count, privacy level, and suggested Intervention.
- Local, share-candidate, and shared **Harness Learnings** use the same domain type; visibility and status distinguish where they are in the sharing flow.
- Sharing a **Harness Learning** is agent-proposed and user-approved; `axctl` should not auto-share Local Evidence or Harness Learnings.
- Agents may automatically create draft issues or pull requests containing **Learning Feedback**, but publishing, merging, or promoting shared Harness Learnings remains approval-gated.
- **Learning Feedback** is part of the compounding improvement loop for the Shared Learning Hub, while human review preserves taste and trust.
- **Learning Feedback** should be stored in the local graph first; GitHub issues or pull requests are collaboration surfaces for shareable feedback.
- The **Learning Registry** prevents shared learnings and experiments from becoming a mess by requiring active items to have scope, owner, status, evidence, and review criteria.
- The **Learning Registry** is an index/control surface over Harness Learnings, Interventions, and Learning Feedback; it does not need a separate registry-entry node in the first implementation.
- Agents may add Learning Feedback to the **Learning Registry**, but they should not silently create canonical Harness Learnings.
- Duplicates and replacements in the **Learning Registry** should be linked through supersession rather than left as unrelated variants.
- A **Share Candidate** can be proposed automatically when a local Harness Learning has enough evidence, reusable scope, acceptable privacy risk, and positive observed effect, but publication still requires approval.
- A **Learning Match** lets local users discover external Harness Learnings by similarity, stack, provider, task type, Harness Layer, or query.
- An **Adoption** records that a Learning Match was applied locally, preserving the link back to the external Harness Learning for future Learning Feedback.
- Every **Adoption** should create a local **Intervention** so the adopted Harness Learning can be measured in the local Harness.
- A **Gotcha** can attach to Harness Learnings, Agent Tooling, stacks, Guidance, Workflows, or Interventions.
- Tool feedback Gotchas are first-class because they explain how Agent Tooling can improve one feedback loop while failing or misleading another.
- **Gotchas** can be shared independently from Harness Learnings when they are broadly reusable, but most adoptions will encounter them through related Harness Learnings.
- A **Stack** should be first-class but lean, so Harness Learnings, Gotchas, Guidance, Agent Tooling, Repositories, and Sessions can reference the technologies they depend on.
- Stack references should start as stable records with names and aliases; richer taxonomy can emerge later from observed usage and shared learnings.
- **Stack** can be declared by Repository files and observed from session/tool behavior; both forms should be preserved because declared capability and actual work context differ.
- A **Workflow** can involve Guidance, Agent Tooling, Stacks, Sessions, Interventions, Gotchas, and Harness Learnings.
- A **Workflow** is repeatable and measurable; a one-off user request is not a Workflow unless it recurs as an operating pattern.
- `edited` edges should preserve observed edit evidence such as Checkout and absolute path seen while pointing to the canonical **File**.
- `touched` edges should preserve commit diff evidence such as status, rename paths, additions, and deletions while pointing to the canonical **File**.
- Claude and Codex session edits should resolve through **Checkout** before linking to canonical **Files**.
- An **Ingest Stage** declares its dependency **Ingest Stages**; the **Ingest Pipeline** computes execution order and parallelism from that graph rather than a hardcoded list.
- The **Ingest Pipeline** runs independent stages concurrently; `claude` and `codex` have no dependency between them and run in parallel.
- `--stages=` and `--derive-only` select a subgraph of the **Ingest Pipeline**; legacy `--X-only` flags are deprecated aliases.

## Example dialogue

> **Dev:** "This file was edited in `/Users/necmttn/Projects/axctl` and again inside a Claude worktree. Are those two repositories?"
> **Domain expert:** "No — they are two **Checkouts** of the same **Repository**."

> **Dev:** "I'm adding a new integration. What else usually changes with the registry file?"
> **Domain expert:** "Look up similar **Change Sets**; their connected **Files** show the backend, UI, registry, tests, and docs that moved together."

## Flagged ambiguities

- "repo" was used to mean both stable Git identity and local filesystem path — resolved: the stable identity is **Repository**, the local path is **Checkout**.
- "change context" was used for both whole-work summaries and per-file explanations — resolved: the whole work unit is **Change Set**, and the per-file artifact is **File Memory**.

- "turn" was previously listed under `Avoid` for **Tool Call** — resolved: **Turn** is now a first-class term for the JSONL message-grain unit, and **Tool Call** is the execution event nested inside a Turn. They are distinct concepts at different grains; both stay.
