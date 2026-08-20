import { builtInPricingCatalog, pricingForModel, estimateCost } from "/Users/necmttn/Projects/ax/.claude/worktrees/audit-cost/apps/axctl/src/ingest/model-pricing.ts";
const cat = builtInPricingCatalog();
for (const m of ["claude-opus-4-5-20251101","claude-opus-4-5","claude-opus-4-6-20260101","claude-opus-4-1-20250805","claude-sonnet-4-5-20250929","claude-haiku-4-5-20251001","gpt-5.1-codex-mini","gpt-5.2-codex-2026-01-01","gpt-5-codex-high"]) {
  const p = pricingForModel(m, cat);
  console.log(m.padEnd(30), p ? `in=${p.inputPerMillionUsd} out=${p.outputPerMillionUsd} cw=${p.cacheCreationPerMillionUsd}` : "UNPRICED(null)");
}
const mk = (m:string)=>estimateCost({modelKey:m,promptTokens:100_000,completionTokens:10_000,cacheCreationInputTokens:0,cacheReadInputTokens:0,estimatedTokens:110_000,pricingCatalog:cat});
console.log("cost opus-4-5 dated:", mk("claude-opus-4-5-20251101").totalUsd);
console.log("cost opus-4-5 exact:", mk("claude-opus-4-5").totalUsd);
