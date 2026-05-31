---
ax_id: harness_check__workflow_candidate__d9c44ad59d7b3dcf
ax_experiment: experiment:harness_check__Require_output_required_evidence_for_SurrealML__4ad59d7b3dcf__mpt17f08_1
---

# Require output_required evidence for SurrealML

Proposal: `proposal:harness_check__Require_output_required_evidence_for_SurrealML__4ad59d7b3dcf`

Executable regression coverage lives in
`src/cli/classifiers-workflow-candidates.test.ts`:

- `passes topic harness checks only with applied classifier result evidence`
- `fails topic harness checks when the evidence stops at html without classifier results`

Baseline evidence refs:

- `classifier_result:verification_event__0_1_0__event_window__38cbc794d9d58e54`
- `classifier_result:verification_event__0_1_0__event_window__9813244cd75c94f7`

