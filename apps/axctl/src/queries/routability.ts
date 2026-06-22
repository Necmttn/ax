/**
 * Main-thread routability lens - classify main-agent class-runs by whether they
 * could have been a cheaper subagent dispatch, and reprice routable spans.
 * Deterministic: tool composition. No LLM.
 *
 * Cross-provider: Claude (`source='claude'`) and Codex (`source='codex'`) main
 * turns are classified and repriced SEPARATELY - each drops to a same-vendor
 * cheaper tier (Claude -> haiku/sonnet, Codex -> gpt-5-nano/gpt-5-mini). Codex
 * tools (exec_command / apply_patch / write_stdin) don't map 1:1 to Claude's
 * Read/Edit/Write, so `codexToolClass` disambiguates exec_command via
 * `command_norm` (read-like rg/cat/git diff vs write/build sed/git add/bun test).
 *
 * Spec: docs/superpowers/specs/2026-06-15-cost-routability-lens-design.md
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { JUDGMENT_GUARD_RE } from "./routing-tune.ts";
import { MODEL_ALIASES, reprice } from "./reprice.ts";
import type { RepriceUsage, ModelPricing } from "./reprice.ts";
import { builtInPricingCatalog, inferModelProvider } from "../ingest/model-pricing.ts";

export type WorkClass =
    | "gather"
    | "niche-research"
    | "mechanical-impl"
    | "synthesis"
    | "design-decision"
    | "interactive";

/** Harnesses whose per-turn cost is admitted into the routability denominator. */
export type RoutabilityProvider = "claude" | "codex";

/**
 * Routable classes and the abstract drop tier. `cheap` = cheapest tier, `mid` =
 * one tier down from frontier. Non-routable classes are absent. Provider-neutral
 * - the concrete model per tier is resolved by PROVIDER_TIER_TARGETS.
 */
export const ROUTABLE_CLASS_TIER: Partial<Record<WorkClass, "cheap" | "mid">> = {
    gather: "cheap",
    "niche-research": "mid",
    "mechanical-impl": "mid",
};

interface TierTarget {
    /** Short label shown in the `tier` column. */
    readonly label: string;
    /** Concrete model id passed to `reprice`. */
    readonly model: string;
}

/**
 * Per-provider concrete drop targets. Repricing gpt-5.5 -> claude-haiku is
 * cross-vendor nonsense, so each provider drops to a SAME-vendor cheaper tier.
 * Codex: gather -> gpt-5-nano (cheapest), mid -> gpt-5-mini. Both gpt-5-mini and
 * gpt-5-nano are priced in BUILTIN_MODEL_PRICING_CATALOG (model-pricing.ts).
 */
export const PROVIDER_TIER_TARGETS: Record<RoutabilityProvider, Record<"cheap" | "mid", TierTarget>> = {
    claude: {
        cheap: { label: "haiku", model: MODEL_ALIASES.haiku },
        mid: { label: "sonnet", model: MODEL_ALIASES.sonnet },
    },
    codex: {
        cheap: { label: "gpt-5-nano", model: "gpt-5-nano" },
        mid: { label: "gpt-5-mini", model: "gpt-5-mini" },
    },
};

export interface ToolCallFact {
    readonly name: string;
    /** `tool_call.command_norm` (normalized head command) - disambiguates Codex exec_command. */
    readonly commandNorm: string | null;
}

export interface TurnFacts {
    seq: number;
    role: string;
    toolNames: ReadonlyArray<string>;
    /**
     * Richer tool list carrying `command_norm`. When present it is used for
     * classification (Codex needs it); when absent, `toolNames` is used (Claude
     * tool names self-classify, no command_norm needed).
     */
    toolCalls?: ReadonlyArray<ToolCallFact>;
    thinkingTokens: number;
    intentKind: string | null;
    text: string | null;
    usage: RepriceUsage | null;
}

type ToolKind = "read" | "edit" | "research";

const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS"]);
const RESEARCH_TOOLS = new Set(["WebFetch", "WebSearch"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "Bash"]);
const INTERACTIVE_INTENTS = new Set(["correction", "preference", "wrapper_instruction"]);

/**
 * Read-like Codex exec_command norms (inspect, don't mutate). Mirror Claude's
 * READ_TOOLS -> gather. `git <subcommand>` norms keep the subcommand, so the
 * read/write split is on the full norm.
 */
const CODEX_READ_NORMS = new Set([
    "rg", "grep", "cat", "nl", "head", "tail", "ls", "find", "fd", "tree", "bat",
    "eza", "pwd", "wc", "jq", "which", "stat", "file", "du", "df", "lsof", "ps",
    "env", "echo", "diff",
    "git status", "git diff", "git show", "git log", "git branch",
    "git rev-parse", "git stash list", "git remote", "git blame",
]);

/**
 * Write- or build-like Codex exec_command norms (mutate the tree or run a
 * build/test). Mirror Claude's EDIT_TOOLS (which includes Bash) -> mechanical-impl.
 * Ambiguous norms (e.g. bare `sed`, which is read with `-n` and write with `-i`)
 * are deliberately ABSENT, so they fall to `null` (conservative: never routable).
 */
const CODEX_WRITE_NORMS = new Set([
    "git add", "git commit", "git push", "git checkout", "git restore",
    "git reset", "git rm", "git mv", "git apply", "git merge", "git rebase",
    "git cherry-pick", "git stash", "git worktree", "git branch -d",
    "rm", "mkdir", "mv", "cp", "touch", "chmod", "chown", "ln", "tee", "patch",
    "printf",
    "bun", "bunx", "bun x", "bun run", "bun test", "bun typecheck", "bun build",
    "bun classifiers", "node", "python3", "python", "npm", "pnpm", "yarn",
    "make", "cargo", "go", "tsc", "deno", "ruff", "pytest", "perl",
]);

/**
 * Map a Codex tool (name + command_norm) to a Claude-equivalent tool kind, or
 * null when it can't be confidently classed. exec_command is overloaded
 * (read-like AND write-like), disambiguated by command_norm; ambiguous norms
 * return null so the turn stays conservative (never counted routable).
 */
export function codexToolClass(name: string, commandNorm: string | null): ToolKind | null {
    switch (name) {
        case "apply_patch":
        case "write_stdin":
        case "send_input":
            return "edit";
        case "view_image":
        case "read":
            return "read";
        case "exec_command":
        case "bash": {
            const n = (commandNorm ?? "").toLowerCase().trim();
            if (!n) return null;
            if (CODEX_READ_NORMS.has(n)) return "read";
            if (CODEX_WRITE_NORMS.has(n)) return "edit";
            return null;
        }
        default:
            return null;
    }
}

/** Unified tool->kind: Claude native sets first, then Codex disambiguation. */
function toolKind(name: string, commandNorm: string | null): ToolKind | null {
    if (READ_TOOLS.has(name)) return "read";
    if (RESEARCH_TOOLS.has(name)) return "research";
    if (EDIT_TOOLS.has(name)) return "edit";
    return codexToolClass(name, commandNorm);
}

/**
 * Assign one work-class to a main-agent turn. Judgment-first precedence so
 * review/design/interactive can never be classed routable. `adjacentToUser`
 * is computed by buildSpans (turn neighbours a user turn).
 *
 * Turn-level tool composition only - the `thinking_tokens` signal was dropped
 * after calibration showed it is 0 on 96.6% of main assistant turns (mixed
 * turns report 0 = lower bound; transcripts strip thinking text), so no
 * threshold separated design work from routine edits. Judgment is now caught
 * solely via JUDGMENT_GUARD_RE on the turn text plus the interactive guards.
 */
export function classifyTurn(t: TurnFacts, adjacentToUser: boolean): WorkClass {
    if (adjacentToUser) return "interactive";
    if (t.intentKind && INTERACTIVE_INTENTS.has(t.intentKind)) return "interactive";

    const calls: ReadonlyArray<ToolCallFact> =
        t.toolCalls ?? t.toolNames.map((name) => ({ name, commandNorm: null }));

    let editCount = 0, readCount = 0, researchCount = 0;
    for (const c of calls) {
        const kind = toolKind(c.name, c.commandNorm);
        if (kind === "edit") editCount++;
        else if (kind === "read") readCount++;
        else if (kind === "research") researchCount++;
    }

    if (t.text && JUDGMENT_GUARD_RE.test(t.text)) return "design-decision";

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
 * How a turn's role participates in span-building:
 * - `work`     : a classifiable unit (carries tools/text + its own cost)
 * - `boundary` : a judgment boundary (user turn) - splits runs, forces the next
 *                work turn to `interactive`
 * - `carry`    : a tool OUTPUT event with no tool name of its own - its cost is
 *                attributed to the open span (the action that produced it)
 * - `skip`     : noise (system/developer/attachment/...) - ignored, no flush
 */
export type RoleKind = "work" | "boundary" | "carry" | "skip";

/**
 * Claude: one assistant turn carries tools + cost together, so it's the work
 * unit; tool results are not separately-costed turns (they never reach here).
 */
export const claudeRoleKind = (role: string): RoleKind =>
  role === "assistant" ? "work" : role === "user" ? "boundary" : "skip";

/**
 * Codex turns are PER-EVENT, so one logical action spans several rows and its
 * cost is fragmented: the tool invocation (`tool_call`), its output
 * (`function_call_output` / `custom_tool_call_output` - the majority of Codex
 * spend), surrounding `reasoning`, and `assistant` text. Tool-output events have
 * no tool name, so their cost is CARRIED onto the action that produced it.
 */
const CODEX_WORK_ROLES = new Set([
  "tool_call", "assistant", "reasoning", "web_search_call",
  "custom_tool_call", "tool_search_call", "image_generation_call",
]);
const CODEX_CARRY_ROLES = new Set([
  "function_call_output", "custom_tool_call_output", "tool_result", "tool_search_output",
]);
export const codexRoleKind = (role: string): RoleKind =>
  role === "user" ? "boundary"
    : CODEX_WORK_ROLES.has(role) ? "work"
    : CODEX_CARRY_ROLES.has(role) ? "carry"
    : "skip";

export const PROVIDER_ROLE_KIND: Record<RoutabilityProvider, (role: string) => RoleKind> = {
  claude: claudeRoleKind,
  codex: codexRoleKind,
};

/**
 * Group ONE session's main-agent turns (seq order) into class-run spans.
 * Splits at every boundary (user) turn; within a segment, groups consecutive
 * same-class work turns. The first work turn after a boundary is forced to
 * `interactive`. `carry` turns fold their cost into the open span (Codex tool
 * outputs). A span is routable iff its class is routable AND run length >= minRun.
 *
 * `roleKind` defaults to Claude semantics (assistant=work, user=boundary, else
 * skip) - pass `codexRoleKind` for Codex's per-event turns.
 */
export function buildSpans(
  turns: ReadonlyArray<TurnFacts>,
  minRun: number,
  roleKind: (role: string) => RoleKind = claudeRoleKind,
): Span[] {
  const spans: Span[] = [];
  let cur: { cls: WorkClass; turnCount: number; usage: RepriceUsage } | null = null;
  let adjacentToBoundary = false; // next work turn neighbours a user turn
  // Judgment carry: Claude splits one assistant message into separate turn rows
  // - a prose turn (text) then its tool-use turns (empty text). classifyTurn
  // reads only ONE turn's text, so edit turns riding behind judgment reasoning
  // misclassify as mechanical-impl. A prose turn carrying JUDGMENT_GUARD_RE text
  // sets this sticky flag; the following tool-only turns of the same message
  // inherit it and are held off the routable path. A new prose turn (next
  // message) re-evaluates it; a user boundary clears it. Conservative: it only
  // demotes (never promotes), so the routability estimate can only tighten.
  let judgmentSticky = false;

  const flush = () => {
    if (!cur) return;
    const tier = ROUTABLE_CLASS_TIER[cur.cls];
    spans.push({ cls: cur.cls, turnCount: cur.turnCount, usage: cur.usage, routable: tier !== undefined && cur.turnCount >= minRun });
    cur = null;
  };

  for (const t of turns) {
    const kind = roleKind(t.role);
    if (kind === "skip") continue;
    if (kind === "boundary") { flush(); adjacentToBoundary = true; judgmentSticky = false; continue; }
    if (kind === "carry") {
      // Tool-output cost belongs to the action that produced it (open span).
      if (cur) cur.usage = addUsage(cur.usage, t.usage);
      else cur = { cls: "interactive", turnCount: 1, usage: addUsage(ZERO_USAGE(), t.usage) };
      continue;
    }
    // work
    // A turn carrying its own text starts a new assistant message - re-evaluate
    // the judgment carry from that text. Tool-only turns (empty text) keep the
    // value set by the prose turn that opened their message.
    const turnText = t.text?.trim() ?? "";
    if (turnText.length > 0) judgmentSticky = JUDGMENT_GUARD_RE.test(turnText);
    let cls = classifyTurn(t, adjacentToBoundary);
    adjacentToBoundary = false;
    // Hold judgment-adjacent edits off the routable path: fold them into the
    // design-decision (non-routable) class so they group with the reasoning
    // that drove them.
    if (judgmentSticky && ROUTABLE_CLASS_TIER[cls] !== undefined) cls = "design-decision";
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
  /** "claude"/"codex" for a per-provider result, "all" for the combined top-level. */
  provider: RoutabilityProvider | "all";
  mainSpendUsd: number;
  routableUsd: number;
  routablePct: number;
  estSavingsUsd: number;
  rows: ReadonlyArray<RoutabilityClassRow>;
  days: number;
  minRun: number;
  /** Per-provider breakdown (populated only on the combined top-level result). */
  providers: ReadonlyArray<RoutabilityResult>;
}

/**
 * Roll one provider's spans up into per-class routable rows + one "stays main"
 * rollup, and compute est savings (routable spans repriced one tier down within
 * the SAME vendor, never negative). `provider` selects the drop-tier targets.
 */
export function aggregateRoutability(
  spans: ReadonlyArray<Span>,
  pricingCatalog: Map<string, ModelPricing>,
  input: RoutabilityInput,
  provider: RoutabilityProvider = "claude",
): RoutabilityResult {
  const targets = PROVIDER_TIER_TARGETS[provider];
  const routableByClass = new Map<WorkClass, { runs: number; turns: number; main: number; repriced: number; tier: string }>();
  let staysMain = 0, staysTurns = 0, staysRuns = 0;

  for (const s of spans) {
    const tierKey = ROUTABLE_CLASS_TIER[s.cls];
    if (!s.routable || tierKey === undefined) {
      staysMain += s.usage.cost_usd; staysTurns += s.turnCount; staysRuns += 1;
      continue;
    }
    const target = targets[tierKey];
    const repriced = reprice(s.usage, target.model, pricingCatalog);
    const acc = routableByClass.get(s.cls) ?? { runs: 0, turns: 0, main: 0, repriced: 0, tier: target.label };
    acc.runs += 1; acc.turns += s.turnCount; acc.main += s.usage.cost_usd;
    acc.repriced += Math.min(repriced, s.usage.cost_usd); // clamp: never "save" by repricing up
    routableByClass.set(s.cls, acc);
  }

  const rows: RoutabilityClassRow[] = [];
  let routableUsd = 0, estSavingsUsd = 0;

  for (const [cls, acc] of routableByClass) {
    const savings = Math.max(0, acc.main - acc.repriced);
    routableUsd += acc.main; estSavingsUsd += savings;
    rows.push({ class: cls, verdict: "routable", runs: acc.runs, turns: acc.turns, mainCostUsd: acc.main, tier: acc.tier, repricedUsd: acc.repriced, estSavingsUsd: savings });
  }
  rows.sort((a, b) => (b.estSavingsUsd ?? 0) - (a.estSavingsUsd ?? 0));

  if (staysRuns > 0) {
    rows.push({ class: "stays main", verdict: "stays", runs: staysRuns, turns: staysTurns, mainCostUsd: staysMain, tier: null, repricedUsd: null, estSavingsUsd: null });
  }

  const mainSpendUsd = routableUsd + staysMain;
  return {
    provider, mainSpendUsd, routableUsd,
    routablePct: mainSpendUsd > 0 ? (routableUsd / mainSpendUsd) * 100 : 0,
    estSavingsUsd, rows, days: input.days, minRun: input.minRun, providers: [],
  };
}

/** Fold per-provider results into the combined top-level result. */
export function combineRoutability(
  results: ReadonlyArray<RoutabilityResult>,
  input: RoutabilityInput,
): RoutabilityResult {
  const mainSpendUsd = results.reduce((a, r) => a + r.mainSpendUsd, 0);
  const routableUsd = results.reduce((a, r) => a + r.routableUsd, 0);
  const estSavingsUsd = results.reduce((a, r) => a + r.estSavingsUsd, 0);
  return {
    provider: "all",
    mainSpendUsd,
    routableUsd,
    routablePct: mainSpendUsd > 0 ? (routableUsd / mainSpendUsd) * 100 : 0,
    estSavingsUsd,
    rows: results.flatMap((r) => r.rows),
    days: input.days,
    minRun: input.minRun,
    providers: results,
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
    text_excerpt AS text
FROM turn
WHERE ts > time::now() - ${sinceDays(days)}d;
`;

/**
 * Tool names + command_norm per turn in the window. tool_call.turn is
 * option<record<turn>>, so we filter NONE. command_norm (normalized head
 * command) disambiguates Codex's overloaded exec_command; it is NONE for
 * non-exec tools, mapped to null on the JS side. No index on turn alone; the
 * ts filter limits the scan to the same window as the turn query.
 */
const TOOL_CALLS_SQL = (days: number) => `
SELECT
    type::string(turn) AS turn_id,
    name,
    command_norm
FROM tool_call
WHERE ts > time::now() - ${sinceDays(days)}d
  AND turn != NONE;
`;

/**
 * Per-turn token usage for MAIN-agent turns, Claude AND Codex. Positive
 * allowlist (source IN ['claude','codex']) rather than a denylist:
 * claude-subagent is a distinct source value (excluded), and the other
 * providers (opencode/cursor/pi) are not yet classified, so admitting them
 * would pollute the denominator. Each admitted turn's `source` tags its
 * provider, classified and repriced separately (Claude -> haiku/sonnet, Codex
 * -> gpt-5-nano/gpt-5-mini). All Codex turn_token_usage rows are main-agent
 * (Codex has no subagent cost split), so no subagent carve-out is needed.
 */
const TURN_USAGE_SQL = (days: number) => `
SELECT
    type::string(turn) AS turn_id,
    source,
    prompt_tokens,
    completion_tokens,
    cache_read_input_tokens,
    cache_creation_input_tokens,
    estimated_cost_usd
FROM turn_token_usage
WHERE ts > time::now() - ${sinceDays(days)}d
  AND source IN ['claude', 'codex'];
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

/** Map a turn_token_usage.source value to a routability provider. */
function providerOfSource(source: string): RoutabilityProvider | null {
    if (source === "claude") return "claude";
    if (source === "codex") return "codex";
    return null;
}

/**
 * Pull main-agent turns (Claude + Codex) from SurrealDB, group into class-run
 * spans per (provider, session), classify + reprice each provider separately,
 * and return a combined RoutabilityResult with a per-provider breakdown.
 * Mirrors fetchCostSplit in cost-analytics.ts: flat queries + JS join/aggregate,
 * no GROUP BY derefs.
 *
 * Main-agent scoping: TURN_USAGE_SQL allowlists source IN ['claude','codex'].
 * claude-subagent and the unclassified providers (opencode/cursor/pi) carry
 * distinct source values and are excluded - their turns may still appear in the
 * grouping but contribute $0, so they never enter the routable totals. Each
 * session is single-harness, so its provider is taken from its costed turns.
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

        // ---- tool calls: turn_id → ToolCallFact[] (carries command_norm) ---
        const toolsByTurn = new Map<string, ToolCallFact[]>();
        for (const row of toolCallRows ?? []) {
            const tid = String(row.turn_id ?? "");
            if (!tid) continue;
            const fact: ToolCallFact = {
                name: String(row.name ?? ""),
                commandNorm: row.command_norm == null ? null : String(row.command_norm),
            };
            const facts = toolsByTurn.get(tid);
            if (facts) facts.push(fact);
            else toolsByTurn.set(tid, [fact]);
        }

        // ---- usage map (Claude + Codex main turns; allowlisted in SQL) -----
        interface UsageData {
            readonly usage: RepriceUsage;
            readonly provider: RoutabilityProvider;
        }
        const usageByTurn = new Map<string, UsageData>();

        for (const row of usageRows ?? []) {
            const tid = String(row.turn_id ?? "");
            if (!tid) continue;
            const provider = providerOfSource(String(row.source ?? ""));
            if (!provider) continue;
            usageByTurn.set(tid, {
                provider,
                usage: {
                    prompt_tokens: Number(row.prompt_tokens ?? 0),
                    completion_tokens: Number(row.completion_tokens ?? 0),
                    cache_read_tokens: Number(row.cache_read_input_tokens ?? 0),
                    cache_create_tokens: Number(row.cache_creation_input_tokens ?? 0),
                    cost_usd: Number(row.estimated_cost_usd ?? 0),
                },
            });
        }

        // ---- session → provider (a session is single-harness) -------------
        // Determined from costed turns; user/cost-less turns inherit it so
        // buildSpans keeps the right user-turn boundaries per provider.
        const sessionProvider = new Map<string, RoutabilityProvider>();
        for (const row of turnRows ?? []) {
            const turnId = String(row.turn_id ?? "");
            const sessionId = String(row.session_id ?? "");
            if (!turnId || !sessionId || sessionProvider.has(sessionId)) continue;
            const usg = usageByTurn.get(turnId);
            if (usg) sessionProvider.set(sessionId, usg.provider);
        }

        // ---- group turns by (provider, session), preserving DB seq order --
        // Boundary (user) turns split runs; work turns are classified; carry
        // turns (Codex tool outputs) fold their cost into the open span. Keep:
        // boundaries, any costed turn, and Codex work turns even when $0 (so a
        // tool_call's later output carries onto the right class). Skip-role and
        // cost-less Claude turns are dropped (they'd just inflate counts).
        const turnsByProviderSession = new Map<RoutabilityProvider, Map<string, TurnFacts[]>>();
        for (const row of turnRows ?? []) {
            const turnId = String(row.turn_id ?? "");
            const sessionId = String(row.session_id ?? "");
            if (!turnId || !sessionId) continue;

            const provider = sessionProvider.get(sessionId);
            if (!provider) continue; // session with no admitted (claude/codex) cost

            const role = String(row.role ?? "");
            const kind = PROVIDER_ROLE_KIND[provider](role);
            if (kind === "skip") continue;
            const usg = usageByTurn.get(turnId);
            const keep = kind === "boundary" || usg !== undefined || (provider === "codex" && kind === "work");
            if (!keep) continue;

            const tf: TurnFacts = {
                seq: Number(row.seq ?? 0),
                role,
                toolNames: (toolsByTurn.get(turnId) ?? []).map((c) => c.name),
                toolCalls: toolsByTurn.get(turnId) ?? [],
                // thinking signal dropped (dead: 0 on ~97% of turns); field kept
                // for test fixtures / future reasoning signal.
                thinkingTokens: 0,
                intentKind: row.intent_kind == null ? null : String(row.intent_kind),
                text: row.text == null ? null : String(row.text),
                usage: usg?.usage ?? null,
            };
            let bySession = turnsByProviderSession.get(provider);
            if (!bySession) {
                bySession = new Map();
                turnsByProviderSession.set(provider, bySession);
            }
            const bucket = bySession.get(sessionId);
            if (bucket) bucket.push(tf);
            else bySession.set(sessionId, [tf]);
        }

        // ---- pricing catalog: builtin (openai + anthropic) then DB override.
        // Codex reprices to gpt-5-mini/gpt-5-nano, which only the builtin
        // catalog prices, so the builtin MUST be the base; agent_model rows
        // (fresh anthropic rates) layer on top.
        const pricingCatalog = builtInPricingCatalog();
        for (const am of agentModelRows ?? []) {
            if (am.name == null) continue;
            const name = String(am.name);
            pricingCatalog.set(name, {
                provider: inferModelProvider(name),
                inputPerMillionUsd: am.input_per_million_usd == null ? null : Number(am.input_per_million_usd),
                outputPerMillionUsd: am.output_per_million_usd == null ? null : Number(am.output_per_million_usd),
                cacheReadPerMillionUsd: am.cache_read_per_million_usd == null ? null : Number(am.cache_read_per_million_usd),
                cacheCreationPerMillionUsd: am.cache_creation_per_million_usd == null ? null : Number(am.cache_creation_per_million_usd),
                fastMultiplier: 1,
                pricingSource: "agent_model",
            });
        }

        // ---- per provider: build spans, aggregate -------------------------
        const providerResults: RoutabilityResult[] = [];
        for (const provider of ["claude", "codex"] as const) {
            const bySession = turnsByProviderSession.get(provider);
            if (!bySession) continue;
            const roleKind = PROVIDER_ROLE_KIND[provider];
            const spans: Span[] = [];
            for (const turns of bySession.values()) {
                turns.sort((a, b) => a.seq - b.seq); // DB orders by (session, seq); defensive
                for (const s of buildSpans(turns, input.minRun, roleKind)) spans.push(s);
            }
            const res = aggregateRoutability(spans, pricingCatalog, input, provider);
            if (res.mainSpendUsd > 0 || res.rows.length > 0) providerResults.push(res);
        }

        return combineRoutability(providerResults, input);
    },
);
