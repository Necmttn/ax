# Turn Feedback Graph Design

## Goal

Capture sparse human feedback and agent message behavior as queryable ax-signals, not generic sentiment analytics.

## Product Fit

The origin story for ax is that agent capability grows while human feedback density collapses. The important signal is already present in turns: corrections, approvals, rejection language, uncertainty, assistant blockers, verification claims, and repeated user phrasing. This feature turns those scattered messages into graph evidence that can be read immediately and later feed proposals, experiments, and verdicts.

## Scope

V0 is local and heuristic-only. It analyzes existing `turn` rows and writes:

- `turn_analysis`: one row per analyzed turn, linked to `turn` and `session`.
- `semantic_signal`: reusable meaning nodes such as `wrong_target`, `needs_verification`, `approval`, `agent_blocked`, and `exploration`.
- `expresses`: relation from `turn` to `semantic_signal`.
- `reacts_to`: relation from a user turn to the prior assistant turn it appears to approve, reject, correct, or revise.

Every written record must have a read path in V0.

## Read Surface

V0 adds two insight queries:

- `feedback-language`: repeated user phrases and signals, ordered by correction/rejection/failure proximity.
- `message-signals`: top semantic signals with counts, session coverage, examples, and last seen.

`sessions show` can later render the labels inline, but V0 must expose the data through insights first so nothing is orphaned.

## Non-Goals

- No embeddings in V0.
- No required LLM calls in ingest.
- No standalone dashboard UI changes in V0.
- No proposal generation directly from this feature until the read queries prove useful.

## Classifier

The heuristic classifier assigns:

- `speaker`: `user`, `assistant`, or `tool`
- `act`: `request`, `correction`, `approval`, `rejection`, `clarification`, `exploration`, `status_update`, `implementation`, `verification`, `blocker`, `handoff`, `tool_result`, or `other`
- `sentiment`: `positive`, `neutral`, `negative`, `mixed`, or `unknown`
- `polarity`: `accept`, `reject`, `revise`, `explore`, or `none`
- `confidence`: `0..1`
- `signals`: JSON array of matched features

Repeated or important acts promote to `semantic_signal` nodes. Low-confidence rows remain in `turn_analysis` but are not promoted unless they match a stable signal key.

## Graph Semantics

`semantic_signal` is the reusable meaning. It should be stable across sessions and provider types.

`turn_analysis` is per-turn evidence.

`expresses` connects evidence to meaning.

`reacts_to` connects a user reaction to the nearest prior assistant turn in the same session when the polarity is `accept`, `reject`, or `revise`.

This keeps the graph useful for questions like:

- Which user corrections repeat across weeks?
- Which assistant behaviors attract rejection or revision?
- Which positive signals follow verification?
- Which feedback signals appear near tool failures or edits?

## Success Criteria

- Running the derive stage creates no rows that are invisible from CLI insights.
- Insight queries return examples with turn/session references.
- Re-running the stage is idempotent.
- Existing correction and n-gram behavior remains intact.
