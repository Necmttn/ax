---
name: ax-add-ingest-stage
description: Use when adding a new ingest stage or a new SurrealDB table to the ax graph. Encodes the exact registration gotchas that fail CI if missed.
---

# Adding an ingest stage / table to ax

Hard-won checklist - each step below has a CI gate that fails if you skip it.

## New SurrealDB table
1. Add the `DEFINE TABLE ... SCHEMAFULL` + fields to `packages/schema/src/schema.surql` (top-level fields explicit; nested objects → JSON-encoded `string`; datetimes via JS `Date`).
2. **Register it in `SCHEMA_TABLES`** (`apps/axctl/src/queries/insights.ts`) - a mirror test diffs `DEFINE TABLE` names vs `SCHEMA_TABLES` and **fails CI** if missing.
3. In a worktree, run `bun install` so `@ax/schema` resolves to the worktree copy (not the main tree's symlink) before the mirror test will pass.

## New `derive`-tagged ingest stage
1. Co-locate the `StageDef` at the bottom of the stage file (mirror `apps/axctl/src/ingest/derive-opportunities.ts`): `export const FooKey = Schema.Literal("foo")` + `fooStage`.
2. Register in `apps/axctl/src/ingest/stage/registry.ts`: add the import, add `FooKey` to the `IngestStageKey` `Schema.Union([...])`, add `fooStage` to `ALL_STAGES`.
3. **Update `apps/axctl/src/cli/effect-cli.test.ts`**: bump the `resolveIngestStages: default runs every stage` `.toHaveLength(N)` by 1, and add your key (sorted) to the `--derive-only` list. CI fails otherwise.
4. **Isolate failures**: wrap the stage body in `Effect.catchCause` returning a zero-row stat, so a stage error never aborts the surrounding ingest.

## New CLI subcommand
Document it in **BOTH** cli-reference gates or CI fails: `docs/cli.md` (or README) + `apps/site/public/llms.txt` (scripts/check-cli-reference.ts), AND a card in `apps/site/app/routes/docs/-cli-reference.data.ts` (scripts/check-site-cli-reference.test.ts).

## Effect v4 beta gotchas
- Multi-arg `Schema.Literal(...)` collapses → use `Schema.Literals([...])`.
- `Schema.Date` doesn't JSON round-trip → use `Schema.DateFromString.check(Schema.isDateValid())`.
