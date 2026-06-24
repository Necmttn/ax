import { Verdict } from "./verdict.ts";

/**
 * Combine the verdicts of several guards that ran against ONE event into a
 * single verdict the harness can act on (a hook process emits exactly one
 * ProcessOutcome).
 *
 * Policy:
 *   1. Any Block wins immediately - the FIRST block's reason is returned, so
 *      enforcement short-circuits (a deny is terminal; later guards can't
 *      un-block it).
 *   2. With no block, the strongest advisory kind present wins, in the fixed
 *      order Inject > Advise > Warn. Messages of that kind are joined with a
 *      blank line so multiple same-kind guards all reach the model/user.
 *   3. Otherwise Allow.
 *
 * In practice the installed guards target disjoint tools/events, so at most one
 * non-Allow verdict appears per event; the same-kind join + priority order make
 * the rare overlap deterministic rather than order-dependent.
 */
export const mergeVerdicts = (verdicts: ReadonlyArray<Verdict>): Verdict => {
  for (const v of verdicts) {
    if (v._tag === "Block") return v;
  }

  const collect = (tag: "Inject" | "Advise" | "Warn"): string[] =>
    verdicts.flatMap((v) => {
      if (v._tag === "Inject" && tag === "Inject") return [v.context];
      if (v._tag === "Advise" && tag === "Advise") return [v.context];
      if (v._tag === "Warn" && tag === "Warn") return [v.message];
      return [];
    });

  const inject = collect("Inject");
  if (inject.length > 0) return Verdict.inject(inject.join("\n\n"));

  const advise = collect("Advise");
  if (advise.length > 0) return Verdict.advise(advise.join("\n\n"));

  const warn = collect("Warn");
  if (warn.length > 0) return Verdict.warn(warn.join("\n\n"));

  return Verdict.allow;
};
