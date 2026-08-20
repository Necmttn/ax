import { reprice } from "/Users/necmttn/Projects/ax/.claude/worktrees/audit-cost/apps/axctl/src/queries/reprice.ts";
import { builtInPricingCatalog, estimateCost } from "/Users/necmttn/Projects/ax/.claude/worktrees/audit-cost/apps/axctl/src/ingest/model-pricing.ts";
const cat = builtInPricingCatalog();
const usage = { prompt_tokens: 1_000_000, completion_tokens: 100_000, cache_read_tokens: 400_000, cache_create_tokens: 500_000, cost_usd: 12.34 };
for (const m of ["gpt-5-nano","gpt-5-mini","gpt-5","gpt-5.5"]) {
  const e = estimateCost({modelKey:m,promptTokens:usage.prompt_tokens,completionTokens:usage.completion_tokens,cacheCreationInputTokens:usage.cache_create_tokens,cacheReadInputTokens:usage.cache_read_tokens,estimatedTokens:0,pricingCatalog:cat,aggregated:true});
  console.log(m.padEnd(12), "total=",reprice(usage,m,cat).toFixed(4), " cacheCreationUsd=", e.cacheCreationUsd, " (500k cache-creation tokens billed at", e.cacheCreationUsd===null?"NOTHING":"a rate", ")");
}
