---
ax_id: harness_check__workflow_candidate__df1d675ec48a9208
ax_experiment: experiment:harness_check__Require_workflow_evidence_for_review_coverage__675ec48a9208__mpudtckh_1
---

# Require workflow evidence for review-coverage

Proposal:
`proposal:harness_check__Require_workflow_evidence_for_review_coverage__675ec48a9208`

Executable regression coverage lives in
`src/cli/classifiers-workflow-candidates.test.ts`:

- `accepted harness proposals compute checks from persisted review facts`

The live DB-backed harness fact is projected by:

```sh
bun src/cli/index.ts classifiers workflow-candidates --topic-report --search=review-coverage --source-kind=hybrid_window_classifier_projection --include-review-facts --include-harness-facts --require-harness-checks --harness-facts=.ax/experiments/workflow-topic-review-coverage-harness-facts-e444.json --harness-write-plan=.ax/experiments/workflow-topic-review-coverage-harness-write-plan-e444.json --apply-harness-facts --limit=10 --out .ax/experiments/workflow-topic-review-coverage-harness-apply-e444.json --json
```

Baseline evidence refs:

- `fact:workflow_topic_candidate_review__review_coverage__classifier_candidate_g__8eae027b4d71`
- `turn:019e57ef_ddbe_7d11_9b7d_7212283b90a4__6bf15e8e3ca0d8cc__seq_000435`
