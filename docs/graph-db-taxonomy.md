# ax Graph DB Taxonomy

This is the step-1 inventory of what ax stores in SurrealDB today: what each record family means, where it comes from, how it is classified, and which code reads it back. The schema source of truth is [`schema/schema.surql`](../schema/schema.surql); ingest orchestration is [`src/ingest/stage/registry.ts`](../src/ingest/stage/registry.ts) and [`src/ingest/run.ts`](../src/ingest/run.ts).

## Source Systems

Agent transcript providers are first-class harnesses. Claude, Codex, Pi, OpenCode, and Cursor each have a dedicated ingest stage, configured source location, normalization path, and provider identity in the graph.

| Source | Ingest stage | Default location | Override | Discovery and ingest path | Primary records |
| --- | --- | --- | --- | --- | --- |
| Installed skills | `skills` | `~/.claude/skills/`, `~/.agents/skills/`, plugin caches, project `.claude/skills/` | `AX_SKILLS_DIRS` adds configured dirs | [`src/ingest/skills.ts`](../src/ingest/skills.ts) scans skill roots and role metadata | `skill`, `role`, `plays_role` |
| Claude slash commands | `commands` | `~/.claude/commands/`, plugin caches, project `.claude/commands/` | `AX_COMMAND_DIRS` adds configured dirs | [`src/ingest/commands.ts`](../src/ingest/commands.ts) scans command roots | `skill` rows with command scopes |
| Claude transcripts | `claude` | `~/.claude/projects/<project-slug>/*.jsonl` | `AX_TRANSCRIPTS_DIR` | [`src/ingest/transcripts.ts`](../src/ingest/transcripts.ts) walks project transcript dirs, optionally scoped by `ax ingest here`, snapshots raw transcripts, extracts turns/tools/plans/hooks/edits | `session`, `agent_provider`, `agent_session`, `agent_event`, `turn`, `tool`, `tool_call`, `invoked`, `edited`, `plan*`, hook evidence |
| Codex transcripts | `codex` | `~/.codex/sessions/**/*.jsonl` | `AX_CODEX_DIR` | [`src/ingest/codex.ts`](../src/ingest/codex.ts) recursively walks JSONL session files, snapshots raw payloads within size limits, extracts provider events, turns, tool calls, `update_plan`, synthetic `codex:*` skills, and token usage | `session`, `agent_provider`, `agent_session`, `agent_event`, `turn`, `tool`, `tool_call`, `invoked`, `plan*`, `session_token_usage` |
| Pi transcripts | `pi` | `~/.pi/agent/sessions/**/*.jsonl` | `AX_PI_DIR` | [`src/ingest/pi.ts`](../src/ingest/pi.ts) recursively walks JSONL files, parses Pi event blocks, normalizes turns/tool calls/provider events, and creates synthetic `pi:<tool>` skills for observed tools | `session`, `agent_provider`, `agent_session`, `agent_event`, `turn`, `tool`, `tool_call`, `invoked`, synthetic Pi tool skills |
| OpenCode transcripts | `opencode` | `~/.local/share/opencode/opencode.db` | `AX_OPENCODE_DIR` | [`src/ingest/opencode.ts`](../src/ingest/opencode.ts) locates `opencode.db`, reads supported SQLite schemas, normalizes sessions/messages/provider events, and maps structured `tool` parts into shared tool calls and synthetic `opencode:<tool>` invocations | `session`, `agent_provider`, `agent_session`, `agent_event`, `turn`, `tool`, `tool_call`, `invoked`, synthetic OpenCode tool skills |
| Cursor transcripts | `cursor` | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` and `~/Library/Application Support/Cursor/User/workspaceStorage/*/state.vscdb` | `AX_CURSOR_USER_DIR` | [`src/ingest/cursor.ts`](../src/ingest/cursor.ts) scans Cursor global and workspace `state.vscdb` files, includes WAL/SHM mtimes for `--since`, extracts composer/chat state into normalized sessions/turns/provider events | `session`, `agent_provider`, `agent_session`, `agent_event`, `turn` |
| Git history | `git` | local git repos/worktrees from current repo and `AX_REPO_LIST` | `AX_REPO_LIST` | [`src/ingest/git.ts`](../src/ingest/git.ts) imports repos/checkouts/commits/files and correlates sessions to commits | `repository`, `checkout`, `commit`, `file`, `has_checkout`, `touched`, `produced` |
| Derived graph signals | `signals`, `outcomes`, `turn-analysis`, `session-health`, `closure`, `proposals`, `opportunities`, `retro-proposals`, `harness` | existing graph rows | stage filters via `--stages=` / `--derive-only` | Derived stages read normalized provider rows and graph evidence | friction, diagnostics, semantic signals, health, proposals, experiments |
| Live hooks and app writes | hook CLI/dashboard/improve/dogfood | hook runtime, dashboard actions, `ax improve`, dogfood runner | command-specific flags | Runtime write paths outside transcript ingest | `hook_fire`, `skill_triage_decision`, `experiment`, `checkpoint`, `dogfood_run` |

## Stage Pipeline

`StageRegistryDefault` runs this canonical list unless `--stages=` or `--derive-only` filters it:

`skills -> commands -> pricing -> claude -> codex -> pi -> opencode -> cursor -> subagents -> invoked-positions -> spawned -> git -> signals -> outcomes -> turn-analysis -> session-health -> closure -> proposals -> opportunities -> retro-proposals -> harness`

Each `axctl ingest` run also writes ingest telemetry:

| Record | What it is | Written by | Read by |
| --- | --- | --- | --- |
| `ingest_run` | One top-level ingest execution. | [`src/ingest/run.ts`](../src/ingest/run.ts), statement builders in [`src/dashboard/telemetry.ts`](../src/dashboard/telemetry.ts) | Dashboard SSE/recent events, ingest health views |
| `ingest_stage` | One stage execution inside a run, with counts and status. | `wrapStage` in [`src/ingest/run.ts`](../src/ingest/run.ts) | Dashboard ingest progress |
| `ingest_event` | Append-like stage messages for UI/live progress. | [`src/dashboard/telemetry.ts`](../src/dashboard/telemetry.ts) | [`src/dashboard/server.ts`](../src/dashboard/server.ts), `use-ingest-events` |

## Provider Feature Parity

Claude-specific features should land in normalized graph records whenever another harness exposes equivalent raw data. Provider-specific parsing is allowed at the ingest edge; downstream reads should prefer `session`, `agent_session`, `agent_event`, `turn`, `tool_call`, `invoked`, `plan*`, `session_token_usage`, and graph relations instead of branching on provider.

The machine-readable source of truth is [`src/ingest/provider-parity.ts`](../src/ingest/provider-parity.ts). The parity gate is [`scripts/check-provider-parity.ts`](../scripts/check-provider-parity.ts), with tests in [`src/ingest/provider-parity.test.ts`](../src/ingest/provider-parity.test.ts). Update the matrix first, then let the gate verify that every claimed `supported` provider feature points to writer evidence and at least one shared read surface. Intentional gaps must use either `raw-signal-unavailable` or `extractor-not-implemented`.

| Feature surface | Claude | Codex | Pi | OpenCode | Cursor | Normalized records |
| --- | --- | --- | --- | --- | --- | --- |
| Provider identity and source path | Yes, from Claude JSONL path | Yes, from Codex JSONL path | Yes, from Pi JSONL path | Yes, from `opencode.db` path | Yes, from Cursor `state.vscdb` path | `agent_provider`, `agent_session`, `session.raw_file` |
| Provider event stream | Yes | Yes | Yes | Yes | Yes | `agent_event`, `agent_event_child` where parentage exists |
| Normalized turns | Yes | Yes | Yes | Yes | Yes | `turn` |
| Tool calls | Yes, when transcript has tool use/result blocks | Yes, from function/tool events | Yes, from Pi tool blocks | Yes, from structured SQLite `tool` parts | Not emitted yet from current state extractor | `tool`, `tool_call` |
| Skill/tool invocation edges | Yes, Skill tool and resolved skill catalogue | Yes, synthetic `codex:<tool>` | Yes, synthetic `pi:<tool>` | Yes, synthetic `opencode:<tool>` | Not emitted yet | `skill`, `invoked`, `concerns` |
| Plans | Yes, `TodoWrite` | Yes, `update_plan` | Not exposed in current raw format | Not exposed in current extractor | Not exposed in current extractor | `plan`, `plan_item`, `plan_snapshot` |
| File edit evidence | Yes, edit/write tool paths | Available once provider tool calls expose file edit arguments | Available once provider tool calls expose file edit arguments | Not emitted yet | Not emitted yet | `file`, `edited` |
| Token/cost usage | Estimated by session health unless explicit counts exist | Explicit `token_count` events | Explicit Pi usage fields when present | Estimated by session health | Estimated by session health | `session_token_usage`, `used_model`, `agent_used_model` |
| Hook evidence | Yes, Claude hook transcript attachments | Runtime hook telemetry still normalizes outside transcript ingest | Runtime hook telemetry still normalizes outside transcript ingest | Runtime hook telemetry still normalizes outside transcript ingest | Runtime hook telemetry still normalizes outside transcript ingest | `harness_hook_event`, `hook_command_invocation`, `hook_fire` |
| Subagent/delegation links | Yes, Claude Task/subagent extraction | Yes, Codex spawn-agent extraction when present | Not exposed in current raw format | Not exposed in current extractor | Not exposed in current extractor | `spawned`, session detail episode views |
| Derived analysis and insights | Yes | Yes | Yes | Yes | Yes | `friction_event`, `command_outcome`, `turn_analysis`, `semantic_signal`, `session_health`, proposals |

Parity rule: if a provider exposes the raw signal, ingest should map it into the shared graph surface, add tests for that provider, and make existing reads work without a provider-specific read path. Gaps above are extractor limitations or missing raw signals, not second-class harness status. When this table and the matrix disagree, treat the matrix and gate as authoritative.

## Core Domain Records

| Record | Classification | What it stores | Written from | Main reads |
| --- | --- | --- | --- | --- |
| `skill` | Node, instruction/tool catalogue | Installed skills, slash commands, and synthetic provider tools. Fields include `name`, `scope`, `dir_path`, `description`, `content_hash`. | `skills`, `commands`, transcript placeholder/synthetic writes in Claude/Codex/Pi/OpenCode/Cursor where provider tools are observable | `ax skills`, `ax taste`, `ax recall --sources=skill`, skill graph, weighted skills |
| `role` | Node, skill classification label | Role labels used to weight or group skills. | Skill frontmatter via `skills`, user tagging via `ax skills tag/lint` | `ax roles`, `ax skills by-role`, weighted skills |
| `plays_role` | Relation, classification edge | `skill -> role`, with `source`, `confidence`, optional `rationale`, optional `weight`. | [`src/ingest/skill-role.ts`](../src/ingest/skill-role.ts), [`src/cli/skills-tag.ts`](../src/cli/skills-tag.ts), skills lint | Weighted skills and role queries |
| `session` | Node, normalized work session | Agent session root with project/cwd/model/source/time/raw pointer and repo links. | Normalized transcript writer, provider stages, git backfill updates repository/checkout | Sessions CLI/dashboard, recall scoping, graph explorer, cost/session health |
| `agent_provider` | Node, provider catalogue | Claude/Codex/Pi/OpenCode/Cursor provider identity and capabilities. | Provider-event writers in transcript stages | Session detail, provider event queries |
| `agent_session` | Node, provider-native session | Provider session id, source path, raw provider metadata, link to `session`. | Normalized transcript/provider-event writers | Session detail, model usage, provider event tree |
| `agent_event` | Node, provider-native event | Raw provider event stream with seq, role/type/text/raw metadata. | Claude/Codex/Pi/OpenCode/Cursor normalization | Session inspect/detail, event parent-child traversal |
| `agent_event_child` | Relation | Parent/child event edges inside provider streams. | [`src/ingest/provider-events.ts`](../src/ingest/provider-events.ts), Codex parent edges | Session inspect/detail |
| `turn` | Node, normalized transcript turn | Ordered session messages with role, message kind, intent kind, text, tool/error flags. | [`src/ingest/normalized/transcripts.ts`](../src/ingest/normalized/transcripts.ts) from provider stages | Recall, sessions show/detail, signals/outcomes/turn-analysis |
| `tool` | Node, normalized tool identity | Agent tools and local CLI commands used inside shell calls. | [`src/ingest/evidence-writers.ts`](../src/ingest/evidence-writers.ts) | Tool failure views, session detail |
| `tool_call` | Node, concrete tool execution | Tool call inputs/outputs/raw JSON, command normalization, status/error fields. | Claude, Codex, Pi, and OpenCode stages via `buildToolCallStatements`; Cursor can join when its extractor exposes concrete tool events | Tool failures, session detail, outcomes, hooks backtests |
| `plan`, `plan_item`, `plan_snapshot` | Nodes, planning evidence | Current plan state, current items, and point-in-time TodoWrite/update_plan snapshots. | Claude `TodoWrite`, Codex `update_plan` via [`src/ingest/evidence-writers.ts`](../src/ingest/evidence-writers.ts) | Session detail, insights `sessions`, session health |
| `file` | Node, code/file identity | Repository-relative and legacy local file records, language/kind/workspace metadata. | Git ingest, edit ingest placeholders, future file evidence derivation | Git/file views, edited/touched/read/search relations |
| `symbol` | Node, code symbol mention | Named symbols extracted from text/tool evidence. | Schema exists; relation writers are not fully wired in current ingest | Intended for code-context graph queries |
| `error_signature` | Node, normalized error text | Reusable error signatures extracted from text/tool evidence. | Schema exists; relation writers are not fully wired in current ingest | Intended for error recurrence queries |
| `repository` | Node, stable repo identity | Normalized remote/root/default branch/initial commit. | Git stage | Repository insights, sessions scoping, git correlations |
| `checkout` | Node, local checkout/worktree | Local path, branch, head, worktree name, dirty flag. | Git stage | Checkout insights, scoped ingest, session linking |
| `workspace` | Node, staged grouping | Cross-checkout workspace grouping. | Schema only in current code | Future workspace-level queries |
| `commit` | Node, git commit | SHA, stable repo key, message, author, timestamp, repository/checkout links. | Git stage | Recall commits, git correlations, closure |
| `agent_model` | Node, model/pricing catalogue | Provider model names, context windows, token pricing. | Pricing stage [`src/ingest/model-pricing.ts`](../src/ingest/model-pricing.ts) | Costs CLI, session health/model usage |

## Core Relations

| Relation | Shape | Meaning | Written from | Main reads |
| --- | --- | --- | --- | --- |
| `invoked` | `turn -> skill` | Explicit skill/tool invocation. Includes JSON args, timestamp, turn error/correction flags, position metadata. | Claude Skill tool, Codex/Pi/OpenCode synthetic tool skills, other provider tool evidence when available, invoked-position backfill | `ax taste/stats/recent/unused`, weighted skills, wrapped, skill graph |
| `proposed` | `turn -> skill` | Assistant mentioned a skill but did not invoke it. | `signals` stage | Taste/search diagnostics |
| `edited` | `turn -> file` | Agent edit/write tool touched a file. | Claude transcript edit extraction | File/session evidence queries |
| `mentioned_file` | `turn -> file` | Text/tool evidence mentioned a file. | Schema exists; intended for file-evidence derivation | Future multi-hop file queries |
| `mentioned_symbol` | `turn -> symbol` | Text/tool evidence mentioned a symbol. | Schema exists | Future code-symbol queries |
| `mentioned_error` | `turn -> error_signature` | Text/tool evidence mentioned an error. | Schema exists | Future error recurrence queries |
| `read_file` | `tool_call -> file` | Tool call read a file. | Schema exists; tool-file evidence tests indicate intended derivation | Future "read before edit" and context queries |
| `searched_file` | `tool_call -> file` | Tool call searched/matched a file. | Schema exists; tool-file evidence tests indicate intended derivation | Future search/context queries |
| `corrected_by` | `turn -> turn` | Assistant turn followed by user correction/pushback. | `signals` stage | Correction rates, friction, turn-analysis |
| `expresses` | `turn -> semantic_signal` | Turn contains a reusable semantic signal. | `turn-analysis` stage | Message/reaction insights |
| `reacts_to` | `turn -> turn` | User reaction turn linked to prior assistant turn. | `turn-analysis` stage | Reaction/revision queries |
| `produced` | `session -> commit` | Session produced a commit in its time window. | Git stage | Git correlation, skill-to-commit impact |
| `touched` | `commit -> file` | Commit touched file with additions/deletions/status. | Git stage | Git/file impact, closure |
| `has_checkout` | `repository -> checkout` | Repository has local checkout/worktree. | Git stage | Repo/checkout overview |
| `concerns` | Generic relation | Evidence edge, currently tool_call-to-skill for invoked skill provenance and imported insights. | Transcript evidence writers, insight imports | Evidence graph and future provenance |
| `skill_paired` | `skill -> skill` | Skills co-occurred within a session/window. | `signals` stage | `ax pairs`, skill graph |
| `recovered_by` | `turn -> skill` | Skill invoked after an error turn. | `signals` stage | `ax recoveries` |
| `spawned` | `session -> session` | Parent session delegated to child/subagent session. | `spawned`, `subagents` stages | Session inspect/detail, episode timelines |
| `used_model` | `session -> agent_model` | Session used model with token/cost evidence. | `session-health` | Costs and model usage |
| `agent_used_model` | `agent_session -> agent_model` | Provider-native session used model. | `session-health` | Costs/session detail |

## Derived Evidence And Health

| Record | Classification | What it stores | Written from | Main reads |
| --- | --- | --- | --- | --- |
| `friction_event` | Node, derived evidence | Tool errors, corrections, and imported/derived friction. | `signals`, Claude insights | Insights friction, session evidence, proposals |
| `insight` | Node, imported usage-data facet | Claude usage-data/insight rows keyed by subject and kind. | Claude insights importer | Insights report and generic evidence views |
| `diagnostic_event` | Node, derived evidence | Failed commands or diagnostic patterns. | `signals` | Insights diagnostics and future proposal mining |
| `command_outcome` | Node, derived evidence | Semantic outcome classification for command/tool calls. | `outcomes` | Feedback loops, proposal mining |
| `user_message_ngram` | Node, aggregate language evidence | User phrase n-grams and nearby correction/failure/edit counts. | `outcomes` | User-language insights |
| `turn_analysis` | Node, per-turn interpretation | Speaker act, sentiment, polarity, confidence, signals JSON. | `turn-analysis` | Message-signals/reactions insights |
| `semantic_signal` | Node, normalized meaning | Reusable labels such as correction or preference themes. | `turn-analysis` | Reaction-theme insights |
| `workflow_epoch` | Node, era marker | Named workflow periods, e.g. `gsd`, `superpowers`. | `session-health` | Token/workflow impact |
| `session_token_usage` | Node, session cost/token facts | Actual or estimated tokens/cache/context/cost. | Codex token counts, `session-health` | Costs CLI/dashboard, session detail |
| `session_health` | Node, aggregate session health | Counts for turns/tools/errors/corrections/subagents/context pressure/task label. | `session-health` | Graph explorer, sessions overview, health insights |
| `commit_classification` | Node, commit label | Commit kind/confidence/message-derived lifecycle class. | `closure` | Closure/post-feature-fix insights |
| `later_fixed_by` | `commit -> commit` | Feature commit later fixed by overlapping fix commit. | `closure` | Closure/post-feature-fix insights |
| `skill_candidate` | Node, candidate behavior | Candidate skill/guardrail with trigger/gap/expected impact. | `closure`, proposals | Skill-candidate insights, proposals |
| `suggests_skill` | `commit -> skill_candidate` | Commit evidence suggests a skill candidate. | `closure` | Candidate/proposal evidence |
| `phase_span` | Node, session phase aggregate | Phase durations, files/tools/tests/corrections. | Schema exists; stage not wired in `ALL_STAGES` yet | Future workflow timing queries |
| `delivery_outcome` | Node, delivery aggregate | PR/promotion status, PR size, review pain, phase metrics. | Delivery code exists; not in default stage list | Future delivery analytics |

## Improvement Loop

| Record | Classification | What it stores | Written from | Main reads |
| --- | --- | --- | --- | --- |
| `proposal` | Node, polymorphic candidate | Repeated workflow candidate with form, hypothesis, dedupe signature, baseline, status. | `proposals`, `retro plan`, dashboard/CLI actions update status | `ax improve`, dashboard improve |
| `skill_proposal` | Node, payload | Typed payload for skill-form proposals. | `proposals`, `retro plan` | Improve list/show/accept |
| `subagent_proposal` | Node, payload | Typed payload for subagent-form proposals. | `proposals`, `retro plan` | Improve list/show/accept |
| `hook_proposal` | Node, payload | Typed payload for hook-form proposals. | `proposals`, `retro plan` | Improve list/show/accept |
| `guidance_proposal` | Node, payload | Typed payload for guidance-file proposals. | `proposals`, `retro plan` | Improve list/show/accept |
| `automation_proposal` | Node, payload | Typed payload for automation-form proposals. | `proposals`, `retro plan` | Improve list/show/accept |
| `cites_evidence` | Generic relation | Proposal cites evidence rows such as friction, command outcomes, spawned edges. | `proposals` | Improve evidence, "unproposed friction" future queries |
| `experiment` | Node | Accepted proposal, artifact path/skill, scaffold state, locked verdict. | `ax improve accept`, `retro plan`, lint/scaffold updates | Improve dashboard/CLI |
| `opportunity` | Generic relation | Experiment trigger recurred after acceptance, with addressed flag. | `opportunities` | Checkpoint/verdict math |
| `checkpoint` | Node | Experiment measurement snapshots and human verdict field. | `derive-checkpoints`, improve verdict actions | Improve dashboard/CLI |
| `retro` | Node | Structured session reflection: tried/worked/failed/next. | `ax retro emit`, Codex rollout extraction, heuristic/manual emit | `ax retro list/pending/reflect/meta/brief` |
| `reviewed` | `session -> retro` | Session has associated retro. | Retro emit | Retro pending queue |
| `guidance`, `guidance_version`, `artifact`, `derived_from` | Nodes/relations, guidance evidence | Proposed guidance text and evidence artifact links. | [`src/self-improve/guidance.ts`](../src/self-improve/guidance.ts) | Self-improve/guidance flows |
| `guidance_source`, `guidance_revision`, `stack` | Nodes, observed project harness facts | Agent files, content hashes, detected stack signals. | `harness` stage | Harness/project context |

## Hook, Feedback, And Dogfood Records

| Record | Classification | What it stores | Written from | Main reads |
| --- | --- | --- | --- | --- |
| `harness_hook_event` | Node | Native Claude/Codex hook lifecycle event. | Claude transcript replay in [`src/ingest/transcripts.ts`](../src/ingest/transcripts.ts) | `ax hooks session`, hook analytics |
| `hook_command_invocation` | Node | Command invoked by a hook, status/effect/excerpts/duration. | Claude transcript replay | `ax hooks summary/invocations/session/backtest` |
| `feedback_case_type` | Node | Backtest case definition and rule JSON. | [`src/queries/feedback-cases.ts`](../src/queries/feedback-cases.ts) | Hook feedback backtests |
| `feedback_case_result` | Node | Deterministic backtest result for evidence windows. | Feedback-case backtest writer | Hook feedback backtests |
| `hook_fire` | Node | Runtime `axctl hook file-context` decision: file, event, inject/skip reason, prior sessions. | [`src/hooks/telemetry.ts`](../src/hooks/telemetry.ts), Codex replay synthesis | Session inspect, hook-fire telemetry |
| `skill_triage_decision` | Node | Dashboard keep/archive/review decision per skill. | [`src/dashboard/triage.ts`](../src/dashboard/triage.ts) | Skill triage/weighted filtering |
| `dogfood_run` | Node | Terminal dogfood scenario result and transcript artifact link. | [`src/dogfood/wterm.ts`](../src/dogfood/wterm.ts) | `ax dogfood runs` |
| `query_sample` | Node, query telemetry | Saved query execution sample/status/duration. | Schema exists; dashboard query endpoint currently guards reads but does not broadly sample | Future graph-query observability |
| `graph_health_check` | Node, health telemetry | Persisted graph health check results. | Graph health query code | Graph-health insights |

## Generic Memory Records

These tables are schema-active but not central to the default ingest path yet. They are the planned shape for richer graph memory.

| Record/relation | Classification | Intended meaning |
| --- | --- | --- |
| `changeset` | Node | Activity-first semantic change summary. |
| `file_memory` | Node | Per-file memory/tribal knowledge with BM25 search. |
| `includes` | `changeset -> file_memory` | Changeset includes memory item. |
| `involves` | `changeset -> file` | Changeset involves file. |
| `resulted_in` | Generic relation | Record produced outcome. |
| `supersedes` | Generic relation | Memory/guidance replacement edge. |
| `produced_artifact` | Generic relation | Producer created artifact. |
| `has_artifact` | Generic relation | Owner has artifact. |
| `branch`, `pull_request`, `review_event`, `check_run` | Nodes | GitHub delivery and review state; schema exists, ingestion is separate/future. |

## Read Surfaces

| Surface | Code | Reads |
| --- | --- | --- |
| CLI skill analytics | [`src/cli/index.ts`](../src/cli/index.ts), [`src/dashboard/skills-weighted.ts`](../src/dashboard/skills-weighted.ts), [`src/dashboard/skill-graph.ts`](../src/dashboard/skill-graph.ts) | `skill`, `invoked`, `plays_role`, `role`, `produced`, `skill_paired`, `recovered_by`, `skill_triage_decision` |
| CLI/session dashboard | [`src/queries/session-detail.ts`](../src/queries/session-detail.ts), [`src/dashboard/session-detail.ts`](../src/dashboard/session-detail.ts), [`src/dashboard/session-inspect.ts`](../src/dashboard/session-inspect.ts) | `session`, `turn`, `tool_call`, `invoked`, `spawned`, `agent_session`, `agent_event`, `session_token_usage`, hook rows |
| Recall/search | [`src/queries/recall.ts`](../src/queries/recall.ts), [`src/dashboard/recall.ts`](../src/dashboard/recall.ts) | BM25 over `turn.text_excerpt`, `commit.message`, `skill.name/description`; session scoping via repository/checkout |
| Insights | [`src/queries/insights.ts`](../src/queries/insights.ts) | Repo/checkout/git, friction, tools, sessions, feedback loops, semantic signals, reactions, tokens, closure, graph health |
| Costs | `costs` CLI commands in [`src/cli/index.ts`](../src/cli/index.ts), [`src/dashboard/cost-query.ts`](../src/dashboard/cost-query.ts) | `session_token_usage`, `session_health`, `agent_model`, `used_model` |
| Improve dashboard/CLI | [`src/improve`](../src/improve), dashboard server improve endpoints | `proposal`, typed proposal payloads, `experiment`, `checkpoint`, `opportunity`, `cites_evidence` |
| Hooks | [`src/queries/hooks.ts`](../src/queries/hooks.ts), hooks CLI in [`src/cli/index.ts`](../src/cli/index.ts) | `harness_hook_event`, `hook_command_invocation`, `feedback_case_*`, `hook_fire` |
| Graph explorer/health | [`src/dashboard/graph-explorer.ts`](../src/dashboard/graph-explorer.ts), [`src/queries/graph-health.ts`](../src/queries/graph-health.ts) | `session_health`, `repository`, `checkout`, relation integrity checks |
| Raw dashboard query endpoint | [`src/dashboard/server.ts`](../src/dashboard/server.ts) | Allows only `SELECT`, `RETURN`, and `INFO` queries |

## Classification Rules Of Thumb

- `source` fields classify origin (`claude`, `codex`, `pi`, `opencode`, `cursor`, `git`, `session_health`, `turn_analysis`, `derive_*`, etc.).
- `labels` and `metrics` fields are JSON-encoded strings when schema comments say so. This is a SurrealDB v3 compatibility rule from [`CLAUDE.md`](../CLAUDE.md).
- Provider-native identity lives in `agent_*`; product-normalized identity lives in `session`/`turn`/`tool_call`.
- Relation tables carry graph facts and provenance. For idempotency, many writers use `RELATE ...:<stable edge id>...` rather than `UPSERT` on relation tables.
- Derived records should name their derivation in `labels.source`, `method`, or `source` so later multi-hop queries can explain why a fact exists.

## Gaps To Close Before Stage 2

- Keep [`src/queries/insights.ts`](../src/queries/insights.ts) in lockstep with this taxonomy when schema migrations add or retire graph tables.
- File evidence relations (`mentioned_file`, `read_file`, `searched_file`, `mentioned_symbol`, `mentioned_error`) are schema-ready but not yet fully documented as default-stage writes.
- Delivery/GitHub tables (`branch`, `pull_request`, `review_event`, `check_run`, `delivery_outcome`) need a confirmed ingest owner before multi-hop delivery queries depend on them.
- Stage 2 graph queries should start from the stable high-signal chains: `session -> turn -> tool_call`, `turn -> invoked -> skill -> plays_role -> role`, `session -> produced -> commit -> touched -> file`, `turn -> reacts_to/corrected_by -> turn`, and `proposal -> cites_evidence -> evidence`.
