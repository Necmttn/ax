import { parseLiteLlmPricingCatalog, parseModelsDevPricingCatalog, mergePricingCatalogs, builtInPricingCatalog, estimateCost } from "/Users/necmttn/Projects/ax/.claude/worktrees/audit-cost/apps/axctl/src/ingest/model-pricing.ts";
const ll = JSON.parse(await Bun.file(process.env.HOME+"/.local/share/ax/pricing/litellm-model-prices.json").text());
const md = JSON.parse(await Bun.file(process.env.HOME+"/.local/share/ax/pricing/models-dev-api.json").text());
const merged = mergePricingCatalogs(parseModelsDevPricingCatalog(md), parseLiteLlmPricingCatalog(ll), builtInPricingCatalog());
const args = (m:string, p:number)=>({modelKey:m,promptTokens:p,completionTokens:20_000,cacheCreationInputTokens:0,cacheReadInputTokens:0,estimatedTokens:p+20_000});
for (const m of ["gemini-3-pro-preview","grok-4","deepseek-chat","claude-sonnet-4-5"]) {
  const ingest = estimateCost(args(m,300_000));                       // ingest: no pricingCatalog
  const read   = estimateCost({...args(m,300_000), pricingCatalog: merged});
  console.log(m.padEnd(22), "ingest_total=", ingest.totalUsd, " merged_total=", read.totalUsd);
}
// long-context tier availability
const s45 = estimateCost({...args("claude-sonnet-4-5",300_000), pricingCatalog: merged});
const s45b = estimateCost(args("claude-sonnet-4-5",300_000));
console.log("sonnet-4-5 300k ctx: merged(tiered)=", s45.totalUsd, " builtin-only(ingest)=", s45b.totalUsd);
