# Classifiers

`ax` classifiers are small, versioned modules that label transcript events and
write the result into the graph. They are intentionally cheap by default:
heuristic classifiers run over compact `EventWindow` inputs and emit
`classifier_result` rows.

The current runtime supports repo-native built-ins and statically registered
workspace packages. Dynamic external package loading is not enabled yet.

## Runtime Model

The default ingest stage is:

```sh
bun src/cli/index.ts ingest --stages=classifier-results
```

It rebuilds event windows from `turn` rows, runs every registered classifier,
and persists:

- `classifier_definition`
- `classifier_run`
- `classifier_result`
- `turn -> has_classification -> classifier_result`
- `classifier_result -> cites_evidence -> turn`

Classifiers are overlapping by design. A single user turn can have both:

- `reaction-event / direction / environment_setup`
- `direction-event / direction / tooling_preference`

This is useful because one classifier can capture the local reaction while
another captures the durable instruction.

## Module Shape

Built-in classifiers live under:

```text
src/classifiers/<classifier-key>/
  index.ts
  index.test.ts
```

Package classifiers live under:

```text
packages/ax-classifier-<classifier-key>/
  ax.classifier.json
  src/index.ts
  src/index.test.ts
  eval-fixtures/<classifier-key>.json
```

Both shapes export a `ClassifierDefinition` created with `defineClassifier`.

Required metadata:

- `key`: stable kebab-case id, for example `verification-event`
- `version`: semver-like string, for example `0.1.0`
- `kind`: currently `heuristic`, `manual`, `local_model`, or `llm_review`
- `input`: currently `event_window` for built-ins
- `labels`: every label the classifier may emit
- `targets`: every target the classifier may emit
- `classify`: deterministic function returning `ClassifierResult[]`

The runner validates emitted labels, targets, confidence, classifier key, and
classifier version against the definition.

Use the shared `label(window, ...)` helper to create results. Result ids are
derived from classifier key, version, subject, label, and target, so re-running
the same version upserts the same graph row.

## Eval Fixtures

Every classifier should have an eval fixture. Built-ins use:

```text
src/classifiers/eval-fixtures/<classifier-key>.json
```

Packages keep fixtures beside the package:

```text
packages/ax-classifier-<classifier-key>/eval-fixtures/<classifier-key>.json
```

Fixture format:

```json
{
  "name": "verification-event",
  "cases": [
    {
      "name": "test-required",
      "classifierKeys": ["verification-event"],
      "window": {
        "user": "did you run the tests?",
        "previousAssistant": "I changed the code.",
        "recentToolFailures": []
      },
      "expect": [
        {
          "classifierKey": "verification-event",
          "label": "verification_request",
          "target": "test_required"
        }
      ],
      "reject": []
    }
  ]
}
```

`expect` entries must appear in classifier output. `reject` entries must not
appear. `polarity` and `durability` are optional in fixtures; include them when
the distinction matters.

Run:

```sh
bun src/cli/index.ts classifiers eval
```

## Commands

List registered classifiers and fixture coverage:

```sh
bun src/cli/index.ts classifiers list
bun src/cli/index.ts classifiers list --json
```

Run golden fixtures:

```sh
bun src/cli/index.ts classifiers eval
bun src/cli/index.ts classifiers eval --path=packages/ax-classifier-verification-event/eval-fixtures/verification-event.json
```

Explain persisted labels for a live turn:

```sh
bun src/cli/index.ts classifiers explain <turn-id>
bun src/cli/index.ts classifiers explain <turn-id> --json
```

Inspect aggregate output:

```sh
bun src/cli/index.ts insights classifier-themes
bun src/cli/index.ts insights classifier-results
```

## Service Helper

Classifier execution is also available through `ClassifierService` in
`src/classifiers/service.ts`. Use it when tests, ingest stages, or debug tools
need one shared entrypoint instead of wiring registry selection and runner calls
by hand.

The service currently exposes:

- `all`: registered classifier definitions
- `select(keys?)`: selected classifier definitions, with typed not-found errors
- `runWindow({ window, classifierKeys? })`
- `runBatch({ windows, classifierKeys? })`
- `debugWindow({ window, classifierKeys? })`: selected keys plus validated output
- `evalSuites(suites)`: golden fixture execution through the same runner path

The default layer is `ClassifierServiceDefault`, backed by the registered
workspace classifiers and `ClassifierRunnerLive`.

## Eval Tooling Notes

The current fixture harness stays intentionally local and deterministic. It is
closer to unit tests for classifiers than to full LLM application evaluation.

Useful external references:

- Promptfoo: good TypeScript/CLI surface for YAML-driven prompt evals, custom JS
  providers, JavaScript assertions, and UI reports.
- Braintrust Autoevals: useful scorer library for factuality, semantic
  similarity, JSON, SQL, and LLM-classifier-style scorers.
- Inspect AI: strong Python framework for agent/model evals, logs, sandboxes,
  eval sets, and large benchmark suites.
- OpenAI Evals: useful benchmark registry and YAML/data pattern, but Python
  heavy and more oriented to model/system evals than cheap local classifiers.

Recommended path: keep `ax` classifier fixtures as the core contract, then add
export/adapters later if we need promptfoo reports or Autoeval scorers. Do not
make classifier packages depend on a hosted eval platform.

## Adding A Built-In Classifier

1. Create `src/classifiers/<key>/index.ts`.
2. Export a `ClassifierDefinition` with `defineClassifier`.
3. Add focused tests in `src/classifiers/<key>/index.test.ts`.
4. Add `src/classifiers/eval-fixtures/<key>.json`.
5. Register it in `src/classifiers/registry.ts`.
6. Run:

```sh
bun test src/classifiers/<key>/index.test.ts src/classifiers/eval.test.ts
bun src/cli/index.ts classifiers eval
bun src/cli/index.ts ingest --stages=classifier-results --progress=plain
```

## Adding A Package Classifier

1. Create `packages/ax-classifier-<key>/`.
2. Add `package.json` with package name `@ax-classifier/<key>` and an export
   for `./src/index.ts`.
3. Add `ax.classifier.json`.
4. Export a `ClassifierDefinition` from `src/index.ts`.
5. Add focused tests in `src/index.test.ts`.
6. Add `eval-fixtures/<key>.json`.
7. Register the package in `src/classifiers/registry.ts` with
   `source: "package"`, `packageName`, `manifestPath`, and `fixturePaths`.
8. Run:

```sh
bun test packages/ax-classifier-<key>/src/index.test.ts src/classifiers/eval.test.ts
bun src/cli/index.ts classifiers list
bun src/cli/index.ts classifiers eval
```

## Package Manifest

The package manifest contract is defined in
`src/classifiers/package-manifest.ts`. Workspace package examples include
`packages/ax-classifier-verification-event/ax.classifier.json` and
`packages/ax-classifier-direction-event/ax.classifier.json`.

Package layout:

```text
@ax-classifier/verification-event
  ax.classifier.json
  src/index.ts
  src/index.test.ts
  eval-fixtures/verification-event.json

@ax-classifier/direction-event
  ax.classifier.json
  src/index.ts
  src/index.test.ts
  eval-fixtures/direction-event.json
```

Manifest fields:

- `schema`: currently `ax.classifier.v1`
- `key`, `version`, `package`, `entrypoint`
- `kind`, `input`, `description`
- `labels`, `targets`
- optional `fixtures`
- optional `assets` for later datasets/models/artifacts

The package layer is deliberately separate from the runtime contract. A package
still exports the same `ClassifierDefinition` as a built-in; the manifest adds
shareable metadata, fixture paths, and later asset/model references.

## Smoke Report

Run the local classifier graph smoke after changing classifier ingest,
classifier evidence, or candidate queries:

```sh
bun run classifiers:smoke -- --days=7 --limit=10
```

The command runs the `classifier-results` ingest stage, then reports source
turns, classifier facts, evidence-edge counts, theme rows, and harness
candidates. It exits non-zero when source turns exist but the classifier fact,
evidence, theme, or candidate surfaces are empty.

## Harness Candidate Contract

`axctl insights harness-candidates` is the read-only handoff from classifier
facts to future proposal promotion. The row contract and human accept/reject
flow are documented in
[`docs/classifier-candidate-contract.md`](./classifier-candidate-contract.md).
