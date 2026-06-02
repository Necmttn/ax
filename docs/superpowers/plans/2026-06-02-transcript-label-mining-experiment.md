# Transcript Label Mining Experiment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a bounded label-mining experiment that turns local transcripts into reviewed, graph-backed, vector-searchable classifier training data without brute-forcing raw LLM classification.

**Architecture:** Mine high-precision weak labels from event windows, attach embedding neighbors for review expansion, promote only reviewed rows into graph facts, and expose product/service read paths for self-improvement agents. Model layers are advisory until promotion gates pass; product behavior consumes graph facts and reviewed evidence, not raw classifier confidence.

**Tech Stack:** Bun 1.3, TypeScript strict, Effect beta v4, SurrealDB 3.x, Python/uv for classifier package helpers, existing `apps/axctl/src/classifiers`, `packages/ax-classifier-session-sections`, `packages/schema/src/schema.surql`, `@ax/lib`, and existing CLI/package-operations test patterns.

---

## Experiment Contract

### Product Deliverable

At the end, ax should have a product-embeddable label-mining loop:

```text
transcript turns + tool context
  -> deterministic weak label candidates
  -> embedding nearest-neighbor expansion
  -> bounded active review queue
  -> reviewed label facts
  -> classifier graph facts + vector index rows
  -> self-improve agent queries
```

The self-improve agent should be able to ask:

- Which repeated user corrections need review?
- Which reviewed correction/direction/verification patterns have nearest transcript neighbors?
- Which graph facts are promotion-safe?
- Which patterns are only weak/advisory and must not mutate guidance?
- Which reviewed labels improved model or graph usefulness metrics?

### Success Metrics

Run the experiment on a fixed transcript window, then report these metrics in
`.ax/experiments/transcript-label-mining-current.json`.

Hard success gates:

- Candidate mining emits at least `200` weak label candidates from real transcripts.
- At least `40` candidates are selected for review queue export.
- Review queue diversity has at least `4` label families represented:
  `correction`, `direction`, `verification`, `approval_or_rejection`, or `workflow_state`.
- High-precision deterministic seed audit precision is at least `0.85` on the reviewed sample.
- Weak-label-to-reviewed promotion false-positive rate is at most `0.15`.
- Nearest-neighbor expansion finds at least `2` unreviewed neighbors for at least `50%` of accepted reviewed labels.
- Graph projection writes at least `1` fact per accepted reviewed row and preserves evidence paths.
- Vector rows exist for every accepted reviewed row.
- Product query returns at least `10` promotion-safe graph facts with evidence and nearest-neighbor explanations.

Soft success gates:

- SetFit or SVM helper improves candidate prioritization versus deterministic-only ordering by at least `10%` precision@20 on reviewed rows.
- Review queue deduplication reduces near-duplicate review rows by at least `25%`.
- No raw model output is promoted without review.

### Iteration Rules

The executing agent must stop after the first satisfied stop condition:

- Maximum `8` implementation iterations.
- Maximum `2` expensive model runs.
- Maximum `1` SetFit robustness run unless metrics show a concrete reviewed-data gain.
- Maximum `500` mined candidate rows per iteration.
- Maximum `80` review rows per batch.
- Stop if two consecutive iterations improve none of:
  `review_precision`, `accepted_label_count`, `neighbor_recall`, `graph_fact_count`, or `product_query_result_count`.
- Stop immediately if privacy guards fail, schema writes are non-idempotent, or product queries cannot distinguish reviewed facts from weak labels.

Each iteration must commit independently and append one experiment entry to the active goal doc.

### Failure Cases Defined Up Front

Treat any of these as experiment failure, not a reason to keep tuning:

- Deterministic candidates are mostly control/wrapper/developer text.
- Candidate precision on reviewed rows is below `0.65`.
- Accepted reviewed rows cannot be traced back to transcript evidence paths.
- Nearest-neighbor explanations point mostly to unrelated sessions.
- Graph facts lack `source_kind`, `predicate`, reviewed status, or evidence edges.
- Vector rows cannot be joined back to graph facts.
- The self-improve query cannot separate:
  reviewed promotion-safe facts, weak labels, rejected labels, and model-only candidates.
- Model retraining improves label F1 but does not improve graph usefulness or review throughput.
- Any command mutates guidance, skills, hooks, or agent files from weak/model-only labels.

### Promotion Rules

Allowed to promote:

- Human-reviewed accepted rows.
- Deterministic replay rows that have explicit reviewed boundary evidence.
- Graph facts with evidence edges and reviewed/provenance metadata.

Not allowed to promote:

- Raw SetFit labels.
- Raw embedding/SVM labels.
- Weak labels without review.
- LLM-suggested labels without review.

---

## File Structure

- Create `apps/axctl/src/classifiers/label-mining.ts`
  - Pure candidate mining, candidate ids, metrics, and projection helpers.
- Create `apps/axctl/src/classifiers/label-mining.test.ts`
  - Unit tests for deterministic seeds, stop gates, promotion gates, and graph/vector rows.
- Create `apps/axctl/src/classifiers/label-mining-service.ts`
  - Effect service for running mining reports over persisted transcripts.
- Create `apps/axctl/src/classifiers/label-mining-service.test.ts`
  - Fake DB tests for service read/write behavior.
- Modify `apps/axctl/src/cli/index.ts`
  - Add `classifiers label-mining` subcommand.
- Create `apps/axctl/src/cli/classifiers-label-mining.test.ts`
  - CLI routing and JSON/text rendering tests.
- Modify `packages/schema/src/schema.surql`
  - Add label mining candidate/review/vector tables if current graph tables cannot represent them cleanly.
- Modify `packages/schema/src/schema.test.ts`
  - Schema coverage for any new tables and indexes.
- Create `packages/ax-classifier-session-sections/label_mining_priority.py`
  - Optional Python helper for embedding/SVM prioritization only.
- Create `packages/ax-classifier-session-sections/label_mining_priority_test.py`
  - Tests for prioritization metrics and no-promotion behavior.
- Modify `packages/ax-classifier-session-sections/ax.classifier.json`
  - Add package operation entries for mining, prioritization, graph projection, and usefulness report.
- Update `docs/superpowers/goals/2026-05-30-setfit-session-section-experiments-goal.md`
  - Add one checkpoint entry per iteration.

---

## Data Model

Use these schemas for experiment artifacts even if the final implementation maps them into existing graph tables.

### Candidate Artifact

```ts
export interface TranscriptLabelCandidate {
    readonly id: string;
    readonly source_kind: "transcript_label_mining";
    readonly subject_type: "event_window";
    readonly subject_id: string;
    readonly session_id: string;
    readonly turn_id: string;
    readonly previous_assistant_turn_id?: string;
    readonly label_family: "correction" | "direction" | "verification" | "approval_or_rejection" | "workflow_state" | "none";
    readonly target: string;
    readonly weak_label: string;
    readonly weak_confidence: number;
    readonly weak_sources: readonly string[];
    readonly evidence_paths: readonly string[];
    readonly excerpt: string;
    readonly previous_assistant_excerpt?: string;
}
```

### Reviewed Label Artifact

```ts
export interface TranscriptReviewedLabel {
    readonly candidate_id: string;
    readonly review_status: "accepted" | "rejected" | "revised" | "deferred";
    readonly reviewed_label?: string;
    readonly reviewed_target?: string;
    readonly rationale: string;
    readonly reviewer: string;
    readonly reviewed_at: string;
}
```

### Vector Row Artifact

```ts
export interface TranscriptLabelVectorRow {
    readonly id: string;
    readonly candidate_id: string;
    readonly graph_fact_id?: string;
    readonly embedding_model: string;
    readonly embedding_dim: number;
    readonly embedding_ref: string;
    readonly nearest_reviewed_candidate_ids: readonly string[];
    readonly nearest_scores: readonly number[];
}
```

### Graph Fact Contract

Every accepted row projected to graph must have:

- `classifier_graph_node.source_kind = "transcript_label_mining_reviewed"`
- `classifier_graph_edge.evidence_path` pointing to the review artifact or transcript artifact
- `classifier_graph_fact.kind = "transcript_reviewed_label"`
- `classifier_graph_fact.predicate` one of:
  - `reviewed_label`
  - `reviewed_target`
  - `nearest_reviewed_neighbor`
  - `promotion_safety`
- `classifier_graph_fact.properties_json.review_status = "accepted"`
- `classifier_graph_fact.properties_json.promotion_safe = true`

Weak/model-only rows must use `promotion_safe = false`.

---

## Task 1: Pure Candidate Mining

**Files:**
- Create: `apps/axctl/src/classifiers/label-mining.ts`
- Create: `apps/axctl/src/classifiers/label-mining.test.ts`

- [ ] **Step 1: Write failing tests for candidate extraction**

Create tests with fixtures for:

- user correction caused by previous assistant action
- direction/preference like “use UV”
- verification demand like “did you run tests?”
- approval/rejection
- wrapper/control text that must be ignored

Run:

```sh
bun test apps/axctl/src/classifiers/label-mining.test.ts
```

Expected: fail because the module does not exist.

- [ ] **Step 2: Implement candidate extraction**

Implement pure functions:

```ts
export function mineTranscriptLabelCandidates(input: {
    readonly windows: readonly EventWindowLike[];
    readonly limit: number;
}): readonly TranscriptLabelCandidate[];

export function auditWeakCandidateBatch(candidates: readonly TranscriptLabelCandidate[]): {
    readonly candidate_count: number;
    readonly label_family_counts: Readonly<Record<string, number>>;
    readonly wrapper_like_count: number;
    readonly evidence_missing_count: number;
    readonly decision: "candidate_batch_ready" | "candidate_batch_failed";
    readonly failures: readonly string[];
};
```

Rules:

- Ignore system/developer/control/subagent wrapper text.
- Require previous assistant context for correction/direction candidates when available.
- Require evidence paths on every candidate.
- Cap excerpt fields to `600` characters each.

- [ ] **Step 3: Verify**

Run:

```sh
bun test apps/axctl/src/classifiers/label-mining.test.ts
bun run typecheck
```

Expected: tests pass and typecheck exits `0`.

- [ ] **Step 4: Commit**

```sh
git add apps/axctl/src/classifiers/label-mining.ts apps/axctl/src/classifiers/label-mining.test.ts
git commit -m "feat(classifiers): mine transcript label candidates"
```

---

## Task 2: Bounded Experiment Gates

**Files:**
- Modify: `apps/axctl/src/classifiers/label-mining.ts`
- Modify: `apps/axctl/src/classifiers/label-mining.test.ts`

- [ ] **Step 1: Add failing tests for stop/failure rules**

Test:

- two no-improvement iterations triggers `stop_for_no_progress`
- more than `8` iterations triggers `stop_for_iteration_limit`
- precision below `0.65` triggers `failed_candidate_precision`
- missing evidence triggers `failed_missing_evidence`
- weak/model-only promotion triggers `failed_unsafe_promotion`

- [ ] **Step 2: Implement gate evaluator**

Implement:

```ts
export function evaluateLabelMiningIteration(input: {
    readonly iteration: number;
    readonly expensive_model_runs: number;
    readonly previous_metrics: readonly LabelMiningMetrics[];
    readonly current_metrics: LabelMiningMetrics;
    readonly candidate_audit: LabelMiningCandidateAudit;
    readonly promotion_audit: LabelMiningPromotionAudit;
}): LabelMiningIterationDecision;
```

The return must include `decision`, `can_continue`, `stop_reason`, `failures`,
and `next_action`.

- [ ] **Step 3: Verify and commit**

```sh
bun test apps/axctl/src/classifiers/label-mining.test.ts
bun run typecheck
git add apps/axctl/src/classifiers/label-mining.ts apps/axctl/src/classifiers/label-mining.test.ts
git commit -m "feat(classifiers): gate transcript label mining iterations"
```

---

## Task 3: Review Queue Export

**Files:**
- Modify: `apps/axctl/src/classifiers/label-mining.ts`
- Create: `apps/axctl/src/classifiers/label-mining-service.ts`
- Create: `apps/axctl/src/classifiers/label-mining-service.test.ts`

- [ ] **Step 1: Write tests for review queue export**

Fake DB tests must prove:

- transcript windows are read from persisted turns
- candidates are sorted by weak confidence and diversity
- at most `80` rows are exported
- every exported row has candidate id, evidence path, previous assistant excerpt, and pending review fields

- [ ] **Step 2: Implement service**

Implement an Effect service with methods:

```ts
readonly miningReport: (input: LabelMiningReportInput) =>
    Effect.Effect<LabelMiningReport, LabelMiningError, SurrealClient>;

readonly writeMiningReport: (input: LabelMiningWriteInput) =>
    Effect.Effect<LabelMiningReport, LabelMiningError, SurrealClient>;
```

Use existing `SurrealClient` and `Effect.fn` patterns. Do not call model helpers here.

- [ ] **Step 3: Verify and commit**

```sh
bun test apps/axctl/src/classifiers/label-mining-service.test.ts
bun run typecheck
git add apps/axctl/src/classifiers/label-mining-service.ts apps/axctl/src/classifiers/label-mining-service.test.ts
git commit -m "feat(classifiers): export transcript label review queue"
```

---

## Task 4: Optional Embedding/SVM Prioritizer

**Files:**
- Create: `packages/ax-classifier-session-sections/label_mining_priority.py`
- Create: `packages/ax-classifier-session-sections/label_mining_priority_test.py`
- Modify: `packages/ax-classifier-session-sections/ax.classifier.json`

- [ ] **Step 1: Write Python tests**

Tests must prove:

- prioritizer ranks candidates by nearest reviewed examples
- hard negatives are surfaced when nearest accepted label differs from weak label
- output has no `promotion_safe=true`
- missing embedding model fails with a clear error

- [ ] **Step 2: Implement prioritizer**

Inputs:

- candidate JSON from Task 3
- reviewed fixture JSONL
- optional embedding cache path

Outputs:

- `.ax/experiments/transcript-label-mining-priority-current.json`
- ranked candidates
- nearest reviewed candidate ids and scores
- precision@20 when reviewed labels are present

- [ ] **Step 3: Verify and commit**

```sh
uv run packages/ax-classifier-session-sections/label_mining_priority_test.py
bun run typecheck
git add packages/ax-classifier-session-sections/label_mining_priority.py packages/ax-classifier-session-sections/label_mining_priority_test.py packages/ax-classifier-session-sections/ax.classifier.json
git commit -m "feat(classifiers): prioritize transcript label review with embeddings"
```

---

## Task 5: Reviewed Graph And Vector Projection

**Files:**
- Modify: `packages/schema/src/schema.surql`
- Modify: `packages/schema/src/schema.test.ts`
- Modify: `apps/axctl/src/classifiers/label-mining.ts`
- Modify: `apps/axctl/src/classifiers/label-mining.test.ts`

- [ ] **Step 1: Decide if new schema is needed**

If existing `classifier_graph_*` tables can store all graph facts and vector refs, do not add new graph tables.

Add only these tables if needed:

- `transcript_label_vector`
- `transcript_label_review`

Required indexes:

- candidate id
- graph fact id
- label family
- review status
- embedding model

- [ ] **Step 2: Write schema and projection tests**

Tests must prove:

- accepted reviewed rows become promotion-safe graph facts
- rejected/deferred rows are stored but not promotion-safe
- vector rows join back to candidate and graph fact ids
- write statements are deterministic and idempotent

- [ ] **Step 3: Implement projection**

Implement:

```ts
export function projectReviewedLabelsToGraph(input: {
    readonly candidates: readonly TranscriptLabelCandidate[];
    readonly reviews: readonly TranscriptReviewedLabel[];
    readonly vectors: readonly TranscriptLabelVectorRow[];
}): LabelMiningGraphProjection;
```

- [ ] **Step 4: Verify and commit**

```sh
bun test packages/schema/src/schema.test.ts apps/axctl/src/classifiers/label-mining.test.ts
bun run typecheck
git add packages/schema/src/schema.surql packages/schema/src/schema.test.ts apps/axctl/src/classifiers/label-mining.ts apps/axctl/src/classifiers/label-mining.test.ts
git commit -m "feat(classifiers): project reviewed transcript labels to graph"
```

---

## Task 6: CLI And Product Query

**Files:**
- Modify: `apps/axctl/src/cli/index.ts`
- Create: `apps/axctl/src/cli/classifiers-label-mining.test.ts`
- Modify: `apps/axctl/src/cli/classifiers-package-operations.ts` only if package operation rendering is reused.

- [ ] **Step 1: Add CLI tests**

Add command coverage for:

```sh
ax classifiers label-mining --since=14 --limit=500 --review-limit=80 --out=.ax/experiments/transcript-label-mining-current.json --json
ax classifiers label-mining --project-reviewed --vectors --graph-projection --out=.ax/experiments/transcript-label-mining-graph-current.json --json
ax classifiers label-mining --self-improve-query --json
```

- [ ] **Step 2: Implement CLI**

The self-improve query must return:

- reviewed promotion-safe fact count
- weak/advisory candidate count
- rejected/deferred count
- nearest-neighbor explanation count
- top repeated correction/direction/verification patterns
- recommended next action

- [ ] **Step 3: Verify and commit**

```sh
bun test apps/axctl/src/cli/classifiers-label-mining.test.ts apps/axctl/src/classifiers/label-mining-service.test.ts
bun run typecheck
git add apps/axctl/src/cli/index.ts apps/axctl/src/cli/classifiers-label-mining.test.ts apps/axctl/src/classifiers/label-mining-service.ts
git commit -m "feat(classifiers): expose transcript label mining cli"
```

---

## Task 7: Run The Bounded Experiment

**Files:**
- Modify: `docs/superpowers/goals/2026-05-30-setfit-session-section-experiments-goal.md`
- Create or update artifacts under `.ax/experiments/`

- [ ] **Step 1: Run mining report**

```sh
bun apps/axctl/src/cli/index.ts classifiers label-mining \
  --since=14 \
  --limit=500 \
  --review-limit=80 \
  --out=.ax/experiments/transcript-label-mining-current.json \
  --json
```

- [ ] **Step 2: Run prioritizer if candidate report is ready**

```sh
uv run packages/ax-classifier-session-sections/label_mining_priority.py \
  --candidates=.ax/experiments/transcript-label-mining-current.json \
  --out=.ax/experiments/transcript-label-mining-priority-current.json
```

- [ ] **Step 3: Apply only reviewed graph facts**

Do not apply weak/model-only facts. If no reviewed rows exist, stop and emit review queue only.

- [ ] **Step 4: Run product query**

```sh
bun apps/axctl/src/cli/index.ts classifiers label-mining \
  --self-improve-query \
  --out=.ax/experiments/transcript-label-mining-self-improve-current.json \
  --json
```

- [ ] **Step 5: Evaluate gates**

Write `.ax/experiments/transcript-label-mining-evaluation-current.json` with:

- all hard success gates
- all soft success gates
- failure cases triggered
- iteration decision
- whether next iteration is allowed

- [ ] **Step 6: Record and commit**

Append the result to the active goal doc.

```sh
git add docs/superpowers/goals/2026-05-30-setfit-session-section-experiments-goal.md .ax/experiments/transcript-label-mining-*.json
git commit -m "docs(classifiers): record transcript label mining experiment"
```

---

## Completion Audit

The experiment is complete only when current evidence proves:

- label mining candidate report exists and passes hard gates or records a defined failure
- review queue export exists
- accepted reviewed rows project into graph facts
- vector rows join back to candidates and graph facts
- self-improve query returns reviewed/advisory/rejected separation
- no raw model-only label is promotion-safe
- iteration decision says `complete`, `continue_allowed`, or a defined failure/stop state

If any item is missing, the goal remains active.

## Execution Choice

Recommended execution style:

1. **Subagent-driven:** one fresh agent per task, review between tasks.
2. **Inline:** execute tasks in order with commits after each task.

Do not run more than one task without committing.
