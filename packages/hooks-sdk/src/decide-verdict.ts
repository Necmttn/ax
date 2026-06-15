// packages/hooks-sdk/src/decide-verdict.ts
import { Verdict } from "./verdict.ts";

export interface DecideInput {
    readonly match: boolean;             // matched a route-down class
    readonly explicit: boolean;          // explicit model set
    readonly cheap: boolean;             // explicit model is sonnet/haiku
    readonly judgmentStrong: boolean;    // stays-strong judgment kind
    readonly routeDownEnforced: boolean; // = (mode === conserve)
    readonly suggest: string;            // the class's suggested cheaper model
}

/** Ordered decision; first rule wins. Judgment is rule 0 (never routed/blocked). */
export const decideVerdict = (i: DecideInput): Verdict => {
    // Rule 0: judgment work sent on a cheap model → advise (any mode).
    // Uses Verdict.advise so the message reaches the model (additionalContext).
    if (i.judgmentStrong && i.cheap) {
        return Verdict.advise(
            "judgment work (review/design/audit) is the catch-rate gate - prefer the strong model (drop the cheap model: or set model:opus).",
        );
    }
    // Rule 1: an explicit model is a deliberate choice - never override.
    if (i.explicit) return Verdict.allow;
    // Rule 2: conserve + forgotten route-down → advise the model to re-dispatch
    // with the cheaper tier. `!judgmentStrong` enforces judgment-precedence:
    // judgment work that also matched a class (class/regex drift) is NEVER advised down.
    // NOTE: PreToolUse hooks cannot rewrite (updatedInput) or block the Agent tool
    // (CC bugs #39814, #40580). additionalContext (Verdict.advise) is the only
    // mechanism that reaches the model for Agent dispatches.
    if (i.match && i.routeDownEnforced && !i.judgmentStrong) {
        return Verdict.advise(
            `this dispatch looks mechanical - re-dispatch with model:${i.suggest} to save quota (conserve mode).`,
        );
    }
    // Rule 3: everything else (incl. splurge+match+inherit = strong inherited model).
    return Verdict.allow;
};
