# Graph Insight Goal Notes

Date: 2026-05-11

## Context

We explored the current `agentctl` graph to find useful insight patterns. The first obvious metrics, such as "most touched files" and raw command failure counts, were not useful enough:

- Most-touched files surfaced noisy artifacts such as lockfiles and deployment config.
- Raw `tool_call.has_error = true` treated expected feedback loops as friction.
- `bun test`, `typecheck`, `lint`, `rg`, `grep`, and similar commands can fail in productive ways.

The important product direction is to distinguish useful feedback from actual friction.

## Key Decision

Do not treat command failure as friction by default.

Command failure should be classified by semantic role:

- `expected_feedback`: tests, typecheck, lint, and checks that intentionally guide edits.
- `search_miss`: `rg`, `grep`, `find`, or lookup commands with no result.
- `guardrail`: validation gates such as `git diff --exit-code`.
- `environment_blocker`: missing command, missing service, auth, network, port, DB, or daemon issue.
- `workflow_error`: wrong path, bad args, wrong branch, bad command shape.
- `product_bug_signal`: test failure, compile failure, or runtime crash after code changes.
- `unknown`: not enough context yet.

Useful friction is not "a command failed." Useful friction is repeated failure without progress, environment blockage, user correction after a tool action, or a failed verification that never recovers.

## Better Signals

Prefer signals that explain behavior:

- Failure followed by successful verification: healthy feedback loop.
- Failure repeated several times with no edit or no changed hypothesis: possible thrash.
- Edits without any verification command: risky session.
- Produced commits without verification: risky output.
- User correction after command/tool sequence: workflow mismatch.
- Files edited repeatedly after failed verification: unstable module or test-driven hotspot.
- Repeated correction phrases by repo/checkout/session: user preference or agent behavior gap.
- Commands near user interruption/correction: likely UX/workflow issue.

## User Messages

User messages are partially indexed today:

- `turn.role = "user"` exists.
- `turn.text_excerpt` stores only the first text block, capped at 500 chars.
- Live graph had many user turns, but only a small subset with text excerpts.
- Raw transcript files are preserved, so richer backfill is possible.

For useful n-gram mining, add full user message ingestion or a derived table.

Potential derived table:

```text
user_message_ngram
- ngram
- n
- count
- sessions
- first_seen
- last_seen
- near_correction_count
- near_failed_tool_count
- near_edit_count
- near_verification_count
```

Useful n-gram categories:

- Correction language: "no", "wait", "wrong", "not that", "instead".
- Intent language: "can we", "let's", "what's next", "verify", "clean up".
- Delegation language: "use claude code", "review", "merge", "commit".
- Product feedback: "useful", "not useful", "show me", "default".
- Friction language: "crashed", "slow", "wrong", "again".

## Candidate Goal

Classify command outcomes and user-message signals so graph insights distinguish useful feedback loops from real friction.

Success criteria:

- Backfill richer user message text or derived user-message n-grams.
- Add command outcome classification for existing `tool_call` rows.
- Keep expected TDD/test/search failures out of generic friction.
- Surface repeated unresolved failures and user corrections as high-signal friction.
- Provide 3 CLI views:
  - `agentctl insights feedback-loops`
  - `agentctl insights verification-gaps`
  - `agentctl insights user-language`

## Candidate Queries

Healthy verification feedback:

```sql
SELECT command_norm, count() AS runs,
  math::sum(IF has_error = true THEN 1 ELSE 0 END) AS failures
FROM tool_call
WHERE command_text IS NOT NONE
AND (
  string::contains(command_text, "test")
  OR string::contains(command_text, "typecheck")
  OR string::contains(command_text, "tsc")
  OR string::contains(command_text, "lint")
)
GROUP BY command_norm
ORDER BY runs DESC
LIMIT 20;
```

Correction patterns:

```sql
SELECT pattern, count() AS corrections
FROM corrected_by
GROUP BY pattern
ORDER BY corrections DESC
LIMIT 20;
```

Large edit sessions without verification:

```sql
SELECT * FROM (
  SELECT id, project, cwd,
    array::len((SELECT id FROM edited WHERE in.session = $parent.id)) AS edits,
    array::len((SELECT id FROM tool_call WHERE session = $parent.id AND (
      string::contains(command_text ?? "", "test")
      OR string::contains(command_text ?? "", "typecheck")
      OR string::contains(command_text ?? "", "tsc")
      OR string::contains(command_text ?? "", "lint")
      OR string::contains(command_text ?? "", "check")
    ))) AS verification_commands
  FROM session
)
WHERE edits >= 10 AND verification_commands = 0
ORDER BY edits DESC
LIMIT 20;
```

Commands near user correction:

```sql
SELECT command_norm, count() AS calls_near_correction
FROM tool_call
WHERE command_norm IS NOT NONE
AND array::len((
  SELECT id FROM corrected_by
  WHERE in.session = $parent.session
  AND in.seq >= $parent.seq
  AND in.seq <= $parent.seq + 5
)) > 0
GROUP BY command_norm
ORDER BY calls_near_correction DESC
LIMIT 20;
```

## Product Framing

The CLI should not say "this failed a lot" as a conclusion. It should explain whether failures were:

- part of a successful feedback loop,
- unresolved and repeated,
- followed by user correction,
- blocking environment progress,
- or missing verification entirely.

## Additional Signals From Interview

Git commits and user feedback remain strong signals, but they are not the only high-value sources. The graph should model how agent work unfolds:

- `feedback_event`: explicit user acceptance, correction, interruption, or preference.
- `delegation_event`: subagent/task dispatch, task size, ownership clarity, return status, and integration outcome.
- `experiment_event`: hypothesis, edit, verification command, result, follow-up edit, accepted/reverted/abandoned.
- `context_pressure_event`: long sessions, large transcript bytes/token estimates, compaction, status churn, and repeated "what's left?" moments.
- `intervention_event`: user interrupted, redirected, paused, corrected, accepted, or changed scope while the agent was working.
- `instruction_change_event`: changes to `CLAUDE.md`, `AGENTS.md`, skills, guidance docs, and project instructions.

These let us ask better questions:

- Did this instruction change improve agent behavior?
- Are subagent tasks too broad?
- Did verification failures guide progress or block it?
- Where does the user repeatedly correct the agent?
- Where does the user interrupt or redirect the agent before it finishes?
- Which sessions are too large or under-closed?

## User Interventions

Interruptions are stronger than normal corrections. They often mean the user stopped the agent mid-flow because it was too slow, going in the wrong direction, using too much context, or missing the current intent.

Claude transcripts include an explicit marker:

```text
[Request interrupted by user]
```

Current derivation already maps this to `corrected_by.pattern = "interrupted"`, but that collapses a distinct behavior into generic correction. It should become first-class.

Potential event:

```text
intervention_event
- session
- turn
- kind
- text
- target_turn
- target_tool_call
- ts
- labels
- metrics
```

Potential kinds:

- `interrupt`: user stopped the agent mid-flow.
- `redirect`: user gave a new direction.
- `scope_change`: user changed the task.
- `pause`: user asked to wait, report status, or stop moving.
- `correction`: user said no, wrong, not that, instead.
- `acceptance`: user approved, continued, merged, or shipped.

Why it matters:

- Interruptions mark wasted or misdirected work more directly than tool errors.
- Interruptions can be used as a context-pressure signal.
- Redirects reveal where the agent misunderstood the goal.
- Pauses/status requests reveal weak closure or poor progress visibility.
- Acceptance events give positive feedback, not only negative friction.

Useful comparisons:

- interruptions per workflow epoch
- interruptions per 1,000 turns
- interruptions after context grows past a threshold
- commands/tool types near interruption
- subagent task size before interruption
- instruction changes that reduce interruptions

## Workflow Migration Impact

The user recently switched from GSD-style workflow to the Superpowers meta-framework and wants backing data, especially token savings.

Add a `workflow_epoch` concept:

```text
workflow_epoch
- name
- starts_at
- ends_at
- evidence_kind
- evidence_ref
- notes
```

Example epochs:

```text
workflow_epoch:gsd
workflow_epoch:superpowers
```

Compare before/after:

- estimated tokens per session/task
- transcript bytes per session/task
- turns per completed task
- tool calls per completed task
- user correction rate
- verification gap rate
- commits per session
- sessions ending with status/continuation questions
- plan churn
- subagent dispatch count
- average subagent prompt size

Potential CLI:

```bash
agentctl insights workflow-impact gsd superpowers
```

Output should include:

- estimated token delta
- session length delta
- correction delta
- verification delta
- completion/commit delta
- confidence level
- missing data that would improve confidence

Token measurement tiers:

- Proxy: transcript bytes/chars and estimated tokens.
- Better: tokenizer-based estimate during ingest.
- Best: actual model usage metadata from Claude/Codex transcripts when available.

## Prompt Cache Health

Prompt cache behavior is another useful workflow signal. The user wants to know how often workflows break prompt cache and whether instruction/framework changes improve cache reuse.

Potential fields:

```text
session_token_usage
- session
- source
- model
- prompt_tokens
- completion_tokens
- cache_creation_input_tokens
- cache_read_input_tokens
- estimated_tokens
- transcript_bytes
- ts
```

Potential derived metrics:

- cache read ratio: `cache_read_input_tokens / prompt_tokens`
- cache creation ratio: `cache_creation_input_tokens / prompt_tokens`
- cache miss proxy: high prompt tokens with low cache read tokens
- context churn: repeated large prompt/cache creation events in same workflow
- instruction churn impact: cache ratio before/after `CLAUDE.md`, `AGENTS.md`, or skill changes

Questions this should answer:

- How much token usage did Superpowers save compared to GSD?
- Did a workflow change improve cache reuse or break it?
- Which instruction files or prompt patterns cause frequent cache creation?
- Are large subagent prompts hurting cache efficiency?
- Do repeated status/resume sessions preserve or lose cache benefits?

Potential CLI:

```bash
agentctl insights token-impact
agentctl insights cache-health
agentctl insights workflow-impact gsd superpowers --tokens
```

## Post-Closure Quality From Git

Git commits are not only completion signals. Commit messages and touched-file overlap can reveal post-feature correction chains.

Core idea:

```text
feature commit(s) -> later fix commit(s) -> same files/modules/sessions
```

Use commit-message classification as a first pass:

- `feature`: `feat:`, `add`, `implement`, `initial`, `support`
- `fix`: `fix:`, `bug`, `repair`, `correct`, `regression`
- `refactor`: `refactor:`, `cleanup`, `simplify`
- `test`: `test:`, `spec`, `coverage`
- `docs`: `docs:`
- `chore`: `chore:`, `deps`, `release`

Then strengthen the relation with graph evidence:

- same repository
- fix commit after feature commit
- time window, e.g. 1-14 days
- overlapping files
- overlapping directories/modules
- same checkout/worktree/branch
- same session or nearby sessions
- user correction or failed verification between feature and fix

Potential relations:

```text
commit(feature) -> later_fixed_by -> commit(fix)
commit(fix) -> fixes_regression_from -> commit(feature)
commit(fix) -> stabilizes -> file
commit(fix) -> repairs -> file
commit(test) -> expands_tests_for -> commit(feature)
```

Why this matters:

- A commit is a weak completion signal if it needs several fixes soon after.
- Fix chains reveal missing verification, weak domain understanding, or bad workflow order.
- Feature quality can be compared before/after workflow or instruction changes.
- Post-closure fixes are better evidence than raw command failures.

Potential CLI:

```bash
agentctl insights closure
agentctl insights post-feature-fixes
agentctl insights commit-quality <sha>
```

## Skill Candidate Discovery

Post-feature fix chains are also a strong source of new skill ideas.

Pattern:

```text
feature commit -> later fix commits -> repeated files/errors/user corrections -> skill_candidate
```

Examples:

- Many fixes after schema changes -> create or improve a SurrealDB schema-change skill.
- Many fixes after Effect service changes -> improve `effect-best-practices` or create a repo-specific Effect skill.
- Many fixes after frontend route/component work -> add browser/frontend QA guidance.
- Many fixes after deploy/config edits -> add deployment guardrail guidance.
- Many fixes after subagent-heavy features -> improve subagent task scoping guidance.
- Many fixes after unverified sessions -> create a just-in-time verification reminder.

Potential node:

```text
skill_candidate
- name
- trigger_pattern
- suspected_gap
- proposed_behavior
- confidence
- expected_impact
- status
- created_at
```

Potential relations:

```text
commit(fix) -> suggests_skill -> skill_candidate
skill_candidate -> supported_by -> evidence bundle
skill_candidate -> targets -> file/module/repository
skill_candidate -> supersedes_or_updates -> skill
```

The goal is to turn history into a skill discovery engine:

- find repeated fix-after-feature patterns
- infer the missing behavior
- propose a narrow skill or instruction update
- measure whether the update reduces future fixes, corrections, interruptions, or token/context cost

## Legacy Self-Improve And Claude Insights

There are two related but distinct data sources:

- Claude insights usage data in `~/.claude/usage-data/facets` and `~/.claude/usage-data/session-meta`.
- The older dotfiles self-improve pipeline in `~/.dotfiles/claude/.claude/self-improve`.

Current `agentctl` Claude insights import reads Claude usage-data facets/session metadata and converts them into:

- `insight` rows with `kind = "claude_insights"`
- `friction_event` rows from `facet.friction_counts`
- `concerns` edges from insight to session

Current imported Claude insight metadata includes useful per-session fields such as:

- `duration_minutes`
- `input_tokens`
- `output_tokens`
- `user_interruptions`
- `tool_errors`
- `tool_counts`
- `tool_error_categories`
- `files_modified`
- `git_commits`
- `git_pushes`

The dotfiles self-improve pipeline is a separate weekly intervention system. It:

- scans raw Claude JSONL transcripts from `~/.claude/projects`
- compacts sessions
- detects friction events with deterministic detectors and an LLM pass
- clusters friction events
- proposes skills, hooks, slash commands, memory entries, or CLAUDE.md additions
- tests proposed interventions
- opens a draft PR against `.dotfiles`
- tracks whether shipped interventions reduced future friction

Its deterministic detectors are valuable signals to reuse:

- hook blocks
- tool denials
- retries
- output truncation
- repeated edits
- rescue invocations

Its LLM-derived event types are also useful:

- user correction
- self correction
- duplicate question
- fallback pattern
- plan revision

Recommended unification:

- Keep Claude usage-data import as the source of session-level classifications and metrics.
- Add a legacy self-improve artifact importer for `runs/*/events.jsonl`, `clusters.json`, `proposed-claudemd.md`, and `_spend.log`.
  Implemented in `src/ingest/legacy-self-improve.ts` and wired into
  `agentctl ingest-insights`; imported rows are modeled as evidence artifacts
  with `self_improve_run`, `artifact`, `friction_event`, `insight`,
  `has_artifact`, and `derived_from`.
- Move reusable detectors from dotfiles into `agentctl` signal derivation or a shared package.
- Model both sources as evidence, not final truth, so graph insights can compare Claude's classification against local transcript-derived signals.

This gives one graph view over:

- Claude's own insight/facet judgments
- local transcript-derived friction
- actual intervention proposals
- intervention spend
- shipped/not-shipped outcome
- later observed wins/regressions

## Codex Insight Equivalent

Codex does not appear to have a Claude-style generated insights directory like:

```text
~/.claude/usage-data/facets
~/.claude/usage-data/session-meta
```

Local Codex data is more event-log oriented:

```text
~/.codex/sessions/**/*.jsonl
~/.codex/session_index.jsonl
~/.codex/state_5.sqlite
~/.codex/logs_2.sqlite
~/.codex/sqlite/codex-dev.db
```

Codex JSONL sessions include valuable raw events that can become our own insights:

- `session_meta`: cwd, cli version, source, model provider, git branch/sha/origin, context window.
- `token_count`: total and last-turn token usage, cached input tokens, output tokens, reasoning output tokens, context window, rate limits, plan type.
- `task_complete`: final agent message, duration, time to first token.
- `turn_aborted`: explicit user interruption.
- `response_item`: user messages, assistant messages, tool calls, tool outputs.
- `event_msg`: lifecycle events such as started/completed/aborted.

Codex SQLite state adds useful session-level structure:

- `threads`: rollout path, cwd, title, source, provider, tokens used, model, reasoning effort, git metadata, first user message.
- `thread_goals`: objective, status, token budget, tokens used, time used.
- `thread_spawn_edges`: parent/child subagent relationships.
- `agent_jobs`: longer-running agent jobs and status.

So the product answer is:

- Claude has first-party generated insight artifacts.
- Codex has better raw telemetry and lifecycle events.
- `agentctl` should derive Codex insights itself from Codex event logs and SQLite state.

Potential Codex-derived insight types:

- `codex_token_health`: cache ratio, context pressure, reasoning/output cost.
- `codex_intervention`: turn aborted, redirected, resumed, completed.
- `codex_goal_health`: active/complete/budget-limited goals and token burn.
- `codex_delegation_health`: subagent count, task size, completion status, parent/child outcome.
- `codex_closure_quality`: task_complete followed by user correction, fix commit, or repeated session.
- `codex_rate_limit_pressure`: primary/secondary usage near limit.

This may be stronger than Claude facets for some questions because it has exact event-level telemetry, but it needs local derivation/classification.

## Reverse-Engineering Claude Insights

Claude insights appears to have two separate layers:

1. Deterministic session metadata in `session-meta/*.json`.
2. Model-derived session classification in `facets/*.json`.

The `session-meta` layer contains facts that can be derived from transcripts and environment state:

- session id
- project path
- start time
- duration
- user/assistant message counts
- tool counts
- languages touched
- git commits and pushes
- token counts
- first prompt excerpt
- user interruption count
- user response timings
- tool error counts and categories
- whether task agents, MCP, web search, or web fetch were used
- lines added/removed
- files modified
- message hours and user message timestamps

The `facets` layer contains judgment/classification:

- underlying goal
- goal categories with weights
- outcome
- user satisfaction counts
- Claude helpfulness
- session type
- friction counts
- friction detail
- primary success
- brief summary

To implement our own equivalent, build these pieces:

1. Session scanner and normalizer
   - Read Claude and Codex raw sessions.
   - Normalize turns, tools, timestamps, cwd, git metadata, model/source, and transcript size.
   - Preserve provider-specific raw facts without forcing them into one lossy shape.

2. Deterministic metadata extractor
   - Compute message counts, duration, tool mix, edits, files, languages, git commits, pushes, interruptions, token/cache usage, rate-limit pressure, and verification commands.
   - This should be cheap, repeatable, and idempotent.

3. Event detector layer
   - Derive first-class events before asking an LLM:
     - user interruption
     - user correction
     - tool error
     - repeated tool retry
     - repeated edit
     - output/context limit
     - environment blocker
     - verification failure/success
     - subagent dispatch/return
     - plan revision
     - post-completion follow-up/fix

4. Facet classifier
   - LLM/classifier pass over compact session evidence.
   - Output structured judgments:
     - underlying goal
     - task/session type
     - outcome
     - satisfaction
     - helpfulness
     - primary success
     - friction taxonomy
     - concise summary
   - Classifier should cite evidence ids, not just write conclusions.

5. Taxonomy and normalization
   - Maintain stable categories for:
     - goal categories
     - session types
     - outcomes
     - success types
     - friction kinds
     - satisfaction labels
   - Avoid unbounded string drift from LLM outputs.

6. Evidence graph writer
   - Store each facet as `insight`.
   - Store each event as `friction_event`, `feedback_event`, `intervention_event`, `verification_event`, etc.
   - Link facets/events back to sessions, turns, tools, files, commits, repositories, skills, and workflow epochs.

7. Confidence and disagreement model
   - Keep deterministic facts separate from model judgments.
   - Track confidence, missing evidence, and conflicting signals.
   - Compare Claude-generated insights, Codex-derived insights, and local detector output rather than trusting one source.

8. Insight rollups
   - Generate weekly/repo/workflow summaries:
     - token/cache health
     - closure quality
     - repeated friction
     - skill candidates
     - workflow epoch impact
     - subagent effectiveness
     - user interruption/correction rate

Implementation order should be:

1. Build provider-neutral `session_meta`.
2. Add provider-specific token/cache extraction.
3. Promote interruption/correction/verification to first-class events.
4. Build a local facet classifier matching Claude's facet shape.
5. Add rollups and CLI views.

The key design rule: metadata should be deterministic; facets should be explicit model judgments with evidence links.

## Claude Usage Report Inspiration

The existing HTML report at `.dotfiles/claude/.claude/usage-data/report.html` is useful because it turns raw session/facet data into a human-readable coaching report. The strongest product ideas to reuse are not the visual style, but the report structure and evidence-to-action flow.

Useful sections to adapt:

- `At a Glance`: four short narrative blocks: what is working, what is hindering, quick wins, ambitious workflows.
- `What You Work On`: clustered project/work categories with approximate session counts and concise descriptions.
- `How You Use Claude Code`: behavioral narrative describing the user's operating model, delegation style, quality bar, and recurring environment constraints.
- `Wins`: positive patterns, not only friction.
- `Where Things Go Wrong`: grouped friction clusters with examples and suggested mitigation.
- `Suggested CLAUDE.md Additions`: concrete instruction changes with rationale and copyable text.
- `Existing Features to Try`: hooks, skills, MCP, slash commands, or workflows recommended based on observed behavior.
- `New Usage Patterns`: copyable prompts/workflow recipes tied to specific friction evidence.
- `On the Horizon`: ambitious automation ideas derived from repeated patterns.

Useful metrics to implement:

- messages/sessions/date range
- lines added/removed
- files modified
- messages per day
- goal category distribution
- top tools used
- languages touched
- session type distribution
- user response time distribution
- parallel session overlap / multi-agent usage
- tool error categories
- primary success categories
- outcome distribution
- friction categories
- inferred satisfaction

High-value derived insights:

- "You use agents as autonomous engineering orchestrators" style summaries.
- "Terse directive, high-trust delegation, aggressive review enforcement" interaction style summaries.
- "Complex stateful environment causes friction" environment summaries.
- "Review/dogfood catches first-pass bugs" closure-quality summaries.
- "Output-token limit during QA suggests writing reports to files" workflow recommendations.
- "Pre-flight env check before browser/dev work" recurring mitigation.
- "Right-size workflow to task" to prevent over-process on trivial work.

Graph-backed implementation idea:

```text
insight_report
- id
- range_start
- range_end
- source_agents
- generated_at
- summary_json
- sections_json
- confidence

insight_recommendation
- id
- kind: claude_md | skill | hook | workflow | mcp | prompt | automation
- title
- rationale
- suggested_text
- evidence_count
- status
```

Relations:

```text
insight_report -> contains -> insight
insight_report -> recommends -> insight_recommendation
insight_recommendation -> supported_by -> friction_event
insight_recommendation -> supported_by -> session
insight_recommendation -> suggests_skill -> skill_candidate
```

Important product lesson:

The report works because it mixes:

- descriptive identity: "how you use agents"
- objective counters: tools, sessions, outcomes
- positive reinforcement: wins and capabilities
- friction clusters: what repeatedly costs time
- actionable artifacts: copyable CLAUDE.md snippets, prompts, hooks, skills
- future roadmap: ambitious workflows

`agentctl insights report` should do the same, but with graph evidence links and provider comparison across Claude and Codex.

## Intervention Lifecycle: Skills, Hooks, And Instruction Changes

Recommendations should not stop at "try this skill/hook/CLAUDE.md addition." They should become tracked interventions with measurable side effects.

Core idea:

```text
observed friction -> recommendation -> installed intervention -> monitored effect -> keep/change/remove
```

Intervention types:

- `skill`: new or updated `SKILL.md`
- `hook`: Claude/Codex lifecycle hook
- `instruction`: `CLAUDE.md`, `AGENTS.md`, repo guidance, global rules
- `slash_command`: reusable command workflow
- `mcp`: new structured integration
- `workflow`: process change such as QA-to-file, preflight checks, spec-first tests
- `automation`: cron/daemon/CI watcher/self-improve loop

Potential records:

```text
intervention
- id
- kind
- name
- path
- version_hash
- source_recommendation
- created_at
- installed_at
- removed_at
- status: proposed | installed | active | paused | removed | superseded
- expected_effect
- target_metrics
- rollout_scope
- owner_notes
```

```text
intervention_observation
- intervention
- window_start
- window_end
- metric
- baseline_value
- observed_value
- delta
- confidence
- sample_size
- interpretation
```

Useful relations:

```text
insight_recommendation -> materialized_as -> intervention
intervention -> modifies -> file
intervention -> targets -> friction_kind
intervention -> targets -> skill_candidate
intervention -> observed_in -> session
intervention -> associated_with -> workflow_epoch
intervention -> supersedes -> intervention
intervention_observation -> evaluates -> intervention
```

What to monitor:

- Did targeted friction decrease?
- Did new friction appear?
- Did interruptions/corrections decrease?
- Did tool failures decrease or just move elsewhere?
- Did token/cache usage improve or regress?
- Did sessions get shorter or longer?
- Did verification gaps close?
- Did post-feature fix chains decrease?
- Did agent over-process increase because the instruction/hook was too heavy?
- Did hooks block useful feedback loops too aggressively?

Examples:

1. Add a `qa-verify` skill.
   - Expected effect: fewer missed browser bugs and fewer giant inline QA responses.
   - Monitor: QA report files created, output-token-limit events, browser bug follow-up fixes, verification command count.

2. Add a dev-server preflight hook.
   - Expected effect: fewer stale process/port/env blockers.
   - Monitor: environment blocker events, port conflict commands, dev server restart loops, hook false positives.

3. Add "right-size workflow" instruction.
   - Expected effect: fewer over-process/wrong-approach events on trivial tasks.
   - Monitor: brainstorming/planning skill usage on tiny edits, user corrections like "just do X", task duration for trivial sessions.

4. Add self-review before completion.
   - Expected effect: fewer review-driven rework cycles.
   - Monitor: review findings after completion, fix commits within 1-7 days, typecheck/lint misses, user corrections after "done".

Important side-effect tracking:

- A hook can reduce one class of errors while adding latency or blocking legitimate work.
- A skill can improve quality but increase token/context cost.
- A CLAUDE.md rule can help Claude but hurt Codex, or vice versa.
- A workflow can reduce bugs but increase ceremony for small tasks.

Report shape:

```bash
agentctl interventions list
agentctl interventions show qa-verify
agentctl interventions impact --since=30
agentctl interventions regressions
agentctl interventions candidates
```

Output should classify each intervention:

- `working`: target metric improved with no major regression.
- `mixed`: target improved but side effects appeared.
- `no_effect`: no measurable movement.
- `regressed`: target worsened or new friction increased.
- `insufficient_data`: not enough sessions/events yet.

This turns `agentctl` into a closed-loop self-improvement system:

1. Discover repeated friction.
2. Suggest a concrete skill/hook/instruction.
3. Track whether it was installed.
4. Measure before/after behavior.
5. Recommend keeping, editing, or removing it.

## Onboarding And Skill Install Setup

Near-term goal: make guidance tracking part of the install/onboarding path, especially for users who are not already tracking their global agent harness in Git.

The `npx`/skill install flow should check and optionally set up:

- project-local `AGENTS.md` / `CLAUDE.md`
- repo-local skills/commands/hooks
- global Claude guidance: skills, hooks, settings, commands
- global Codex guidance: skills, rules, config
- plugin/cache guidance as imported read-only sources
- dotfiles or other Git-tracked repository for global guidance

If global guidance is not Git-tracked:

- ingest it anyway with weak evidence quality
- warn that proactive optimization will be less reliable
- recommend Git tracking through a dotfiles repository
- offer an explicit setup path to create or connect that tracked source
- avoid moving or rewriting personal config without approval

Desired installer/onboarding behavior:

```bash
npx agentctl install
agentctl onboarding check
agentctl guidance doctor
```

Expected output style:

```text
Guidance sources
✓ project AGENTS.md tracked
✓ global dotfiles guidance tracked
⚠ ~/.codex/rules/default.rules is untracked
⚠ ~/.claude/settings.json is untracked
→ Recommendation: track global guidance in dotfiles before enabling proactive harness optimization
```

This should become part of tonight's goal: installation should not only install the skill, but also prepare the guidance evidence foundation needed for future self-improvement.

## Additional Product Directions

### A/B Or Epoch-Based Workflow Experiments

Interventions should support lightweight experiments:

```text
experiment
- name
- hypothesis
- baseline_window
- treatment_window
- changed_interventions
- target_metrics
- guardrail_metrics
- result
```

Examples:

- Superpowers vs GSD workflow.
- With vs without `qa-verify`.
- Hook enabled only for one repo/worktree.
- Codex review before merge vs after merge.
- Spec-first tests vs implementation-first.

This answers: did the workflow actually improve quality, speed, or token/cache cost?

### Intervention Blast Radius

Every intervention needs scope:

- global
- provider-specific: Claude, Codex
- repo-specific
- project/worktree-specific
- task-type-specific
- model-specific

This prevents a rule that helps one repo from damaging another. Example: "always use browser QA" may be right for frontend work and wrong for small CLI edits.

### Instruction Conflict Detection

`CLAUDE.md`, `AGENTS.md`, skills, hooks, and system/developer rules can conflict.

Potential insight:

```text
instruction_conflict
- instruction_a
- instruction_b
- conflict_kind
- observed_sessions
- evidence
```

Examples:

- "Always brainstorm before creative work" conflicts with "skip ceremony for trivial edits."
- "Use worktrees for feature work" conflicts with "do not over-process small tasks."
- "Use concise answers" conflicts with "write exhaustive QA report inline."

This could explain wrong-approach and over-ceremony events.

### Skill Coverage Map

Map recurring work/friction to skills:

```text
task_pattern -> has_skill? -> skill_used? -> outcome_delta
```

Questions:

- Which recurring tasks have no skill?
- Which skills exist but are not invoked?
- Which skills are invoked but correlate with worse outcomes?
- Which skills should be split, merged, deprecated, or narrowed?

This turns skill management from file hygiene into evidence-backed product tuning.

### Hook False Positive/False Negative Tracking

Hooks need special monitoring:

- false positive: hook blocks a valid action.
- false negative: hook allowed an action that later caused friction.
- latency cost: hook added too much waiting.
- noisy output: hook polluted the agent context.

Useful metrics:

- hook invocations
- blocked count
- user override count
- repeated bypasses
- follow-up corrections after hook ran
- sessions where hook output caused context bloat

### Agent/Model Routing Insights

Track which agent/provider/model works best for which work:

- Claude vs Codex for review
- Claude vs Codex for implementation
- subagent vs main agent
- high reasoning vs low reasoning
- browser-capable vs terminal-only

Potential CLI:

```bash
agentctl insights routing
agentctl insights model-fit
agentctl insights provider-compare
```

Output: "Codex review catches React stale-closure bugs; Claude browser QA catches layout regressions; main agent should own orchestration."

### Cost Of Human Intervention

Measure when user had to step in:

- interrupt
- redirect
- correction
- clarification
- approval
- manual command
- manual merge/push

Then compute:

- interventions per completed task
- correction-to-completion time
- user response delay
- sessions blocked waiting for user
- high-autonomy sessions with low user intervention

This differentiates "agent did a lot" from "agent saved attention."

### Memory And Preference Drift

Track whether agent behavior matches user preferences over time:

- user repeatedly says "concise"
- user repeatedly rejects over-planning
- user asks for default pipeline progress
- user prefers files over inline walls of text

Then detect:

- preference learned
- preference forgotten
- preference contradicted by new instruction
- preference should become skill/hook/CLAUDE.md rule

### Artifact Quality

Track durable outputs, not only sessions:

- PRs
- commits
- plans
- specs
- reports
- screenshots
- QA files
- release notes
- issues

For each artifact:

- was it reused?
- was it corrected?
- did it lead to successful merge?
- did it create follow-up work?
- did it reduce future friction?

This helps separate productive verbosity from disposable output.

### Insight Explainability

Every recommendation should answer:

- What pattern triggered this?
- What evidence supports it?
- What metric should move?
- What side effects should we watch?
- When should we remove it?

This avoids turning `agentctl` into another vague analytics dashboard.

## Harness Layers From 10x Coding Agent Framing

The user's "10x Your Coding Agent by Fixing Its Environment" article gives a useful taxonomy for harness optimization:

- `perception`: what the agent can search and notice.
- `representation`: how legible code, diffs, logs, JSON, and outputs are.
- `verification`: how quickly the codebase pushes back.
- `boundary`: what the agent can safely touch.

This should become a first-class classification for Harness changes and recommendations.

Examples:

- `ripgrep`, `fd`, `fzf`: perception improvements.
- `bat`, `delta`, `jq`, focused snippets, structured CLI JSON: representation improvements.
- `tsgo`, `oxc`, `rs lint`, tests, CI log filtering: verification improvements.
- `git worktree`, `lazygit`, `zdiff3`, permissions, hooks, safe merge workflows: boundary improvements.

Why this matters:

- It avoids reducing agent improvement to prompt/guidance changes.
- It lets `agentctl` recommend environmental fixes, not just CLAUDE.md edits.
- It makes onboarding more concrete: install/check tools by layer.
- It gives proactive optimization a stable lens: identify weak layers in a repo/harness.

Potential CLI views:

```bash
agentctl harness doctor
agentctl harness layers
agentctl harness recommend --layer=verification
agentctl insights harness-impact
```

Potential report section:

```text
Harness Health
- Perception: good, rg/fd present, but search often hits generated artifacts.
- Representation: weak, JSON/log output often enters transcript unfiltered.
- Verification: mixed, typecheck exists but too slow; oxlint/tsgo candidate.
- Boundary: weak, worktree/dev-server conflicts recurring.
```

This bridges the insight system with setup/onboarding. `agentctl` can observe repeated friction and say which Harness Layer is likely weak.

## Terminal Automation As Agent Tooling

`wterm` suggests an important dogfooding path: render terminal sessions into browser-accessible DOM so another agent can inspect and drive terminal agents through the accessibility tree.

Reference:

- `vercel-labs/wterm`: terminal emulator for the web with DOM rendering, native selection/copy/find/accessibility, WebSocket PTY transport, and React/Vue packages.

Why it matters:

- It turns terminal sessions into inspectable UI, not opaque process output.
- `agent-browser` or similar browser automation can snapshot, click, and type into terminal-based agents.
- This can dogfood one agent with another: e.g. Codex/agent-browser driving Claude Code, or Claude driving OpenCode.
- It gives repeatable e2e tests for agent harness behavior such as branch guardrails, prompts, hooks, approvals, and progress UI.

Harness Layer mapping:

- `representation`: terminal state becomes DOM/a11y tree instead of raw ANSI output.
- `verification`: harness behavior can be tested end-to-end.
- `boundary`: tests can run in isolated worktrees/sandboxes with explicit controls.
- `perception`: the driving agent can inspect terminal state semantically.

Potential dogfood scenario:

```text
1. Start wterm PTY in an isolated worktree.
2. Launch Claude Code inside wterm.
3. Use agent-browser to snapshot the terminal.
4. Type a task that should trigger a guardrail, e.g. "edit this file on main".
5. Verify the hook blocks the action and the agent asks for override or creates a branch.
6. Store the transcript and result as Intervention Observation evidence.
```

Safety constraints:

- Run only in isolated checkouts/worktrees.
- Use scoped test credentials or no credentials.
- Use timeouts and token/process budgets.
- Allowlist commands for automated dogfood sessions.
- Record snapshots and terminal transcripts as evidence.
- Avoid unrestricted agent-recursive control until guardrails exist.

Local note:

- The local `claude` binary exists.
- In this shell, `cc` resolves to `/usr/bin/cc`, so dogfooding should call `claude` directly unless a shell alias/function is explicitly loaded.

Implemented tracer bullet:

- `agentctl dogfood terminal --scenario=agentctl-setup` serves a local wterm DOM terminal.
- The server streams a scripted terminal process to the browser over WebSocket and runs a scratch-HOME setup demo.
- The scenario demonstrates `agentctl --help`, `agentctl onboarding --json`, host-agent git tracking of `.claude`, `.codex`, and `.agents`, then a second onboarding check.
- The terminal transcript is persisted as `artifact` and the pass/fail result is persisted as `intervention_observation` when the local DB is reachable.
- This is intentionally not yet a free-running Claude driver or native PTY transport; it proves the wterm/browser evidence path before recursive agent control.

## Hosted Taste / Skill Hub Monetization Sketch

Command Code validates the market framing around "coding taste": agents that learn preferences, auto-generate project skills, and share taste across teams. The opportunity for `agentctl` should not be "another coding agent." It can be the evidence layer and registry behind taste:

- observe agent behavior across Claude, Codex, and other harnesses
- extract Taste Signals from corrections, accept/reject/edit patterns, interventions, and outcomes
- turn repeated patterns into Harness Learnings, Gotchas, skills, hooks, and guidance changes
- measure side effects after adoption
- share curated Harness Learnings through a hosted hub

Differentiation:

- agent-neutral: works across Claude, Codex, Command Code-like agents, and future tools
- graph-backed: recommendations cite sessions, commits, guidance revisions, stacks, workflows, and observed impact
- harness-focused: improves perception, representation, verification, and boundary, not just prompts
- community loop: agents can draft Learning Feedback issues/PRs, while users approve publication
- measurable taste: taste is not just memory/preferences; it is behavior plus outcomes plus side effects

Potential monetizable product:

```text
Local agentctl: private graph, harness doctor, local learning registry
Hosted hub: shared Harness Learnings, Gotchas, Stack guides, skill packs, adoption telemetry, team registry
```

Possible paid surfaces:

- Team Learning Registry: shared private learnings across a team/org.
- Taste Packs: curated stack/workflow packs, e.g. TypeScript+Bun+React, Effect+SurrealDB, Browser QA.
- Harness Doctor Pro: compare team harness health against community baselines.
- Adoption Impact: measure whether a shared learning improved the team's local graph.
- Skill/Gotcha Marketplace: versioned skills, hooks, commands, and guidance snippets with evidence.
- Proactive Harness Optimization: agent-generated PRs to improve guidance/tooling, gated by review.

Key strategic bet:

The durable asset is not raw telemetry. It is curated, evidence-backed know-how about how agents should work in specific stacks and workflows.

## Tracer Bullet V1

Near-term implementation should stay narrow:

```text
Harness Doctor + One Learning Loop
```

Scope:

1. Scan Guidance Sources.
   - project-local guidance
   - global guidance
   - Git-tracked vs weak evidence

2. Detect Stack and Agent Tooling.
   - declared stack from repo files
   - observed stack from sessions/tools
   - installed tools
   - repo-exposed scripts and CI

3. Use existing Insights.
   - whether agents actually use available guidance/tooling
   - repeated friction around missing/unused/noisy feedback loops

4. Produce one Harness Doctor report.
   - perception
   - representation
   - verification
   - boundary

5. Produce one local Harness Learning candidate.
   - evidence-backed
   - local-only
   - includes applicable Stack, Workflow, Gotchas, and suggested Intervention

6. Track one Intervention.
   - user applies guidance/tooling/workflow change
   - later sessions become the after-window
   - produce an Intervention Observation

Out of scope for tracer bullet:

- hosted Shared Learning Hub
- Public Taste Cards
- marketplace
- automatic publishing
- multi-user federation
- broad ontology completion

Success criterion:

`agentctl` can inspect a real repo/harness, identify one weak Harness Layer, suggest one evidence-backed local learning, and later measure whether the applied intervention changed observed agent behavior.

First seeded follow-up loop:

Use Claude's existing report suggestion as seed evidence:

```text
Persist QA findings to files, not chat.
```

Why this first:

- It already appears in the Claude usage report as a concrete recommendation.
- It ties to output-token-limit friction during QA/verification sessions.
- It has a clear Workflow: browser QA / multi-step verification.
- It has clear Harness Layers: representation and verification.
- It can become a concrete Guidance/skill Intervention.
- It has measurable before/after signals.

Candidate Harness Learning:

```text
title: Persist QA findings to files
problem: Long browser QA and verification sessions can hit output limits or bury findings in chat.
pattern: Write detailed findings to qa-report.md and summarize only counts/blockers inline.
workflow: browser_qa, verification
harness_layer: representation, verification
applies_when: multi-step QA, browser testing, visual/regression checks
avoid_when: tiny one-off checks
gotchas: final response and PR body must link the report path; blocking bugs still need inline mention
suggested_intervention: add qa-verify skill or AGENTS.md guidance
```

Measures:

- output-token-limit events around QA sessions
- final answers that include report path
- QA report artifacts created
- browser/dogfood findings reused in PRs
- follow-up bugs after QA sessions
- user corrections saying findings were missing or too verbose

First dogfood tracer bullet:

Use the main-branch guardrail because it is easier to test locally and clearly demonstrates escalation:

```text
Do not let agents work directly on main in multi-agent projects.
```

Why this first:

- The behavior is easy to simulate and verify.
- The risk is high enough to justify escalation.
- The expected outcome is concrete: agents should use feature branches/worktrees.
- The intervention ladder is clear: advisory guidance -> hook guardrail.
- Side effects are observable: false positives, blocked legitimate hotfixes, user bypasses.

Candidate Harness Learning:

```text
title: Block main-branch edits in multi-agent projects
problem: Agents can ignore guidance and work directly on main, creating coordination and merge risk.
pattern: Start with guidance that requires feature branches/worktrees; escalate to a scoped hook if violations continue.
workflow: multi_agent_development, merge_flow
harness_layer: boundary
risk: branch_safety/high
applies_when: multiple agents, shared repo, non-trivial changes
avoid_when: explicit hotfix or single-user throwaway repo
gotchas: allow explicit user override; do not block read-only commands; scope to write/commit/push actions
suggested_intervention: PreToolUse hook or equivalent branch guard
```

Measures:

- sessions started on main for non-trivial work
- edit/write/commit/push attempts on main
- user overrides
- false positives
- feature branch/worktree adoption after warning
- user corrections about branch safety

Main-branch violation definition:

A violation is a write-risk action on `main` or `master` during non-trivial or multi-agent work.

Count as violations:

- file edit/write
- `git commit`
- `git push`
- destructive git operations
- package/schema/config changes

Do not count as violations:

- read-only commands
- `git status`, `git diff`, `rg`, `cat`, `sed`, `ls`
- explicit user-approved hotfix
- docs-only work can warn rather than block

## Intervention Strength And Escalation

Agents should not blindly choose AGENTS.md vs skill vs hook. `agentctl` should recommend the least forceful intervention likely to work, then escalate only when observations show the behavior persists.

Intervention Strength levels:

- `advisory`: docs, AGENTS.md/CLAUDE.md guidance, preference text.
- `workflow`: skill, command, checklist, reusable workflow.
- `automation`: doctor, preflight script, generated task, scheduled check.
- `guardrail`: hook, blocker, policy check, warning that interrupts flow.
- `hard_boundary`: permissions, sandbox, branch protection, CI enforcement.

Example:

```text
Taste Signal:
Do not work on main in multi-agent projects.

Advisory Intervention:
Add AGENTS.md rule: use worktrees/feature branches.

Observation:
Agents still edit or commit on main.

Escalation:
Add PreToolUse hook that blocks writes/commits on main unless explicitly overridden.

Side effects to monitor:
false positives, hotfix friction, user bypasses, blocked legitimate commands.
```

This is how local taste becomes enforceable without overbuilding controls too early.
