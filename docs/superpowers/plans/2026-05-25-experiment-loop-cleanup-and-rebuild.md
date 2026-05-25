# Experiment-Loop Cleanup + Rebuild

**Date:** 2026-05-25
**Branch (origin):** feat/skill-source-and-catalog-resolver
**Status:** ready for Phase A
**Supersedes:** writer-only orphans introduced 2026-05-10 → 2026-05-20

---

## Why this plan exists

User shared the "look across sessions, identify repeated workflows, package smallest useful skill/subagent/automation" prompt pattern (popularized by self-improving Codex). ax already ingests the substrate the prompt asks the LLM to grep for, so the 10x is to back it with deterministic queries + verdict tracking instead of LLM guesses.

Audit found 16 tables in `schema/schema.surql` that are write-only orphans from prior attempts at this loop. The CLI surface meant to consume them (`axctl interventions list|show|impact|regressions|candidates` at `src/cli/index.ts:641-656`) is a broken stub that queries columns the schema does not define.

## Diagnosis (from archaeology + adversarial reviews)

All 5 prior clusters died at the same step:

| Cluster | Intro | Plan doc | What landed | What stalled |
|---|---|---|---|---|
| Learning registry | 2026-05-12 (6227baf) | `2026-05-11-graph-insight-backlog-completion.md` | 9 tables + writer | reader/CLI never wired |
| Delivery telemetry | 2026-05-15 (3a811e1) | `2026-05-15-graph-explorer-delivery-telemetry.md` | 3 tables, classification logic | ingest writer + reader never wired |
| Harness interventions | 2026-05-20 (e91f03a) | ADR 0004 | schema + writer + CLI stub | hook events never streamed; CLI never reads real data |
| Legacy self-improve | 2026-05-10 (512032f) | - | filesystem import | no consumer |
| Recommendation | gradual | - | writer in derive-signals | no consumer |

**Common shape:** schema → writer → CLI stub → silence. Author kept laying foundation tables; consumer side never crossed the threshold.

**Architectural root cause:** strong ingest seam, weak query seam. Each feature built isolated write paths assuming readers would emerge organically. None did. No CI gate enforced "reader ships with writer."

## Reviews consulted

| Reviewer | Verdict | Key insight |
|---|---|---|
| general-purpose (adversarial) | 3 blockers | verdict mechanics undefined; evidence_refs JSON forecloses queries; accept-without-scaffold breaks loop |
| codex-rescue (adversarial) | request changes | **opportunity-denominator table** (resolves verdict blocker); typed per-form payloads (one flat proposal is wrong shape); kill list missed live writers (need sequenced deletion) |
| archaeology (Explore) | - | original intent + plan docs recoverable; salvage feedback_case_type/result as backtest engine |

All three converged on: typed record links over JSON, per-form payloads, CI gate on reader-ships-with-writer.

---

## V2 schema (9 new tables, 15 dropped)

### New

```sql
-- 1. Polymorphic shortlist
DEFINE TABLE proposal SCHEMAFULL;
DEFINE FIELD form           ON proposal TYPE string;
  -- skill | subagent | hook | guidance | automation
DEFINE FIELD title          ON proposal TYPE string;
DEFINE FIELD hypothesis     ON proposal TYPE string;
DEFINE FIELD dedupe_sig     ON proposal TYPE string;
  -- hash of normalized trigger pattern; prevents re-proposing same thing
DEFINE FIELD frequency      ON proposal TYPE int;
DEFINE FIELD confidence     ON proposal TYPE string;  -- low|medium|high
DEFINE FIELD status         ON proposal TYPE string DEFAULT 'open';
  -- open | accepted | rejected | superseded
DEFINE FIELD reject_reason  ON proposal TYPE option<string>;
  -- includes 'not_worth_packaging' (the tweet's "skip")
DEFINE FIELD baseline       ON proposal TYPE option<string>;
  -- JSON snapshot frozen AT created_at, NOT accept-time (Hawthorne fix)
DEFINE FIELD created_at     ON proposal TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at     ON proposal TYPE option<datetime>;
DEFINE INDEX proposal_dedupe_uq ON proposal FIELDS dedupe_sig UNIQUE;
DEFINE INDEX proposal_status_freq ON proposal FIELDS status, frequency;

-- 2-6. Per-form typed payloads (one table per real form)
DEFINE TABLE skill_proposal SCHEMAFULL;
DEFINE FIELD proposal           ON skill_proposal TYPE record<proposal>;
DEFINE FIELD trigger_pattern    ON skill_proposal TYPE string;
DEFINE FIELD suspected_gap      ON skill_proposal TYPE string;
DEFINE FIELD proposed_behavior  ON skill_proposal TYPE string;
DEFINE FIELD expected_impact    ON skill_proposal TYPE option<string>;
DEFINE INDEX skill_proposal_uq ON skill_proposal FIELDS proposal UNIQUE;

DEFINE TABLE subagent_proposal SCHEMAFULL;
DEFINE FIELD proposal              ON subagent_proposal TYPE record<proposal>;
DEFINE FIELD bounded_role          ON subagent_proposal TYPE string;
DEFINE FIELD delegation_trigger    ON subagent_proposal TYPE string;
  -- pattern matching against Task tool calls (see opportunity below)
DEFINE FIELD example_task_patterns ON subagent_proposal TYPE array<string>;
DEFINE INDEX subagent_proposal_uq ON subagent_proposal FIELDS proposal UNIQUE;

DEFINE TABLE hook_proposal SCHEMAFULL;
DEFINE FIELD proposal      ON hook_proposal TYPE record<proposal>;
DEFINE FIELD event_name    ON hook_proposal TYPE string;  -- PreToolUse | PostToolUse | ...
DEFINE FIELD target_tool   ON hook_proposal TYPE option<string>;
DEFINE FIELD hook_command  ON hook_proposal TYPE string;
DEFINE INDEX hook_proposal_uq ON hook_proposal FIELDS proposal UNIQUE;

DEFINE TABLE guidance_proposal SCHEMAFULL;
DEFINE FIELD proposal       ON guidance_proposal TYPE record<proposal>;
DEFINE FIELD file_target    ON guidance_proposal TYPE string;
  -- e.g. "CLAUDE.md", "~/.claude/CLAUDE.md"
DEFINE FIELD section        ON guidance_proposal TYPE option<string>;
DEFINE FIELD suggested_text ON guidance_proposal TYPE string;
DEFINE INDEX guidance_proposal_uq ON guidance_proposal FIELDS proposal UNIQUE;

DEFINE TABLE automation_proposal SCHEMAFULL;
DEFINE FIELD proposal        ON automation_proposal TYPE record<proposal>;
DEFINE FIELD trigger_signal  ON automation_proposal TYPE string;
DEFINE FIELD schedule        ON automation_proposal TYPE option<string>;  -- cron expr
DEFINE FIELD action          ON automation_proposal TYPE string;
DEFINE INDEX automation_proposal_uq ON automation_proposal FIELDS proposal UNIQUE;

-- 7. Typed evidence edges (replaces JSON evidence_refs)
DEFINE TABLE cites_evidence TYPE RELATION FROM proposal TO friction_event|command_outcome|skill_candidate|hook_command_invocation|spawned;
DEFINE FIELD count ON cites_evidence TYPE int DEFAULT 1;
DEFINE FIELD ts    ON cites_evidence TYPE datetime DEFAULT time::now();
DEFINE INDEX cites_evidence_in  ON cites_evidence FIELDS in;
DEFINE INDEX cites_evidence_out ON cites_evidence FIELDS out;
-- Enables: SELECT * FROM friction_event WHERE id NOT IN (SELECT VALUE out FROM cites_evidence)

-- 8. Experiment (created on accept)
DEFINE TABLE experiment SCHEMAFULL;
DEFINE FIELD proposal       ON experiment TYPE record<proposal>;
DEFINE FIELD artifact       ON experiment TYPE option<record<skill>>;
  -- typed link for skill form
DEFINE FIELD artifact_path  ON experiment TYPE option<string>;
  -- for hook file / guidance file / automation script
DEFINE FIELD scaffolded_at  ON experiment TYPE option<datetime>;
DEFINE FIELD created_at     ON experiment TYPE datetime DEFAULT time::now();
DEFINE FIELD locked_verdict ON experiment TYPE option<string>;
  -- set at t+30 from user_verdict
DEFINE INDEX experiment_proposal_uq ON experiment FIELDS proposal UNIQUE;

-- 9. Opportunity (the verdict denominator)
DEFINE TABLE opportunity SCHEMAFULL;
DEFINE FIELD experiment    ON opportunity TYPE record<experiment>;
DEFINE FIELD matched_at    ON opportunity TYPE datetime;
DEFINE FIELD evidence      ON opportunity TYPE record;
  -- the friction_event/tool_call/spawned that matched the trigger
DEFINE FIELD was_addressed ON opportunity TYPE bool;
  -- did the artifact get invoked/applied near this match?
DEFINE INDEX opportunity_experiment_ts ON opportunity FIELDS experiment, matched_at;

-- 10. Checkpoint (decision support, never auto-verdict)
DEFINE TABLE checkpoint SCHEMAFULL;
DEFINE FIELD experiment   ON checkpoint TYPE record<experiment>;
DEFINE FIELD kind         ON checkpoint TYPE string;  -- t+7 | t+30 | t+90
DEFINE FIELD measured     ON checkpoint TYPE object;
  -- {built:bool, invoked:int, opportunities:int, addressed:int, friction_delta:number}
DEFINE FIELD suggested    ON checkpoint TYPE option<string>;
  -- algorithmic guess: adopted | ignored | regressed | no_longer_needed | partial
DEFINE FIELD user_verdict ON checkpoint TYPE option<string>;
  -- user confirms/overrides; NULL until reviewed
DEFINE FIELD observed_at  ON checkpoint TYPE datetime DEFAULT time::now();
DEFINE INDEX checkpoint_experiment_kind ON checkpoint FIELDS experiment, kind, observed_at;
```

### Dropped (15 tables, sequenced after writer removal)

`pattern_candidate, feedback_event, ask_outcome, adoption, gotcha, learning_match, learning_feedback, taste_signal, workflow, agent_tooling, recommendation, self_improve_run, harness_learning, intervention, intervention_observation`

### Kept (was on initial kill list)

- `stack` - project-profiling signal, useful evidence for derive-proposals scoring per project tech
- `skill_candidate` - closure stage detector, becomes evidence source for `skill_proposal` derivation
- `friction_event, diagnostic_event, command_outcome, hook_command_invocation, harness_hook_event, feedback_case_type, feedback_case_result, ask-outcome.ts classifier output` - all alive evidence sources

## Verdict math

```
at checkpoint kind=t+30 from experiment.created_at:
  opportunities = count(opportunity WHERE experiment=X AND matched_at > created_at)
  addressed     = count(opportunity WHERE ... AND was_addressed=true)

  if opportunities == 0:           suggested = no_longer_needed   (pattern self-resolved)
  elif addressed/opportunities > 0.6: suggested = adopted
  elif addressed/opportunities < 0.1: suggested = ignored
  else:                            suggested = partial

  user_verdict left NULL until user runs `axctl improve verdict <id>`.
  At t+30, if user_verdict still NULL after 7d, accept suggested as locked_verdict.
```

Algorithm proposes, human decides. Decision support, not auto-judgment.

## Per-form opportunity definitions

| Form | Trigger pattern source | was_addressed=true when |
|---|---|---|
| skill | `friction_event.kind` matching `skill_proposal.trigger_pattern` regex over text/labels | `invoked` edge to the created skill exists within ±2 turns of matched_at |
| subagent | `spawned` edge (Task tool call) where input matches `subagent_proposal.delegation_trigger` | `spawned.tool='Task'` AND payload subagent_type = the created one (not 'general-purpose') |
| hook | `tool_call` matching `hook_proposal.target_tool` | `hook_command_invocation` for that tool_call with hook_name matching the created hook |
| guidance | `friction_event` (e.g. corrections) where suggested_text would have applied | check whether `guidance_proposal.file_target` was modified between match and now |
| automation | scheduled trigger fires | `tool_call` or output evidence shows automation ran |

## Pipeline

```
INGEST (existing)              → evidence: friction_event, command_outcome,
                                  skill_candidate, hook_command_invocation, spawned, stack
       ↓
DERIVE-PROPOSALS (new)         → for each evidence cluster matching frequency≥N
                                  AND no existing skill/hook/guidance covers it
                                  → upsert proposal + form-specific payload + cites_evidence
                                  → freeze baseline at created_at
       ↓
CLI: axctl improve list        → ranked shortlist (frequency × confidence / cost)
     axctl improve show <id>   → proposal + payload + cited evidence
     axctl improve accept <id> → create experiment, scaffold artifact file
                                  (e.g. ~/.claude/skills/<name>/SKILL.md stub)
     axctl improve reject <id> --reason → status=rejected (dedupe blocks re-proposal)
       ↓
DERIVE-OPPORTUNITIES (new)     → each ingest, for active experiments,
                                  scan window for trigger matches, upsert opportunity rows
                                  with was_addressed computed per form definition
       ↓
DERIVE-CHECKPOINTS (new)       → at experiment.created_at + 7d/30d/90d,
                                  aggregate opportunities → checkpoint row with suggested verdict
       ↓
CLI: axctl improve verdict <id> → user confirms/overrides suggested → locked_verdict
                                  rejected/ignored verdicts feed back into derive-proposals
                                  scoring (downweight similar patterns)
       ↓
LAUNCHD (new plist)            → weekly: `axctl improve checkpoint`
```

---

## Execution phases

### Phase A - Delete dead writers (schema untouched)

DB still works throughout. Each sub-step is its own commit.

| Step | File | Action | Verify |
|---|---|---|---|
| A1 | `src/ingest/learning-registry.ts` | Delete whole file | `bun typecheck` |
| A2 | `src/ingest/pipeline.ts` | Remove learning-registry stage | `bun typecheck` + `bun test` |
| A3 | `src/ingest/legacy-self-improve.ts` | Delete whole file | `bun typecheck` |
| A4 | `src/cli/index.ts:597` | Unwire legacy-self-improve from CLI | `bun typecheck` |
| A5 | `src/ingest/derive-signals.ts:964-970` | Drop recommendation writer | `bun typecheck` + `bun test` |
| A6 | `src/ingest/harness.ts:82-181` | Drop writers for harness_learning, intervention, intervention_observation, agent_tooling. Keep `stack` writer (line 82) and `buildProjectHarnessReport` (will repoint in Phase C). | `bun typecheck` + `bun test` |
| A7 | `src/dogfood/wterm.ts:382-410` | Drop intervention_observation overload. Defer dogfood_run table to Phase C. | `bun typecheck` + `bun test` |
| A8 | `src/cli/index.ts:641-656` | Delete broken `axctl interventions` handler | `bun typecheck` + `axctl --help` |

### Phase B - Drop dead schema + add new

Single migration. After Phase A merged.

| Step | Action |
|---|---|
| B1 | Append `REMOVE TABLE` statements for the 15 dead tables to `schema/schema.surql` |
| B2 | Add 10 new `DEFINE TABLE` blocks (proposal + 5 form payloads + cites_evidence + experiment + opportunity + checkpoint) |
| B3 | Apply via `scripts/apply-schema.sh` |
| B4 | Verify with `axctl doctor` (or equivalent) |

### Phase C - Build new pipeline

Each sub-step shippable independently.

| Step | What |
|---|---|
| C1 | `src/derive/proposals.ts` writer. Reads evidence, computes dedupe_sig, snapshots baseline at created_at, upserts proposal + form payload + cites_evidence edges |
| C2 | `axctl improve list` + `show` (read-only CLI, surfaces proposals) |
| C3 | `axctl improve accept <id>` - creates experiment + scaffolds skill stub (or hook file / guidance edit / automation script). Records `scaffolded_at` |
| C4 | `axctl improve reject <id> --reason` |
| C5 | `src/derive/opportunities.ts` - per-form trigger matcher; populates `opportunity` rows |
| C6 | `src/derive/checkpoints.ts` - computes suggested verdict from opportunity aggregates |
| C7 | `axctl improve checkpoint` (manual + automatable) |
| C8 | `axctl improve verdict <id>` (user confirms suggested) |
| C9 | launchd plist `com.necmttn.ax-checkpoint`, weekly |
| C10 | Dashboard view at `src/dashboard/web/src/routes/improve.tsx` |
| C11 | Repoint `buildProjectHarnessReport` → emits proposal rows instead of dead tables |
| C12 | New `dogfood_run` table to replace wterm's intervention_observation overload |

### Phase D - CI gate (root-cause fix)

| Step | What |
|---|---|
| D1 | `scripts/check-table-coverage.ts` - for each `UPSERT <table>` or `CREATE <table>` in src/, require matching `SELECT FROM <table>` in src/cli/, src/dashboard/, or src/queries/. Hard fail. |
| D2 | Grandfather list for existing tables with no reader yet (managed allowlist, must shrink) |
| D3 | Wire into `bun run check:cli-reference` chain in `package.json` |
| D4 | Run on existing codebase, confirm Phase A removed all violations |

---

## Open / deferred

- **`dogfood_run` table shape** (Phase C12) - wterm currently jams test results into intervention_observation with `intervention=NONE`. New table needs: `scenario`, `driver`, `status`, `setup_verified`, `timed_out`, `notes`. Defer details until C12.
- **Cost model for proposal ranking** - adversarial review flagged: frequency alone ranks cheap-low-impact wins over expensive-high-impact ones. Defer until we have empirical data on which forms users actually accept.
- **Cross-experiment confounding** - multiple concurrent experiments → friction delta attribution is ambiguous. Mitigated by opportunity-denominator approach (per-experiment trigger matching), but worth revisiting at C6.

## Salvaged design ideas (from archaeology)

- **Draft-only local registry** (Cluster A) → `proposal.status='open'` is intrinsically local; no auto-publish path planned
- **Ask-to-outcome linking** (Cluster B) → `ask-outcome.ts` classifier becomes evidence source for guidance-form proposals
- **Deterministic backtests** (Cluster C, ADR 0004) → reuse alive `feedback_case_type`/`feedback_case_result` as opportunity matcher engine (Phase C5)
- **Plan docs preserved** as historical context - do not delete: `2026-05-11-graph-insight-backlog-completion.md`, `2026-05-15-graph-explorer-delivery-telemetry.md`, ADR 0004

## Locked decisions

| Decision | Choice | Source |
|---|---|---|
| Per-form payload shape | Separate typed tables per form | user 2026-05-25 |
| Accept behavior | Always scaffold artifact file | user 2026-05-25 |
| Subagent form | Include now (use `spawned` edges as opportunity signal) | user 2026-05-25 |
| CI gate strictness | Hard fail on missing reader | user 2026-05-25 |

---

## Status tracker

| Phase | Status | Commit/PR |
|---|---|---|
| A1 | done | 892b877 |
| A2 | done | 892b877 |
| A3 | done | 086a6bc |
| A4 | done | 086a6bc |
| A5 | done | 740744a |
| A6 | done | b067f1a |
| A7 | done | c73b99f |
| A8 | done | 3a8679d |
| B1-B4 | done | 1f8fec6 |
| C1 | done | 0eebefc |
| C2 | done | aae9bc9 |
| C3 | done | f96d181 |
| C4 | done | f96d181 |
| C5 | done | c44cca9 |
| C6 | done | 785c395 |
| C7 | done | 785c395 |
| C8 | done | 785c395 |
| C9 | done | a984e15 |
| C10 | api-done; react-followup | dce0188 |
| C11 | done | (pending commit) |
| C12 | pending | - |
| D1 | done | 4027070 |
| D2 | done | 4027070 |
| D3 | done | 4027070 |
| D4 | done | 4027070 |
