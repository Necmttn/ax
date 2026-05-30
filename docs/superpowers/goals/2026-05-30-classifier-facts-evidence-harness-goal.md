# Goal: Classifier Facts, Evidence, And Harness Discovery

## Objective

Turn classifier output from labels attached to turns into queryable graph facts
that can explain agent behavior, surface recurring work patterns, and produce
evidence-backed harness/guidance candidates.

This goal is designed for a 10-iteration agent run. Each iteration should leave
the repo in a passing state, improve a measurable benchmark, and update the
scorecard below.

## Current Baseline

Already exists:

- `classifier_result` rows with classifier key, version, label, target,
  durability, confidence, evidence JSON, turn, session, and timestamp.
- `turn -> has_classification -> classifier_result` edges.
- `classifier_result -> cites_evidence -> turn` edges.
- `classifier-results` ingest stage.
- `classifiers list`, `classifiers eval`, and `classifiers explain`.
- `classifier-results` and `classifier-themes` insight views.
- `ClassifierService` for shared registry/runner/eval/debug behavior.

Known gap:

- Facts do not yet cite previous assistant turns, tool failures, files, commands,
  or harness events as explicit evidence edges.
- Query views do not yet show `fact -> prior context -> later action -> outcome`.
- No harness candidate query turns repeated classifier facts into actionable
  proposals with evidence.

## Target Capability

Given local transcript history, ax can answer:

- Which turns contain correction, direction, verification, or approval facts?
- What prior assistant/tool context caused the fact?
- What did the agent do after the fact?
- Did a later command, test, user reaction, or commit indicate recovery?
- Which repeated facts suggest a harness/guidance improvement?
- Which exact turns/tool calls/files support that suggestion?

## Success Benchmarks

The agent should optimize these numbers during 10 iterations.

| Metric | Baseline | Target |
|---|---:|---:|
| Classifier golden fixture pass rate | 12/12 | >= 24/24 |
| Classifier package count | 1 | >= 2 |
| Insight views using classifier facts | 2 | >= 6 |
| Fact evidence edge kinds | 1 (`cites_evidence -> turn`) | >= 4 |
| Harness candidate query views | 0 | >= 1 |
| Tests covering classifier graph/query behavior | current + service tests | +12 focused tests |
| DB smoke command count | ad hoc | >= 4 documented commands |
| `bun run typecheck` | exits 0 | exits 0 |
| Focused classifier/insight tests | 106 pass | >= 118 pass |

Targets are minimums. Do not chase fixture count by adding weak duplicate cases.
Each added fixture should cover a distinct label, target, edge case, or false
positive guard.

## Benchmark Commands

Run these after every iteration:

```sh
bun src/cli/index.ts classifiers eval
bun test src/classifiers/service.test.ts src/classifiers/eval.test.ts src/classifiers/list.test.ts
bun test src/classifiers/core.test.ts src/classifiers/event-window.test.ts src/classifiers/repository.test.ts src/ingest/classifier-results.test.ts src/queries/insights.test.ts src/cli/insights-format.test.ts src/cli/effect-cli.test.ts
bun run typecheck
```

Run these when DB changes or insight views change:

```sh
bun src/cli/index.ts ingest --stages=classifier-results --since=7 --progress=plain
bun src/cli/index.ts insights classifier-results --limit=10
bun src/cli/index.ts insights classifier-themes --limit=10
bun src/cli/index.ts insights harness-candidates --limit=10
bun run classifiers:smoke -- --days=7 --limit=10
bun src/cli/index.ts classifiers explain <known-turn-id>
```

Add new smoke commands to this list as new views land.

## Scorecard Format

Update this section after each iteration.

```text
iteration:
date:
changes:
classifier eval:
focused tests:
typecheck:
new insight views:
new evidence edges:
known gaps:
next iteration:
```

## Iteration Log

```text
iteration: 1
date: 2026-05-30
changes:
  - Added classifier-facts insight view for fact -> user turn -> previous assistant -> recent tool failures.
  - Added correction-contexts insight view focused on correction facts and causal context.
  - Added compact formatter support for both views.
  - Added direct bun-types dev dependency so the existing tsconfig "types": ["bun-types"] typecheck path is reproducible.
classifier eval:
  - bun src/cli/index.ts classifiers eval => 12/12 passed
focused tests:
  - bun test src/classifiers/service.test.ts src/classifiers/eval.test.ts src/classifiers/list.test.ts => 8 pass
  - bun test src/classifiers/core.test.ts src/classifiers/event-window.test.ts src/classifiers/repository.test.ts src/ingest/classifier-results.test.ts src/queries/insights.test.ts src/cli/insights-format.test.ts src/cli/effect-cli.test.ts => 61 pass
typecheck:
  - bun run typecheck => exits 0; Effect language-service warnings remain informational
new insight views:
  - classifier-facts
  - correction-contexts
new evidence edges:
  - none yet; this iteration exposes richer context through query joins, not persistence expansion
db smoke:
  - bun src/cli/index.ts insights classifier-facts --limit=2 => returned real rows
  - bun src/cli/index.ts insights correction-contexts --limit=2 => returned real rows
known gaps:
  - Evidence edge kinds remain at 1.
  - Fixture count remains 12/12.
  - Harness candidate query is still missing.
next iteration:
  - Expand persisted cites_evidence edges to previous assistant turns and recent failed tool_call records.
```

```text
iteration: 2
date: 2026-05-30
changes:
  - Added ClassifierEvidenceRef persistence input for classifier_result evidence edges.
  - Derived evidence refs from event windows for previous assistant turns and recent failure evidence.
  - Kept the classifier API unchanged; evidence expansion happens at ingest/persistence boundaries.
  - Full classifier-result reset now clears old classifier_result-origin cites_evidence edges before rebuilding.
classifier eval:
  - bun src/cli/index.ts classifiers eval => 12/12 passed
focused tests:
  - bun test src/classifiers/repository.test.ts src/ingest/classifier-results.test.ts src/classifiers/event-window.test.ts => 3 pass
  - bun test src/classifiers/service.test.ts src/classifiers/eval.test.ts src/classifiers/list.test.ts src/classifiers/repository.test.ts src/ingest/classifier-results.test.ts src/queries/insights.test.ts src/cli/insights-format.test.ts => 39 pass
typecheck:
  - bun run typecheck => exits 0; Effect language-service warnings remain informational
new insight views:
  - none
new evidence edges:
  - classifier_result -> cites_evidence -> previous assistant turn
  - classifier_result -> cites_evidence -> recent failure evidence turn when present in event windows
db smoke:
  - bun src/cli/index.ts ingest --stages=classifier-results --since=7 --progress=plain => exits 0
  - classifier_result-origin cites_evidence count => 2722
  - previous_assistant edge ids => 336
known gaps:
  - Local event windows currently build recent failure evidence from transcript tool-result turns, not canonical tool_call rows.
  - Local DB smoke did not find recent_tool_failure edges in the current 7-day event-window data.
  - Fixture count remains 12/12.
next iteration:
  - Make event-window evidence aware of canonical tool_call rows or add a post-classification evidence expansion query for tool_call/file targets.
```

```text
iteration: 3
date: 2026-05-30
changes:
  - Added canonical ClassifierToolCallRow input for classifier event-window enrichment.
  - Merged recent canonical tool_call rows into classifier EventWindow recentToolCalls/recentToolFailures.
  - Canonical tool_call failure evidence now produces classifier_result -> cites_evidence -> tool_call edges.
  - Kept transcript tool-result fallback evidence for sources without normalized tool_call rows.
classifier eval:
  - bun src/cli/index.ts classifiers eval => 12/12 passed
focused tests:
  - bun test src/ingest/classifier-results.test.ts src/classifiers/event-window.test.ts src/classifiers/repository.test.ts src/classifiers/reaction-event/index.test.ts src/classifiers/direction-event/index.test.ts => 9 pass
  - bun test src/classifiers/service.test.ts src/classifiers/eval.test.ts src/classifiers/list.test.ts => 8 pass
  - bun test src/classifiers/core.test.ts src/classifiers/event-window.test.ts src/classifiers/repository.test.ts src/ingest/classifier-results.test.ts src/queries/insights.test.ts src/cli/insights-format.test.ts src/cli/effect-cli.test.ts => 62 pass
typecheck:
  - bun run typecheck => exits 0; Effect language-service warnings remain informational
new insight views:
  - none
new evidence edges:
  - classifier_result -> cites_evidence -> canonical tool_call
db smoke:
  - bun src/cli/index.ts ingest --stages=classifier-results --since=7 --progress=plain => exits 0
  - bun src/cli/index.ts insights classifier-facts --limit=2 => shows recent canonical tool failures
  - classifier_result-origin cites_evidence target counts after smoke:
    - turn: 2722
    - tool_call: 809
  - recent_tool_failure edge ids => 809
known gaps:
  - File evidence edges are still missing.
  - Harness candidate query is still missing.
  - Fixture count remains 12/12.
next iteration:
  - Add file evidence by joining canonical tool_call rows through edited/read/searched file relations where available, or add classifier-outcomes if file linkage is too sparse.
```

## Iteration Plan

### 1. Fact Inspection View

Add an insight view that returns recent classifier facts with the user turn,
previous assistant turn, evidence JSON, and signals.

Acceptance:

- `axctl insights classifier-facts --limit=20` works.
- Unit tests assert the SQL joins `classifier_result`, `turn`, and prior context.
- Output is human-readable and does not dump unformatted JSON blobs.

### 2. Correction Contexts View

Add a correction-focused query:

```text
correction fact -> user turn -> previous assistant -> recent failed tool calls
```

Acceptance:

- `axctl insights correction-contexts --limit=20` works.
- Query filters `classifier_key = "correction-event"` or `label = "correction"`.
- Tests cover SQL shape and formatter output.

### 3. Evidence Edge Expansion

Persist more explicit evidence edges from classifier results:

- `classifier_result -> cites_evidence -> previous assistant turn`
- `classifier_result -> cites_evidence -> recent failed tool_call`
- `classifier_result -> cites_evidence -> touched file`, when available

Acceptance:

- Repository tests assert new `RELATE ... ->cites_evidence` statements.
- Schema supports heterogeneous evidence targets already; avoid schema churn
  unless a field/index is actually needed.
- Re-ingest does not duplicate edges.

### 4. Fact Action Outcome View

Add a query that shows what happened after a classified fact:

```text
fact turn -> later tool calls -> command outcomes -> later user reaction
```

Acceptance:

- `axctl insights classifier-outcomes --limit=20` works.
- At least one test asserts later-tool/later-outcome query shape.
- Output helps identify whether the agent recovered, verified, or repeated the
  issue.

### 5. Harness Candidate View

Group repeated facts into candidate harness/guidance improvements:

```text
same classifier_key/label/target/durability
  + repeated sessions
  + supporting examples
  + likely harness layer
```

Acceptance:

- `axctl insights harness-candidates --limit=20` works.
- Query returns count, session count, last seen, examples, and suggested layer.
- Tests cover grouping and formatter labels.

### 6. Facts Service

Add an Effect service that returns relevant facts for a turn/session/repo. This
is the API future agent harnesses should consume.

Acceptance:

- Service methods:
  - `forTurn(turnId)`
  - `forSession(sessionId, limit)`
  - `forRepo(repositoryKey, limit)` if repo/session links are available
- Tests use mocked `SurrealClient`.
- No CLI depends on ad hoc SQL when the service can be shared.

### 7. Package Another Classifier

Move or create one more classifier package, preferably `correction-event` or
`direction-event`, with manifest, fixtures, and package-local tests.

Acceptance:

- `classifiers list --json` shows at least two package classifiers.
- `classifiers eval` remains green.
- Docs show package author workflow with two examples.

### 8. Fixture Growth And False Positive Guards

Grow fixtures from 12 to at least 24 strong cases:

- corrections needing previous context
- directions that are only one-off, not durable
- verification requests that are not correction
- negative examples that must emit no result

Acceptance:

- `classifiers eval` reports at least 24/24.
- At least 6 cases use `reject`.
- At least 4 cases assert `durability`.

### 9. DB Smoke Script

Add a local script or documented command set that runs ingest, insights, and
explain against a local SurrealDB.

Acceptance:

- One command can produce a smoke report.
- Report includes counts for classifier facts, evidence edges, themes, and
  candidate rows.
- Script exits non-zero if core views are empty after ingest when source data
  exists.

### 10. Promotion-Ready Candidate Contract

Define the handoff from harness candidate query to proposal/promotion without
auto-mutating guidance.

Acceptance:

- Candidate row includes stable id/dedupe signature.
- Candidate row includes evidence links.
- Candidate row includes proposed harness layer and action kind.
- Docs explain how a human or future agent can accept/reject it.

## Non-Goals

Do not build these during the 10-iteration run:

- Hosted classifier registry.
- Dynamic npm package installation.
- LLM judge by default over raw transcripts.
- Automatic edits to `AGENTS.md`, skills, hooks, or harness files.
- Large model artifact download.
- Private transcript export to public packages.

## Working Rules

- Prefer cheap deterministic classifiers before LLM review.
- Every new fact must retain evidence.
- Every query must answer a user-facing question.
- New graph edges need tests and a smoke command.
- Package classifiers must ship fixtures.
- Do not add schema fields unless a query or persistence path uses them.
- Keep results versioned; never overwrite meaning across classifier versions.

## Definition Of Done

This goal is complete when:

- Classifier facts are discoverable through at least 6 insight views.
- Facts cite at least 4 kinds of evidence.
- There is at least one harness candidate query backed by classifier facts.
- At least 24 fixture cases pass.
- At least two classifiers are package-shaped.
- Focused tests and typecheck pass.
- A DB smoke path demonstrates ingest -> facts -> evidence -> candidates.

## Iteration Log

### 1. Classifier Fact Views

Date: 2026-05-30

Changes:

- Added `classifier-facts` and `correction-contexts` insight views.
- Joined classifier facts to user turn, previous assistant turn, and recent tool failures.
- Added focused SQL builder and CLI formatter tests.

Results:

- `bun src/cli/index.ts classifiers eval` -> `12/12 passed`.
- `bun test src/queries/insights.test.ts src/cli/insights-format.test.ts src/cli/effect-cli.test.ts` -> passed.
- DB smoke for `classifier-facts` and `correction-contexts` returned real rows.

Known gaps:

- Facts were visible but not yet persisted as evidence edges.
- Outcome/harness discovery was still missing.

### 2. Classifier Evidence Edges

Date: 2026-05-30

Changes:

- Added classifier evidence refs to classifier persistence.
- Wrote `classifier_result -> cites_evidence -> turn/tool_call` style edges for previous assistant context and recent failures.
- Added reset cleanup for classifier-origin `cites_evidence` edges.

Results:

- Focused classifier persistence tests passed.
- DB smoke showed classifier facts could cite prior turns and failure evidence.

Known gaps:

- Canonical `tool_call` evidence was not yet preferred over transcript-derived tool result turns.

### 3. Canonical Tool Evidence

Date: 2026-05-30

Changes:

- Enriched event windows with canonical `tool_call` rows.
- Preferred `tool_call` evidence refs for recent tool failures.
- Kept transcript turn fallback for providers without canonical tool rows.

Results:

- `bun test src/ingest/classifier-results.test.ts` proved `tool_call:tc1` becomes a `recent_tool_failure` evidence ref.
- DB smoke after ingest showed classifier-result `cites_evidence` targets:
  - `turn`: 2722
  - `tool_call`: 809
  - `recent_tool_failure`: 809

Known gaps:

- File evidence and outcome grouping were still missing.

### 4. Classifier Outcome View

Date: 2026-05-30

Changes:

- Added `classifier-outcomes` insight view connecting classifier facts to later tool calls, command outcomes, and later user turns.
- Added compact CLI formatting for the outcome rows.
- Added focused SQL and formatter tests.

Results:

- `bun src/cli/index.ts classifiers eval` -> `12/12 passed`.
- `bun test src/classifiers/service.test.ts src/classifiers/eval.test.ts src/classifiers/list.test.ts` -> `8 pass, 0 fail`.
- `bun test src/classifiers/core.test.ts src/classifiers/event-window.test.ts src/classifiers/repository.test.ts src/ingest/classifier-results.test.ts src/queries/insights.test.ts src/cli/insights-format.test.ts src/cli/effect-cli.test.ts` -> `64 pass, 0 fail`.
- `bun run typecheck` -> exits `0`; existing Effect language-service advisories remain informational.
- `bun src/cli/index.ts insights classifier-outcomes --limit=3` -> returned real rows with fact, next tool, command outcome, and later user turn context.

Known gaps:

- Harness candidate query is still missing.
- File evidence edges are still missing.
- Fixture count remains `12/12`.

Next iteration:

- Add `harness-candidates` insight view grouping repeated classifier fact/outcome patterns into proposed harness layers and actions.

### 5. Harness Candidate View

Date: 2026-05-30

Changes:

- Added `harness-candidates` insight view that groups repeated classifier fact patterns by classifier, label, target, and durability.
- Added deterministic dedupe signature output for each candidate group.
- Added proposed harness layer and action classification for verification, environment, representation, guidance, and triage candidates.
- Attached recent example facts with their classifier evidence refs.
- Added compact CLI formatting for candidate rows.

Results:

- `bun src/cli/index.ts classifiers eval` -> `12/12 passed`.
- `bun test src/classifiers/service.test.ts src/classifiers/eval.test.ts src/classifiers/list.test.ts` -> `8 pass, 0 fail`.
- `bun test src/classifiers/core.test.ts src/classifiers/event-window.test.ts src/classifiers/repository.test.ts src/ingest/classifier-results.test.ts src/queries/insights.test.ts src/cli/insights-format.test.ts src/cli/effect-cli.test.ts` -> `66 pass, 0 fail`.
- `bun run typecheck` -> exits `0`; existing Effect language-service advisories remain informational.
- `bun src/cli/index.ts insights harness-candidates --limit=5` -> returned real rows with signatures, proposed actions, examples, and evidence refs.

Known gaps:

- Fixture count remains `12/12`; target is at least `24/24`.
- Classifier package count remains `1`; target is at least `2`.
- File evidence edges are still missing.
- Candidate rows are query-only; promotion into `proposal` / `guidance_proposal` is not wired yet.

Next iteration:

- Add file evidence edges from classifier results by linking relevant post-fact tool calls through edited/read/searched file relations where available.

### 6. File Evidence Edges

Date: 2026-05-30

Changes:

- Added `kind` metadata to `cites_evidence` so classifier evidence edges can be queried by role.
- Switched classifier evidence relation ids to short deterministic hashes to avoid long-key relation collisions.
- Incremental classifier persistence now deletes existing evidence edges for each result before recreating the current evidence set.
- Classifier result ingest now fetches `edited` relations and emits `classifier_result -> cites_evidence -> file` refs for recent edited files before the classified user turn.

Results:

- `bun run db:schema` -> schema applied to `ax/main`.
- `bun src/cli/index.ts ingest --stages=classifier-results --since=7 --progress=plain` -> exits `0`.
- Classifier-result evidence target counts after smoke:
  - `file / recent_edited_file`: 240
  - `tool_call / recent_tool_failure`: 809
  - `turn / classified_turn`: 547
  - `turn / previous_assistant`: 336
  - legacy no-kind turn edges: 1839
- `bun src/cli/index.ts classifiers eval` -> `12/12 passed`.
- `bun test src/classifiers/service.test.ts src/classifiers/eval.test.ts src/classifiers/list.test.ts` -> `8 pass, 0 fail`.
- `bun test src/classifiers/core.test.ts src/classifiers/event-window.test.ts src/classifiers/repository.test.ts src/ingest/classifier-results.test.ts src/queries/insights.test.ts src/cli/insights-format.test.ts src/cli/effect-cli.test.ts schema/schema.test.ts` -> `86 pass, 0 fail`.
- `bun run typecheck` -> exits `0`; existing Effect language-service advisories remain informational.

Known gaps:

- Fixture count remains `12/12`; target is at least `24/24`.
- Classifier package count remains `1`; target is at least `2`.
- File evidence currently uses `edited`; `read_file` and `searched_file` classifier evidence are not wired yet.
- Promotion from `harness-candidates` into proposal rows is still missing.

Next iteration:

- Grow fixtures and false-positive guards, or add the second package-shaped classifier before wiring proposal promotion.

### 7. Second Package And Fixture Growth

Date: 2026-05-30

Changes:

- Added `@ax-classifier/direction-event` workspace package with manifest, package-local tests, and package-local eval fixtures.
- Registered `direction-event` as a package classifier with package manifest and fixture paths.
- Updated classifier package docs to show both `verification-event` and `direction-event` package examples.
- Grew golden fixtures from `12` to `26` cases.
- Added six reject-guard cases and fourteen durability assertions across direction, correction, reaction, and verification suites.

Results:

- `bun src/cli/index.ts classifiers eval` -> `26/26 passed`.
- `bun src/cli/index.ts classifiers list --json` -> shows two package classifiers:
  - `@ax-classifier/direction-event`
  - `@ax-classifier/verification-event`
- `bun test src/classifiers/service.test.ts src/classifiers/eval.test.ts src/classifiers/list.test.ts src/classifiers/package-manifest.test.ts packages/ax-classifier-direction-event/src/index.test.ts packages/ax-classifier-verification-event/src/index.test.ts` -> `17 pass, 0 fail`.
- `bun test src/classifiers/core.test.ts src/classifiers/event-window.test.ts src/classifiers/repository.test.ts src/ingest/classifier-results.test.ts src/queries/insights.test.ts src/cli/insights-format.test.ts src/cli/effect-cli.test.ts schema/schema.test.ts` -> `86 pass, 0 fail`.
- `bun run typecheck` -> exits `0`; existing Effect language-service advisories remain informational.
- Fixture metadata check -> `total=26`, `rejectCases=6`, `durabilityExpectations=14`.

Known gaps:

- Facts service is still missing.
- DB smoke script is still missing.
- Promotion from `harness-candidates` into proposal rows is still missing.
- Read/search file evidence is still not linked to classifier facts.

Next iteration:

- Add the shared classifier facts service so CLI/dashboard/future harness consumers do not depend on ad hoc SQL strings.

### 8. Classifier Facts Service

Date: 2026-05-30

Changes:

- Added `ClassifierFactsService` as a shared Effect service over classifier facts.
- Added methods:
  - `forTurn(turnId)`
  - `forSession(sessionId, limit)`
  - `forRepo(repositoryKey, limit)`
- Service rows include classifier fact fields plus nested `cites_evidence` refs with evidence table and kind.
- Added mocked `SurrealClient` tests for turn/session/repo query shape and invalid limit handling.

Results:

- `bun test src/classifiers/facts.test.ts` -> `4 pass, 0 fail`.
- `bun src/cli/index.ts classifiers eval` -> `26/26 passed`.
- `bun test src/classifiers/service.test.ts src/classifiers/eval.test.ts src/classifiers/list.test.ts src/classifiers/package-manifest.test.ts src/classifiers/facts.test.ts packages/ax-classifier-direction-event/src/index.test.ts packages/ax-classifier-verification-event/src/index.test.ts` -> `21 pass, 0 fail`.
- `bun test src/classifiers/core.test.ts src/classifiers/event-window.test.ts src/classifiers/repository.test.ts src/ingest/classifier-results.test.ts src/queries/insights.test.ts src/cli/insights-format.test.ts src/cli/effect-cli.test.ts schema/schema.test.ts` -> `86 pass, 0 fail`.
- `bun run typecheck` -> exits `0`; existing Effect language-service advisories remain informational.

Known gaps:

- CLI insight views still use SQL builders directly; the service is ready for dashboard/harness reuse but not yet adopted by command handlers.
- DB smoke script is still missing.
- Promotion from `harness-candidates` into proposal rows is still missing.
- Read/search file evidence is still not linked to classifier facts.

Next iteration:

- Add a DB smoke script/report that proves ingest -> classifier facts -> evidence -> harness candidates in one command.

### 9. Classifier DB Smoke Report

Date: 2026-05-30

Changes:

- Added `scripts/classifier-smoke.ts`.
- Added `bun run classifiers:smoke` package script.
- Smoke command runs `classifier-results` ingest, then reports:
  - recent source user turns
  - recent classifier facts
  - classifier evidence edge counts by target table and kind
  - classifier theme rows
  - harness candidate rows and top candidate summaries
- Smoke command exits non-zero when source turns exist but fact, evidence,
  theme, or candidate surfaces are empty.
- Documented the smoke report in `docs/classifiers.md` and added it to the
  goal benchmark command list.

Results:

- `bun run classifiers:smoke -- --days=7 --limit=5` -> exits `0`.
- Smoke report:
  - source turns: 18286
  - classifier facts: 538
  - classifier evidence edges: 3771
  - classifier themes: 5
  - harness candidates: 5
  - evidence includes `file / recent_edited_file`, `tool_call / recent_tool_failure`, `turn / classified_turn`, and `turn / previous_assistant`.
- `bun test scripts/classifier-smoke.test.ts src/classifiers/service.test.ts src/classifiers/eval.test.ts src/classifiers/list.test.ts src/classifiers/package-manifest.test.ts src/classifiers/facts.test.ts packages/ax-classifier-direction-event/src/index.test.ts packages/ax-classifier-verification-event/src/index.test.ts` -> `24 pass, 0 fail`.
- `bun test src/classifiers/core.test.ts src/classifiers/event-window.test.ts src/classifiers/repository.test.ts src/ingest/classifier-results.test.ts src/queries/insights.test.ts src/cli/insights-format.test.ts src/cli/effect-cli.test.ts schema/schema.test.ts` -> `86 pass, 0 fail`.
- `bun src/cli/index.ts classifiers eval` -> `26/26 passed`.
- `bun run typecheck` -> exits `0`; existing Effect language-service advisories remain informational.

Known gaps:

- Promotion-ready candidate contract docs are still missing.
- Read/search file evidence is still not linked to classifier facts.

Next iteration:

- Define the promotion-ready handoff contract for `harness-candidates`, including stable signature, evidence links, proposed action, and human accept/reject flow.

### 10. Promotion-Ready Candidate Contract

Date: 2026-05-30

Changes:

- Added stable `candidate_id` values to `harness-candidates` rows.
- Kept `dedupe_signature`, `proposed_layer`, `proposed_action`, examples, and nested evidence refs in each candidate row.
- Updated candidate CLI formatting to show the candidate id and signature.
- Added `docs/classifier-candidate-contract.md` documenting candidate identity, evidence, proposed actions, accept flow, and reject flow.
- Linked the contract from `docs/classifiers.md`.

Results:

- `bun src/cli/index.ts insights harness-candidates --limit=3` -> exits `0` and shows candidate ids, signatures, examples, and evidence refs.
- `bun run classifiers:smoke -- --days=7 --limit=5` -> exits `0`.
- Smoke report:
  - source turns: 18286
  - classifier facts: 538
  - classifier evidence edges: 3771
  - classifier themes: 5
  - harness candidates: 5
  - evidence includes `file / recent_edited_file`, `tool_call / recent_tool_failure`, `turn / classified_turn`, and `turn / previous_assistant`.
- `bun src/cli/index.ts classifiers eval` -> `26/26 passed`.
- `bun test scripts/classifier-smoke.test.ts src/classifiers/service.test.ts src/classifiers/eval.test.ts src/classifiers/list.test.ts src/classifiers/package-manifest.test.ts src/classifiers/facts.test.ts packages/ax-classifier-direction-event/src/index.test.ts packages/ax-classifier-verification-event/src/index.test.ts` -> `24 pass, 0 fail`.
- `bun test src/classifiers/core.test.ts src/classifiers/event-window.test.ts src/classifiers/repository.test.ts src/ingest/classifier-results.test.ts src/queries/insights.test.ts src/cli/insights-format.test.ts src/cli/effect-cli.test.ts schema/schema.test.ts` -> `86 pass, 0 fail`.
- `bun test src/queries/insights.test.ts src/cli/insights-format.test.ts scripts/classifier-smoke.test.ts` -> `36 pass, 0 fail`.
- `bun run typecheck` -> exits `0`; existing Effect language-service advisories remain informational.

Known gaps:

- Read/search file evidence is still not linked to classifier facts.
- CLI insight views still use SQL builders directly even though the shared `ClassifierFactsService` exists.
- Candidate accept/reject is documented as a contract, not yet persisted as proposal rows.
