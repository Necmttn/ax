# Classifier Candidate Contract

`axctl insights harness-candidates` is the read-only handoff from classifier
facts to future proposal promotion. It does not mutate guidance, skills, hooks,
or proposal rows.

## Candidate Identity

Each row includes:

- `candidate_id`: stable tuple
  `["classifier_harness_candidate", classifier_key, label, target, durability]`
- `dedupe_signature`: stable classifier grouping tuple
  `[classifier_key, label, target, durability]`
- `classifier_key`, `label`, `target`, `durability`

Consumers should dedupe on `candidate_id`. If the query later adds more
ranking fields, the identity must remain stable unless the semantic grouping
changes.

## Evidence

Each row includes:

- `facts`: number of classifier facts in the group
- `sessions`: number of distinct sessions
- `avg_confidence`
- `last_seen`
- `examples`: recent classifier facts in the group
- `examples[].evidence`: `cites_evidence` links for each example, including
  evidence `kind`, target record, target table, and timestamp

Evidence links are the bridge back into the graph. A promotion UI or agent
should show at least one example fact and its evidence links before asking a
human to accept the candidate.

## Proposed Action

Each row includes:

- `proposed_layer`: one of `verification`, `environment`, `representation`,
  `guidance`, or `triage`
- `proposed_action`: one of `add_verification_gate`,
  `record_environment_preference`, `add_context_guardrail`,
  `record_guidance`, or `review_pattern`

These fields are suggestions, not authorization. They are safe to use for
sorting, routing, and drafting proposal text.

## Accept Flow

A human or future agent can accept a candidate by creating a `proposal` row
using:

- `dedupe_sig`: derived from `candidate_id`
- `form`: usually `guidance`, `hook`, `automation`, or `skill`
- `title`: short action-oriented description
- `hypothesis`: why the repeated facts indicate a harness gap
- `trigger_pattern`: summarized from `classifier_key`, `label`, `target`, and
  examples
- `proposed_behavior`: derived from `proposed_action`
- `cites_evidence`: links from the proposal to selected example facts or their
  evidence records

Acceptance must not directly edit `AGENTS.md`, skills, hooks, or other harness
files. It should create a proposal/experiment artifact first, then use the
existing review/accept loop.

## Reject Flow

Reject by recording the candidate id, reason, and timestamp in the future
proposal/triage surface. Rejection should not delete classifier facts. Useful
reject reasons include:

- too broad
- duplicate of existing guidance
- false-positive classifier pattern
- one-off user preference
- needs more evidence

Rejected candidates should remain explainable from the underlying facts so the
classifier or thresholds can improve later.
