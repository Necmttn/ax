# 003 - Fix the `>200k` context-tier calculation (and stop feeding it aggregates)

- **Written against commit:** `d70e1b3e` (branch `fix/751-pricing-claude-opus-5-unpriced-the`)
- **Status:** TODO
- **Depends on:** plan 001 (same function, `estimateCost`; land 001 first to avoid a conflict)
- **Blocks:** nothing

## Why this matters

`componentCost` implements long-context pricing as a **marginal, per-component**
calculation. Real provider pricing is a **flat switch on the request's input
context size**: if a single request's context exceeds the threshold, that whole
request bills at the higher rate. Three things are wrong:

1. **Marginal vs flat.** The code bills the first 200k at the base rate and only
   the remainder at the premium. Providers bill every token of a qualifying
   request at the premium.
2. **Per-component vs per-request-context.** The threshold is compared against
   *each component's own token count* - output tokens against 200k, cache-read
   tokens against 200k, etc. The tier is a property of the input context, not of
   each bucket. `outputAbove200kPerMillionUsd` is effectively dead code: output
   caps at 128k per request, so `tokens <= 200_000` is always true for it.
3. **Aggregates, not requests.** Every caller passes *summed* token counts.
   `session_token_usage` holds one row per session - the live DB has
   `claude-opus-4-8` at 47.86B prompt tokens across 1,669 session rows, i.e.
   ~28.7M prompt tokens per row. `resolveRowCost` in
   `apps/axctl/src/queries/cost-analytics.ts` is worse: its input is a whole
   rollup group summed across many sessions. Against those numbers the "first
   200k at base rate" is rounding error and **essentially 100% of tokens bill at
   the premium**, whether or not any individual request was ever long-context.

Today the blast radius is small because none of the top-spend models has tier
rates loaded - checked in the live DB, `claude-opus-4-8`, `claude-fable-5`,
`gpt-5.5`, `gpt-5.4`, `claude-opus-4-7`, `claude-sonnet-4-6` and
`claude-haiku-4-5-20251001` all have `input_above_200k_per_million_usd = NONE`.
Rows that DO carry tiers (litellm `claude-sonnet-4-5` family, `inp=3 → inp200=6`)
are not in the user's top spend.

**That changes with PR #752**, which adds `*Above200k*` fields to `gpt-5.6-sol`,
`gpt-5.6-terra` and `gpt-5.6-luna`. Once merged, any Codex session on those
models gets ~all of its tokens billed at the premium - for terra that is
$4/M instead of $2/M input, a ~2× over-count. **This plan must land before, or
together with, those tier fields becoming active.**

## Current state

`apps/axctl/src/ingest/model-pricing.ts:503-507`:

```ts
const componentCost = (tokens: number, basePerMillion: number | null, above200kPerMillion?: number | null): number | null => {
    if (basePerMillion === null) return null;
    if (!above200kPerMillion || tokens <= 200_000) return tokens * basePerMillion / 1_000_000;
    return (200_000 * basePerMillion + (tokens - 200_000) * above200kPerMillion) / 1_000_000;
};
```

Called four times from `estimateCost` (`model-pricing.ts:533-538`), once per
component, each with that component's own token count.

Callers, all of which pass aggregated counts:
- `apps/axctl/src/metrics/cost-estimate.ts:77-85` - one session's summed usage.
- `apps/axctl/src/ingest/derive-cost-backfill.ts:98-107` - same, at derive time.
- `apps/axctl/src/queries/cost-analytics.ts` `resolveRowCost` - a rollup group.
- `apps/axctl/src/queries/reprice.ts:41-49` - a dispatch's summed usage.

## What to do

The honest fix is **not** to make the aggregate calculation cleverer - the input
simply does not carry the per-request context sizes needed to apply a
per-request tier. The fix is to make the code do something defensible and say
which it is doing.

### Step 1 - decide and encode the semantics

Implement **flat-switch, evaluated once per estimate, against the request's
input context** - and make the "is this one request?" question explicit at the
call site rather than implied.

In `apps/axctl/src/ingest/model-pricing.ts`, replace `componentCost` with a flat
rate selection, and choose the tier ONCE in `estimateCost`:

```ts
/** Long-context threshold: above this input context, the whole request bills at the tier rate. */
export const CONTEXT_TIER_THRESHOLD_TOKENS = 200_000;

const componentCost = (tokens: number, perMillion: number | null): number | null =>
    perMillion === null ? null : tokens * perMillion / 1_000_000;
```

In `estimateCost`, after `promptTokens` / cache buckets are resolved, pick the
rate set once:

```ts
    // The long-context surcharge is a property of ONE REQUEST's input context,
    // and it is flat: above the threshold, every token of that request bills at
    // the tier rate. Callers that pass SUMMED tokens (a whole session, a rollup
    // group) cannot answer "was any single request long-context?", so they must
    // NOT trigger the tier - see `aggregated` below.
    const tiered = input.aggregated !== true
        && promptTokens > CONTEXT_TIER_THRESHOLD_TOKENS
        && pricing.inputAbove200kPerMillionUsd != null;

    const inputRate = tiered ? pricing.inputAbove200kPerMillionUsd : pricing.inputPerMillionUsd;
    const outputRate = tiered ? (pricing.outputAbove200kPerMillionUsd ?? pricing.outputPerMillionUsd) : pricing.outputPerMillionUsd;
    const cacheCreationRate = tiered ? (pricing.cacheCreationAbove200kPerMillionUsd ?? pricing.cacheCreationPerMillionUsd) : pricing.cacheCreationPerMillionUsd;
    const cacheReadRate = tiered ? (pricing.cacheReadAbove200kPerMillionUsd ?? pricing.cacheReadPerMillionUsd) : pricing.cacheReadPerMillionUsd;
```

and use those four rates in the four `componentCost` calls.

Add the flag to `estimateCost`'s input type (mind `exactOptionalPropertyTypes`:
declare `readonly aggregated?: boolean`, compare with `=== true`, and omit the
key rather than passing `undefined`):

```ts
    /**
     * These token counts are a SUM over many requests (a session row, a rollup
     * group), not one request. Suppresses the long-context tier, which is
     * per-request and cannot be recovered from a sum. Default false.
     */
    readonly aggregated?: boolean;
```

### Step 2 - mark the aggregate call sites

Set `aggregated: true` at every caller that passes summed counts:

- `apps/axctl/src/metrics/cost-estimate.ts` - inside `fillEstimatedCost`.
- `apps/axctl/src/queries/cost-analytics.ts` - inside `resolveRowCost`.
- `apps/axctl/src/queries/reprice.ts` - inside `reprice`.

`derive-cost-backfill.ts` goes through `fillEstimatedCost`, so it inherits the
flag - do not add it there separately.

Leave any genuine per-request call site (a single turn's usage) unflagged. Find
every call with:

```
rg -n "estimateCost\(" apps/axctl/src
```

and classify each one in the PR body: request-grain (tier may apply) vs
aggregate (tier suppressed). If you cannot tell for a given site, treat it as
aggregate - under-counting a surcharge is the safer error, and it is the
behaviour those sites have today for all top-spend models.

### Step 3 - while you are here, read the tiers models.dev already publishes

`parseModelsDevPricingCatalog` (`model-pricing.ts:427-436`) drops the tier data
entirely, while `parseLiteLlmPricingCatalog` (`:398-401`) reads its
`*_above_200k_tokens` fields. models.dev exposes the same information as
`cost.context_over_200k` (and a `cost.tiers` array), e.g. for `gpt-5.6-terra`:

```json
"cost": { "input": 2, "output": 12, "cache_read": 0.2, "cache_write": 2.5,
          "context_over_200k": { "input": 4, "output": 18, "cache_read": 0.4, "cache_write": 5 } }
```

Add the four `*Above200kPerMillionUsd` fields to the object built in
`parseModelsDevPricingCatalog`, reading from `cost.context_over_200k` via the
existing `numberOrNull` helper and the existing `asRecord` guard. Ignore
`cost.tiers` - `context_over_200k` is the flat form this code models.

This is additive: it only populates fields that were `undefined` before. It is in
scope here (not a separate plan) precisely because step 1 must land first -
populating tier rates while the marginal/aggregate calculation is still in place
would activate the over-count on many more models.

### Step 4 - tests

In `apps/axctl/src/ingest/model-pricing.test.ts`:

```ts
    it("applies the long-context tier flat, per request, and only above the threshold", () => {
        const catalog = builtInPricingCatalog();
        const base = {
            modelKey: "gpt-5.6-terra",
            completionTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            pricingCatalog: catalog,
        };

        // Under the threshold: base rate ($2/M).
        expect(estimateCost({ ...base, promptTokens: 100_000, estimatedTokens: 100_000 }).totalUsd)
            .toBeCloseTo(0.2, 6);
        // Over the threshold: the WHOLE request at the tier rate ($4/M) - not
        // 200k at base plus the remainder at tier.
        expect(estimateCost({ ...base, promptTokens: 1_000_000, estimatedTokens: 1_000_000 }).totalUsd)
            .toBeCloseTo(4, 6);
    });

    it("never applies the long-context tier to aggregated token sums", () => {
        const catalog = builtInPricingCatalog();
        const summed = {
            modelKey: "gpt-5.6-terra",
            promptTokens: 28_000_000,
            completionTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            estimatedTokens: 28_000_000,
            pricingCatalog: catalog,
        };

        // A session row summing 28M tokens says nothing about any single
        // request's context - bill at base ($2/M), not the tier rate.
        expect(estimateCost({ ...summed, aggregated: true }).totalUsd).toBeCloseTo(56, 6);
    });

    it("reads models.dev context_over_200k tiers", () => {
        const catalog = parseModelsDevPricingCatalog({
            openai: { models: { "gpt-test": { id: "gpt-test", cost: {
                input: 2, output: 12, cache_read: 0.2, cache_write: 2.5,
                context_over_200k: { input: 4, output: 18, cache_read: 0.4, cache_write: 5 },
            } } } },
        });
        expect(catalog.get("gpt-test")).toMatchObject({
            inputPerMillionUsd: 2,
            inputAbove200kPerMillionUsd: 4,
            outputAbove200kPerMillionUsd: 18,
        });
    });
```

Then find and update every existing test that asserts the OLD marginal maths:

```
rg -n "200_000|200000|Above200k|above_200k" apps/axctl/src --glob '*.test.ts'
```

Any test asserting `(200_000 * base + remainder * tier)` must be rewritten to the
flat expectation. If one of them documents the marginal behaviour as intentional
(a comment citing a provider doc), **STOP and report** - that would contradict
this plan's premise and needs a human decision.

Verify:

```
bun test apps/axctl/src/ingest/model-pricing.test.ts
bunx tsc --noEmit -p tsconfig.json
bun test
```

Expected: green except the 4 pre-existing `apps/studio-desktop` electron
failures (`Electron failed to install correctly`).

## Boundaries

**In scope:** `apps/axctl/src/ingest/model-pricing.ts` (`componentCost`,
`estimateCost`, `parseModelsDevPricingCatalog`), the `aggregated: true` flag at
the three aggregate call sites named in step 2, and the affected tests.

**Out of scope - do not touch:**
- `fastMultiplier` and its gating - that is plan 001.
- Session model attribution - that is plan 002.
- The `*_above_200k_*` schema columns or `agentModelStatement`.
- Repricing stored history.
- The 272,000-token `tiers[].tier.size` variant in models.dev. This plan models
  the flat `context_over_200k` form only; do not implement a second threshold.

## Done criteria

1. `bunx tsc --noEmit -p tsconfig.json` prints no `error TS` lines.
2. `bun test apps/axctl/src/ingest/model-pricing.test.ts` - all pass, including
   the three new cases.
3. `bun test` - only the 4 pre-existing electron failures.
4. `rg -n "200_000" apps/axctl/src/ingest/model-pricing.ts` shows the threshold
   defined ONCE (`CONTEXT_TIER_THRESHOLD_TOKENS`) and referenced from
   `estimateCost` - not inside `componentCost`.
5. Every `estimateCost(` call site in `apps/axctl/src` is classified in the PR
   body as request-grain or aggregate.

## Test plan

All three new cases are pure (no DB, no network) and live in
`apps/axctl/src/ingest/model-pricing.test.ts` alongside the existing pricing
tests. The models.dev parser case follows the shape of the existing
`parseLiteLlmPricingCatalog` / `parseModelsDevPricingCatalog` tests at the top of
that file - inline literal input, `toMatchObject` on the parsed entry.

## Maintenance note

The `aggregated` flag is a **grain assertion**, not a tuning knob: it says "these
counts are a sum over requests". Any new `estimateCost` caller must answer that
question. A caller that is unsure should pass `aggregated: true`.

If ax ever records per-request input context (e.g. per-turn prompt tokens at
request grain rather than turn grain), the tier could be applied accurately at
that grain and summed upward - that is the only path to a correct long-context
number, and it is a data-model change, not a pricing-formula change.

## Escape hatches

- If plan 001 has not landed, STOP - both plans edit the tail of `estimateCost`
  and will conflict.
- If any existing test documents the marginal calculation as deliberate with a
  provider-doc citation, STOP and report before changing it.
- If `rg -n "estimateCost\("` turns up a call site in `apps/studio` or
  `packages/`, STOP and report - this plan surveyed `apps/axctl` only.
