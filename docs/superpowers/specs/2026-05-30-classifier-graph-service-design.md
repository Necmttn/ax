# Classifier Graph Service Design

## Goal

Build a cheap, extensible classification layer over local agent transcripts so
ax can turn repeated user feedback, runtime corrections, review findings, and
workflow preferences into graph evidence.

The feature should avoid brute-force LLM classification. Cheap classifiers run
first over local event windows. LLM review is reserved for later promotion
steps, where a clustered pattern may become durable guidance, a hook, a skill,
or an experiment.

## Review Response And Phase Boundary

Fabijons reviewed this plan and called out the main risk: the design was
trying to define a classifier ecosystem before proving the graph contract.

The working boundary is now:

- **v0 builds only the boring graph core.**
- **Training, external package loading, hosted registries, lazy model assets,
  and LLM review are explicitly non-v0.**
- **Classifier output must be useful as graph evidence before any promotion,
  package, or model-training layer is built.**

### Phase 0: Existing Prototype Reality

Current state:

- `reaction_event` exists as the first specialized table.
- `reaction-events` derives context-aware reaction rows from turns.
- Existing cheap labels already find examples like `can you use UV ?` and
  `i dont want just html i want to see the results`.

Phase 1 should treat this as migration context, not as a blank slate. The
generic classifier model must either subsume `reaction_event` or keep it as a
compatibility surface with a clear read path.

### Phase 1: Classifier Core

Build:

- deterministic `EventWindow`
- pure TypeScript `ClassifierDefinition`
- `ClassifierRegistry`
- `ClassifierRunner`
- `ClassifierRepository`
- `classifier_run`
- `classifier_result`
- `classifier-themes` and `classifier-results` insights

Do not build in Phase 1:

- training
- external packages
- lazy assets
- LLM review
- automatic guidance mutation
- session-health scoring from classifier labels

### Phase 2: Reports And Manual Promotion

Build cluster reports and markdown/manual review surfaces. A human can accept
or reject a cluster before it becomes a proposal, guidance edit, hook, or skill.

No automatic graph mutation beyond classifier results and run metadata.

### Phase 3: Contributor API

Add repo-native classifier modules with fixtures and docs:

```text
src/classifiers/<key>/
  index.ts
  fixtures.ts
  README.md
  <key>.test.ts
```

This is the first open-source contribution model.

### Phase 4: Packages And Training

External packages, datasets, model artifacts, and training hooks are future
work. They require a privacy/security review and a proven graph contract first.

Phase 4 also requires a model evaluation and evolution gate. No trained model
artifact should become active only because training completed.

## Product Question

The classifier layer must answer:

- What did the user correct, steer, approve, reject, or clarify?
- What assistant behavior or runtime context caused that reaction?
- Which corrections repeat across sessions or projects?
- Which preferences are durable enough to become guidance?
- Which failures should become hooks, checks, or skills?
- Did an accepted guidance/intervention reduce future correction rate?

The output is not just labels. The output is graph evidence that completes the
picture around sessions, turns, tools, files, guidance, proposals, and
experiments.

## Core Model

### Event Window

An `event_window` is the shared input unit for cheap classifiers.

For v0, event windows are rebuilt on demand and only classifier results are
persisted. Materialized `event_window` rows can be added later if recomputation
cost or debugging requires it.

The v0 event window is deterministic:

- `user_turn`: the user turn being interpreted.
- `previous_assistant_turn`: nearest prior assistant turn in the session.
- `recent_tool_calls`: at most 5 tool calls before the user turn, same
  session, ordered by `seq DESC`, then re-sorted ascending before presenting to
  classifiers.
- `recent_tool_failures`: failed tool calls from that same recent set.
- `recent_files`: files edited/read/searched by those recent tool calls when
  graph edges exist.
- `session`: source, cwd, repository, checkout, objective when available.
- `existing_labels`: current `turn_analysis`, `semantic_signal`,
  `reacts_to`, `command_outcome`, and `session_health` context.

Exclusions:

- wrapper/context/developer/system messages are not event-window subjects
- subagent notifications are excluded from v0 classifier subjects unless a
  classifier explicitly opts into review-payload classification
- tool output excerpts are truncated before classifier input
- raw full transcript text is not copied into classifier evidence

The event window is deliberately broader than a single message. A message like
`can you use UV ?` only becomes useful when paired with the previous package
setup struggle.

### Classifier Result

A `classifier_result` row is one classifier's output over one event window or
turn.

Suggested fields:

- `classifier_key`: stable classifier id, such as `reaction-event`,
  `review-feedback`, `runtime-state`, `reuse-existing-infra`,
  `reference-compliance`, or `frontend-taste`.
- `subject_type`: `event_window`, `turn`, `session`, `tool_call`, or
  `reaction_event`.
- `subject_id`: record id string for the classified subject.
- `session`: optional `session` record.
- `turn`: optional `turn` record.
- `label`: primary label.
- `target`: thing being corrected, requested, or affected.
- `polarity`: `accept`, `reject`, `revise`, `explore`, or `none`.
- `durability`: `one_off`, `session_preference`, `repo_preference`,
  `global_preference`, or `candidate_guidance`.
- `confidence`: `0..1`.
- `method`: v0 supports `heuristic` and `manual`. `local_model` and
  `llm_review` are future methods.
- `evidence_json`: compact JSON with quoted turn excerpts, prior assistant
  context, tool failures, files, and matched rules.
- `ts`: timestamp of the subject event.

This keeps each classifier independently addable without schema churn.

Deterministic result id:

```text
hash(classifier_key, classifier_version, subject_type, subject_id, label, target)
```

One classifier may emit multiple labels for the same subject as long as each
label/target pair has a distinct result id.

Classifier version changes do not overwrite old rows. New versions write new
`classifier_result` ids. Reports default to the latest registered version per
classifier unless `--all-versions` is requested.

## Effect Service Shape

The classifier layer should be built as small Effect services with explicit
contracts. Classifier implementations should stay pure where possible; DB,
training artifacts, and run telemetry live behind services.

### Domain Types

Core domain classes should be defined with `Schema.Class` so classifier IO can
be validated, persisted, and tested.

Phase 1 domain types:

- `ClassifierKey`: branded string.
- `ClassifierVersion`: string such as `0.1.0`.
- `ClassifierKind`: v0 uses `heuristic` and `manual`.
- `ClassifierDefinition`: metadata and callable classifier contract.
- `EventWindow`: shared context around a user turn or other subject.
- `ClassifierResult`: one label emitted by one classifier.
- `ClassifierRun`: persisted execution metadata for an ingest/backfill run.

Errors should be tagged:

- `ClassifierNotFound`
- `ClassifierInputError`
- `ClassifierPersistenceError`

### Classifier Definition

A classifier definition is the unit developers add when they want a new
classifier.

Conceptual TypeScript shape:

```ts
interface ClassifierDefinition {
    readonly key: ClassifierKey;
    readonly version: ClassifierVersion;
    readonly kind: ClassifierKind;
    readonly description: string;
    readonly input: "event_window" | "turn" | "session" | "tool_call";
    readonly labels: readonly string[];
    readonly targets: readonly string[];
    readonly classify: (
        input: EventWindow,
    ) => Effect.Effect<readonly ClassifierResult[], ClassifierInputError>;
}
```

Rules:

- `classify` should be deterministic for heuristic classifiers.
- Results include evidence, not just labels.
- Classifier definitions do not write to SurrealDB directly.
- Version changes when behavior or output schema meaning changes.

### ClassifierRegistry

`ClassifierRegistry` owns discovery and selection.

Contract:

```ts
class ClassifierRegistry extends Context.Service<ClassifierRegistry, {
    readonly all: () => readonly ClassifierDefinition[];
    readonly byKey: (key: string) => Option.Option<ClassifierDefinition>;
    readonly byKind: (kind: ClassifierKind) => readonly ClassifierDefinition[];
    readonly select: (keys: readonly string[]) =>
        Effect.Effect<readonly ClassifierDefinition[], ClassifierNotFound>;
}>()(
    "ax/ClassifierRegistry",
) {}
```

This mirrors the repo-local `StageRegistry` pattern. Implementations should
hide dependencies inside Layers and use `Effect.fn` for non-trivial methods.

### EventWindowBuilder

`EventWindowBuilder` reads graph context and creates the shared classifier
input.

Contract:

```ts
class EventWindowBuilder extends Context.Service<EventWindowBuilder, {
    readonly recent: (opts: { readonly sinceDays: number }) =>
        Effect.Effect<readonly EventWindow[], DbError>;
    readonly backfillBatch: (opts: {
        readonly after?: string;
        readonly limit: number;
    }) => Effect.Effect<readonly EventWindow[], DbError>;
    readonly forTurn: (turnId: string) =>
        Effect.Effect<Option.Option<EventWindow>, DbError>;
}>()(
    "ax/EventWindowBuilder",
) {}
```

This service should be the only place that decides the context window:
previous assistant turn, recent tool failures, file activity, session metadata,
and existing graph labels.

### ClassifierRunner

`ClassifierRunner` executes selected classifiers over event windows and returns
results. It does not choose persistence policy.

Contract:

```ts
class ClassifierRunner extends Context.Service<ClassifierRunner, {
    readonly runWindow: (input: {
        readonly window: EventWindow;
        readonly classifiers: readonly ClassifierDefinition[];
    }) => Effect.Effect<readonly ClassifierResult[], ClassifierInputError>;
    readonly runBatch: (input: {
        readonly windows: readonly EventWindow[];
        readonly classifiers: readonly ClassifierDefinition[];
    }) => Effect.Effect<readonly ClassifierResult[], ClassifierInputError>;
}>()(
    "ax/ClassifierRunner",
) {}
```

`runBatch` should support bounded concurrency later, but the first slice can be
sequential because cheap heuristics are fast and easier to verify.

### ClassifierTrainer

Training is non-v0. Keep this section as future design context only.

`ClassifierTrainer` is optional per classifier. Heuristic classifiers return
`Option.none` for training capability.

Contract:

```ts
interface TrainableClassifier extends ClassifierDefinition {
    readonly train: (dataset: TrainingDataset) =>
        Effect.Effect<TrainingRun, ClassifierTrainingError>;
}

class ClassifierTrainer extends Context.Service<ClassifierTrainer, {
    readonly buildDataset: (input: {
        readonly classifierKey: string;
        readonly sinceDays?: number;
        readonly labelSource: "heuristic" | "manual" | "brief";
    }) => Effect.Effect<TrainingDataset, DbError | ClassifierInputError>;
    readonly train: (input: {
        readonly classifierKey: string;
        readonly dataset: TrainingDataset;
    }) => Effect.Effect<TrainingRun, ClassifierTrainingError | ClassifierNotFound>;
}>()(
    "ax/ClassifierTrainer",
) {}
```

Training should produce a persisted artifact and metrics, not mutate classifier
results directly. A later run chooses whether to use the trained model.

### ClassifierRepository

`ClassifierRepository` persists definitions, runs, results, training runs, and
model artifacts.

Contract:

```ts
class ClassifierRepository extends Context.Service<ClassifierRepository, {
    readonly saveDefinitions: (
        definitions: readonly ClassifierDefinition[],
    ) => Effect.Effect<void, DbError>;
    readonly startRun: (input: StartClassifierRun) =>
        Effect.Effect<ClassifierRun, DbError>;
    readonly saveResults: (
        run: ClassifierRun,
        results: readonly ClassifierResult[],
    ) => Effect.Effect<void, DbError>;
    readonly finishRun: (input: FinishClassifierRun) =>
        Effect.Effect<void, DbError>;
    readonly saveTrainingRun: (
        run: TrainingRun,
    ) => Effect.Effect<void, DbError>;
}>()(
    "ax/ClassifierRepository",
) {}
```

Persistence is intentionally separate from `ClassifierRunner` so tests can run
classification without SurrealDB, and ingest/backfill can decide when to flush.

### ClassifierBackfillService

`ClassifierBackfillService` coordinates long-running work.

Contract:

```ts
class ClassifierBackfillService extends Context.Service<ClassifierBackfillService, {
    readonly runRecent: (input: {
        readonly classifierKeys: readonly string[];
        readonly sinceDays: number;
    }) => Effect.Effect<ClassifierRun, ClassifierServiceError>;
    readonly runBackfill: (input: {
        readonly classifierKeys: readonly string[];
        readonly batchSize: number;
        readonly resume: boolean;
    }) => Effect.Effect<ClassifierRun, ClassifierServiceError>;
    readonly runTopic: (input: {
        readonly classifierKeys: readonly string[];
        readonly query: string;
        readonly sinceDays?: number;
    }) => Effect.Effect<ClassifierRun, ClassifierServiceError>;
}>()(
    "ax/ClassifierBackfillService",
) {}
```

This is the service used by CLI commands and ingest stages.

### Service Composition

Production layer:

```text
ClassifierBackfillService
  depends on ClassifierRegistry
  depends on EventWindowBuilder
  depends on ClassifierRunner
  depends on ClassifierRepository
  depends on SurrealClient
```

Training layer:

```text
ClassifierTrainer
  depends on ClassifierRegistry
  depends on ClassifierRepository
  depends on SurrealClient
  optionally depends on ProcessService for Python/uv/local model training
```

Pure tests should provide:

- in-memory `ClassifierRegistry`
- fixture `EventWindowBuilder`
- no-op/in-memory `ClassifierRepository`

Integration tests should cover the SurrealDB repository separately.

## Open Source Contribution Model

The classifier system should be easy for outside contributors to extend without
needing access to the maintainer's private transcript graph.

The first version should use repo-native classifier modules, not arbitrary
runtime plugins. This keeps review, testing, and security simple while still
making classifiers independently addable.

### Contribution Unit

A contributed classifier should be one folder:

```text
src/classifiers/<classifier-key>/
  index.ts
  fixtures.ts
  README.md
  <classifier-key>.test.ts
```

`index.ts` exports one `ClassifierDefinition`.

`fixtures.ts` exports redacted `EventWindow` fixtures that prove the classifier
behavior without private user data.

`README.md` explains:

- what the classifier detects
- what labels and targets it emits
- examples of positive and negative matches
- when not to use it
- what downstream surfaces consume it

The root registry imports `index.ts` and adds the classifier to the canonical
list.

### Public Classifier API

The public API should be a small stable surface, exported from one module:

```ts
import {
    defineClassifier,
    label,
    type ClassifierDefinition,
    type EventWindow,
    type ClassifierResult,
} from "@ax/classifiers";
```

Contributors should not import private DB helpers, Surreal query builders, or
ingest internals.

Example:

```ts
export default defineClassifier({
    key: "reuse-existing-infra",
    version: "0.1.0",
    kind: "heuristic",
    input: "event_window",
    labels: ["reuse_existing", "preferred_library", "avoid_handrolled"],
    targets: ["implementation_choice", "environment_setup"],
    classify: (window) => [
        label(window, {
            label: "reuse_existing",
            target: "implementation_choice",
            confidence: 0.84,
            evidence: {
                user: window.userTurn.text,
                previousAssistant: window.previousAssistantTurn?.text,
                matched: "reuse existing",
            },
        }),
    ],
});
```

`defineClassifier` should validate:

- key format
- version format
- declared labels/targets match emitted labels/targets
- deterministic result ids can be derived
- confidence is in `0..1`
- evidence is JSON-serializable

### Classifier Manifest

Each classifier should have machine-readable metadata, either embedded in
`index.ts` or generated from the definition.

Metadata:

- `key`
- `version`
- `owner`
- `stability`: `experimental`, `beta`, or `stable`
- `kind`: `heuristic`, `local_model`, `llm_review`, or `manual`
- `input`
- `labels`
- `targets`
- `docsPath`
- `fixtureCount`
- `createdAt`
- `updatedAt`

The CLI should expose this:

```bash
axctl classifiers list
axctl classifiers show reuse-existing-infra
axctl classifiers test reuse-existing-infra
```

### Stability Levels

Classifiers should not all carry equal authority.

- `experimental`: may change labels and behavior; excluded from automatic
  guidance proposals by default.
- `beta`: labels are mostly stable; included in reports but promotion requires
  stronger evidence.
- `stable`: labels are treated as durable graph vocabulary; breaking changes
  require migration notes.

Stable classifiers must document:

- label meanings
- examples
- false-positive risks
- downstream consumers
- migration policy

### Fixture Requirements

Every classifier must include fixture tests.

Minimum tests:

- one positive fixture for each emitted label
- one negative fixture for common false-positive risk
- one evidence-shape assertion
- one deterministic-id assertion if result ids are produced locally

Fixtures must be redacted and should look like realistic event windows:

```ts
export const useExistingInfraWindow = eventWindowFixture({
    user: "Can you reuse the existing recording pipeline instead of hand rolling?",
    previousAssistant: "I can build a new waveform registry from scratch.",
    recentToolFailures: [],
    files: ["src/recording/waveform.ts"],
});
```

### Documentation Structure

Public docs should include:

```text
docs/classifiers/
  README.md
  authoring.md
  api.md
  labels.md
  fixtures.md
  training.md
  privacy.md
```

`README.md`:

- what classifiers are
- how they fit the graph
- how to run recent classification
- how to inspect results

`authoring.md`:

- step-by-step classifier creation
- folder layout
- `defineClassifier` API
- fixture requirements
- review checklist

`api.md`:

- stable exported TypeScript API
- Effect service contracts
- result schema

`labels.md`:

- shared label taxonomy
- naming rules
- when to add a new label vs reuse an existing one

`fixtures.md`:

- how to create redacted fixtures
- examples of event windows
- false-positive/negative testing guidance

`training.md`:

- when a classifier can become trainable
- dataset format
- artifact persistence
- evaluation metrics
- local model constraints

`privacy.md`:

- no private transcript excerpts in commits
- fixture redaction rules
- how to report useful examples without leaking user data
- local-only backfill behavior

### Contributor Workflow

New classifier workflow:

```bash
axctl classifiers scaffold reuse-existing-infra
bun test src/classifiers/reuse-existing-infra/reuse-existing-infra.test.ts
bun src/cli/index.ts classifiers test reuse-existing-infra
bun src/cli/index.ts classify topic reuse-existing-infra --since=7
bun src/cli/index.ts insights classifier-themes --classifier=reuse-existing-infra
```

The scaffold command should create:

- folder layout
- starter classifier
- fixture file
- test file
- README template

The maintainer review should check:

- label names fit taxonomy
- fixtures are redacted
- false positives are tested
- output evidence is useful
- classifier is cheap and deterministic
- downstream graph use is documented

## Classifier Packages And Lazy Assets

This entire section is non-v0. Do not implement external classifier packages,
package training hooks, hosted registry URLs, or lazy model assets until Phase 1
has proven the graph contract and Phase 3 has proven repo-native classifier
contribution.

For open source sharing, classifiers should eventually be distributable as
packages. The package should be small by default and only download heavy
training data or model artifacts when the user asks for them.

This lets ax install quickly while still allowing richer classifiers to carry
datasets, examples, embeddings, ONNX files, or evaluation artifacts.

### Package Shape

A classifier package should contain a manifest, code, docs, and lightweight
fixtures.

```text
@ax-classifier/reuse-existing-infra
  package.json
  ax.classifier.json
  dist/index.js
  dist/index.d.ts
  README.md
  fixtures/
    positive.jsonl
    negative.jsonl
  datasets/
    manifest.json
  artifacts/
    manifest.json
```

The npm package should include:

- classifier definition code
- label/target taxonomy metadata
- small redacted fixtures
- dataset and artifact manifests
- docs

The npm package should not include large assets by default.

### Package Manifest

`ax.classifier.json` should be the stable metadata contract.

Example:

```json
{
  "schema": "ax.classifier.v1",
  "key": "reuse-existing-infra",
  "version": "0.1.0",
  "package": "@ax-classifier/reuse-existing-infra",
  "entry": "./dist/index.js",
  "kind": "heuristic",
  "stability": "experimental",
  "input": "event_window",
  "labels": ["reuse_existing", "preferred_library", "avoid_handrolled"],
  "targets": ["implementation_choice", "environment_setup"],
  "assets": {
    "fixtures": {
      "included": true,
      "size_bytes": 18000
    },
    "datasets": [
      {
        "name": "redacted-training-v1",
        "kind": "training_set",
        "optional": true,
        "size_bytes": 4200000,
        "sha256": "…",
        "url": "https://registry.ax.dev/classifiers/reuse-existing-infra/datasets/redacted-training-v1.jsonl"
      }
    ],
    "artifacts": [
      {
        "name": "centroid-v1",
        "kind": "centroid_json",
        "optional": true,
        "size_bytes": 96000,
        "sha256": "…",
        "url": "https://registry.ax.dev/classifiers/reuse-existing-infra/artifacts/centroid-v1.json"
      }
    ]
  }
}
```

The manifest lets ax inspect package capabilities without loading classifier
code or downloading assets.

### Lazy Asset Downloads

Training sets and model artifacts should be optional assets.

Commands:

```bash
axctl classifiers install @ax-classifier/reuse-existing-infra
axctl classifiers assets list reuse-existing-infra
axctl classifiers assets fetch reuse-existing-infra --dataset=redacted-training-v1
axctl classifiers assets fetch reuse-existing-infra --artifact=centroid-v1
axctl classifiers train reuse-existing-infra --dataset=redacted-training-v1
```

Asset storage:

```text
~/.local/share/ax/classifiers/
  reuse-existing-infra/
    package/
    assets/
      datasets/
      artifacts/
    cache/
```

Rules:

- verify `sha256` after download
- record downloaded assets in `classifier_artifact` or
  `classifier_dataset`
- never download optional assets during normal `ax install`
- never upload local private training data automatically
- allow deleting assets without uninstalling classifier code

### Dataset Packaging

Datasets should be JSONL and privacy-safe by default.

Dataset row shape:

```json
{
  "id": "fixture-001",
  "input": {
    "user": "Can you reuse the existing recording pipeline instead of hand rolling?",
    "previous_assistant": "I can build a new waveform registry from scratch.",
    "recent_tool_failures": [],
    "files": ["src/recording/waveform.ts"]
  },
  "labels": [
    {
      "label": "reuse_existing",
      "target": "implementation_choice",
      "durability": "repo_preference"
    }
  ],
  "source": {
    "kind": "redacted_fixture",
    "license": "MIT"
  }
}
```

Dataset policy:

- public datasets must be redacted and licensed
- private local datasets stay local
- package manifests can reference multiple datasets
- training runs record exact dataset name, hash, and row count
- dataset rows should avoid raw private transcript text unless explicitly local

### Package Registry

v0 can support npm packages directly. A later classifier registry can add
search, ranking, metadata, and asset hosting.

Possible commands:

```bash
axctl classifiers search reuse
axctl classifiers install @ax-classifier/reuse-existing-infra
axctl classifiers update reuse-existing-infra
axctl classifiers uninstall reuse-existing-infra
```

Registry metadata should include:

- package name
- classifier key
- version
- stability
- labels and targets
- asset sizes
- docs URL
- license
- minimum ax version

### Install Modes

Install should support three levels:

```bash
axctl classifiers install <pkg> --code-only
axctl classifiers install <pkg> --with-fixtures
axctl classifiers install <pkg> --with-assets
```

Defaults:

- `--code-only` for normal install
- fixtures included if they are already inside the npm package
- no training sets or model artifacts unless requested

This keeps ax lightweight but lets motivated users fetch richer packages.

### Security Model

Classifier packages execute code, so they need a trust model.

Initial policy:

- repo-native classifiers are trusted as part of ax
- external package install requires explicit user command
- package manifest is inspected before code is loaded
- classifier execution should not receive DB write access
- classifier code receives `EventWindow` data and returns `ClassifierResult`
- persistence is handled by ax services, not package code

Later policy:

- signed manifests
- allowlist registry
- package provenance metadata
- optional sandboxing for untrusted classifiers

### Training From Packages

Training should be reproducible and recorded.

When training a package classifier:

1. Resolve package manifest.
2. Ensure dataset asset is present or fetch it.
3. Build `TrainingDataset` from dataset JSONL.
4. Run package training hook or ax default trainer.
5. Persist `classifier_training_run`.
6. Persist produced `classifier_artifact`.
7. Mark artifact as available for future classifier runs.

Trainable package API:

```ts
export const train = (input: TrainingDataset) =>
    Effect.Effect<TrainingRun, ClassifierTrainingError, ProcessService>;
```

Packages without `train` remain heuristic-only.

## Model Evaluation And Evolution

This section is non-v0 and applies once ax supports `local_model` classifiers.
Trained models must be treated as versioned artifacts with regression gates,
not as automatic upgrades.

### Evaluation Goals

The evaluation mechanism should prevent:

- a new model getting worse than the heuristic baseline
- overfitting to noisy heuristic labels
- losing rare but important labels
- changing label meanings without a migration
- silently producing different graph facts after an update
- promoting a model trained on private/local data as if it were general

### Evaluation Sets

Each trainable classifier should have multiple evaluation sets.

Required sets:

- **Fixture set**: small, hand-authored examples committed with the classifier.
- **Gold set**: manually reviewed labels, local by default.
- **Regression set**: previously misclassified examples that must not regress.
- **Shadow set**: recent real local event windows, evaluated without becoming
  active.

Optional sets:

- **Synthetic public set**: generated or manually authored examples safe for
  open source.
- **Package dataset set**: optional downloaded dataset from a classifier
  package, only when user opted in.

Public packages should not claim broad quality from private local datasets.

### Metrics

Metrics should be label-aware, not just one aggregate score.

Track:

- macro F1
- per-label precision/recall/F1
- confusion matrix
- abstain rate
- coverage rate
- calibration buckets when confidence is emitted
- false-positive examples by label
- false-negative examples by label
- delta versus previous active model
- delta versus heuristic baseline

For rare labels, require minimum recall or require abstention rather than
confident wrong output.

### Promotion Gate

A trained model can become active only if it passes a promotion gate.

Gate inputs:

- classifier key/version
- candidate artifact
- baseline artifact or heuristic classifier
- evaluation set refs
- metrics
- example diffs
- reviewer decision

Default gate:

- candidate macro F1 must be better than baseline by a configured margin
- no critical label may regress beyond threshold
- fixture set must pass exactly
- regression set must pass exactly or require explicit override
- candidate must emit only declared labels and targets
- candidate must not increase high-confidence false positives above threshold

Promotion output:

- `candidate`
- `approved`
- `rejected`
- `shadow_only`
- `rolled_back`

Only `approved` artifacts can be used by default classification runs.

### Shadow Mode

New models should run in shadow before activation.

Shadow behavior:

- run candidate model alongside current active classifier
- persist shadow results with `status = "shadow"`
- do not expose shadow labels as normal graph facts by default
- compare deltas in `axctl classifiers eval`
- allow user to inspect example disagreements

Example command:

```bash
axctl classifiers eval reuse-existing-infra \
  --candidate=artifact:reuse-existing-infra-centroid-v2 \
  --against=active \
  --shadow-since=7
```

### Rollback

Every model activation must be rollbackable.

Rollback should:

- mark candidate artifact inactive
- restore prior active artifact pointer
- keep historical classifier results
- optionally recompute recent results with the restored artifact
- record rollback reason

Example:

```bash
axctl classifiers rollback reuse-existing-infra --to=artifact:<previous>
```

### Drift Detection

The evaluator should detect when the world has moved.

Signals:

- model confidence drops over recent windows
- abstain rate rises
- user corrections increase after model activation
- manual false-positive overrides cluster around one label
- candidate disagrees with heuristic baseline more than expected

Drift should create an insight or proposal, not automatically retrain.

### Manual Review And Override

Model evolution needs human review points.

Commands:

```bash
axctl classifiers eval <classifier>
axctl classifiers eval <classifier> --examples --label=<label>
axctl classifiers promote <classifier> --artifact=<artifact>
axctl classifiers reject <classifier> --artifact=<artifact> --reason="..."
axctl classifiers override-result <result-id> --label=<label> --target=<target>
```

Manual overrides should be persisted separately from model output so future
training can use them as higher-quality labels.

Suggested table:

### `classifier_label_override`

Fields:

- `classifier_key`
- `subject_type`
- `subject_id`
- `original_result`
- `label`
- `target`
- `polarity`
- `durability`
- `rationale`
- `reviewer`
- `created_at`

Overrides are candidates for gold/regression sets.

### Evolution Tables

Non-v0 tables:

### `classifier_evaluation_run`

Records evaluation jobs.

Fields:

- `classifier_key`
- `candidate_artifact`
- `baseline_artifact`
- `baseline_kind`
- `dataset_refs_json`
- `metrics_json`
- `status`
- `started_at`
- `finished_at`
- `error`

### `classifier_model_activation`

Records active model changes.

Fields:

- `classifier_key`
- `artifact`
- `previous_artifact`
- `status`: `active`, `rolled_back`, `shadow`
- `decision`
- `rationale`
- `activated_at`
- `deactivated_at`

### `classifier_eval_example`

Stores compact evaluation examples and disagreements.

Fields:

- `evaluation_run`
- `subject_id`
- `expected_json`
- `candidate_json`
- `baseline_json`
- `status`: `match`, `candidate_wrong`, `baseline_wrong`, `both_wrong`,
  `needs_review`
- `evidence_json`

### Open Rule

Do not train or activate a model from heuristic labels alone. Heuristic labels
can bootstrap candidates, but promotion requires fixtures, regression examples,
or manual/gold review.

## Persistence Tables

Classifier execution should be recorded as durable graph state.

### `classifier_definition`

Records classifier metadata.

Fields:

- `key`
- `version`
- `kind`
- `description`
- `input`
- `labels_json`
- `targets_json`
- `created_at`
- `updated_at`

### `classifier_run`

Records every recent, topic, or backfill run.

Fields:

- `run_id`
- `mode`: `recent`, `topic`, `backfill`, `manual`
- `classifier_keys_json`
- `since`
- `query`
- `batch_size`
- `status`: `running`, `complete`, `error`, `cancelled`
- `started_at`
- `finished_at`
- `metrics_json`: windows scanned, results written, skipped, errors
- `cursor_json`: resumable progress

### `classifier_result`

Generic output row for every classifier.

Fields listed in the earlier `Classifier Result` section.

Indexes:

- `(classifier_key, label, target)`
- `(session, ts)`
- `(turn)`
- `(durability, confidence)`

### `classifier_training_run`

Non-v0.

Records dataset build and training attempts.

Fields:

- `classifier_key`
- `classifier_version`
- `label_source`
- `dataset_ref`
- `rows`
- `train_rows`
- `test_rows`
- `metrics_json`
- `artifact`
- `status`
- `started_at`
- `finished_at`
- `error`

### `classifier_artifact`

Non-v0.

Records model files or serialized parameters.

Fields:

- `classifier_key`
- `classifier_version`
- `artifact_type`: `surml`, `onnx`, `json_model`, `sklearn_pickle`,
  `centroid_json`
- `path`
- `sha256`
- `metrics_json`
- `created_at`

## Classifier Families

### Reaction Event Classifier

Detects user reactions to the previous assistant output.

Labels include:

- `approval`
- `correction`
- `direction`
- `scope_adjustment`
- `clarification`
- `rejection`
- `continuation`
- `meta_question`

Targets include:

- `environment_setup`
- `prototype_completeness`
- `verification`
- `wrong_scope`
- `wrong_output`
- `implementation_choice`
- `communication`

Existing examples:

- `can you use UV ?` -> `direction / environment_setup /
  repo_preference`
- `i dont want just html i want to see the results` ->
  `correction / prototype_completeness / repo_preference`

### Review Feedback Classifier

Detects review outputs and requested fixes.

Useful labels:

- `spec_review`
- `code_quality_review`
- `final_review`
- `changes_requested`
- `approved`
- `regression_test_required`
- `docs_fix_required`
- `typecheck_failure`

This should separate human/user feedback from subagent review payloads.

### Runtime State Classifier

Detects corrections about the actual environment or application state.

Useful labels:

- `server_down`
- `browser_state_wrong`
- `feature_not_working`
- `needs_restart`
- `login_state_changed`
- `port_conflict`

This can drive future hooks like "verify server/browser state before claiming
the feature works."

### Reference Compliance Classifier

Detects when the user says the agent ignored, copied, or misunderstood a
reference.

Useful labels:

- `ignored_reference`
- `wrong_reference_target`
- `copied_not_inspired`
- `missing_reference_check`

This is common in frontend/design work and should connect to screenshots,
links, browser checks, and design assets when present.

### Reuse Existing Infra Classifier

Detects "do not hand-roll; use existing package/system/infrastructure."

Useful labels:

- `reuse_existing`
- `preferred_library`
- `avoid_handrolled`
- `existing_tooling_available`
- `wrong_tool_choice`

Examples:

- use `uv`
- rely on `livetrace`
- use `durable-stream`
- reuse existing waveform/recording infrastructure

### Verification Quality Classifier

Detects whether verification was requested, claimed, missing, or weak.

Useful labels:

- `verification_requested`
- `verification_claimed`
- `verification_missing`
- `weak_proof`
- `needs_red_green_test`
- `needs_browser_smoke`

This should feed agent behavior directly because it can decide when future
responses need stronger proof.

### Frontend Taste Classifier

Detects recurring design and product-feedback patterns.

Useful labels:

- `visual_noise`
- `too_complex`
- `native_motion`
- `layout_overlap`
- `demo_incomplete`
- `interaction_mechanics`
- `missing_link_or_navigation`
- `not_realistic_enough`

These labels should eventually route to frontend-specific guidance and
screenshots/dogfood workflows.

### Durability Classifier

Runs after other classifiers and estimates whether a signal should be promoted.

Durability labels:

- `one_off`
- `session_preference`
- `repo_preference`
- `global_preference`
- `candidate_guidance`

This classifier should consider repetition, recency, confidence, repo scope,
and whether the same correction appears after similar assistant behavior.

## Ingestion Strategy

Classification can be expensive over the full transcript graph, so ingestion
should be incremental and resumable.

### Default Fast Path

Normal user-facing ingest should classify only recent data:

- default: last 1-2 days, or the current active sessions
- optional: `--since=7d` for recent work
- run automatically after transcript ingestion
- keep latency low enough for local development

### Backfill Path

Full-history classification should be an explicit long-running job.

Possible command:

```bash
axctl classify backfill --classifiers=all --batch-size=500 --since=all
```

It should:

- iterate in stable timestamp/id order
- persist progress per classifier
- be interruptible and resumable
- print progress by classifier, rows scanned, rows written, and ETA
- allow pausing after each batch
- ask before classifying the rest of history when launched interactively

### Keyword / Targeted Path

The user should be able to classify only likely-interesting topics first.

Possible commands:

```bash
axctl classify search "uv|surrealml|not just html"
axctl classify topic verification --since=30d
axctl classify topic frontend-taste --since=90d
```

This lets ax build useful clusters around one concern without scanning every
turn.

## Graph Integration

Classifier results should become graph facts, not isolated reports.

For v0, graph mutation is limited to classifier definitions, classifier runs,
classifier results, and evidence edges. Classifier results do not directly
modify `session_health`, `proposal`, `guidance_revision`, `skill_candidate`, or
`opportunity`.

Direct reads:

- `axctl insights classifier-themes`
- `axctl insights classifier-results --classifier=<key>`
- `axctl sessions show <id> --classifiers`
- dashboard panes for classifier themes and examples

Edges and rollups:

- `turn -> has_classification -> classifier_result`
- `classifier_result -> cites_evidence -> turn/tool_call/file`
- future: `classifier_result -> suggests_guidance -> proposal` when promoted
- future: `classifier_result -> opportunity -> experiment` when accepted
  guidance is later tested

V0 edge semantics:

- `has_classification` is a relation from the primary subject record to the
  `classifier_result`.
- `has_classification` is unique by `(in, out)`.
- `cites_evidence` is a relation from `classifier_result` to each supporting
  `turn`, `tool_call`, or `file`.
- `cites_evidence` may have multiple edges per result.
- Re-running the same classifier version upserts the same result id and
  replaces its evidence edges.
- Deleting or recomputing a classifier run must not delete results from other
  classifier versions.
- Cluster reports count sessions distinctly to avoid one long session
  dominating repeated turns.

Existing tables that should consume classifier output:

- `proposal`: repeated high-confidence clusters become improvement proposals.
- `guidance_revision`: accepted guidance records cite classifier evidence.
- `opportunity`: future occurrences of the same classified pattern measure
  whether an experiment is working.
- `session_health`: repeated corrections or weak verification lower health.
- `skill_candidate`: repeated review/runtime/reuse patterns can suggest skills.

## Promotion Loop

Cheap classifier output should not automatically rewrite guidance.

Promotion flow:

1. Classifiers emit `classifier_result` rows.
2. Insight views cluster by classifier, label, target, durability, repo, and
   time window.
3. Repeated or high-impact clusters become proposals.
4. User accepts, rejects, or edits proposal.
5. Accepted proposal creates guidance/skill/hook/task artifact.
6. Future classifier output measures recurrence before and after acceptance.

This creates a closed loop:

```text
transcripts -> event windows -> classifier results -> clusters -> proposals
-> guidance/hooks/skills -> future events -> measured impact
```

## First Build Slice

The first implementation slice is Phase 1. It should avoid LLMs, training,
external packages, lazy assets, dashboard work, and broad automation.

Build:

- `event_window` builder over turns and recent tool context.
- `classifier_result` schema.
- `classifier_run` schema.
- `has_classification` and `cites_evidence` edges.
- classifier registry with pure TypeScript classifiers.
- port current `reaction_event` logic into the registry or document why it
  remains a compatibility table.
- add `review-feedback`, `runtime-state`, and `reuse-existing-infra`.
- add `axctl insights classifier-themes`.
- add `axctl insights classifier-results --classifier=<key>`.

Do not build yet:

- `ClassifierTrainer`
- package install/search/update
- lazy dataset/artifact downloads
- automatic guidance rewrites
- LLM promotion
- dashboard UI
- hosted sharing of classifier results
- session-health scoring from classifier output

## Open Questions

- Should `reaction_event` remain as a specialized table, or should it become a
  compatibility view/query over `classifier_result`?
- What is the default "recent" window: 1 day, 2 days, or 7 days? Current
  leaning: 2 days for automatic local ingest; 7 days for explicit recent
  classification.
- Should full backfill be prompted interactively, or only run through an
  explicit command?
- Which classifier result labels should affect `session_health` later? V0:
  none.
- Should manual false-positive corrections be stored as `classifier_result`
  rows with `method = "manual"` or as separate override rows?
- Should label vocabulary be global or classifier-local? Current leaning:
  classifier-local labels in v0, with shared taxonomy docs for conventions.
