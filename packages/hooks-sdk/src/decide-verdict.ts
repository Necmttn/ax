// packages/hooks-sdk/src/decide-verdict.ts
import { Verdict } from "./verdict.ts";

export interface DecideInput {
    readonly match: boolean;             // matched a route-down class
    readonly explicit: boolean;          // explicit model set
    readonly cheap: boolean;             // explicit model is sonnet/haiku
    readonly judgmentStrong: boolean;    // stays-strong judgment kind
    readonly routeDownEnforced: boolean; // = (mode === conserve)
    readonly input: Record<string, unknown>; // original Agent input (for Route merge)
    readonly suggest: string;            // the class's suggested cheaper model
}

/** Ordered decision; first rule wins. Judgment is rule 0 (never routed/blocked). */
export const decideVerdict = (i: DecideInput): Verdict => {
    // Rule 0: judgment work sent on a cheap model → warn (any mode).
    if (i.judgmentStrong && i.cheap) {
        return Verdict.warn(
            "judgment work (review/design/audit) is the catch-rate gate - prefer the strong model (drop the cheap `model:` or set model:opus).",
        );
    }
    // Rule 1: an explicit model is a deliberate choice - never override.
    if (i.explicit) return Verdict.allow;
    // Rule 2: conserve + forgotten route-down → silently rewrite to the cheaper
    // tier. `!judgmentStrong` enforces judgment-precedence: judgment work that
    // also matched a class (class/regex drift) is NEVER routed down.
    if (i.match && i.routeDownEnforced && !i.judgmentStrong) {
        return Verdict.route({ ...i.input, model: i.suggest });
    }
    // Rule 3: everything else (incl. splurge+match+inherit = strong inherited model).
    return Verdict.allow;
};
