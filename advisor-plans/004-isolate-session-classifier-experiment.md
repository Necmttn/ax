# Isolate the session classifier experiment

**Priority:** P2  
**Effort:** M  
**Risk:** MED  
**Type:** refactor  
**Baseline:** `5f06ce46`  
**Dependencies:** Plan 003

## Executor instruction

Move only the Python experiment package. Preserve all deterministic classifiers used by ingest.

## Drift check

Search imports from `packages/ax-classifier-session-sections`. Inspect `apps/axctl/src/classifiers`, the hidden classifier command, root scripts, and classifier operation tests. Stop if production ingest imports experiment code or fixtures.

## Status

Ready after Plan 003.

## Why

One local experiment occupies a product package location. It adds about 146 files, about 68 Python test files, and about 65 root operation aliases.

## Current state

- The package README calls the package a local experiment.
- Default ingest does not use the package.
- Root scripts expose many package operations.
- Product ingest uses deterministic TypeScript classifiers in `apps/axctl/src/classifiers`.

## Scope

- Move the package with `git mv packages/ax-classifier-session-sections experiments/session-sections`.
- Add `experiments/README.md` with lifecycle and run instructions.
- Remove experiment operation aliases from the root package file.
- Update `ax.classifier.json` to use direct commands.
- Update `scripts/classifier-package-operations.ts`, its tests, and default paths.
- Update the document catalog.

Use direct commands such as `uv run --project experiments/session-sections`, `python3`, or direct Bun script paths.

## Out of scope

- Do not move `apps/axctl/src/classifiers`.
- Do not remove the hidden classifier command.
- Do not split large TypeScript classifier modules.
- Do not change classifier results.

## Git workflow

Obtain an issue. Run `bun run wip claim <issue#> refactor`. Work in its worktree. Use a Conventional Commit. Do not push without approval.

## Steps

1. Prove dependency boundaries.
   - Run `rg -n "ax-classifier-session-sections|session-sections" apps packages scripts package.json`.
   - Classify each match as product, experiment, test, or operation metadata.
2. Run focused operation and manifest tests before the move.
3. Use `git mv` for the package.
4. Remove root experiment aliases.
5. Update the experiment manifest and operation runner paths.
6. Update tests and the lifecycle catalog.
7. Run focused Bun tests for classifier package operations.
8. Run the package Python unit tests from the new path.
9. Run `bun run typecheck` and `bun test`.
10. Run `rg -n "packages/ax-classifier-session-sections" --glob '!docs/superpowers/**'`.
    - Expect no active path references.

## Test plan

Compare operation lists before and after the move. Run manifest tests, Python unit tests, TypeScript checks, and repository tests.

## Done criteria

- Product workspaces no longer contain the experiment package.
- Root scripts no longer expose experiment operations.
- Experiment commands work from `experiments/session-sections`.
- Production classifier imports and results remain unchanged.

## STOP conditions

- Stop if ingest imports experiment code or data.
- Stop if the move changes generated classifier output.
- Stop if an external workflow requires the old path and has no migration path.

## Maintenance notes

New experiments belong under `experiments/`. They need an owner, a question, a run command, and an exit rule.
