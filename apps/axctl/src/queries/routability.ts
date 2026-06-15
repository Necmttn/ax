/**
 * Main-thread routability lens - classify main-agent class-runs by whether they
 * could have been a cheaper subagent dispatch, and reprice routable spans.
 * Deterministic: tool composition (A) + thinking signal (B). No LLM.
 * Spec: docs/superpowers/specs/2026-06-15-cost-routability-lens-design.md
 */
import { JUDGMENT_GUARD_RE } from "./routing-tune.ts";
import type { RepriceUsage } from "./reprice.ts";

export type WorkClass =
    | "gather"
    | "niche-research"
    | "mechanical-impl"
    | "synthesis"
    | "design-decision"
    | "interactive";

/** Routable classes and the tier they should drop to. Others stay on main. */
export const ROUTABLE_TIER: Partial<Record<WorkClass, "haiku" | "sonnet">> = {
    gather: "haiku",
    "niche-research": "sonnet",
    "mechanical-impl": "sonnet",
};

export interface TurnFacts {
    seq: number;
    role: string;
    toolNames: ReadonlyArray<string>;
    thinkingTokens: number;
    intentKind: string | null;
    text: string | null;
    usage: RepriceUsage | null;
}

export const THINK_HI = 1500; // output tokens of thinking that marks "reasoning"
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS"]);
const RESEARCH_TOOLS = new Set(["WebFetch", "WebSearch"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "Bash"]);
const INTERACTIVE_INTENTS = new Set(["correction", "preference", "wrapper_instruction"]);

/**
 * Assign one work-class to a main-agent turn. Judgment-first precedence so
 * review/design/interactive can never be classed routable. `adjacentToUser`
 * is computed by buildSpans (turn neighbours a user turn).
 */
export function classifyTurn(t: TurnFacts, adjacentToUser: boolean): WorkClass {
    if (adjacentToUser) return "interactive";
    if (t.intentKind && INTERACTIVE_INTENTS.has(t.intentKind)) return "interactive";

    const hasEdit = t.toolNames.some((n) => EDIT_TOOLS.has(n));
    const editCount = t.toolNames.filter((n) => EDIT_TOOLS.has(n)).length;
    const readCount = t.toolNames.filter((n) => READ_TOOLS.has(n)).length;
    const researchCount = t.toolNames.filter((n) => RESEARCH_TOOLS.has(n)).length;

    if (t.text && JUDGMENT_GUARD_RE.test(t.text)) return "design-decision";
    if (t.thinkingTokens >= THINK_HI && hasEdit) return "design-decision";
    if (t.thinkingTokens >= THINK_HI && t.toolNames.length <= 1) return "synthesis";

    if (editCount > 0 && editCount >= readCount && editCount >= researchCount) return "mechanical-impl";
    if (researchCount > 0) return "niche-research";
    if (readCount > 0) return "gather";

    return "interactive";
}
