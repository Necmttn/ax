# Give document collections a clear lifecycle state

**Priority:** P1  
**Effort:** M  
**Risk:** LOW  
**Type:** docs  
**Baseline:** `5f06ce46`  
**Dependencies:** Plans 001 and 002

## Executor instruction

Add a lifecycle catalog. Do not rewrite or delete historical records.

## Drift check

Count tracked files under `docs/`. Inspect all top-level document directories. Stop if another lifecycle system now exists.

## Status

Ready after Plans 001 and 002.

## Why

The repository mixes current guidance, decisions, experiments, evidence, generated files, and old plans. Readers cannot identify authoritative documents.

## Current state

- The repository tracks about 359 document files.
- `docs/superpowers/plans` contains about 92 plans.
- `docs/superpowers/specs` contains about 53 specifications.
- `docs/prototypes` contains about 46 prototypes.
- No document index defines lifecycle states.

## Lifecycle model

Use these states: `current`, `decision`, `historical`, `experiment`, `evidence`, `release`, `generated`, and `asset`.

Use collection defaults:

- `docs/superpowers/plans`, `specs`, `fleet`, and `goals`: `historical`
- `docs/prototypes`: `experiment`
- `docs/adr`: `decision`
- `docs/releases`: `release`
- Dogfood, research, missions, investigations, findings, and experiments: `evidence`
- `docs/studio`: `generated`
- Media files: `asset`

List current documents and justified exceptions explicitly.

## Scope

- Add `docs/catalog.json`.
- Add `docs/README.md`.
- Add `docs/superpowers/README.md`.
- Add `docs/prototypes/README.md`.
- Add `docs/adr/README.md`.
- Add `scripts/check-doc-catalog.ts` and its test.
- Add the check to root scripts and CI checks.

## Out of scope

- Do not add status headers to every old file.
- Do not delete or move old files.
- Do not change product behavior.

## Git workflow

Obtain an issue. Run `bun run wip claim <issue#> docs`. Work in its worktree. Use a Conventional Commit. Do not push without approval.

## Steps

1. Generate a tracked document inventory with `git ls-files 'docs/**'`.
2. Define the JSON schema in the test fixtures.
   - Require a version, state definitions, collection defaults, current files, and overrides.
3. Add the catalog and the four reader indexes.
4. Add validation.
   - Require exactly one state for each tracked document artifact.
   - Reject overlapping defaults unless an explicit override resolves them.
   - Require a reason for each override.
   - Reject missing files and unknown states.
5. Run `bun test scripts/check-doc-catalog.test.ts`.
6. Run `bun run check:doc-catalog`.
7. Run `bun run typecheck` and `bun test`.

## Test plan

Test missing coverage, duplicate coverage, unknown states, missing reasons, removed files, and valid collection defaults.

## Done criteria

- Every tracked document artifact has one lifecycle state.
- Readers can find current guidance from `docs/README.md`.
- Old plans and prototypes have clear non-current states.
- The validation check passes.

## STOP conditions

- Stop if one file must have two states.
- Stop if generated files cannot be identified from repository code.
- Stop if a collection contains current and historical files without clear overrides.

## Maintenance notes

Require catalog changes when a new document collection enters the repository.
