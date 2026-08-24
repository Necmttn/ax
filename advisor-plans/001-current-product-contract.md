# Make active documents describe the current product

**Priority:** P1  
**Effort:** M  
**Risk:** LOW  
**Type:** docs  
**Baseline:** `5f06ce46`  
**Dependencies:** None

## Executor instruction

Implement this plan only after you claim an issue. Keep historical records unchanged.

## Drift check

Before work, inspect `README.md`, `CONTEXT.md`, `docs/*.md`, `docs/*.mdx`, `apps/axctl/package.json`, and `apps/site/app/routes/docs`. Stop if the storage model or service model changed after the baseline.

## Status

Ready.

## Why

Active documents describe retired SurrealDB services and retired session timing. New users cannot identify the supported product model.

## Current state

- `README.md` describes a Stop hook and `t+7`, `t+30`, and `t+90` checkpoints.
- `CONTEXT.md` describes SurrealDB as the current backend.
- `docs/how-ax-sees-your-work.mdx` uses port `8521` and SurrealQL.
- `docs/development.md` describes a watcher and daemon controls.
- `apps/axctl/package.json` says that ax ingests data into SurrealDB.
- The active text names five harnesses in one place and six harnesses in another place.

## Product contract

- DuckDB stores the rebuildable cache.
- SQLite stores durable judgments.
- Reads use the published snapshot.
- Writes use the live cache under the ingest lock. A completed ingest publishes the cache.
- `ax studio` starts an on-demand service and stops after the client disconnects.
- `ax otlpd` is the only optional long-running service.
- Ax supports Claude Code, Codex, Pi, Omp, OpenCode, and Cursor.
- Session review uses the pull model and `+3s`, `+10s`, and `+30s` checkpoints.

## Scope

Update these active files:

- `README.md`
- `CONTEXT.md`
- `docs/how-ax-sees-your-work.mdx`
- `docs/development.md`
- `docs/metrics.md`
- `docs/instrumentation.md`
- `docs/HOOKS.md`
- `docs/language.md`
- `docs/manifesto.md`
- `docs/retro-loop.svg`
- `apps/axctl/package.json`
- Current site metadata and `llms.txt`

Add `scripts/check-current-product-docs.ts` and its test. Add the check to the root scripts and CI checks.

## Out of scope

- Do not edit historical plans, specifications, release notes, or test reports.
- Do not delete `schema.surql`.
- Do not change runtime behavior.

## Git workflow

1. Obtain an issue number.
2. Run `bun run wip list`.
3. Run `bun run wip claim <issue#> docs`.
4. Work in the generated worktree.
5. Use a Conventional Commit message.
6. Do not push final changes without user approval.

## Steps

1. Record the active contract from code and schema files.
   - Run `rg -n "Surreal|8521|daemon|watcher|t\\+7|t\\+30|t\\+90|five harness" README.md CONTEXT.md docs apps/axctl/package.json apps/site`.
   - Expect matches in the files in this plan.
2. Update the scoped documents.
   - Use one term for each store and service.
   - Mark historical links as historical when active documents link to them.
3. Add a narrow document check.
   - Scan only the active file allowlist.
   - Reject current claims about SurrealDB, port `8521`, retired daemon controls, and old session checkpoints.
   - Do not scan historical collections.
4. Add focused tests for accepted and rejected text.
5. Run `bun test scripts/check-current-product-docs.test.ts`.
   - Expect all focused tests to pass.
6. Run `bun run check:current-product-docs`, `bun run check:cli-reference`, and `bun run check:site-cli-reference`.
   - Expect exit code zero from each command.
7. Run `bun run typecheck` and `bun test`.
   - Expect no new failures.

## Test plan

Test each banned current claim. Test each approved product statement. Confirm that a historical specification does not fail the check.

## Done criteria

- Every scoped active document matches the product contract.
- The harness count is six in all active summaries.
- The new check prevents the same drift.
- Focused and full checks pass.

## STOP conditions

- Stop if code supports a different store or service model.
- Stop if a scoped file is generated and its source is unknown.
- Stop if an active document must preserve a quoted historical statement.

## Maintenance notes

Keep the active file allowlist small. Add files only when users use them as current guidance.
