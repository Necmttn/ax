# agentctl Feature Research

Date: 2026-05-09

This note collects research for feature discussions around `agentctl` as a
local observability, memory, and self-improvement layer for AI coding agents.
The goal is not to copy token-saving tools. The useful wedge is to understand
what other tools prove, then decide where `agentctl` should stay distinct.

## Working Positioning

`agentctl` should be the local agent observability and project memory layer:

> Install once, initialize per project, and let Claude Code, Codex, and related
> agents query what this repo has learned from prior sessions, git history,
> tool feedback, skills, commands, and interventions.

This positions `agentctl` as the behavior and outcome graph around agents,
not as a code search engine or terminal-output compressor.

## Current agentctl Baseline

The repo already has a graph foundation:

- Transcript ingestion for Claude Code and Codex.
- Skill ingestion across user, project, shared, and plugin skill roots.
- Git ingest for commits and file touches.
- Derived signals for corrections, proposed-but-not-invoked skills, skill
  pairings, and recovery after errors.
- CLI views such as `search`, `stats`, `recent`, `unused`, `taste`, `pairs`,
  and `recovery`.
- SurrealDB graph tables for `session`, `turn`, `skill`, `file`, `commit`, and
  relations like `invoked`, `edited`, `produced`, and `touched`.

The next layer should make this graph useful before and during agent work:

- `agentctl init` per project.
- `agentctl project context`.
- `agentctl project memory`.
- `agentctl recall <question>`.
- `agentctl verify`.
- JSON contracts for self-improve and other agents.

## Feature Categories

### 1. Active Token Compression

These tools reduce tokens while the agent is running by filtering output,
caching raw content, or replacing verbose tool results with summaries.

References:

- [rtk-ai/rtk](https://github.com/rtk-ai/rtk): Rust command proxy that filters
  terminal output for agents. Strong fit for heavy shell/git/test output.
- [mksglu/context-mode](https://github.com/mksglu/context-mode): MCP sandbox
  that stores raw tool output in per-project SQLite and returns summaries.
- [ooples/token-optimizer-mcp](https://github.com/ooples/token-optimizer-mcp):
  MCP cache layer for files, APIs, build/test/log output, and token analytics.

What this proves:

- Agents need a way to avoid dumping raw logs, test output, Playwright output,
  and GitHub output into context.
- Per-project local storage plus summarized retrieval is a practical pattern.

How `agentctl` differs:

- `agentctl` should not primarily be a live output filter.
- It can ingest evidence from these tools and measure whether they help.
- A later `agentctl otel serve` or `agentctl command ingest` can record command
  outcomes without becoming a proxy for every command.

Feature discussion:

- Should `agentctl` integrate with RTK/context-mode as upstream signal sources?
- Should `agentctl verify` recommend RTK/context-mode when repeated truncation
  or noisy command patterns appear?

### 2. Codebase Structure And Retrieval

These tools index code so agents can navigate by symbols, dependencies, and
semantic retrieval instead of reading full files.

References:

- [abhigyanpatwari/GitNexus](https://github.com/abhigyanpatwari/GitNexus):
  repository knowledge graph with Tree-sitter, imports, calls, impact analysis,
  MCP tools, and repo-specific skills. Current docs describe LadybugDB storage,
  `.gitnexus/` per-repo indexes, and global registry metadata.
- [tirth8205/code-review-graph](https://github.com/tirth8205/code-review-graph):
  Tree-sitter graph in SQLite for code review and blast-radius context.
- [Mibayy/token-savior](https://github.com/Mibayy/token-savior): MCP server for
  symbol navigation, call graph, and persistent memory.
- [zilliztech/claude-context](https://github.com/zilliztech/claude-context):
  code search MCP using embeddings and vector search.
- [Context-Engine](https://mcpdir.dev/servers/context-engine): hybrid search,
  micro-chunking, memory storage, reranking, and MCP bridge.

What this proves:

- Code structure and symbol navigation are a separate product surface.
- MCP is the natural agent-facing interface for repository context.
- Good retrieval tools expose small, precise slices rather than files.

How `agentctl` differs:

- GitNexus answers "what code depends on this?"
- `agentctl` should answer "what has this agent/user/project learned from
  previous work?"
- These are complementary. GitNexus can supply structural code context;
  `agentctl` can supply behavioral context, workflow history, and outcome
  evidence.

Feature discussion:

- Add `entity` records to resolve phrases like "self-improve", "ingest",
  "Surreal schema", or "name entity resolution" to files, commands, commits,
  skills, and past sessions.
- Support adapters for GitNexus/code graph tools instead of reimplementing
  deep AST indexing immediately.

### 3. Prompt And Style Compression

These tools reduce output tokens or startup context through instructions,
skills, and project docs.

References:

- [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman): terse
  response skill/plugin ecosystem, plus helpers for commits, reviews, and
  memory compression.
- [drona23/claude-token-efficient](https://github.com/drona23/claude-token-efficient):
  drop-in `CLAUDE.md` rules for concise Claude behavior.
- [nadimtuhin/claude-token-optimizer](https://github.com/nadimtuhin/claude-token-optimizer):
  markdown layout and `.claudeignore` style for reducing startup context.

What this proves:

- Static instructions can reduce output volume quickly.
- They are easy to install but hard to evaluate honestly.

How `agentctl` differs:

- `agentctl` can measure whether a style/prompt rule actually changes usage,
  corrections, retries, or outcomes.
- It should treat these as interventions to score, not as the core product.

Feature discussion:

- Add first-class intervention records for CLAUDE.md rules, skills, hooks,
  commands, and memory entries.
- Track before/after effects on friction clusters and agent behavior.

### 4. Token And Config Auditing

These tools inspect waste in skills, MCP servers, memory files, and context
configuration.

References:

- [alexgreensh/token-optimizer](https://github.com/alexgreensh/token-optimizer):
  Claude/OpenClaw/Codex plugin for ghost-token audits, dashboards, compaction
  checkpoints, and skill/config cleanup.
- [ccusage](https://github.com/ryoppippi/ccusage): usage reports for Claude
  Code and Codex, with CLI and MCP exposure.
- [CodeBurn](https://github.com/getagentseal/codeburn): TUI dashboard for
  token, cost, and tool observability across several coding agents.

What this proves:

- Local usage reporting is a real need.
- The useful reports are not just totals; they need sessions, agents, tools,
  deduping, and project filters.

How `agentctl` differs:

- It already has skill/tool/session graph data.
- It should lean into "what actually helps" rather than only "what costs".

Feature discussion:

- Add `--json` to core commands so self-improve and agents do not parse text.
- Add cost/token metrics where transcript/OTEL sources provide them.
- Score interventions by reduced friction, not only reduced token count.

### 5. Session Browsers And Work Logs

These tools make previous agent sessions searchable, resumable, exportable, or
shareable.

References:

- [Agent Sessions](https://github.com/jazzyalex/agent-sessions): native macOS
  browser over local sessions from Codex, Claude Code, OpenCode, Gemini, and
  Copilot CLI.
- [claude-history](https://github.com/raine/claude-history): TUI for searching
  and viewing Claude Code local conversations.
- [claude-code-transcripts](https://github.com/simonw/claude-code-transcripts):
  converts Claude Code sessions to clean static HTML archives.
- [CodeFire](https://codefire.app/): work log, context engine, task board, and
  handoff layer for multiple coding agents.

What this proves:

- Transcript search is useful as a daily tool, not only as analytics.
- "How did we solve this before?" is a strong user-facing query.

How `agentctl` differs:

- It already stores normalized sessions and relations.
- It can turn session history into project memory, commands, and rules.

Feature discussion:

- Add `agentctl recall <question>` for previous sessions, commands, files, and
  outcomes.
- Add session export or "evidence packet" output for self-improve proposals.

### 6. Runtime Observability And OTEL

These surfaces expose spans, metrics, events, latency, tool calls, and errors
from agent runtimes.

References:

- Quera `apps/devkit`: first-party AI dev-session orchestrator at
  `/Users/necmttn/Projects/quera/apps/devkit`. It starts frontend/backend dev
  services, wires local HTTPS through portless, captures process logs plus OTLP
  traces/logs/metrics, detects known failure patterns, and exposes diagnostics
  through HTTP and intended MCP tools. Entry point:
  `/Users/necmttn/Projects/quera/apps/devkit/src/index.ts`.
- [Claude Code monitoring](https://code.claude.com/docs/en/monitoring-usage):
  official OpenTelemetry metrics, logs/events, and optional traces.
- [Claude Agent SDK observability](https://code.claude.com/docs/en/agent-sdk/observability):
  spans for interactions, model requests, tools, hooks, and trace propagation.
- [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/):
  standard attributes and operations such as `chat`, `invoke_agent`,
  `execute_tool`, `retrieval`, token usage, model metadata, and tool data.
- [LangSmith Codex tracing plugin](https://docs.langchain.com/langsmith/trace-with-codex):
  Codex tracing through plugin hooks into LangSmith.
- [openai/codex issue #17110](https://github.com/openai/codex/issues/17110):
  evidence that Codex CLI can export OTEL logs from project-scoped config,
  while Desktop/App behavior may currently require global config.
- [AgentSight](https://github.com/eunomia-bpf/agentsight): eBPF/process-level
  observability for agent runs.

What this proves:

- Agent runtimes are moving toward standard telemetry.
- Transcripts are historical context; OTEL gives measured runtime behavior.
- A repo-local dev-session harness can give agents a tight feedback loop:
  start services, make a change, call a single health tool, inspect logs/traces,
  restart a service if needed, then continue.

How `agentctl` differs:

- `agentctl` can be a local OTLP receiver or importer, then join telemetry to
  transcripts, git, skills, commands, and interventions.
- Quera devkit is live, repo-local, and mostly in-memory. `agentctl` should be
  durable and cross-session, with a graph that outlives any one dev server run.

Feature discussion:

- Add `agentctl otel serve`.
- Store spans/events with session and cwd correlation.
- Derive measured signals for slow tools, hook blocks, retries, command
  failures, tool latency, MCP instability, and token/cost hot spots.
- Add dev-run records for local development sessions:
  - `dev_run`
  - `managed_process`
  - `span`
  - `log`
  - `diagnostic_issue`
  - `pattern_match`
- Link those records to existing `session`, `turn`, `skill`, `file`, `commit`,
  and future `intervention` records.
- Support project-local diagnostic pattern packs, similar to Quera devkit's
  `.devkit/patterns`, so known error strings can map to suggested actions.
- Avoid isolated MCP memory. If `agentctl` exposes MCP, the MCP server, CLI,
  OTLP receiver, and TUI should all read the same persisted graph. Quera devkit
  shows the risk: `devkit dev` starts the OTLP/API state, while `devkit mcp`
  launches a separate stdio process with fresh in-memory stores unless bridged.

### 6a. First-Party Dev Session Orchestration

Quera devkit is not a competitor or external reference; it is an internal
prototype of the workflow `agentctl` can generalize.

Useful ideas:

- One standard command for agents: Quera documents `just pall` as the normal
  way to start backend, frontend, HTTPS proxy, env sync, and worktree-prefixed
  local URLs.
- Worktree-aware ports: branch/worktree names produce deterministic offsets and
  stable local URLs, avoiding parallel-agent collisions.
- Runtime evidence: managed process stdout/stderr, OTLP traces, OTLP logs,
  forwarded metrics, and process status.
- Agent diagnostics: `health_check`, `get_errors`, `get_span_tree`,
  `get_traces`, `get_logs`, `tail`, `get_status`, and `restart_service`.
- Pattern packs: bundled JSON patterns for Effect, Bun, database, AI, infra,
  and Node errors. Each pattern can include severity, title, and suggested
  action.

What should carry into `agentctl`:

- `agentctl project verify` should optionally query a live dev diagnostic
  endpoint, then include process crashes, recent error spans, matched patterns,
  and failing services next to static typecheck/test recommendations.
- `agentctl recall <query>` should index error strings, pattern tags,
  suggested actions, trace trees, and eventual fix commits so a future agent can
  ask how an issue was fixed before.
- `agentctl self-improve context --json` should include repeated diagnostic
  issues, slow operations, port/preflight failures, and whether suggested
  actions reduced retries or corrections.
- `agentctl init` can install project diagnostic packs without forcing every
  repo to adopt a full dev orchestrator.

### 7. Self-Improving Agent Workflows

Existing local pipeline:

- Tracked copy: `/Users/necmttn/.dotfiles/claude/.claude/self-improve`.
- Live copy: `/Users/necmttn/.claude/self-improve`.
- The two copies matched during research.

Current pipeline stages:

1. `ingest`: compacts Claude transcripts into run-local JSON.
2. `agentctl_ingest`: runs `agentctl ingest --since=14`.
3. `extract`: deterministic detectors plus LLM extraction into events.
4. `cluster`: assigns events to `taxonomy.json`.
5. `propose`: drafts hook, skill, command, memory, or CLAUDE.md interventions.
6. `test`: validates interventions and replays hook cases.
7. `ship`: opens draft PRs against dotfiles.
8. `wins`: tracks merged intervention ratios.
9. `metrics`: computes shipped-intervention usage.
10. `deprecate`: classifies underused interventions and cross-checks
    `agentctl unused`.

Current detector taxonomy:

- `user_correction`
- `tool_denial`
- `hook_block`
- `retry`
- `repeated_edit`
- `self_correction`
- `output_truncation`
- `duplicate_question`
- `fallback_pattern`
- `rescue_invocation`
- `plan_revision`

Current `agentctl` integration:

- Runs ingest before extraction.
- Uses `agentctl unused --days=90` during deprecation.
- Parses human CLI output today.

Missing grounding:

- No direct query path from self-improve clusters/events into `agentctl` graph.
- No structured join from friction event to turn, tool args, edited files,
  command outcome, git diff, and commit result.
- No use of `taste`, `stats`, `pairs`, `recovery`, or `search` in proposal
  prompts.
- No first-class project memory records.
- No command-history capture outside transcript-visible Bash calls.
- No OTEL span ingest for measured latency, hook timing, MCP failures, or
  shell exit behavior.

Feature discussion:

- Make `agentctl` the grounding layer.
- Leave self-improve as the weekly decision and PR engine.
- Ingest self-improve outputs back into `agentctl`: taxonomy clusters,
  proposed interventions, shipped PRs, usage, wins, and deprecations.
- Replace text parsing with JSON commands:
  - `agentctl unused --json`
  - `agentctl taste --json`
  - `agentctl cluster-context <id> --json`
  - `agentctl project context --json`

## Proposed Product Loops

### Observe

Sources:

- Claude Code transcripts.
- Codex transcripts.
- Installed skills and plugins.
- Git commits, staged files, diffs, and file touches.
- Agent command calls and tool outputs.
- TypeScript/lint/test/build feedback.
- Dev-server process logs, OTLP traces, OTLP logs, and diagnostic pattern
  matches.
- OTEL spans/events/metrics.
- Self-improve interventions and outcomes.

### Resolve

Turn vague project language into concrete context:

- Names and concepts to files.
- Prompt phrases to prior sessions.
- Commands to previous successful command lines.
- Error strings to prior fixes.
- Diagnostic pattern matches to known suggested actions.
- Trace trees to root-cause paths.
- Commit messages to actual diffs.
- Skills to use or avoid.
- Project conventions to verification steps.

Example:

```text
"name entity resolution" ->
  files: src/resolution/name-entity.ts, tests/name-entity.test.ts
  commands: bun test name-entity, bun typecheck
  prior failures: alias normalization before fuzzy match
  related sessions: ...
```

### Improve

Use evidence to generate small, testable changes:

- Project memory entries.
- AGENTS.md/CLAUDE.md rules.
- Skills.
- Hooks.
- Commands.
- Verification plans.
- Deprecated interventions.

The improvement loop should always answer:

1. What repeated friction occurred?
2. What evidence proves it?
3. What small change should be made?
4. How will later sessions show whether it helped?

## Candidate Feature Set

### `agentctl init`

Per-project setup.

Possible outputs:

- `.agentctl/config.toml`
- optional `.agentctl/memory.md`
- project registration in SurrealDB
- shell/agent integration snippets

Discussion point:

- Keep memory mostly in DB and expose via commands, or write visible markdown
  files for review and git history?

### `agentctl project context`

Agent-facing context for the current repo and diff.

Should include:

- Stack and package manager.
- Project instructions and declared rules.
- Changed/staged files.
- Relevant known pitfalls.
- Recommended checks based on changed files.
- Relevant skills.
- Recent failure patterns.
- Live dev-session status when available: managed processes, service health,
  recent error spans, matched diagnostic patterns, and local URLs.

### `agentctl project verify`

Diff-aware verification guidance.

First implementation target: static diff-aware checks plus an optional HTTP
diagnostics adapter; OTEL persistence remains a later phase.

Examples:

- TypeScript changed -> run typecheck.
- `package.json` changed -> lockfile should usually change.
- schema changed -> run schema/db smoke check.
- Effect code changed -> consult `effect-solutions`.
- tests changed -> run relevant tests.
- live dev server is running -> query diagnostics and report new errors since
  the last check.
- OTLP spans show a new error -> include the trace tree and suggested pattern
  action.

### `agentctl recall <query>`

Search prior sessions, commands, commits, files, and memory.

Example questions:

- "How did we fix this SurrealDB Date issue before?"
- "What command verifies ingest?"
- "What did the agent run when resolving name entities?"
- "How did we fix this Effect service missing error?"
- "Which trace showed the auth regression?"

### `agentctl entities resolve <query>`

Project entity resolution.

Sources:

- file paths
- symbols
- docs headings
- package scripts
- test names
- commit messages
- transcript mentions
- skill names
- command history

### `agentctl otel serve`

Local OTLP receiver for Claude Code, Codex, and custom agent harnesses.

Store:

- trace/span ids
- session ids and cwd
- tool names
- duration
- status/error
- model/token/cost attributes when available
- hook and command spans
- service/process identifiers
- diagnostic pattern matches and suggested actions

### `agentctl self-improve`

Not a replacement for the existing cron. Better shape:

- `agentctl self-improve context --since=14d --json`
- self-improve pipeline consumes that context
- proposals cite graph evidence
- shipped interventions feed back into `agentctl`

## Differentiation

`agentctl` should not try to be all of these:

- RTK-style command proxy.
- GitNexus-style AST/code graph.
- claude-context-style vector code search.
- Caveman-style terse prompt pack.
- Quera-devkit-style full dev-service orchestrator for every repo.
- Session browser only.

The defensible center is:

> Cross-agent behavioral telemetry and project memory, grounded in transcripts,
> git, commands, tool feedback, skills, OTEL, and self-improvement outcomes.

That gives other agents a practical answer to:

- What does this repo expect?
- What worked here before?
- What keeps failing?
- Which skills/tools are actually helpful?
- What should I run before finishing?
- What should the weekly self-improve pipeline change next?

## Open Questions

- Should `agentctl` expose an MCP server, or keep the first agent-facing
  interface as CLI commands?
- Should project memory be visible markdown, DB-only, or hybrid with promoted
  memories written to disk?
- How much structural code indexing belongs in `agentctl` versus integration
  with GitNexus/code-review-graph/claude-context?
- Which command history sources are acceptable by default: agent tool calls
  only, shell history opt-in, or both?
- What is the minimum useful OTEL schema before adding a full collector?
- Should live dev diagnostics be pulled from repo-specific adapters such as
  Quera devkit, or should `agentctl otel serve` become the default diagnostic
  endpoint?
- Should `agentctl init` modify AGENTS.md/CLAUDE.md, or print snippets for
  manual promotion?
- What scoring model decides that an intervention helped?
