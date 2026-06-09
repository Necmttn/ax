# Handoff: wire PR / merge ingest (session→PR→merge gap)

**Date:** 2026-06-09
**Status:** not started - orphan code exists, needs wiring
**Context:** surfaced while adding `ax loc`. The `pull_request` table is **empty in the
local DB (0 rows)**, so the session→PR→merge chain is unavailable. Session→commit
(`produced` edge) is healthy (5,647 edges, 4,636 commits).

## The gap in one line

The PR/review/check/delivery **schema + normalizers + scorers already exist** but are
**orphaned** - nothing fetches from the GitHub API, nothing upserts the rows, and no
ingest stage is registered. The work is *wiring*, not greenfield.

## Evidence (verified 2026-06-09)

Live DB (`127.0.0.1:8521`, ns=ax, db=main):

| table | rows | note |
|---|---|---|
| `commit` | 4,636 | good |
| `produced` (session→commit) | 5,647 | good - the working chain |
| `pull_request` | **0** | empty |
| merged-with-sha (`merged_at != NONE AND merge_sha != NONE`) | **0** | empty |

Code state:
- `apps/axctl/src/ingest/github-pr.ts` - **normalizers only** (`NormalizedPullRequest`,
  `NormalizedReviewEvent`, gh-JSON → normalized mappers). Imported by **nothing but its
  own test** (`rg -l github-pr` → only `github-pr.test.ts`).
- `apps/axctl/src/ingest/delivery.ts` - **pure scorers** (`PrSize`, `ReviewPain`,
  `DeliveryStatus` → labels for `delivery_outcome`). No source feeds it.
- **No upsert of `pull_request` anywhere** (`rg "upsert.*pull_request"` in app code → 0).
- Schema tables ready & defined: `pull_request`, `review_event`, `check_run`, `branch`,
  `delivery_outcome` (`packages/schema/src/schema.surql`).

So three pieces are missing between the normalizers and the tables:
1. a GitHub **fetch** (gh CLI),
2. a **writer** (normalized → SurrealDB upserts + edges),
3. a **registered stage** that runs fetch→normalize→write.

## What to build

### 1. gh fetch helper
Pattern already in repo - copy it:
- `apps/axctl/src/share/gist.ts:54` builds `["gh","api",...]` argv and spawns it.
- `apps/axctl/src/cli/star-nudge.ts:161` uses `spawnSync("gh", ["auth","status"])`.

Fetch with `gh pr list --json number,title,state,baseRefName,headRefName,headRefOid,
mergeCommit,author,url,createdAt,closedAt,mergedAt,additions,deletions,changedFiles,
commits,labels,reviews,statusCheckRollup --state all --limit N`. The exact JSON field
names already line up with what `github-pr.ts` normalizers consume (`asRecord`/
`stringOrNull`/`finiteNumberOrNull`). Requires `gh auth` + a GitHub remote - gate
gracefully when absent (no remote / not authed → skip stage, don't fail ingest).

### 2. writer
Upsert `pull_request` keyed by `(repository, number)` (unique index
`pull_request_repo_number` exists). Then:
- `review_event` rows (FROM pull_request) - `github-pr.ts` already normalizes these.
- `check_run` rows from `statusCheckRollup`.
- `delivery_outcome` - score via `delivery.ts` (`PrSize`, `ReviewPain`,
  `DeliveryStatus`); `reachedMain` = does `merge_sha`/`head_sha` resolve to a `commit`
  already linked by `produced`.

**Link PR → session (closes the gap):** `pull_request.merge_sha` / `head_sha` →
match `commit.sha` → existing `produced` edge → `session`. Alt: `head_branch` →
`checkout.branch`. No new session parsing needed; reuse the commit graph.

**Schema reminder:** if any *new* table is added, register it in `SCHEMA_TABLES`
(`insights.ts`) or a test fails CI (see memory `schema-tables-mirror`). The five tables
above already exist, so no new table is expected.

### 3. register the stage
Model exactly on `gitStage` (`apps/axctl/src/ingest/git.ts`). A stage = export a
`<name>Key` (`Schema.Literal("github-pr")`) + a `<name>Stage` (`StageDef`), then in
`apps/axctl/src/ingest/stage/registry.ts`:
- add the import,
- add the key to the `IngestStageKey = Schema.Union([...])`,
- add the stage to `ALL_STAGES`.
Tag it so it runs in the right phase (after `gitStage` - needs commits present to link).
Gate behind remote+auth availability like other optional stages.

## Acceptance

- `ax ingest` (or a scoped `ax ingest here`) on a repo with a GitHub remote populates
  `pull_request` / `review_event` / `check_run` / `delivery_outcome`.
- `SELECT count() FROM pull_request GROUP ALL` > 0.
- At least one PR resolves to a session via `merge_sha → commit → produced → session`.
- Stage skips cleanly (no error) when `gh` missing/unauthed or no remote.
- `ax costs for --commit <sha>` already walks `produced`; add an analogous PR view later.

## Not in scope

- Live OTEL ingest (the *other* missing-metrics path - permission decisions, API
  latency/error codes). Separate handoff.
- Backfilling historical PRs beyond gh's `--limit`; log what was capped (memory:
  no silent caps).

## Pointers

- normalizers: `apps/axctl/src/ingest/github-pr.ts`
- scorers: `apps/axctl/src/ingest/delivery.ts`
- stage to copy: `apps/axctl/src/ingest/git.ts`
- registry: `apps/axctl/src/ingest/stage/registry.ts`
- gh-spawn pattern: `apps/axctl/src/share/gist.ts`
- schema: `packages/schema/src/schema.surql` (`pull_request` ~L919)
