import { parseLiteLlmPricingCatalog, parseModelsDevPricingCatalog, mergePricingCatalogs, builtInPricingCatalog, pricingForModel } from "/Users/necmttn/Projects/ax/.claude/worktrees/audit-cost/apps/axctl/src/ingest/model-pricing.ts";
const ll = JSON.parse(await Bun.file(process.env.HOME+"/.local/share/ax/pricing/litellm-model-prices.json").text());
const md = JSON.parse(await Bun.file(process.env.HOME+"/.local/share/ax/pricing/models-dev-api.json").text());
const cat = mergePricingCatalogs(parseModelsDevPricingCatalog(md), parseLiteLlmPricingCatalog(ll), builtInPricingCatalog());
console.log("catalog size", cat.size);
for (const m of ["claude-opus-4-5-20251101","claude-opus-4-5","claude-opus-4-6","claude-opus-5-20260101","gpt-5.1-codex-mini","gpt-5-codex","gpt-5.3-codex","claude-sonnet-4-5-20250929"]) {
  const p = pricingForModel(m, cat);
  console.log(m.padEnd(30), p ? `in=${p.inputPerMillionUsd} out=${p.outputPerMillionUsd} src=${p.pricingSource}` : "UNPRICED");
}
console.log([...cat.keys()].filter(k=>k.includes("opus-4-5")).slice(0,10));
for (const m of ["claude-opus-4-6-20260401","claude-opus-4-7-20260601","claude-opus-4-8-20260801","claude-opus-4-5-thinking"]) {
  const p = pricingForModel(m, cat);
  console.log("LIVE", m.padEnd(28), p ? `in=${p.inputPerMillionUsd} out=${p.outputPerMillionUsd} src=${p.pricingSource}` : "UNPRICED");
}
