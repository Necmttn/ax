/**
 * The `ax skills taste` composite score formula, shared by the CLI
 * (`cli/commands/skills.ts`) and the studio triage dashboard
 * (`dashboard/triage.ts`) so the two consumers cannot drift apart on what
 * "score" means.
 *
 * The score is an ALL-TIME composite (not a 30-day metric - `inv_30d` is a
 * separate display column, never a formula input) and `clean` (error-free
 * invocations) does not feed into it at all. See TASTE_SCORE_LEGEND for what
 * every column means.
 *
 * `cmts` is commit correlation, not comments and not "commits after
 * invocation": it is the count of DISTINCT `produced` (commit) edges from
 * every session that invoked this skill, with no ordering constraint between
 * the invocation and the commit within that session. A single commit-heavy
 * session can push `cmts` far past a skill's own `total`, so the formula caps
 * its contribution at `total` (commit_credit = min(cmts, total)) - otherwise
 * one prolific session could dominate the score for a skill invoked once.
 * The raw, uncapped `cmts` stays visible as its own column.
 */

export interface TasteScoreInputs {
    /** all-time invocations of the skill */
    readonly total: number;
    /** invocations followed by a same-session correction within 3 turns */
    readonly corrections: number;
    /** raw correlated-commit count (see module doc) - NOT capped */
    readonly cmts: number;
    /** proposal edges into this skill */
    readonly proposals: number;
}

export const TASTE_SCORE_FORMULA = "score = total - 2×corr + min(cmts, total) - 0.5×prop";

export const TASTE_SCORE_LEGEND: ReadonlyArray<{ readonly key: string; readonly desc: string }> = [
    { key: "total", desc: "all-time invocations (formula input)" },
    { key: "clean", desc: "invocations with no tool/turn error - display only, does not affect score" },
    { key: "corr", desc: "invocations followed by a same-session correction within 3 turns (formula input, x2 weight)" },
    { key: "prop", desc: "proposal edges into this skill (formula input, x0.5 weight)" },
    { key: "cmts", desc: "commits correlated with a session that invoked this skill, not necessarily after invocation - raw value shown, capped at total in the formula (commit_credit = min(cmts, total))" },
];

/** commit_credit = min(cmts, total) - the capped contribution `cmts` makes to the score. */
export const commitCredit = (cmts: number, total: number): number => Math.min(cmts, total);

export const computeTasteScore = (inputs: TasteScoreInputs): number =>
    inputs.total - 2 * inputs.corrections + commitCredit(inputs.cmts, inputs.total) - 0.5 * inputs.proposals;
