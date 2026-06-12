/**
 * `ax dispatches` queries: subagent dispatch analytics.
 *
 * Three flat queries, joined in JS by record-id string (hang-avoidance: NO
 * record derefs inside aggregates, NO graph traversal in SELECT projections
 * over large tables):
 *   (1) SELECT from spawned with ts, agent_type, description, tool_use_id,
 *       and stringified in/out IDs.
 *   (2) session_token_usage rows for claude-subagent sessions (child cost).
 *   (3) Agent tool_call rows in window: session, call_id, input_json.
 *   (4) Parent session models: SELECT id, model FROM session (non-subagent).
 *
 * Routing classes mirror packages/hooks-sdk/src/hooks/route-dispatch.ts
 * (feat/route-dispatch-hook branch). NOT imported from there - duplicated with
 * a comment. A compile-routing step will unify later.
 */
import { Effect, FileSystem, Path } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { estimateCost, type ModelPricing } from "../ingest/model-pricing.ts";
import {
    defaultRoutingTablePath,
    loadStoredRoutingTable,
    mergeRoutingTables,
    saveStoredRoutingTable,
} from "./routing-table-io.ts";

// ---------------------------------------------------------------------------
// Routing classes
// (mirrors packages/hooks-sdk/src/hooks/route-dispatch.ts DEFAULT_TABLE)
// ---------------------------------------------------------------------------

export interface RoutingClass {
    readonly id: string;
    readonly pattern: string;
    readonly flags: string;
    readonly suggest: string; // "sonnet" | "haiku"
    readonly reason: string;
}

export interface RoutingTable {
    readonly version: 1;
    readonly classes: ReadonlyArray<RoutingClass>;
    readonly agentTypes: Readonly<Record<string, string>>;
}

/**
 * ROUTING_CLASSES - exported typed constant.
 * Mirrors route-dispatch.ts DEFAULT_TABLE. Do NOT import from there;
 * a compile-routing step will unify them later.
 */
export const ROUTING_CLASSES: RoutingTable = {
    version: 1,
    classes: [
        // Quality reviews and PR reviews deliberately have NO class: the main
        // model is the Q&A reviewer in this workflow, so only the mechanical
        // spec-compliance pass routes down.
        {
            id: "spec-review",
            pattern: "^spec review",
            flags: "i",
            suggest: "sonnet",
            reason: "spec-compliance checklist review",
        },
        {
            id: "search-locate",
            pattern: "^(pattern-find|locate|find|map|sweep|grep)",
            flags: "i",
            suggest: "haiku",
            reason: "code search/sweep",
        },
        {
            id: "research",
            pattern: "^(research|investigate docs|study)",
            flags: "i",
            suggest: "sonnet",
            reason: "web/docs research",
        },
        {
            id: "well-specified-impl",
            pattern: "^implement ",
            flags: "i",
            suggest: "sonnet",
            reason: "spec'd implementation",
        },
        {
            id: "bulk-mechanical",
            pattern: "^(write announcements|regenerate|standardize|merge main)",
            flags: "i",
            suggest: "sonnet",
            reason: "bulk mechanical work",
        },
        // Mined by /routing-tune 2026-06-12 (adversarially backtested over 90d;
        // brief: .ax/tasks/routing-tune-undated.md). The colon in task-N-impl
        // is load-bearing: "Task 4 spec compliance review" (no colon) must NOT
        // match - reviews stay on the main model.
        {
            id: "task-N-impl",
            pattern: "^Task \\d+:",
            flags: "i",
            suggest: "sonnet",
            reason: "numbered plan-task implementation",
        },
        {
            id: "bug-fix",
            pattern: "^Fix\\s",
            flags: "i",
            suggest: "sonnet",
            reason: "bounded bug-fix remediation",
        },
        {
            id: "feature-add",
            pattern: "^Add\\s",
            flags: "i",
            suggest: "sonnet",
            reason: "additive feature with a clear target",
        },
    ],
    agentTypes: {
        Explore: "haiku",
        "codebase-locator": "haiku",
        "codebase-pattern-finder": "haiku",
        "codebase-analyzer": "sonnet",
    },
};

// Model name resolution for repricing suggestions
const MODEL_ALIASES: Record<string, string> = {
    sonnet: "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5-20251001",
};

// Expensive model tiers (candidate filter)
export const EXPENSIVE_TIER_RE = /fable|opus/i;

// ---------------------------------------------------------------------------
// Routing match
// ---------------------------------------------------------------------------

export interface RoutingMatch {
    readonly classId: string;
    readonly suggest: string;
    readonly reason: string;
    readonly source: "agentType" | "description";
}

export const matchRoutingWith = (
    table: RoutingTable,
    description: string | null,
    agentType: string | null,
): RoutingMatch | null => {
    // Agent-type rules win first (more specific)
    if (agentType) {
        const suggest = table.agentTypes[agentType];
        if (suggest) {
            return {
                classId: `agent-type:${agentType}`,
                suggest,
                reason: `agent type ${agentType}`,
                source: "agentType",
            };
        }
    }
    if (description) {
        for (const cls of table.classes) {
            try {
                const re = new RegExp(cls.pattern, cls.flags);
                if (re.test(description)) {
                    return {
                        classId: cls.id,
                        suggest: cls.suggest,
                        reason: cls.reason,
                        source: "description",
                    };
                }
            } catch {
                continue;
            }
        }
    }
    return null;
};

export const matchRouting = (
    description: string | null,
    agentType: string | null,
): RoutingMatch | null => matchRoutingWith(ROUTING_CLASSES, description, agentType);

// ---------------------------------------------------------------------------
// Raw DB row interfaces (query results before joining)
// ---------------------------------------------------------------------------

interface SpawnedRow {
    parent_id: string;
    child_id: string;
    ts: string;
    agent_type: string | null;
    description: string | null;
    tool_use_id: string | null;
}

interface UsageRow {
    session_id: string;
    model: string | null;
    prompt_tokens: number;
    completion_tokens: number;
    cache_read_tokens: number;
    cache_create_tokens: number;
    cost_usd: number;
}

interface ToolCallRow {
    session_id: string;
    call_id: string;
    input_json: string | null;
}

interface ParentSessionRow {
    session_id: string;
    model: string | null;
}

interface AgentModelRow {
    name: string;
    input_per_million_usd: number | null;
    output_per_million_usd: number | null;
    cache_read_per_million_usd: number | null;
    cache_creation_per_million_usd: number | null;
}

// ---------------------------------------------------------------------------
// Dispatch row (post-join)
// ---------------------------------------------------------------------------

/** One model's share of a child session, from per-turn usage rows. */
export interface DispatchLeg {
    readonly model: string;
    readonly cost_usd: number;
    readonly turns: number;
}

export interface DispatchRow {
    readonly ts: string;
    readonly parent_id: string;
    readonly child_id: string;
    readonly agent_type: string | null;
    readonly description: string | null;
    /** "inherit" when no explicit model in Agent tool input */
    readonly dispatch_model: string;
    /** Model the child actually ran on (from usage or session.model) */
    readonly child_model: string | null;
    readonly child_cost_usd: number;
    /** Per-model legs of the child session (turn_token_usage granularity). */
    readonly child_legs: ReadonlyArray<DispatchLeg>;
    /** True when an explicitly routed dispatch ran legs on a different model
     *  (Claude Code drops the model override on SendMessage/compact
     *  continuations - the continued legs inherit the parent model). */
    readonly model_dropped: boolean;
    /** Cost of the legs that ran on a model other than the requested one. */
    readonly dropped_cost_usd: number;
    /** Prompt tokens (for repricing) */
    readonly prompt_tokens: number;
    /** Completion tokens (for repricing) */
    readonly completion_tokens: number;
    /** Cache read tokens (for repricing) */
    readonly cache_read_tokens: number;
    /** Cache creation tokens (for repricing) */
    readonly cache_create_tokens: number;
}

export interface DispatchesResult {
    readonly rows: ReadonlyArray<DispatchRow>;
    readonly total_dispatches: number;
    readonly inherit_pct: number;
    readonly total_child_cost_usd: number;
    /** Routed (non-inherit) dispatches whose child ran off-model legs. */
    readonly dropped_count: number;
    /** Total cost of off-model legs across dropped dispatches. */
    readonly dropped_cost_usd: number;
}

// ---------------------------------------------------------------------------
// Candidate row (candidates subcommand)
// ---------------------------------------------------------------------------

export interface CandidateRow extends DispatchRow {
    readonly routing_match: RoutingMatch;
    readonly suggested_model: string; // resolved full model name
    readonly est_savings_usd: number; // child_cost - repriced cost
}

export interface CandidatesResult {
    readonly candidates: ReadonlyArray<CandidateRow>;
    readonly total_est_savings_usd: number;
    readonly top_classes: ReadonlyArray<{ classId: string; savings_usd: number }>;
}

// ---------------------------------------------------------------------------
// SQL queries (flat, no derefs in aggregates)
// ---------------------------------------------------------------------------

const SPAWNED_SQL = (sinceDays: number) => `
SELECT
    type::string(in)  AS parent_id,
    type::string(out) AS child_id,
    type::string(ts)  AS ts,
    agent_type,
    description,
    tool_use_id
FROM spawned
WHERE ts > time::now() - ${Math.max(1, Math.trunc(sinceDays))}d
  AND agent_type != NONE;
`;

const USAGE_SQL = (sinceDays: number) => `
SELECT
    type::string(session) AS session_id,
    model,
    prompt_tokens,
    completion_tokens,
    cache_read_input_tokens  AS cache_read_tokens,
    cache_creation_input_tokens AS cache_create_tokens,
    estimated_cost_usd AS cost_usd
FROM session_token_usage
WHERE ts > time::now() - ${Math.max(1, Math.trunc(sinceDays))}d
  AND source = 'claude-subagent';
`;

const TOOL_CALLS_SQL = (sinceDays: number) => `
SELECT
    type::string(session) AS session_id,
    call_id,
    input_json
FROM tool_call
WHERE ts > time::now() - ${Math.max(1, Math.trunc(sinceDays))}d
  AND name = 'Agent';
`;

const PARENT_SESSIONS_SQL = (sinceDays: number) => `
SELECT
    type::string(id) AS session_id,
    model
FROM session
WHERE source != 'claude-subagent'
  AND started_at > time::now() - ${Math.max(1, Math.trunc(sinceDays))}d;
`;

/**
 * Per-model legs of each subagent session. Grouped aggregate stays deref-free
 * (raw fields only); the outer select stringifies the grouped record id, the
 * inner/outer shape mirrors graph-explorer's FILE_ATTENTION_SQL.
 */
const CHILD_LEGS_SQL = (sinceDays: number) => `
SELECT type::string(session) AS session_id, model, cost_usd, turns FROM (
    SELECT
        session,
        model,
        math::sum(estimated_cost_usd ?? 0) AS cost_usd,
        count() AS turns
    FROM turn_token_usage
    WHERE ts > time::now() - ${Math.max(1, Math.trunc(sinceDays))}d
      AND source = 'claude-subagent'
      AND model != NONE
    GROUP BY session, model
);
`;

const AGENT_MODELS_SQL = `
SELECT
    name,
    input_per_million_usd,
    output_per_million_usd,
    cache_read_per_million_usd,
    cache_creation_per_million_usd
FROM agent_model;
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cleanSessionId = (id: string): string =>
    id.replace(/^session:/, "").replace(/^`(.*)`$/, "$1");

// ---------------------------------------------------------------------------
// Model-drop detection (continuation legs on a non-requested model)
// ---------------------------------------------------------------------------

/**
 * Does a child leg's model satisfy the dispatch-time request? Aliases match
 * by family ("sonnet" matches claude-sonnet-4-6); full names match exactly
 * (a leg on any other model counts as a drop).
 */
export const legMatchesDispatchModel = (
    legModel: string,
    dispatchModel: string,
): boolean => {
    const lm = legModel.toLowerCase();
    const dm = dispatchModel.toLowerCase();
    return lm === dm || lm.includes(dm);
};

export interface ModelDrop {
    readonly dropped: boolean;
    readonly dropped_cost_usd: number;
}

/**
 * Detect dropped-model legs for a routed dispatch. Claude Code applies the
 * Agent `model` param to the first leg only; SendMessage follow-ups and
 * post-compact resumes continue on the parent session's model. Falls back to
 * the session-level child model when no per-turn legs exist.
 */
export const computeModelDrop = (
    dispatchModel: string,
    legs: ReadonlyArray<DispatchLeg>,
    fallbackChildModel: string | null,
    fallbackChildCost: number,
): ModelDrop => {
    if (dispatchModel === "inherit") return { dropped: false, dropped_cost_usd: 0 };
    if (legs.length > 0) {
        const off = legs.filter((l) => !legMatchesDispatchModel(l.model, dispatchModel));
        const cost = off.reduce((s, l) => s + l.cost_usd, 0);
        return { dropped: off.length > 0, dropped_cost_usd: cost };
    }
    if (fallbackChildModel && !legMatchesDispatchModel(fallbackChildModel, dispatchModel)) {
        return { dropped: true, dropped_cost_usd: fallbackChildCost };
    }
    return { dropped: false, dropped_cost_usd: 0 };
};

const parseInputJson = (raw: string | null): Record<string, unknown> => {
    if (!raw) return {};
    try {
        return JSON.parse(raw) as Record<string, unknown>;
    } catch {
        return {};
    }
};

// ---------------------------------------------------------------------------
// Core fetch: build joined DispatchRow array
// ---------------------------------------------------------------------------

export const fetchDispatches = Effect.fn("queries.fetchDispatches")(
    function* (opts: { readonly sinceDays: number; readonly limit: number }) {
        const db = yield* SurrealClient;

        const [spawnedResult, usageResult, toolCallsResult, parentSessionsResult, childLegsResult] =
            yield* db.query<[
                Array<Record<string, unknown>>,
                Array<Record<string, unknown>>,
                Array<Record<string, unknown>>,
                Array<Record<string, unknown>>,
                Array<Record<string, unknown>>,
            ]>(
                SPAWNED_SQL(opts.sinceDays) +
                USAGE_SQL(opts.sinceDays) +
                TOOL_CALLS_SQL(opts.sinceDays) +
                PARENT_SESSIONS_SQL(opts.sinceDays) +
                CHILD_LEGS_SQL(opts.sinceDays),
            );

        const spawnedRows: SpawnedRow[] = (spawnedResult ?? []).map((r) => ({
            parent_id: String(r.parent_id ?? ""),
            child_id: String(r.child_id ?? ""),
            ts: String(r.ts ?? ""),
            agent_type: r.agent_type == null ? null : String(r.agent_type),
            description: r.description == null ? null : String(r.description),
            tool_use_id: r.tool_use_id == null ? null : String(r.tool_use_id),
        }));

        const usageRows: UsageRow[] = (usageResult ?? []).map((r) => ({
            session_id: String(r.session_id ?? ""),
            model: r.model == null ? null : String(r.model),
            prompt_tokens: Number(r.prompt_tokens ?? 0),
            completion_tokens: Number(r.completion_tokens ?? 0),
            cache_read_tokens: Number(r.cache_read_tokens ?? 0),
            cache_create_tokens: Number(r.cache_create_tokens ?? 0),
            cost_usd: Number(r.cost_usd ?? 0),
        }));

        const toolCallRows: ToolCallRow[] = (toolCallsResult ?? []).map((r) => ({
            session_id: String(r.session_id ?? ""),
            call_id: String(r.call_id ?? ""),
            input_json: r.input_json == null ? null : String(r.input_json),
        }));

        const parentSessionRows: ParentSessionRow[] = (parentSessionsResult ?? []).map((r) => ({
            session_id: String(r.session_id ?? ""),
            model: r.model == null ? null : String(r.model),
        }));

        // Per-model legs keyed by bare child session id
        const legsByChildId = new Map<string, DispatchLeg[]>();
        for (const r of childLegsResult ?? []) {
            const model = r.model == null ? null : String(r.model);
            if (!model) continue;
            const bare = cleanSessionId(String(r.session_id ?? ""));
            const list = legsByChildId.get(bare) ?? [];
            list.push({
                model,
                cost_usd: Number(r.cost_usd ?? 0),
                turns: Number(r.turns ?? 0),
            });
            legsByChildId.set(bare, list);
        }

        // Build lookup maps
        const usageByChildId = new Map<string, UsageRow>();
        for (const u of usageRows) {
            const bare = cleanSessionId(u.session_id);
            usageByChildId.set(u.session_id, u);
            usageByChildId.set(bare, u);
            usageByChildId.set(`session:${bare}`, u);
        }

        // tool_call lookup: call_id -> input_json
        const toolCallByCallId = new Map<string, ToolCallRow>();
        for (const tc of toolCallRows) {
            if (tc.call_id) toolCallByCallId.set(tc.call_id, tc);
        }

        // parent session model lookup: bare session id -> model
        const parentModelById = new Map<string, string | null>();
        for (const ps of parentSessionRows) {
            const bare = cleanSessionId(ps.session_id);
            parentModelById.set(bare, ps.model);
            parentModelById.set(ps.session_id, ps.model);
        }

        // Join rows
        const rows: DispatchRow[] = [];
        for (const sp of spawnedRows) {
            const bareChild = cleanSessionId(sp.child_id);
            const bareParent = cleanSessionId(sp.parent_id);

            // Get dispatch model from Agent tool_call input
            let dispatchModel = "inherit";
            if (sp.tool_use_id) {
                const tc = toolCallByCallId.get(sp.tool_use_id);
                if (tc) {
                    const inp = parseInputJson(tc.input_json);
                    const m = inp.model;
                    if (typeof m === "string" && m.trim().length > 0) {
                        dispatchModel = m.trim();
                    }
                }
            }

            // Get child usage
            const usage = usageByChildId.get(bareChild) ??
                usageByChildId.get(`session:${bareChild}`) ??
                usageByChildId.get(sp.child_id);

            // Resolve child model: prefer usage, fall back to parent session model
            let childModel: string | null = usage?.model ?? null;
            if (!childModel) {
                childModel = parentModelById.get(bareParent) ?? parentModelById.get(sp.parent_id) ?? null;
            }

            const childLegs = legsByChildId.get(bareChild) ?? [];
            const childCost = usage?.cost_usd ?? 0;
            const drop = computeModelDrop(dispatchModel, childLegs, childModel, childCost);

            rows.push({
                ts: sp.ts,
                parent_id: bareParent,
                child_id: bareChild,
                agent_type: sp.agent_type,
                description: sp.description,
                dispatch_model: dispatchModel,
                child_model: childModel,
                child_cost_usd: childCost,
                child_legs: childLegs,
                model_dropped: drop.dropped,
                dropped_cost_usd: drop.dropped_cost_usd,
                prompt_tokens: usage?.prompt_tokens ?? 0,
                completion_tokens: usage?.completion_tokens ?? 0,
                cache_read_tokens: usage?.cache_read_tokens ?? 0,
                cache_create_tokens: usage?.cache_create_tokens ?? 0,
            });
        }

        // Sort by cost desc, then apply limit
        rows.sort((a, b) => b.child_cost_usd - a.child_cost_usd);
        const limited = rows.slice(0, opts.limit);

        const total_dispatches = rows.length;
        const inheritCount = rows.filter((r) => r.dispatch_model === "inherit").length;
        const inherit_pct = total_dispatches > 0 ? (inheritCount / total_dispatches) * 100 : 0;
        const total_child_cost_usd = rows.reduce((s, r) => s + r.child_cost_usd, 0);
        const droppedRows = rows.filter((r) => r.model_dropped);

        return {
            rows: limited,
            total_dispatches,
            inherit_pct,
            total_child_cost_usd,
            dropped_count: droppedRows.length,
            dropped_cost_usd: droppedRows.reduce((s, r) => s + r.dropped_cost_usd, 0),
        } satisfies DispatchesResult;
    },
);

// ---------------------------------------------------------------------------
// Candidates fetch: inherit + expensive + routing-match
// ---------------------------------------------------------------------------

export const fetchDispatchCandidates = Effect.fn("queries.fetchDispatchCandidates")(
    function* (opts: { readonly sinceDays: number; readonly table?: RoutingTable }) {
        const table = opts.table ?? ROUTING_CLASSES;
        const db = yield* SurrealClient;

        const [spawnedResult, usageResult, toolCallsResult, parentSessionsResult, agentModelsResult] =
            yield* db.query<[
                Array<Record<string, unknown>>,
                Array<Record<string, unknown>>,
                Array<Record<string, unknown>>,
                Array<Record<string, unknown>>,
                Array<Record<string, unknown>>,
            ]>(
                SPAWNED_SQL(opts.sinceDays) +
                USAGE_SQL(opts.sinceDays) +
                TOOL_CALLS_SQL(opts.sinceDays) +
                PARENT_SESSIONS_SQL(opts.sinceDays) +
                AGENT_MODELS_SQL,
            );

        const spawnedRows: SpawnedRow[] = (spawnedResult ?? []).map((r) => ({
            parent_id: String(r.parent_id ?? ""),
            child_id: String(r.child_id ?? ""),
            ts: String(r.ts ?? ""),
            agent_type: r.agent_type == null ? null : String(r.agent_type),
            description: r.description == null ? null : String(r.description),
            tool_use_id: r.tool_use_id == null ? null : String(r.tool_use_id),
        }));

        const usageRows: UsageRow[] = (usageResult ?? []).map((r) => ({
            session_id: String(r.session_id ?? ""),
            model: r.model == null ? null : String(r.model),
            prompt_tokens: Number(r.prompt_tokens ?? 0),
            completion_tokens: Number(r.completion_tokens ?? 0),
            cache_read_tokens: Number(r.cache_read_tokens ?? 0),
            cache_create_tokens: Number(r.cache_create_tokens ?? 0),
            cost_usd: Number(r.cost_usd ?? 0),
        }));

        const toolCallRows: ToolCallRow[] = (toolCallsResult ?? []).map((r) => ({
            session_id: String(r.session_id ?? ""),
            call_id: String(r.call_id ?? ""),
            input_json: r.input_json == null ? null : String(r.input_json),
        }));

        const parentSessionRows: ParentSessionRow[] = (parentSessionsResult ?? []).map((r) => ({
            session_id: String(r.session_id ?? ""),
            model: r.model == null ? null : String(r.model),
        }));

        const agentModels: AgentModelRow[] = (agentModelsResult ?? []).map((r) => ({
            name: String(r.name ?? ""),
            input_per_million_usd: r.input_per_million_usd == null ? null : Number(r.input_per_million_usd),
            output_per_million_usd: r.output_per_million_usd == null ? null : Number(r.output_per_million_usd),
            cache_read_per_million_usd: r.cache_read_per_million_usd == null ? null : Number(r.cache_read_per_million_usd),
            cache_creation_per_million_usd: r.cache_creation_per_million_usd == null ? null : Number(r.cache_creation_per_million_usd),
        }));

        // Build lookup maps
        const usageByChildId = new Map<string, UsageRow>();
        for (const u of usageRows) {
            const bare = cleanSessionId(u.session_id);
            usageByChildId.set(u.session_id, u);
            usageByChildId.set(bare, u);
            usageByChildId.set(`session:${bare}`, u);
        }

        const toolCallByCallId = new Map<string, ToolCallRow>();
        for (const tc of toolCallRows) {
            if (tc.call_id) toolCallByCallId.set(tc.call_id, tc);
        }

        const parentModelById = new Map<string, string | null>();
        for (const ps of parentSessionRows) {
            const bare = cleanSessionId(ps.session_id);
            parentModelById.set(bare, ps.model);
            parentModelById.set(ps.session_id, ps.model);
        }

        // agent_model rows -> estimateCost catalog, so repricing uses the SAME
        // DB pricing that priced the actual costs at ingest.
        const pricingCatalog = new Map<string, ModelPricing>();
        for (const am of agentModels) {
            pricingCatalog.set(am.name, {
                provider: "anthropic",
                inputPerMillionUsd: am.input_per_million_usd ?? null,
                outputPerMillionUsd: am.output_per_million_usd ?? null,
                cacheCreationPerMillionUsd: am.cache_creation_per_million_usd ?? null,
                cacheReadPerMillionUsd: am.cache_read_per_million_usd ?? null,
                fastMultiplier: 1,
                pricingSource: "agent_model",
            });
        }

        // Helper: reprice token buckets at a given model's rates. Delegates to
        // the ingest's estimateCost - prompt_tokens here is TOTAL billed input
        // (fresh + both cache buckets), and estimateCost recovers fresh input
        // by subtracting the cache buckets before applying the input rate.
        const reprice = (usage: UsageRow, targetModelName: string): number => {
            const cost = estimateCost({
                modelKey: targetModelName,
                promptTokens: usage.prompt_tokens,
                completionTokens: usage.completion_tokens,
                cacheCreationInputTokens: usage.cache_create_tokens,
                cacheReadInputTokens: usage.cache_read_tokens,
                estimatedTokens: usage.prompt_tokens + usage.completion_tokens,
                ...(pricingCatalog.size > 0 ? { pricingCatalog } : {}),
            });
            return cost.totalUsd ?? usage.cost_usd;
        };

        const candidates: CandidateRow[] = [];

        for (const sp of spawnedRows) {
            const bareChild = cleanSessionId(sp.child_id);
            const bareParent = cleanSessionId(sp.parent_id);

            // Tool call lookup for dispatch model
            let dispatchModel = "inherit";
            if (sp.tool_use_id) {
                const tc = toolCallByCallId.get(sp.tool_use_id);
                if (tc) {
                    const inp = parseInputJson(tc.input_json);
                    const m = inp.model;
                    if (typeof m === "string" && m.trim().length > 0) {
                        dispatchModel = m.trim();
                    }
                }
            }

            // Candidate criterion (a): dispatch_model must be "inherit"
            if (dispatchModel !== "inherit") continue;

            const usage = usageByChildId.get(bareChild) ??
                usageByChildId.get(`session:${bareChild}`) ??
                usageByChildId.get(sp.child_id);

            let childModel: string | null = usage?.model ?? null;
            if (!childModel) {
                childModel = parentModelById.get(bareParent) ?? parentModelById.get(sp.parent_id) ?? null;
            }

            // Candidate criterion (b): child model is expensive tier (fable/opus)
            if (!childModel || !EXPENSIVE_TIER_RE.test(childModel)) continue;

            // Candidate criterion (c): description or agent_type matches a routing class
            const routingMatch = matchRoutingWith(table, sp.description, sp.agent_type);
            if (!routingMatch) continue;

            // Resolve suggested model name
            const suggestedAlias = routingMatch.suggest;
            const suggestedModelName = MODEL_ALIASES[suggestedAlias] ?? suggestedAlias;

            // Reprice
            const childCostUsd = usage?.cost_usd ?? 0;
            const repricedCost = usage ? reprice(usage, suggestedModelName) : 0;
            const estSavings = Math.max(0, childCostUsd - repricedCost);

            candidates.push({
                ts: sp.ts,
                parent_id: bareParent,
                child_id: bareChild,
                agent_type: sp.agent_type,
                description: sp.description,
                dispatch_model: dispatchModel,
                child_model: childModel,
                child_cost_usd: childCostUsd,
                // Candidates are inherit-only: a model drop requires an explicit
                // dispatch model, so these are structurally empty here.
                child_legs: [],
                model_dropped: false,
                dropped_cost_usd: 0,
                prompt_tokens: usage?.prompt_tokens ?? 0,
                completion_tokens: usage?.completion_tokens ?? 0,
                cache_read_tokens: usage?.cache_read_tokens ?? 0,
                cache_create_tokens: usage?.cache_create_tokens ?? 0,
                routing_match: routingMatch,
                suggested_model: suggestedModelName,
                est_savings_usd: estSavings,
            });
        }

        // Sort by est savings desc
        candidates.sort((a, b) => b.est_savings_usd - a.est_savings_usd);

        const total_est_savings_usd = candidates.reduce((s, c) => s + c.est_savings_usd, 0);

        // Top 3 routing classes by savings
        const classSavings = new Map<string, number>();
        for (const c of candidates) {
            const existing = classSavings.get(c.routing_match.classId) ?? 0;
            classSavings.set(c.routing_match.classId, existing + c.est_savings_usd);
        }
        const top_classes = [...classSavings.entries()]
            .sort(([, a], [, b]) => b - a)
            .slice(0, 3)
            .map(([classId, savings_usd]) => ({ classId, savings_usd }));

        return {
            candidates,
            total_est_savings_usd,
            top_classes,
        } satisfies CandidatesResult;
    },
);

// ---------------------------------------------------------------------------
// compile-routing: write routing table JSON to disk
// ---------------------------------------------------------------------------

export interface CompileRoutingResult {
    readonly path: string;
    readonly written: boolean;
    readonly preserved_user_classes: number;
    /** True when the file exists but is unparseable - we refuse to overwrite. */
    readonly corrupt: boolean;
}

export const compileRouting = (
    outPath?: string,
): Effect.Effect<CompileRoutingResult, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const resolvedPath = outPath ?? defaultRoutingTablePath();
        const exists = yield* fs.exists(resolvedPath).pipe(Effect.orElseSucceed(() => false));
        const existing = yield* loadStoredRoutingTable(resolvedPath);
        if (exists && existing === null) {
            // File present but corrupt/unparseable: overwriting would silently
            // destroy any mined user classes. Refuse and surface it.
            return { path: resolvedPath, written: false, preserved_user_classes: 0, corrupt: true };
        }
        const merged = mergeRoutingTables(ROUTING_CLASSES, existing);
        yield* saveStoredRoutingTable(resolvedPath, merged);
        const preserved = merged.classes.filter((c) => c.origin === "user").length;
        return { path: resolvedPath, written: true, preserved_user_classes: preserved, corrupt: false };
    });

// ---------------------------------------------------------------------------
// compile-routing --skill-md: regenerate the routing table inside a skill doc
// ---------------------------------------------------------------------------

const SKILL_TABLE_OPEN = "<!-- ax:routing-table -->";
const SKILL_TABLE_CLOSE = "<!-- /ax:routing-table -->";

/** Render ROUTING_CLASSES as the markdown table embedded in skill docs. */
export const renderRoutingTableMarkdown = (): string => {
    const lines = [
        "| class | description pattern | model |",
        "|---|---|---|",
    ];
    for (const cls of ROUTING_CLASSES.classes) {
        // Escape pipes so regex alternations don't break the table.
        const pattern = cls.pattern.replace(/\|/g, "\\|");
        lines.push(`| ${cls.id} | \`${pattern}\` | ${cls.suggest} |`);
    }
    const byModel = new Map<string, string[]>();
    for (const [agentType, model] of Object.entries(ROUTING_CLASSES.agentTypes ?? {})) {
        const list = byModel.get(model) ?? [];
        list.push(agentType);
        byModel.set(model, list);
    }
    const agentTypes = [...byModel.entries()]
        .map(([model, types]) => `${types.join(", ")} → ${model}`)
        .join("; ");
    if (agentTypes) lines.push(`| agent types | ${agentTypes} | |`);
    return lines.join("\n");
};

/**
 * Replace the marked routing-table section in a skill markdown body.
 * Returns null when the markers are missing (caller surfaces the error).
 */
export const replaceSkillRoutingSection = (content: string): string | null => {
    const open = content.indexOf(SKILL_TABLE_OPEN);
    const close = content.indexOf(SKILL_TABLE_CLOSE);
    if (open === -1 || close === -1 || close < open) return null;
    return (
        content.slice(0, open + SKILL_TABLE_OPEN.length) +
        "\n" + renderRoutingTableMarkdown() + "\n" +
        content.slice(close)
    );
};

export interface CompileSkillMdResult {
    readonly path: string;
    readonly written: boolean;
    readonly error?: string;
}

/** Regenerate the `ax:routing-table` section of a skill markdown file in place. */
export const compileRoutingSkillMd = (
    skillPath: string,
): Effect.Effect<CompileSkillMdResult, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const content = yield* fs.readFileString(skillPath).pipe(Effect.orDie);
        const updated = replaceSkillRoutingSection(content);
        if (updated === null) {
            return {
                path: skillPath,
                written: false,
                error: `missing ${SKILL_TABLE_OPEN} ... ${SKILL_TABLE_CLOSE} markers`,
            };
        }
        if (updated !== content) {
            yield* fs.writeFileString(skillPath, updated).pipe(Effect.orDie);
        }
        return { path: skillPath, written: updated !== content };
    });
