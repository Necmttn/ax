# Pricing-calculation improvement plans

Written against commit `d70e1b3e` (branch `fix/751-pricing-claude-opus-5-unpriced-the`)
by an audit scoped to the cost/pricing path only.

All figures below were measured against the live local SurrealDB at the time of
writing, not estimated.

## Execution order

| # | Plan | Why now | Effort | Risk | Status |
|---|---|---|---|---|---|
| 001 | [Stop billing every OpenAI session at priority-tier rates](001-fast-multiplier-gating.md) | ~$10.3k phantom of ~$87.5k all-time reported spend (~12%) | M | M | TODO |
| 002 | [Stop one `<synthetic>` message relabelling a session's model](002-synthetic-session-model.md) | 148 sessions / 645M prompt tokens priced $0; ≥$385 invisible | S | L | TODO |
| 003 | [Fix the `>200k` context-tier calculation](003-context-tier-semantics.md) | Latent today, **activated by PR #752** | M | M | TODO |

**Dependencies:** 003 depends on 001 - both edit the tail of `estimateCost` and
will conflict otherwise. 002 is independent and can land in parallel with either.

**Ordering rationale:** 001 is the largest dollar error and is independent. 002
is the cheapest real loss with the lowest risk. 003 is latent *today* but PR #752
adds `*Above200k*` rates to `gpt-5.6-sol/terra/luna`, which activates it - so 003
must land before, or together with, those tier fields becoming live.

## Interaction with PR #752 (issue #751)

PR #752 is correct about rates and should land. But its three new
`*Above200k*` field sets are the exact input that turns finding 003 from latent
into active (~2× over-count on long `gpt-5.6-terra` sessions). Two safe orders:

- Drop the four `*Above200k*` fields from the three `gpt-5.6-*` entries in #752,
  merge it, then land 003 (which re-adds tiers *and* reads them from models.dev
  automatically). **Recommended** - smallest window of wrong numbers.
- Merge #752 as-is and land 003 immediately after, accepting that gpt-5.6 tier
  usage over-bills in between.

**Known-wrong claim in PR #752's body:** it states that
`ax ingest --reparse=pricing` reprices old rows. It does not - that target only
rewrites the `agent_model` catalog table (`model-pricing.ts:764-789`). Stored
`session_token_usage` costs are never re-priced by anything (see "considered and
rejected" below). That line needs correcting before merge.

## Considered and not planned

- **Opposite catalog precedence at ingest vs read.** `loadPricingCatalog` merges
  `(modelsDev, litellm, builtIn)` so the built-in table wins
  (`model-pricing.ts:707-711`); `loadPricingCatalogForModels` merges
  `(builtIn, dbRows)` so DB rows win (`metrics/cost-estimate.ts:125`, whose
  comment asserts the DB-wins policy as intentional). Real inconsistency - the
  same model can price differently depending on the surface - but it is a
  policy decision that needs a human call on which source should be canonical,
  not a mechanical fix. Raise as an issue.
- **No repricing path for already-costed rows.** `derive-cost-backfill` only
  selects `WHERE estimated_cost_usd IS NONE` (`derive-cost-backfill.ts:79`) and
  deliberately never re-prices (documented invariant, `:16-24`). So every rate
  bug is permanent in history. Fixing this properly wants a `cost_basis` column
  distinguishing provider-reported / catalog-priced / estimated costs, so a
  reprice can target only the derived ones - a schema change, worth its own
  design pass rather than being bolted onto a rate fix.
- **`reprice()` skips `normalizeModelName`** on its target model
  (`queries/reprice.ts:41-49`). Real but tiny: its inputs come from
  `MODEL_ALIASES`, which already holds canonical ids. Fold into whichever plan
  next touches that file.
- **`gpt-5.3-codex` / `gpt-5.3-codex-spark` carry `fastMultiplier: 2`** with no
  upstream basis (models.dev reports `experimental.modes.fast: null` for
  `gpt-5.3-codex`). Plan 001 makes it inert by default, so it stops mattering;
  noted in that plan's maintenance section rather than planned separately.

## Verification commands (all plans)

```
bunx tsc --noEmit -p tsconfig.json     # what CI gates on; `bun run typecheck` can exit 0 while this fails
bun test                               # 4 pre-existing failures: apps/studio-desktop electron install
```

These plan files are intentionally **uncommitted** - they are advisory notes on
the branch, not part of PR #752.
