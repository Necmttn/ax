# 001 - Stop billing every OpenAI session at priority-tier rates

- **Written against commit:** `d70e1b3e` (branch `fix/751-pricing-claude-opus-5-unpriced-the`)
- **Status:** TODO
- **Depends on:** nothing
- **Blocks:** nothing (plan 003 touches the same function; land 001 first)

## Why this matters

`estimateCost` multiplies the whole computed cost by `pricing.fastMultiplier`,
unconditionally. Four built-in catalog entries carry a multiplier above 1:

| model | fastMultiplier |
|---|---|
| `gpt-5.3-codex` | 2 |
| `gpt-5.3-codex-spark` | 2 |
| `gpt-5.4` | 2 |
| `gpt-5.5` | 2.5 |

Those multipliers encode OpenAI's **priority / fast service tier**. models.dev
confirms the ratio is real for two of them - `gpt-5.5` base is 5/30/0.5 and its
`experimental.modes.fast.cost` is 12.5/75/1.25, exactly 2.5× - so the *numbers*
are correct. The bug is that they are applied to **every** session regardless of
which tier the request actually used.

This machine's Codex config (`~/.codex/config.toml:8`) says:

```toml
service_tier = "default"
```

i.e. NOT priority. Yet the live database shows `gpt-5.5` stored at **$17,235.02**
across 1,736 session rows - the third-largest model by spend - every dollar of
it inflated 2.5×. Removing the unwarranted multiplier drops it to roughly
$6,894, i.e. **~$10.3k of the ~$87.5k all-time reported spend is phantom (~12%)**.

`gpt-5.3-codex` is worse: models.dev lists `experimental.modes.fast` as `null`
for it - there is no documented fast tier at all - yet ax hardcodes ×2.

**There is no per-session tier signal in ingested data.** `service_tier` does not
appear in Codex rollout transcripts; `turn_context` payloads carry only
`approval_policy, collaboration_mode, current_date, cwd, model, personality,
realtime_active, sandbox_policy, summary, timezone, truncation_policy, turn_id,
user_instructions`. So the fix cannot be "detect the tier per session". It must
be: **default to base rates, and make the fast tier an explicit opt-in.** Base
rates are the correct default because the standard tier is the default in the
harness config.

## Current state

`apps/axctl/src/ingest/model-pricing.ts:539-541`:

```ts
    const totalUsd = [inputUsd, outputUsd, cacheCreationUsd, cacheReadUsd]
        .filter((value): value is number => value !== null)
        .reduce((sum, value) => sum + value, 0) * pricing.fastMultiplier;
```

`apps/axctl/src/ingest/model-pricing.ts:153-161` (one of the four entries):

```ts
    "gpt-5.5": {
        provider: "openai",
        inputPerMillionUsd: 5,
        outputPerMillionUsd: 30,
        cacheCreationPerMillionUsd: 5,
        cacheReadPerMillionUsd: 0.5,
        fastMultiplier: 2.5,
        pricingSource: MODEL_PRICING_SOURCE,
    },
```

`fastMultiplier` is also a persisted column: `packages/schema/src/schema.surql:157`
`DEFINE FIELD fast_multiplier ON agent_model TYPE option<float>;`, written by
`agentModelStatement` (`model-pricing.ts:572`) and read back by
`pricingRowsToCatalog` (`model-pricing.ts:469`). Do NOT drop the column - keep
the rate data, change only when it is applied.

## What to do

### Step 1 - make the multiplier opt-in at the estimate site

In `apps/axctl/src/ingest/model-pricing.ts`, add an optional `fastTier` flag to
`estimateCost`'s input object (default `false`) and apply the multiplier only
when it is set:

```ts
export function estimateCost(input: {
    readonly modelKey: string | null;
    readonly promptTokens: number | null;
    readonly completionTokens: number | null;
    readonly cacheCreationInputTokens: number | null;
    readonly cacheReadInputTokens: number | null;
    readonly estimatedTokens: number;
    readonly pricingCatalog?: ReadonlyMap<string, ModelPricing>;
    /**
     * Bill at the provider's priority/fast tier. OFF by default: the harness
     * default is the standard tier (`service_tier = "default"` in
     * ~/.codex/config.toml) and no per-session tier signal exists in any
     * transcript, so assuming priority overstated every OpenAI cost.
     */
    readonly fastTier?: boolean;
}): CostEstimate {
```

and at the total:

```ts
    const tierMultiplier = input.fastTier === true ? pricing.fastMultiplier : 1;
    const totalUsd = [inputUsd, outputUsd, cacheCreationUsd, cacheReadUsd]
        .filter((value): value is number => value !== null)
        .reduce((sum, value) => sum + value, 0) * tierMultiplier;
```

`exactOptionalPropertyTypes: true` is on in this repo - declare the field as
`readonly fastTier?: boolean` and compare with `=== true`; do not add
`| undefined` to the property type, and do not pass `fastTier: undefined`
explicitly at call sites (omit the key instead). See the existing conditional-
spread idiom at `apps/axctl/src/queries/reprice.ts:48`:
`...(pricingCatalog.size > 0 ? { pricingCatalog } : {})`.

**Do not** change any of the four catalog entries' `fastMultiplier` values, and
do not touch the `fast_multiplier` schema column. The rates stay; only their
application becomes conditional.

Verify:

```
bunx tsc --noEmit -p tsconfig.json
```

Expected: no `error TS` lines. (`bun run typecheck` is NOT sufficient - it can
exit 0 while CI's plain `tsc` fails; CI gates on the command above.)

### Step 2 - add the env opt-in

Still in `model-pricing.ts`, export a small reader so callers that price at
ingest can honor an explicit opt-in:

```ts
/**
 * Opt into priority/fast-tier billing (`AX_OPENAI_FAST_TIER=1`). Default is the
 * standard tier - see `estimateCost`'s `fastTier` doc comment.
 */
export const fastTierEnabled = (
    env: Record<string, string | undefined> = process.env,
): boolean => env.AX_OPENAI_FAST_TIER === "1";
```

Do NOT wire this into every call site in this plan. Wire it into exactly one:
the ingest pricing path in `apps/axctl/src/ingest/codex.ts` where `estimateCost`
is called for Codex usage rows. Find it with:

```
rg -n "estimateCost\(" apps/axctl/src
```

Add `fastTier: fastTierEnabled()` to that one call (conditional-spread if the
flag is false, per the note in step 1). Leave read-time callers
(`metrics/cost-estimate.ts`, `queries/cost-analytics.ts`, `queries/reprice.ts`)
on the default - they must agree with what ingest stored, and the default is now
base rates on both sides.

### Step 3 - tests

Add to `apps/axctl/src/ingest/model-pricing.test.ts`, inside the existing
`describe("model pricing", ...)` block. Follow the file's existing style: plain
`it(...)`, `builtInPricingCatalog()` for the catalog, `toMatchObject` /
`toBeCloseTo` for numbers.

```ts
    it("bills at base rates by default and at the fast tier only when asked", () => {
        const catalog = builtInPricingCatalog();
        const usage = {
            modelKey: "gpt-5.5",
            promptTokens: 1_000_000,
            completionTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            estimatedTokens: 1_000_000,
            pricingCatalog: catalog,
        };

        // 1M fresh input tokens at $5/M.
        expect(estimateCost(usage).totalUsd).toBeCloseTo(5, 6);
        // Priority tier is 2.5x - opt-in only.
        expect(estimateCost({ ...usage, fastTier: true }).totalUsd).toBeCloseTo(12.5, 6);
    });

    it("reads the fast-tier opt-in from the environment", () => {
        expect(fastTierEnabled({})).toBe(false);
        expect(fastTierEnabled({ AX_OPENAI_FAST_TIER: "0" })).toBe(false);
        expect(fastTierEnabled({ AX_OPENAI_FAST_TIER: "1" })).toBe(true);
    });
```

Add `fastTierEnabled` to the import list at the top of the test file.

Then check whether any EXISTING test asserts a fast-multiplied total. Run:

```
rg -n "fastMultiplier|fast_multiplier|gpt-5\.5|gpt-5\.4|gpt-5\.3-codex" apps/axctl/src --glob '*.test.ts'
```

Any test that asserted a ×2 / ×2.5 total must be updated to the base-rate number
**and** gain a sibling assertion with `fastTier: true`. A test that only asserts
the catalog entry's `fastMultiplier` field value (not a computed total) stays
as-is - the field is unchanged.

Verify:

```
bun test apps/axctl/src/ingest/model-pricing.test.ts
bun test
```

Expected: model-pricing suite fully green. On the full run, exactly 4 failures
are pre-existing and unrelated - `apps/studio-desktop/src/electron/*.test.ts`
failing with `Electron failed to install correctly`. Any OTHER failure is yours;
fix it or STOP and report.

### Step 4 - do NOT reprice history in this plan

Stored costs written under the old multiplier stay wrong until a repricing path
exists - there is none today (`derive-cost-backfill.ts:79` only selects
`WHERE estimated_cost_usd IS NONE`, and `ax ingest --reparse=pricing` rewrites
only the `agent_model` catalog table, not usage rows). Repricing is deliberately
out of scope here. Note it in the PR body as a known follow-up.

## Boundaries

**In scope:** `apps/axctl/src/ingest/model-pricing.ts`,
`apps/axctl/src/ingest/model-pricing.test.ts`, the single Codex ingest
`estimateCost` call site, and any existing test that asserted a fast-multiplied
total.

**Out of scope - do not touch:**
- The four `fastMultiplier` values in `BUILTIN_MODEL_PRICING_CATALOG`.
- `packages/schema/src/schema.surql` (the `fast_multiplier` column stays).
- `componentCost` and the `*Above200k*` fields - that is plan 003.
- Any stored-row migration / repricing.
- `apps/studio*`, `apps/site`, docs beyond a one-line note if you add one.

## Done criteria

1. `bunx tsc --noEmit -p tsconfig.json` prints no `error TS` lines.
2. `bun test apps/axctl/src/ingest/model-pricing.test.ts` - all pass.
3. `bun test` - only the 4 pre-existing electron failures.
4. `rg -n "pricing.fastMultiplier" apps/axctl/src` returns exactly one hit, and
   that line is guarded by the `fastTier` flag.
5. Sanity check the headline number:
   ```
   bun -e 'import {estimateCost,builtInPricingCatalog} from "./apps/axctl/src/ingest/model-pricing.ts"; const c=builtInPricingCatalog(); const u={modelKey:"gpt-5.5",promptTokens:1e6,completionTokens:0,cacheCreationInputTokens:0,cacheReadInputTokens:0,estimatedTokens:1e6,pricingCatalog:c}; console.log(estimateCost(u).totalUsd, estimateCost({...u,fastTier:true}).totalUsd)'
   ```
   Expected output: `5 12.5`.

## Test plan

New tests live in `apps/axctl/src/ingest/model-pricing.test.ts` (pattern: the
existing `it("prices claude-sonnet-5 and every GPT-5.6 tier from the built-in
catalog", ...)`). Two cases: default-is-base-rates + opt-in-is-multiplied, and
the env reader's three states. No DB, no network, no fixtures - `estimateCost`
and `fastTierEnabled` are pure.

## Maintenance note

Anyone adding a model with a documented priority tier should set
`fastMultiplier` from the provider's published fast rate ÷ base rate (models.dev
exposes this as `experimental.modes.fast.cost`) and must NOT assume it will be
applied - it only applies under `AX_OPENAI_FAST_TIER=1`.

`gpt-5.3-codex` and `gpt-5.3-codex-spark` carry `fastMultiplier: 2` but
models.dev reports `experimental.modes.fast` as `null` for `gpt-5.3-codex` -
that multiplier has no upstream basis. After this plan it is inert by default,
so it is not urgent; flag it in review if someone enables the opt-in.

## Escape hatches

- If `rg -n "estimateCost\(" apps/axctl/src` shows the Codex ingest path does
  **not** call `estimateCost` directly (e.g. it goes through a wrapper), wire
  `fastTier` at the wrapper instead - but if that wrapper is shared with a
  read-time surface, STOP and report: wiring it there would reintroduce the
  ingest/read disagreement this plan is trying to avoid.
- If more than ~5 existing tests assert fast-multiplied totals, STOP and report
  the list before editing them - that many would suggest the multiplier is
  load-bearing somewhere this plan did not survey.
