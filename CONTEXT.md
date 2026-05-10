# agentctl Context

`agentctl` is a local agent telemetry and project-memory graph. It connects
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

**Commit Signal**:
The quality of commit evidence for reconstructing durable agent work memory.
_Avoid_: commit lint

**Tracer Context**:
Code-structure context extracted lazily around changed or queried **Files**.
_Avoid_: full-repo static index

**Storage Backend**:
The SurrealDB persistence engine used by `agentctl`, separate from product semantics.
_Avoid_: memory versioning model

**Current View**:
A materialized SurrealDB table view that exposes current records for ergonomic reads.
_Avoid_: canonical state

**Insights Surface**:
The dashboard, website, or app interface that turns graph evidence into visible
session, repository, file, friction, and recommendation insights.
_Avoid_: report export

**Tool Call**:
A single observed execution event, such as an agent builtin tool, CLI command,
MCP call, or skill invocation.
_Avoid_: turn

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

**Guidance Version**:
A content-addressed version of **Guidance**, bounded by Git commits when
available and filesystem observation time otherwise.
_Avoid_: current rule

## Relationships

- A **Repository** has one or more **Checkouts**.
- A **Checkout** belongs to exactly one **Repository**.
- A **Checkout** is a node in the graph, linked from **Repository**, because sessions, edits, diagnostics, and derivation may all refer to it.
- A **Worktree** is represented as a kind of **Checkout**, not as a separate top-level graph concept.
- A session should point directly to its **Repository** and **Checkout** when they are known; raw cwd remains observed metadata.
- A commit belongs to a **Repository** and may record the **Checkout** where it was observed during ingest.
- A **Repository Identity** is chosen from normalized remote, then initial commit SHA, then checkout-root hash as a machine-local fallback.
- `agentctl` should encourage Git tracking because commits are a primary signal for connecting agent work to durable outcomes.
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
- `agentctl` should coach **Commit Signal** quality through non-blocking diagnostics, not enforce commit workflow policy.
- The **Derivation Engine** belongs to `agentctl`; Codex-specific code can feed it through adapters but should not define its domain model.
- **Tracer Context** is activity-first and lazy: extract around touched, edited, or queried Files before considering full-repo indexing.
- **Storage Backend** versioning must stay invisible to product semantics, user-facing queries, and tests.
- Node tables store durable identity; edge tables store relationship-specific evidence.
- Schema names should use single words when readable and snake_case when clarity wins; use `changeset` for **Change Set** and `file_memory` for **File Memory**.
- Use `code_finding` for code-structure findings so future non-code findings can use their own terms.
- **Current Views** are read surfaces over stored status fields; supersession edges remain canonical truth.
- The **Insights Surface** should make the graph legible to humans first, then let agents reuse the same queries for automated context.
- **Tool Calls** are canonical execution evidence; edit, skill, command, MCP, and diagnostic signals should attach to Tool Calls when possible.
- **Friction Events**, **Feedback Events**, and **Diagnostic Events** are evidence/events, while **Insights**, **Recommendations**, **Change Sets**, and **File Memories** are derived memory/product layer records.
- **Guidance** must be versioned so `agentctl` can compare agent behavior before and after CLAUDE.md, AGENTS.md, hook, settings, or instruction changes.
- `edited` edges should preserve observed edit evidence such as Checkout and absolute path seen while pointing to the canonical **File**.
- `touched` edges should preserve commit diff evidence such as status, rename paths, additions, and deletions while pointing to the canonical **File**.
- Claude and Codex session edits should resolve through **Checkout** before linking to canonical **Files**.

## Example dialogue

> **Dev:** "This file was edited in `/Users/necmttn/Projects/agentctl` and again inside a Claude worktree. Are those two repositories?"
> **Domain expert:** "No — they are two **Checkouts** of the same **Repository**."

> **Dev:** "I'm adding a new integration. What else usually changes with the registry file?"
> **Domain expert:** "Look up similar **Change Sets**; their connected **Files** show the backend, UI, registry, tests, and docs that moved together."

## Flagged ambiguities

- "repo" was used to mean both stable Git identity and local filesystem path — resolved: the stable identity is **Repository**, the local path is **Checkout**.
- "change context" was used for both whole-work summaries and per-file explanations — resolved: the whole work unit is **Change Set**, and the per-file artifact is **File Memory**.
