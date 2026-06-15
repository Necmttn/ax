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

export interface Span {
  cls: WorkClass;
  turnCount: number;
  usage: RepriceUsage; // summed across the span's turns
  routable: boolean; // cls is routable AND turnCount >= minRun
}

const ZERO_USAGE = (): RepriceUsage => ({
  prompt_tokens: 0, completion_tokens: 0, cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: 0,
});

function addUsage(a: RepriceUsage, b: RepriceUsage | null): RepriceUsage {
  if (!b) return a;
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    cache_read_tokens: a.cache_read_tokens + b.cache_read_tokens,
    cache_create_tokens: a.cache_create_tokens + b.cache_create_tokens,
    cost_usd: a.cost_usd + b.cost_usd,
  };
}

/**
 * Group ONE session's main-agent turns (seq order) into class-run spans.
 * Splits at every user turn (judgment boundary); within a segment, groups
 * consecutive assistant turns sharing a class. A turn neighbouring a user
 * turn is forced to `interactive`. A span is routable iff its class is
 * routable AND its run length >= minRun.
 */
export function buildSpans(turns: ReadonlyArray<TurnFacts>, minRun: number): Span[] {
  const spans: Span[] = [];
  let cur: { cls: WorkClass; turnCount: number; usage: RepriceUsage } | null = null;

  const flush = () => {
    if (!cur) return;
    const tier = ROUTABLE_TIER[cur.cls];
    spans.push({ cls: cur.cls, turnCount: cur.turnCount, usage: cur.usage, routable: tier !== undefined && cur.turnCount >= minRun });
    cur = null;
  };

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.role !== "assistant") { flush(); continue; }
    const prevIsUser = i > 0 && turns[i - 1].role === "user";
    const cls = classifyTurn(t, prevIsUser);
    if (cur && cur.cls === cls) {
      cur.turnCount += 1;
      cur.usage = addUsage(cur.usage, t.usage);
    } else {
      flush();
      cur = { cls, turnCount: 1, usage: addUsage(ZERO_USAGE(), t.usage) };
    }
  }
  flush();
  return spans;
}
