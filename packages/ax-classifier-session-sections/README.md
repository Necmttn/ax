# @ax-classifier/session-sections

Local model experiment package for AX event-window classification and session-section assembly.

This package is intentionally experimental. It is not part of default ingest and does not persist model facts into the AX graph. It provides a repeatable benchmark path for deciding whether a heavier local model adds useful, evidence-backed graph signals beyond deterministic classifiers.

## What It Classifies

Input: `event_window`

Chunk labels:

- `correction`
- `direction`
- `verification_request`
- `tooling_or_environment_issue`
- `recovery_action`
- `approval`
- `rejection`
- `none`

Section outputs:

- `correction_loop`
- `preference_discovery`
- `verification_loop`
- `section_candidate`

## Package Contract

- `ax.classifier.json` declares the package metadata, labels, fixtures, and optional local model artifacts.
- `ax.classifier.json` also declares operational entry points under
  `operations` so tooling can discover lifecycle commands without reading this
  README. Each operation has a `kind`: `train`, `eval`, `review`, `status`,
  `publish`, or `debug`.
- `eval-fixtures/chunks.jsonl` is the public chunk fixture set used for embedding and SetFit evals.
- `eval-fixtures/sections.json` is the public session-section fixture set used for boundary/evidence evals.
- `eval.py` trains and evaluates a SetFit classifier through `uv`.
- `hybrid_gate.py` evaluates the deterministic plus SetFit gating policy.
- `section_assembler.py` evaluates chunk-to-section assembly.
- `graph_usefulness.py` turns section reports into candidate groups.
- `review.py` generates, syncs, and evaluates the manual review gate.
- `promotion_plan.py` turns reviewed candidate groups into explicit graph fact and evidence-edge candidates.
- `experiment_summary.py` aggregates the experiment artifacts into one machine-readable recommendation and gate summary.
- `failure_analysis.py` turns SetFit eval reports into weak labels, confusion pairs, and next labeling tasks.
- `relabel_audit.py` audits fixed-fold misses for fixture-label contract ambiguity before any relabeling.
- `blind_label_review.py` generates and syncs blind fixture labels before the
  blind gate-stack evaluator is allowed to score predictions.
- `blind_label_suggest.py` generates non-authoritative suggestions to speed
  blind review without writing accepted labels.
- `blind_review_priority.py` ranks blind review rows by model-risk signals so
  reviewers start with likely false positives and low-confidence cases.
- `blind_review_packet.py` consolidates blind label, suggestion, priority, and
  hard-negative context into one read-only review packet, including proposed
  hard-negative labels and reviewer instructions.
- `blind_review_workspace.py` generates one editable Markdown workspace and
  syncs explicit human label/status edits back to E49 and E54 after validating
  labels, targets, statuses, and hard-negative candidate IDs.
- `blind_post_review_runner.py` syncs/evaluates the workspace and runs the
  blind eval, hard-negative export, and fixture append stages when ready.
- `blind_eval_roundtrip.py` syncs the blind label review, writes the labeled
  fixture file, and runs the blind gate-stack evaluator once labels are ready.
- `blind_sensitivity.py` runs explicitly synthetic label scenarios to estimate
  how review outcomes could affect the gate stack; it is not a blind metric.
- `blind_hard_negative_miner.py` prepares pending `none` hard-negative
  candidates from high-risk blind rows; reviewers must accept them before
  they become training fixtures.
- `hard_negative_review.py` syncs accepted/rejected statuses and review notes
  from the hard-negative Markdown queue back into JSON.
- `hard_negative_export.py` exports only accepted hard-negative candidates as
  append-ready fixture rows; pending candidates produce a blocking preflight.
- `workflow_fixture_review.py` reviews classifier fixtures exported from
  graph-discovered workflow candidates before they can be appended to an
  experiment fixture set.
- `blind_workflow_status.py` summarizes the blind review, sensitivity, and
  hard-negative stages into one machine-readable status report.
- `fixture_append.py` validates accepted append rows against existing fixtures
  and writes a combined fixture JSONL only when duplicate and label checks pass.
- `fixture_metadata.py` adds source, boundary, and pair-group metadata used by
  split-safe model experiments.
- `strict_none_gate_eval.py` evaluates candidate context/workflow-control
  `none` gates over synthetic blind scenarios without promoting them.
- `embedding_helper_review.py` turns frozen embedding/SVM helper reports into
  reviewable routing, hard-negative, nearest-neighbor, and dedupe artifacts.
- `embedding_helper_review_batch.py` generates a focused editable review batch
  with source fixture text and nearest-neighbor evidence, then syncs status and
  notes back through the same review-status gate.
- `embedding_helper_review_status.py` syncs and evaluates accepted/rejected
  embedding-helper hard-negative and dedupe review statuses from Markdown.
- `embedding_helper_export.py` exports only accepted embedding-helper
  hard-negatives as append-ready fixture rows and accepted dedupe clusters as
  graph evidence aggregation hints; pending review writes an empty blocked
  export report.
- `embedding_helper_graph_projection.py` projects reviewed embedding helper
  routing, hard-negative, nearest-neighbor, and dedupe evidence into graph-ready
  facts plus a Surreal write plan.
- `boundary_miss_review.py` turns repeated residual robustness misses into a
  Markdown review gate before canonical fixture promotion.

Optional model assets are expected under `.ax/experiments/`. They are not required to install the package and should not be committed by default.

## Label Contract Notes

These rules are intentionally conservative because model-positive chunks may later become graph facts.

- `approval`: use only when the user explicitly accepts a proposed next action and the prior assistant turn asked for or clearly offered that action. Do not use for generic progress prompts like "continue" when the assistant was already executing.
- `none`: use for conversational control, status requests, explanation requests, context recall, git hygiene requests, and "what next" turns that do not add durable preference, correction, verification, rejection, or environment signal.
- `recovery_action`: use when the projected window is evidence that the agent performed a repair, rerun, cleanup, or documentation refresh after a failure or request. Prefer this only when the previous assistant action is the important evidence; do not use it for a plain user go-ahead.
- `tooling_or_environment_issue`: use for local setup, dependency, runtime, model artifact, DB, Nix/Docker, cache, or install constraints that affect repeatability. If the user is only asking for a benchmark report after work is done, prefer `verification_request`.
- `verification_request`: use when the user asks to prove behavior, show command output, run tests/smoke/typecheck/benchmarks, report failed gates, or compare against a baseline.
- `rejection`: use when the user rejects an approach, scope, default behavior, cost, safety posture, or evidence quality. Cost objections to brute-force LLM classification stay `rejection`, not environment/preference.
- `direction`: use when the user gives a forward-looking product, architecture, package, graph, workflow, or process instruction that should shape future work.

Ambiguous boundary examples should be resolved in this contract before changing `eval-fixtures/chunks.jsonl`. Do not relabel canonical fixtures from model predictions alone.

## Run The Experiment Track

From the repo root:

```sh
bun run classifiers:export-windows -- --days=7 --limit=1000 --out=.ax/experiments/model-windows-e1.jsonl
bun run classifiers:embedding-baseline -- --fixtures=packages/ax-classifier-session-sections/eval-fixtures/chunks.jsonl --windows=.ax/experiments/model-windows-e1.jsonl --window-limit=1000 --out=.ax/experiments/embedding-baseline-e2-expanded.json
bun run classifiers:setfit-eval -- --fixtures=packages/ax-classifier-session-sections/eval-fixtures/chunks.jsonl --model=sentence-transformers/all-MiniLM-L6-v2 --epochs=1 --batch-size=8 --label-mode=coarse --model-dir=.ax/experiments/setfit-session-sections-coarse-model --out=.ax/experiments/setfit-session-sections-e3-coarse.json
bun run classifiers:hybrid-gate -- --windows=.ax/experiments/model-windows-e1.jsonl --model-dir=.ax/experiments/setfit-session-sections-coarse-model --limit=1000 --out=.ax/experiments/hybrid-gate-e4.json
bun run classifiers:hybrid-window-candidate-projection -- --hybrid=.ax/experiments/hybrid-gate-e4.json --out=.ax/experiments/hybrid-window-candidate-graph-projection-current.json --write-plan=.ax/experiments/hybrid-window-candidate-graph-write-plan-current.json
bun run classifiers:graph-write-plan-apply -- --write-plan=.ax/experiments/hybrid-window-candidate-graph-write-plan-current.json --out=.ax/experiments/hybrid-window-candidate-graph-apply-current.json
bun run classifiers:workflow-candidates -- --source-kind=hybrid_window_classifier_projection --limit=10 --examples=3 --out=.ax/experiments/workflow-candidate-report-hybrid-window-current.json
bun run classifiers:workflow-candidate-compare -- --baseline=.ax/experiments/workflow-candidate-report-e156.json --candidate=.ax/experiments/workflow-candidate-report-hybrid-window-current.json --out=.ax/experiments/workflow-candidate-compare-current.json
bun run classifiers:workflow-candidate-combined -- --baseline=.ax/experiments/workflow-candidate-report-e156.json --hybrid=.ax/experiments/workflow-candidate-report-hybrid-window-current.json --out=.ax/experiments/workflow-candidate-combined-current.json
bun run classifiers:workflow-candidate-proposal-pack -- --combined=.ax/experiments/workflow-candidate-combined-current.json --out=.ax/experiments/workflow-candidate-proposal-pack-current.json --brief-dir=.ax/tasks/workflow-candidate-proposals --limit=4
bun run classifiers:workflow-candidate-proposal-review -- --pack=.ax/experiments/workflow-candidate-proposal-pack-current.json --out=.ax/experiments/workflow-candidate-proposal-review-current.json --summary=.ax/experiments/workflow-candidate-proposal-review-current.md
bun run classifiers:workflow-candidate-proposal-promote -- --review=.ax/experiments/workflow-candidate-proposal-review-current.json --out=.ax/experiments/workflow-candidate-proposal-promotion-current.json --task-dir=.ax/tasks/workflow-candidate-promotion-drafts
bun run classifiers:workflow-candidate-proposal-promote-smoke -- --review-out=.ax/experiments/workflow-candidate-proposal-ready-smoke-review-current.json --out=.ax/experiments/workflow-candidate-proposal-ready-smoke-promotion-current.json --task-dir=.ax/experiments/workflow-candidate-proposal-ready-smoke-drafts
bun run classifiers:assemble-sections -- --fixtures=packages/ax-classifier-session-sections/eval-fixtures/sections.json --out=.ax/experiments/session-section-assembly-e5.json
bun run classifiers:graph-usefulness -- --hybrid=.ax/experiments/hybrid-gate-e4.json --sections=.ax/experiments/session-section-assembly-e5.json --out=.ax/experiments/graph-usefulness-e6.json
bun run classifiers:review-sections -- --mode=generate --graph=.ax/experiments/graph-usefulness-e6.json --sections=.ax/experiments/session-section-assembly-e5.json --review=.ax/experiments/graph-usefulness-review.json --brief=.ax/experiments/graph-usefulness-review.md --out=.ax/experiments/graph-usefulness-review-report.json
bun run classifiers:promotion-plan -- --review=.ax/experiments/graph-usefulness-review.json --out=.ax/experiments/graph-promotion-plan.json
bun run classifiers:failure-analysis -- --out=.ax/experiments/setfit-failure-analysis.json
bun run classifiers:setfit-robustness -- --fixtures=packages/ax-classifier-session-sections/eval-fixtures/chunks.jsonl --test-ids=packages/ax-classifier-session-sections/eval-fixtures/fixed-fold-seed7-test-ids.json --label-mode=coarse --seeds=7,13,42 --epochs=2 --batch-size=8 --calibration-threshold=0.4 --out=.ax/experiments/setfit-robustness-fixed-fold.json
bun run classifiers:frozen-embedding -- --fixtures=packages/ax-classifier-session-sections/eval-fixtures/chunks.jsonl --model=sentence-transformers/all-MiniLM-L6-v2 --classifier=svm --label-mode=coarse --seeds=7,13,42 --calibration-threshold=0.4 --routing-thresholds=none,0.2,0.3,0.4 --nearest-neighbors=5 --dedupe-threshold=0.92 --hard-negative-limit=10 --out=.ax/experiments/frozen-embedding-helper-svm-current.json
bun run classifiers:embedding-helper-review -- --report=.ax/experiments/frozen-embedding-helper-svm-current.json --out=.ax/experiments/embedding-helper-review-current.json --brief=.ax/experiments/embedding-helper-review-current.md --summary=.ax/experiments/embedding-helper-review-current-report.json --min-positive-recall=0.9
bun run classifiers:embedding-helper-review-batch -- --review=.ax/experiments/embedding-helper-review-current.json --fixtures=packages/ax-classifier-session-sections/eval-fixtures/chunks.jsonl --batch=.ax/experiments/embedding-helper-review-batch-current.md --out=.ax/experiments/embedding-helper-review-batch-current-report.json --limit=5
bun run classifiers:embedding-helper-review-batch -- --mode=evaluate --status-exit-zero --review=.ax/experiments/embedding-helper-review-current.json --batch=.ax/experiments/embedding-helper-review-batch-current.md --out=.ax/experiments/embedding-helper-review-progress-current.json
bun run classifiers:embedding-helper-review-batch -- --mode=sync --dry-run --review=.ax/experiments/embedding-helper-review-current.json --batch=.ax/experiments/embedding-helper-review-batch-current.md --out=.ax/experiments/embedding-helper-review-batch-dry-run-current-report.json
bun run classifiers:embedding-helper-review-batch -- --mode=sync --dry-run --review=.ax/experiments/embedding-helper-review-current.json --review-out=.ax/experiments/embedding-helper-review-synced-copy-current.json --batch=.ax/experiments/embedding-helper-review-batch-current.md --out=.ax/experiments/embedding-helper-review-copy-sync-current-report.json
bun run classifiers:embedding-helper-review-status -- --review=.ax/experiments/embedding-helper-review-current.json --brief=.ax/experiments/embedding-helper-review-current.md --out=.ax/experiments/embedding-helper-review-status-current.json --mode=sync
bun run classifiers:embedding-helper-export -- --review=.ax/experiments/embedding-helper-review-current.json --status=.ax/experiments/embedding-helper-review-status-current.json --fixtures=packages/ax-classifier-session-sections/eval-fixtures/chunks.jsonl --out=.ax/experiments/embedding-helper-fixture-append-current.jsonl --hints=.ax/experiments/embedding-helper-dedupe-hints-current.json --report=.ax/experiments/embedding-helper-export-current-report.json
bun run classifiers:fixture-append -- --base packages/ax-classifier-session-sections/eval-fixtures/chunks.jsonl --append .ax/experiments/embedding-helper-fixture-append-current.jsonl --out .ax/experiments/chunks-with-embedding-helper-fixtures-current.jsonl --report .ax/experiments/fixture-append-embedding-helper-current-report.json --allow-existing-identical --json
bun run classifiers:fixture-metadata -- --fixtures=.ax/experiments/chunks-with-embedding-helper-fixtures-current.jsonl --out=.ax/experiments/chunks-with-embedding-helper-fixture-metadata-current.jsonl
bun run classifiers:split-audit -- --fixtures=.ax/experiments/chunks-with-embedding-helper-fixture-metadata-current.jsonl --group-field=pair_group --pair-field=pair_group --label-mode=coarse --seeds=7,13,42 --out=.ax/experiments/embedding-helper-fixture-split-audit-current.json --json
bun run classifiers:setfit-robustness -- --fixtures=.ax/experiments/chunks-with-embedding-helper-fixture-metadata-current.jsonl --group-field=pair_group --label-mode=coarse --seeds=7,13,42 --epochs=1 --batch-size=8 --calibration-threshold=0.4 --out=.ax/experiments/setfit-robustness-embedding-helper-fixtures-current.json --json
bun run classifiers:failure-analysis -- --robustness=.ax/experiments/setfit-robustness-embedding-helper-fixtures-current.json --fixtures=.ax/experiments/chunks-with-embedding-helper-fixture-metadata-current.jsonl --out=.ax/experiments/setfit-failure-analysis-embedding-helper-fixtures-current.json --json
bun run classifiers:boundary-miss-review -- --analysis=.ax/experiments/setfit-failure-analysis-embedding-helper-fixtures-current.json --review=.ax/experiments/boundary-miss-review-current.json --brief=.ax/experiments/boundary-miss-review-current.md --out=.ax/experiments/boundary-miss-review-current-report.json --mode=generate --json
bun run classifiers:boundary-miss-review -- --review=.ax/experiments/boundary-miss-review-current.json --brief=.ax/experiments/boundary-miss-review-current.md --out=.ax/experiments/boundary-miss-review-current-report.json --mode=sync --json
bun run classifiers:embedding-helper-export -- --allow-partial-preview --preview-exit-zero --review=.ax/experiments/embedding-helper-review-current.json --status=.ax/experiments/embedding-helper-review-status-current.json --fixtures=packages/ax-classifier-session-sections/eval-fixtures/chunks.jsonl --out=.ax/experiments/embedding-helper-fixture-preview-current.jsonl --hints=.ax/experiments/embedding-helper-dedupe-preview-current.json --report=.ax/experiments/embedding-helper-export-preview-current-report.json
bun run classifiers:embedding-helper-graph-projection -- --review=.ax/experiments/embedding-helper-review-current.json --out=.ax/experiments/embedding-helper-graph-projection-current.json --write-plan=.ax/experiments/embedding-helper-graph-write-plan-current.json
bun run classifiers:relabel-audit -- --robustness=.ax/experiments/setfit-robustness-fixed-fold.json --fixtures=packages/ax-classifier-session-sections/eval-fixtures/chunks.jsonl --out=.ax/experiments/setfit-relabel-audit.json
bun run classifiers:blind-label-review -- --fixtures=.ax/experiments/blind-session-section-fixtures-e46.jsonl --review=.ax/experiments/blind-session-section-label-review-e49.json --brief=.ax/experiments/blind-session-section-label-review-e49.md --labeled-out=.ax/experiments/blind-session-section-fixtures-e49-labeled.jsonl --out=.ax/experiments/blind-session-section-label-review-e49-report.json --mode=generate
bun run classifiers:blind-label-suggest -- --review=.ax/experiments/blind-session-section-label-review-e49.json --predictions=.ax/experiments/blind-session-section-predictions-e48.jsonl --out=.ax/experiments/blind-session-section-label-suggestions-e51.json --brief=.ax/experiments/blind-session-section-label-suggestions-e51.md --report=.ax/experiments/blind-session-section-label-suggestions-e51-report.json
bun run classifiers:blind-review-priority -- --review=.ax/experiments/blind-session-section-label-review-e49.json --suggestions=.ax/experiments/blind-session-section-label-suggestions-e51.json --out=.ax/experiments/blind-session-section-review-priority-e52.json --brief=.ax/experiments/blind-session-section-review-priority-e52.md --report=.ax/experiments/blind-session-section-review-priority-e52-report.json --limit=15
bun run classifiers:blind-sensitivity -- --review=.ax/experiments/blind-session-section-label-review-e49.json --suggestions=.ax/experiments/blind-session-section-label-suggestions-e51.json --priorities=.ax/experiments/blind-session-section-review-priority-e52.json --predictions=.ax/experiments/blind-session-section-predictions-e48.jsonl --out=.ax/experiments/blind-sensitivity-e53.json
bun run classifiers:blind-hard-negatives -- --review=.ax/experiments/blind-session-section-label-review-e49.json --priorities=.ax/experiments/blind-session-section-review-priority-e52.json --out=.ax/experiments/blind-hard-negative-candidates-e54.json --brief=.ax/experiments/blind-hard-negative-candidates-e54.md --report=.ax/experiments/blind-hard-negative-candidates-e54-report.json --min-score=3
bun run classifiers:blind-review-packet -- --review=.ax/experiments/blind-session-section-label-review-e49.json --suggestions=.ax/experiments/blind-session-section-label-suggestions-e51.json --priorities=.ax/experiments/blind-session-section-review-priority-e52.json --hard-negatives=.ax/experiments/blind-hard-negative-candidates-e54.json --out=.ax/experiments/blind-review-packet-e61.json --brief=.ax/experiments/blind-review-packet-e61.md --report=.ax/experiments/blind-review-packet-e61-report.json
bun run classifiers:blind-review-workspace -- --packet=.ax/experiments/blind-review-packet-e61.json --review=.ax/experiments/blind-session-section-label-review-e49.json --hard-negatives=.ax/experiments/blind-hard-negative-candidates-e54.json --workspace=.ax/experiments/blind-review-workspace-e63.md --out=.ax/experiments/blind-review-workspace-e63-report.json --mode=generate
bun run classifiers:blind-post-review -- --workspace=.ax/experiments/blind-review-workspace-e63.md --review=.ax/experiments/blind-session-section-label-review-e49.json --hard-negatives=.ax/experiments/blind-hard-negative-candidates-e54.json --out=.ax/experiments/blind-post-review-runner-e65.json
bun run classifiers:hard-negative-review -- --candidates=.ax/experiments/blind-hard-negative-candidates-e54.json --brief=.ax/experiments/blind-hard-negative-candidates-e54.md --out=.ax/experiments/blind-hard-negative-review-e56-report.json --mode=sync
bun run classifiers:hard-negative-export -- --candidates=.ax/experiments/blind-hard-negative-candidates-e54.json --out=.ax/experiments/blind-hard-negative-fixture-append-e55.jsonl --report=.ax/experiments/blind-hard-negative-fixture-append-e55-report.json
bun run classifiers:fixture-append -- --base=.ax/experiments/chunks-e38-targeted-fixtures-metadata.jsonl --append=.ax/experiments/blind-hard-negative-fixture-append-e55.jsonl --out=.ax/experiments/chunks-e58-with-accepted-hard-negatives.jsonl --report=.ax/experiments/fixture-append-e58-report.json
bun run classifiers:strict-none-gate -- --review=.ax/experiments/blind-session-section-label-review-e49.json --suggestions=.ax/experiments/blind-session-section-label-suggestions-e51.json --priorities=.ax/experiments/blind-session-section-review-priority-e52.json --predictions=.ax/experiments/blind-session-section-predictions-e48.jsonl --baseline=.ax/experiments/blind-sensitivity-e53.json --out=.ax/experiments/strict-none-gate-e59.json
bun run classifiers:blind-workflow-status -- --out=.ax/experiments/blind-workflow-status-e57.json
bun run classifiers:blind-eval-roundtrip -- --fixtures=.ax/experiments/blind-session-section-fixtures-e46.jsonl --review=.ax/experiments/blind-session-section-label-review-e49.json --brief=.ax/experiments/blind-session-section-label-review-e49.md --predictions=.ax/experiments/blind-session-section-predictions-e48.jsonl --labeled-out=.ax/experiments/blind-session-section-fixtures-e50-labeled.jsonl --eval-out=.ax/experiments/blind-gate-stack-eval-e50.json --out=.ax/experiments/blind-eval-roundtrip-e50-report.json --sync
bun run classifiers:experiment-summary -- --out=.ax/experiments/session-section-experiment-summary.json
```

The review generation command exits nonzero while candidates are pending. That is expected; the failure is the measurable manual-review gate.

## Manual Review Round Trip

1. Open `.ax/experiments/graph-usefulness-review.md`.
2. For each candidate, change `Verdict` from `pending` to `accept`, `revise`, or `reject`.
3. Add a short `Rationale`.
4. Sync the Markdown back to JSON:

```sh
bun run classifiers:review-sections -- --mode=sync --review=.ax/experiments/graph-usefulness-review.json --brief=.ax/experiments/graph-usefulness-review.md --out=.ax/experiments/graph-usefulness-review-report.json
```

5. Evaluate the JSON review directly:

```sh
bun run classifiers:review-sections -- --mode=evaluate --review=.ax/experiments/graph-usefulness-review.json --out=.ax/experiments/graph-usefulness-review-report.json
```

The graph-usefulness gate passes only when every candidate is reviewed and the reject rate is below `30%`.

## Blind Review Workspace Round Trip

1. Open `.ax/experiments/blind-review-workspace-e63.md` or generate a focused
   batch:

```sh
bun run classifiers:blind-review-batch -- --workspace=.ax/experiments/blind-review-workspace-e63.md --report=.ax/experiments/blind-review-workspace-e76-progress-refs-report.json --out=.ax/experiments/blind-review-batch-e77.md --summary=.ax/experiments/blind-review-batch-e77-report.json --limit=5
```

To refresh the focused batch, eval report, guarded sync report, and workflow
status as one coherent bundle:

```sh
bun run classifiers:blind-review-refresh
```

Focused batches preserve the workspace section order, include the allowed
label/target/status vocabulary, and enrich each selected section with packet
context when available: confidence values, evidence refs, and hard-negative
proposed label/target plus review instruction. Those context fields are
informational; the authoritative editable fields remain `Review label`,
`Review target`, `Review notes`, `Hard-negative status`, and
`Hard-negative notes`. Review notes and hard-negative notes are quality-gated:
they must be non-placeholder, at least 8 characters, and at least 2 words
before any batch or workspace sync is allowed to pass.

To inspect the operations declared by the classifier package manifest:

```sh
bun src/cli/index.ts classifiers package-operations --manifest=packages/ax-classifier-session-sections/ax.classifier.json --json
bun src/cli/index.ts classifiers package-operations --operation=setfit-train-eval --json
bun src/cli/index.ts classifiers package-operations --operation=setfit-train-eval --preflight --json
bun src/cli/index.ts classifiers package-operations --operation=setfit-train-eval --dry-run --json
bun src/cli/index.ts classifiers package-operations --operation=setfit-train-eval --execute --json
bun src/cli/index.ts classifiers package-operations --operation=blind-review-refresh --execute --out=.ax/experiments/classifier-package-execution-current.json
bun src/cli/index.ts classifiers package-operations --operation=setfit-train-eval --execute --allow-expensive --out=.ax/experiments/classifier-package-execution-current.json
bun src/cli/index.ts classifiers package-operations --operation=blind-review-refresh --out=.ax/experiments/classifier-package-operation-current.json
bun src/cli/index.ts classifiers package-operations --all --json
bun src/cli/index.ts classifiers package-operations --all --out=.ax/experiments/classifier-packages-operations-current.json
bun src/cli/index.ts classifiers package-operations --operation=graph-health-summary --json
bun src/cli/index.ts classifiers package-operations --graph-health --graph-mode=guarded
bun src/cli/index.ts classifiers package-operations --graph-health --graph-mode=changed-artifacts --operation=blind-review-refresh
bun src/cli/index.ts classifiers package-operations --graph-health --graph-mode=evidence --operation=setfit-train-eval
bun src/cli/index.ts classifiers package-operations --operation=classifier-lifecycle-status --json
bun src/cli/index.ts classifiers package-operations --operation=focused-batch-eval --json
bun src/cli/index.ts classifiers lifecycle --out=.ax/experiments/classifiers-lifecycle-current.json
bun run classifiers:package-operations -- --manifest=packages/ax-classifier-session-sections/ax.classifier.json --json
bun run classifiers:package-operations -- --operation=blind-review-refresh --out=.ax/experiments/classifier-package-operation-current.json
```

AX TypeScript callers can use `ClassifierPackageService` from
`src/classifiers/package-service.ts` to load package manifests, list or select
operations, and write operation reports through an Effect service layer.

The `graph-health-*` operations are read-only status hooks for the persisted
classifier lifecycle graph. They do not train models or mutate SurrealDB; they
inspect `classifier_graph_node`, `classifier_graph_edge`, and
`classifier_graph_fact` after `--apply-write-plan` has populated those tables.

The `classifier-lifecycle-status` operation is the higher-level status hook. It
joins package lifecycle readiness, persisted graph health, and blind-review
progress into `.ax/experiments/classifiers-lifecycle-current.json`. It can exit
nonzero when the lifecycle is blocked, for example while blind labels or
hard-negative decisions are still pending.

The `focused-batch-eval` operation is the smallest review gate. It validates
the current focused batch for pending fields and invalid labels, targets, or
hard-negative statuses before a reviewer syncs it back into the full workspace.

Workflow-candidate fixture operations are the graph-to-fixture package path:

```sh
bun src/cli/index.ts classifiers package-operations --operation=workflow-fixture-review --preflight --json
bun src/cli/index.ts classifiers package-operations --operation=workflow-fixture-review --json
bun src/cli/index.ts classifiers package-operations --operation=workflow-fixture-review-sync --json
bun src/cli/index.ts classifiers package-operations --operation=workflow-fixture-append --json
bun src/cli/index.ts classifiers package-operations --operation=workflow-fixture-metadata --json
bun src/cli/index.ts classifiers package-operations --operation=workflow-fixture-split-audit --json
bun src/cli/index.ts classifiers package-operations --operation=workflow-fixture-setfit-robustness --json
bun src/cli/index.ts classifiers package-operations --operation=workflow-fixture-failure-analysis --json
bun src/cli/index.ts classifiers package-operations --operation=workflow-fixture-none-safety-pregate --json
bun run classifiers:export-windows -- --days=7 --limit=2000 --out=.ax/experiments/model-windows-none-safety-current.jsonl --json
bun src/cli/index.ts classifiers package-operations --operation=workflow-fixture-none-safety-window-replay --json
bun src/cli/index.ts classifiers package-operations --operation=workflow-fixture-hybrid-robustness --json
bun src/cli/index.ts classifiers package-operations --operation=workflow-fixture-hybrid-graph-usefulness --json
bun src/cli/index.ts classifiers package-operations --operation=hybrid-window-candidate-projection --json
bun src/cli/index.ts classifiers package-operations --operation=hybrid-window-candidate-apply --json
bun src/cli/index.ts classifiers package-operations --operation=hybrid-window-workflow-candidate-report --json
bun src/cli/index.ts classifiers package-operations --operation=workflow-candidate-source-compare --json
bun src/cli/index.ts classifiers package-operations --operation=workflow-candidate-combined-report --json
bun src/cli/index.ts classifiers package-operations --operation=workflow-candidate-proposal-pack --json
bun src/cli/index.ts classifiers package-operations --operation=workflow-candidate-proposal-review --json
bun src/cli/index.ts classifiers package-operations --operation=workflow-candidate-proposal-promote-drafts --json
bun src/cli/index.ts classifiers package-operations --operation=workflow-candidate-proposal-ready-smoke --json
```

Embedding-helper fixture operations expose the same reviewed-append to
model-quality gate for helper-mined hard negatives:

```sh
bun src/cli/index.ts classifiers package-operations --operation=embedding-helper-fixture-append --json
bun src/cli/index.ts classifiers package-operations --operation=embedding-helper-fixture-metadata --json
bun src/cli/index.ts classifiers package-operations --operation=embedding-helper-fixture-split-audit --json
bun src/cli/index.ts classifiers package-operations --operation=embedding-helper-fixture-setfit-robustness --json
bun src/cli/index.ts classifiers package-operations --operation=embedding-helper-fixture-failure-analysis --json
bun src/cli/index.ts classifiers package-operations --operation=embedding-helper-boundary-miss-review --json
bun src/cli/index.ts classifiers package-operations --operation=embedding-helper-boundary-miss-review-sync --json
```

Use this path after `embedding-helper-export` is appendable. It keeps canonical
fixtures untouched while checking whether reviewed helper hard negatives remain
split-safe and whether residual SetFit confusions require another targeted
review batch before fixture promotion. The boundary-miss review only selects
repeated canonical fixture misses by default; helper-appended rows that already
classify cleanly do not block promotion.

The intended sequence is:

1. Export pending fixture rows from a topic report.
2. Generate the review brief through `workflow-fixture-review`.
3. Human-review the brief into
   `.ax/experiments/workflow-fixture-review-current-reviewed.md`.
4. Sync accepted rows through `workflow-fixture-review-sync`.
5. Append only accepted rows into a non-canonical experiment fixture file.
6. Enrich that experiment set with `fixture-metadata`.
7. Run `workflow-fixture-split-audit` before using the set for model training
   or robustness comparisons.
8. Run `workflow-fixture-setfit-robustness` with `--allow-expensive` when the
   split audit passes and you are ready to spend local SetFit runtime.
9. If robustness fails, run `workflow-fixture-failure-analysis` to rank repeated
   `none` false positives and boundary misses for the next review batch.
10. Run `workflow-fixture-none-safety-pregate` to replay the repeated `none`
    false-positive fixes as a deterministic text gate before another SetFit
    training run.
11. Export fresh model windows and run
    `workflow-fixture-none-safety-window-replay` to check whether the gate
    fires on new transcript windows and whether those hits conflict with
    existing deterministic light labels.
12. Run `workflow-fixture-hybrid-robustness` to score SetFit calibrated
    predictions plus deterministic gates with the same robustness contract as
    raw SetFit.
13. Run `workflow-fixture-hybrid-graph-usefulness` to compare raw SetFit and
    hybrid predictions as evidence-backed graph candidate groups and confirm
    the hybrid gate removes graph noise without dropping fixture evidence.
14. Run `hybrid-window-candidate-projection` after `hybrid-gate-eval` to project
    transcript-backed, model-only event-window candidates into the shared
    classifier graph tables with real turn/evidence refs.
15. Run `hybrid-window-candidate-apply` to persist those graph rows locally,
    then `hybrid-window-workflow-candidate-report` and
    `workflow-candidate-source-compare` to compare the hybrid source kind
    against deterministic transcript-backed candidates.
16. Run `workflow-candidate-combined-report` when both source reports exist to
    merge them by proposed action and keep per-source support, evidence, and
    task-like counts visible in one report.
17. Run `workflow-candidate-proposal-pack` to emit reviewable guidance/harness
    proposal briefs from the combined action report. These briefs are pending
    human review; they do not apply guidance or harness changes.
18. Run `workflow-candidate-proposal-review` after editing the proposal briefs
    to verify every proposal has a verdict, rationale, proposed change, and
    target before any promotion path uses it.
19. Run `workflow-candidate-proposal-promote-drafts` only after the review
    report is ready. It emits Markdown task drafts for accepted or revised
    proposals and does not mutate guidance or harness files directly.
20. Run `workflow-candidate-proposal-ready-smoke` to verify the ready-review
    promotion path using a deterministic fixture: accepted/revised proposals
    emit drafts and rejected proposals are skipped.

These operations deliberately write under `.ax/experiments/`. They do not
mutate `eval-fixtures/chunks.jsonl`; canonical promotion still requires a
separate reviewed change.

2. Fill `Review label`, `Review target`, and `Review notes` for each row.
3. For rows with a hard-negative candidate, set `Hard-negative status` to
   `accepted` or `rejected` and add `Hard-negative notes`.
4. If editing a focused batch, evaluate it before syncing:

```sh
bun run classifiers:blind-review-batch -- --mode=evaluate --batch=.ax/experiments/blind-review-batch-e77.md --summary=.ax/experiments/blind-review-batch-eval-report.json
```

5. If the focused batch is ready, sync it back into the main workspace:

```sh
bun run classifiers:blind-review-batch -- --mode=sync --workspace=.ax/experiments/blind-review-workspace-e63.md --batch=.ax/experiments/blind-review-batch-e77.md --workspace-out=.ax/experiments/blind-review-workspace-e63.md --summary=.ax/experiments/blind-review-batch-sync-report.json
```

Sync refuses incomplete batch reviews by default. Use `--allow-incomplete`
only for mechanical preview/debug artifacts that must not be treated as review
progress. Batch reports include content hashes so workflow status can detect
eval/sync reports generated from different batch contents.

6. Dry-run the workspace sync:

```sh
bun run classifiers:blind-review-workspace -- --mode=sync --dry-run --workspace=.ax/experiments/blind-review-workspace-e63.md --review=.ax/experiments/blind-session-section-label-review-e49.json --hard-negatives=.ax/experiments/blind-hard-negative-candidates-e54.json --out=.ax/experiments/blind-review-workspace-dry-run-report.json
```

7. Sync the workspace back to E49 and E54:

```sh
bun run classifiers:blind-review-workspace -- --mode=sync --workspace=.ax/experiments/blind-review-workspace-e63.md --review=.ax/experiments/blind-session-section-label-review-e49.json --hard-negatives=.ax/experiments/blind-hard-negative-candidates-e54.json --out=.ax/experiments/blind-review-workspace-e63-report.json
```

The workspace gate passes only when E49 has no pending labels and E54 has no
pending hard-negative candidates. Sync refuses malformed workspace edits before
writing E49 or E54.

8. Run the post-review pipeline:

```sh
bun run classifiers:blind-post-review -- --sync-workspace --workspace=.ax/experiments/blind-review-workspace-e63.md --review=.ax/experiments/blind-session-section-label-review-e49.json --hard-negatives=.ax/experiments/blind-hard-negative-candidates-e54.json --out=.ax/experiments/blind-post-review-runner-e65.json
```

The post-review runner skips blind eval/export/append until the workspace
report is `ready_for_roundtrip`.

## Graph Promotion Contract

`promotion_plan.py` is the handoff between review and graph persistence. It does not write to SurrealDB. It emits a promotion plan that can later be consumed by an AX graph writer.

Promoted facts include:

- `id`
- `source_candidate_id`
- `fact_type`
- `section_type`
- `proposed_action`
- `verdict`
- `rationale`
- `sections`
- `evidence_refs`

Evidence refs become `supported_by` edge candidates. Promotion is blocked when any candidate is still pending, reviewed candidates lack rationales, promotable candidates lack evidence, or the reject rate is `>= 30%`.

## Contributor Checklist

When adding or changing a classifier package:

- Keep public fixtures small enough to commit.
- Put large trained models under `.ax/experiments/` or another optional asset path.
- Declare labels, targets, fixtures, and optional assets in `ax.classifier.json`.
- Declare package operations with a lifecycle `kind` when contributors need to
  train, evaluate, review, inspect status, publish, or debug package artifacts.
- Include hard negative `none` examples.
- Report model size, runtime, macro F1, `none` false-positive rate, and evidence coverage.
- Do not make local model output part of default ingest until graph usefulness and review gates pass.

Focused verification:

```sh
bun test src/classifiers/package-manifest.test.ts
python3 -m unittest packages/ax-classifier-session-sections/section_assembler_test.py packages/ax-classifier-session-sections/graph_usefulness_test.py packages/ax-classifier-session-sections/review_test.py
python3 -m unittest packages/ax-classifier-session-sections/promotion_plan_test.py packages/ax-classifier-session-sections/experiment_summary_test.py packages/ax-classifier-session-sections/failure_analysis_test.py packages/ax-classifier-session-sections/relabel_audit_test.py
uv run python -m unittest packages/ax-classifier-session-sections/eval_test.py packages/ax-classifier-session-sections/hybrid_gate_test.py
```
