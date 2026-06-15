/**
 * Main-thread routability lens - classify main-agent class-runs by whether they
 * could have been a cheaper subagent dispatch, and reprice routable spans.
 * Deterministic: tool composition (A) + thinking signal (B). No LLM.
 * Spec: docs/superpowers/specs/2026-06-15-cost-routability-lens-design.md
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { JUDGMENT_GUARD_RE } from "./routing-tune.ts";
import { MODEL_ALIASES, reprice } from "./reprice.ts";
import type { RepriceUsage, ModelPricing } from "./reprice.ts";

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

export interface RoutabilityInput {
  days: number;
  minRun: number;
}

export interface RoutabilityClassRow {
  class: string;
  verdict: "routable" | "stays";
  runs: number;
  turns: number;
  mainCostUsd: number;
  tier: string | null;
  repricedUsd: number | null;
  estSavingsUsd: number | null;
}

export interface RoutabilityResult {
  mainSpendUsd: number;
  routableUsd: number;
  routablePct: number;
  estSavingsUsd: number;
  rows: ReadonlyArray<RoutabilityClassRow>;
  days: number;
  minRun: number;
}

/**
 * Roll spans up into per-class routable rows + one "stays main" rollup, and
 * compute est savings (routable spans repriced one tier down, never negative).
 */
export function aggregateRoutability(
  spans: ReadonlyArray<Span>,
  pricingCatalog: Map<string, ModelPricing>,
  input: RoutabilityInput,
): RoutabilityResult {
  const routableByClass = new Map<WorkClass, { runs: number; turns: number; main: number; repriced: number }>();
  let staysMain = 0, staysTurns = 0, staysRuns = 0;

  for (const s of spans) {
    if (!s.routable) {
      staysMain += s.usage.cost_usd; staysTurns += s.turnCount; staysRuns += 1;
      continue;
    }
    const tierAlias = ROUTABLE_TIER[s.cls]!;
    const targetModel = MODEL_ALIASES[tierAlias] ?? tierAlias;
    const repriced = reprice(s.usage, targetModel, pricingCatalog);
    const acc = routableByClass.get(s.cls) ?? { runs: 0, turns: 0, main: 0, repriced: 0 };
    acc.runs += 1; acc.turns += s.turnCount; acc.main += s.usage.cost_usd;
    acc.repriced += Math.min(repriced, s.usage.cost_usd); // clamp: never "save" by repricing up
    routableByClass.set(s.cls, acc);
  }

  const rows: RoutabilityClassRow[] = [];
  let routableUsd = 0, estSavingsUsd = 0;

  for (const [cls, acc] of routableByClass) {
    const savings = Math.max(0, acc.main - acc.repriced);
    routableUsd += acc.main; estSavingsUsd += savings;
    rows.push({ class: cls, verdict: "routable", runs: acc.runs, turns: acc.turns, mainCostUsd: acc.main, tier: ROUTABLE_TIER[cls] ?? null, repricedUsd: acc.repriced, estSavingsUsd: savings });
  }
  rows.sort((a, b) => (b.estSavingsUsd ?? 0) - (a.estSavingsUsd ?? 0));

  if (staysRuns > 0) {
    rows.push({ class: "stays main", verdict: "stays", runs: staysRuns, turns: staysTurns, mainCostUsd: staysMain, tier: null, repricedUsd: null, estSavingsUsd: null });
  }

  const mainSpendUsd = routableUsd + staysMain;
  return {
    mainSpendUsd, routableUsd,
    routablePct: mainSpendUsd > 0 ? (routableUsd / mainSpendUsd) * 100 : 0,
    estSavingsUsd, rows, days: input.days, minRun: input.minRun,
  };
}

// ---------------------------------------------------------------------------
// DB fetch
// ---------------------------------------------------------------------------

const sinceDays = (d: number): number => Math.max(1, Math.trunc(d));

/**
 * All turns in the window (user + assistant). Ordered by (session, seq) so
 * each session's slice is contiguous and seq-ordered when read sequentially.
 * Uses text_excerpt (~500 chars) rather than full text - adequate for
 * JUDGMENT_GUARD_RE pattern matching which targets first-sentence keywords.
 */
const TURNS_SQL = (days: number) => `
SELECT
    type::string(id) AS turn_id,
    type::string(session) AS session_id,
    seq,
    role,
    intent_kind,
    text_excerpt AS text,
    thinking_tokens
FROM turn
WHERE ts > time::now() - ${sinceDays(days)}d;
`;

/**
 * Tool names per turn in the window. tool_call.turn is option<record<turn>>,
 * so we filter NONE. No index on turn alone; the ts filter limits the scan
 * to the same window as the turn query.
 */
const TOOL_CALLS_SQL = (days: number) => `
SELECT
    type::string(turn) AS turn_id,
    name
FROM tool_call
WHERE ts > time::now() - ${sinceDays(days)}d
  AND turn != NONE;
`;

/**
 * Per-turn token usage. source distinguishes main ('claude-code' etc.) from
 * subagent ('claude-subagent') at the session level - all rows for a subagent
 * session carry source='claude-subagent'. Filtering happens in JS.
 */
const TURN_USAGE_SQL = (days: number) => `
SELECT
    type::string(turn) AS turn_id,
    type::string(session) AS session_id,
    source,
    prompt_tokens,
    completion_tokens,
    cache_read_input_tokens,
    cache_creation_input_tokens,
    estimated_cost_usd
FROM turn_token_usage
WHERE ts > time::now() - ${sinceDays(days)}d;
`;

/** Pricing catalog - same query and field mapping as dispatch-analytics. */
const AGENT_MODELS_SQL = `
SELECT
    name,
    input_per_million_usd,
    output_per_million_usd,
    cache_read_per_million_usd,
    cache_creation_per_million_usd
FROM agent_model;
`;

/**
 * Pull main-agent turns from SurrealDB, group into class-run spans per
 * session, and return a RoutabilityResult. Mirrors fetchCostSplit in
 * cost-analytics.ts: flat queries + JS join/aggregate, no GROUP BY derefs.
 *
 * Session classification: a session is a subagent session if ANY of its
 * turn_token_usage rows have source='claude-subagent'; those sessions are
 * excluded entirely. Sessions with no usage rows (e.g. purely user-turn
 * stubs) are treated as main - they contribute zero cost and don't skew
 * the result.
 */
export const fetchRoutability = Effect.fn("queries.fetchRoutability")(
    function* (input: RoutabilityInput) {
        const db = yield* SurrealClient;

        const [turnRows, toolCallRows, usageRows, agentModelRows] = yield* db.query<[
            Array<Record<string, unknown>>,
            Array<Record<string, unknown>>,
            Array<Record<string, unknown>>,
            Array<Record<string, unknown>>,
        ]>(
            TURNS_SQL(input.days) +
            TOOL_CALLS_SQL(input.days) +
            TURN_USAGE_SQL(input.days) +
            AGENT_MODELS_SQL,
        );

        // ---- tool names: turn_id → string[] --------------------------------
        const toolsByTurn = new Map<string, string[]>();
        for (const row of toolCallRows ?? []) {
            const tid = String(row.turn_id ?? "");
            if (!tid) continue;
            const names = toolsByTurn.get(tid);
            if (names) {
                names.push(String(row.name ?? ""));
            } else {
                toolsByTurn.set(tid, [String(row.name ?? "")]);
            }
        }

        // ---- usage map + subagent session classification ------------------
        interface UsageData {
            readonly prompt_tokens: number;
            readonly completion_tokens: number;
            readonly cache_read_tokens: number;
            readonly cache_create_tokens: number;
            readonly cost_usd: number;
        }
        const usageByTurn = new Map<string, UsageData>();
        const subagentSessionIds = new Set<string>();

        for (const row of usageRows ?? []) {
            const tid = String(row.turn_id ?? "");
            const sid = String(row.session_id ?? "");
            if (!tid) continue;
            if (String(row.source ?? "") === "claude-subagent") {
                subagentSessionIds.add(sid);
            }
            usageByTurn.set(tid, {
                prompt_tokens: Number(row.prompt_tokens ?? 0),
                completion_tokens: Number(row.completion_tokens ?? 0),
                cache_read_tokens: Number(row.cache_read_input_tokens ?? 0),
                cache_create_tokens: Number(row.cache_creation_input_tokens ?? 0),
                cost_usd: Number(row.estimated_cost_usd ?? 0),
            });
        }

        // ---- group turns by session (main only), preserving DB seq order --
        const turnsBySession = new Map<string, TurnFacts[]>();
        for (const row of turnRows ?? []) {
            const turnId = String(row.turn_id ?? "");
            const sessionId = String(row.session_id ?? "");
            if (!turnId || !sessionId) continue;
            if (subagentSessionIds.has(sessionId)) continue;

            const usg = usageByTurn.get(turnId);
            const tf: TurnFacts = {
                seq: Number(row.seq ?? 0),
                role: String(row.role ?? ""),
                toolNames: toolsByTurn.get(turnId) ?? [],
                thinkingTokens: Number(row.thinking_tokens ?? 0),
                intentKind: row.intent_kind == null ? null : String(row.intent_kind),
                text: row.text == null ? null : String(row.text),
                usage: usg ?? null,
            };
            const bucket = turnsBySession.get(sessionId);
            if (bucket) {
                bucket.push(tf);
            } else {
                turnsBySession.set(sessionId, [tf]);
            }
        }

        // ---- pricing catalog: same field mapping as dispatch-analytics ----
        const pricingCatalog = new Map<string, ModelPricing>();
        for (const am of agentModelRows ?? []) {
            if (am.name == null) continue;
            pricingCatalog.set(String(am.name), {
                provider: "anthropic",
                inputPerMillionUsd: am.input_per_million_usd == null ? null : Number(am.input_per_million_usd),
                outputPerMillionUsd: am.output_per_million_usd == null ? null : Number(am.output_per_million_usd),
                cacheReadPerMillionUsd: am.cache_read_per_million_usd == null ? null : Number(am.cache_read_per_million_usd),
                cacheCreationPerMillionUsd: am.cache_creation_per_million_usd == null ? null : Number(am.cache_creation_per_million_usd),
                fastMultiplier: 1,
                pricingSource: "agent_model",
            });
        }

        // ---- build spans per session, concat, aggregate ------------------
        const allSpans: Span[] = [];
        for (const turns of turnsBySession.values()) {
            // DB orders by (session, seq); sort defensively in case of ties.
            turns.sort((a, b) => a.seq - b.seq);
            for (const s of buildSpans(turns, input.minRun)) {
                allSpans.push(s);
            }
        }

        return aggregateRoutability(allSpans, pricingCatalog, input);
    },
);
