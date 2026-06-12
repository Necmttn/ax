// Routing-class tuning workflow - the anti-staleness loop for ROUTING_CLASSES.
//
// The routing table (apps/axctl/src/queries/dispatch-analytics.ts ROUTING_CLASSES,
// mirrored into the route-dispatch hook and skills/efficient-dispatch) is a
// hand-written constant. This workflow mines recent dispatch history for
// class updates, adversarially backtests every proposal against judgment-work
// false positives, and emits a reviewable brief - it never edits the constant
// itself. Run it when `ax dispatches --candidates` keeps surfacing unmatched
// spend, or monthly. Pass args: { days?: number, date: "YYYY-MM-DD" }.
export const meta = {
  name: "routing-tune",
  description: "Mine dispatch history for routing-class updates, backtest against false positives, emit a review brief",
  whenToUse: "When ax dispatches --candidates shows unmatched expensive dispatches, or as a monthly routing-table refresh",
  phases: [
    { title: "Mine", detail: "pull dispatch history, cluster unmatched expensive inherits" },
    { title: "Backtest", detail: "one adversarial verifier per proposed class" },
    { title: "Emit", detail: "write .ax/tasks brief with the surviving diff" },
  ],
};

const days = (args && args.days) || 30;
const date = (args && args.date) || "undated";

const PROPOSAL_SCHEMA = {
  type: "object",
  required: ["proposals", "retire_candidates", "unmatched_total_cost_usd"],
  properties: {
    proposals: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "pattern", "flags", "suggest", "reason", "examples", "est_savings_usd"],
        properties: {
          id: { type: "string", description: "kebab-case class id" },
          pattern: { type: "string", description: "JS regex source matching dispatch descriptions" },
          flags: { type: "string" },
          suggest: { type: "string", enum: ["sonnet", "haiku"] },
          reason: { type: "string" },
          examples: { type: "array", items: { type: "string" }, description: "3+ real dispatch descriptions this would match" },
          est_savings_usd: { type: "number" },
        },
      },
    },
    retire_candidates: {
      type: "array",
      items: { type: "string" },
      description: "existing class ids that matched nothing in the window",
    },
    unmatched_total_cost_usd: { type: "number" },
  },
};

const VERDICT_SCHEMA = {
  type: "object",
  required: ["keep", "false_positive_risk", "rationale"],
  properties: {
    keep: { type: "boolean" },
    false_positive_risk: { type: "string", enum: ["none", "low", "high"] },
    rationale: { type: "string" },
  },
};

phase("Mine");
const mined = await agent(
  `In the ax repo (cwd), run \`bun apps/axctl/src/cli/index.ts dispatches --days=${days} --limit=500 --json\` ` +
  `and \`bun apps/axctl/src/cli/index.ts dispatches --candidates --days=${days} --json\`. ` +
  `Read ROUTING_CLASSES in apps/axctl/src/queries/dispatch-analytics.ts. ` +
  `Find dispatches that (a) ran with dispatch_model=inherit on an expensive child model (fable/opus), ` +
  `(b) match NO current class, and (c) look mechanical (bounded scope, spec'd, search/summarize/convert work - ` +
  `NOT quality review, PR review, plan synthesis, architecture, or taste-heavy design/copy: those stay on the main model by policy). ` +
  `Cluster their descriptions and propose at most 5 new routing classes with tight ^-anchored patterns - ` +
  `prefer missing a few over matching judgment work. Also list existing class ids that matched zero dispatches in the window.`,
  { label: "mine:unmatched", phase: "Mine", schema: PROPOSAL_SCHEMA, model: "sonnet" },
);

phase("Backtest");
const verdicts = await parallel(
  mined.proposals.map((p) => () =>
    agent(
      `Adversarially review this proposed dispatch-routing class for the ax routing table. ` +
      `Class: ${JSON.stringify(p)}. ` +
      `In the ax repo (cwd), run \`bun apps/axctl/src/cli/index.ts dispatches --days=${days * 3} --limit=500 --json\` ` +
      `and test the regex /${p.pattern}/${p.flags} against EVERY description. ` +
      `Try to REFUTE the class: does it match any quality review, PR review, plan, architecture, design, or copy dispatch ` +
      `(judgment work that must stay on the main model)? Does it overlap an existing ROUTING_CLASSES pattern ` +
      `(apps/axctl/src/queries/dispatch-analytics.ts)? Default keep=false when uncertain.`,
      { label: `backtest:${p.id}`, phase: "Backtest", schema: VERDICT_SCHEMA, model: "sonnet" },
    ).then((v) => ({ proposal: p, verdict: v })),
  ),
);

const surviving = verdicts.filter(Boolean).filter((r) => r.verdict.keep);
const rejected = verdicts.filter(Boolean).filter((r) => !r.verdict.keep);
log(`${surviving.length}/${mined.proposals.length} proposed classes survived adversarial backtest`);

phase("Emit");
const brief = await agent(
  `Write a routing-tune review brief to .ax/tasks/routing-tune-${date}.md in the ax repo (cwd). Content: ` +
  `(1) window: last ${days}d, unmatched expensive inherit spend $${mined.unmatched_total_cost_usd}; ` +
  `(2) SURVIVING class proposals as ready-to-paste ROUTING_CLASSES entries (TypeScript object literals matching the existing style in apps/axctl/src/queries/dispatch-analytics.ts), each with its examples and est savings: ${JSON.stringify(surviving)}; ` +
  `(3) rejected proposals with refutation rationale: ${JSON.stringify(rejected.map((r) => ({ id: r.proposal.id, rationale: r.verdict.rationale })))}; ` +
  `(4) retirement candidates (zero matches in window): ${JSON.stringify(mined.retire_candidates)}; ` +
  `(5) apply checklist: edit ROUTING_CLASSES + the hook DEFAULT_TABLE (packages/hooks-sdk/src/hooks/route-dispatch.ts), run the dispatch-analytics + route-dispatch tests, then \`ax dispatches compile-routing\` and \`ax dispatches compile-routing --skill-md=skills/efficient-dispatch/SKILL.md\`. ` +
  `Do NOT edit ROUTING_CLASSES or the hook yourself - the brief is the deliverable. Return the file path.`,
  { label: "emit:brief", phase: "Emit", model: "sonnet" },
);

return {
  window_days: days,
  unmatched_cost_usd: mined.unmatched_total_cost_usd,
  proposed: mined.proposals.length,
  survived: surviving.length,
  retire_candidates: mined.retire_candidates,
  brief,
};
