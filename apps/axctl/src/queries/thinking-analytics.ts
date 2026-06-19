/**
 * `ax thinking` queries: extended-thinking + reasoning-effort analytics.
 *
 * Two signals, one per harness family:
 *   - Claude: per-turn `thinking_blocks` / `thinking_tokens` on `turn`
 *     (counted from `thinking` + `redacted_thinking` content blocks at
 *     ingest). The transcript has no thinking-level field, so volume is
 *     the measurable proxy.
 *   - Effort levels on `session.reasoning_effort`: codex turn_context effort
 *     (minimal|low|medium|high|xhigh) + claude settings.json effortLevel
 *     (high|medium|low; stamped only on sessions active at ingest time -
 *     transcripts carry no per-session effort field).
 *
 * Query shape follows dispatch-analytics: flat grouped aggregates (no record
 * derefs), JS-side join on stringified session ids.
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { normalizeModelName } from "../ingest/model-pricing.ts";
import { CODEX_SOURCES_SQL } from "../ingest/source-origin.ts";
import { fetchSparSessionIds } from "./spar-sessions.ts";

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface ThinkingModelRow {
    readonly model: string;
    readonly sessions: number;
    readonly assistant_turns: number;
    /** Assistant turns that contained at least one thinking block. */
    readonly thinking_turns: number;
    readonly thinking_blocks: number;
    readonly thinking_tokens: number;
    /** thinking_turns / assistant_turns * 100 */
    readonly thinking_turn_pct: number;
    /** thinking_tokens / thinking_turns (0 when no thinking turns) */
    readonly avg_tokens_per_thinking_turn: number;
    /**
     * thinking_tokens x agent_model.output_per_million_usd / 1e6 (thinking
     * tokens bill at the model's output rate). 0 when the model has no
     * pricing row or a null rate.
     */
    readonly thinking_cost_usd: number;
}

export interface EffortRow {
    readonly source: string;
    readonly model: string;
    readonly reasoning_effort: string;
    readonly sessions: number;
}

export interface CodexReasoningRow {
    readonly model: string;
    readonly sessions: number;
    readonly reasoning_tokens: number;
    readonly completion_tokens: number;
    /** reasoning_tokens / completion_tokens * 100 (reasoning is a subset of output) */
    readonly reasoning_share_pct: number;
    /**
     * reasoning_tokens x agent_model.output_per_million_usd / 1e6 (reasoning
     * tokens bill at the model's output rate). 0 when the model has no
     * pricing row or a null rate.
     */
    readonly reasoning_cost_usd: number;
}

export interface ThinkingResult {
    readonly models: ReadonlyArray<ThinkingModelRow>;
    /** Effort distribution across sources (codex turn_context effort + claude
     *  settings effortLevel stamped on live sessions at ingest). */
    readonly efforts: ReadonlyArray<EffortRow>;
    readonly codex_reasoning: ReadonlyArray<CodexReasoningRow>;
    readonly window_days: number;
}

// ---------------------------------------------------------------------------
// SQL (flat, deref-free aggregates; outer select stringifies grouped ids)
// ---------------------------------------------------------------------------

const days = (sinceDays: number): number => Math.max(1, Math.trunc(sinceDays));

const SESSION_THINKING_SQL = (sinceDays: number) => `
SELECT type::string(session) AS session_id, blocks, tokens, assistant_turns, thinking_turns FROM (
    SELECT
        session,
        math::sum(thinking_blocks ?? 0) AS blocks,
        math::sum(thinking_tokens ?? 0) AS tokens,
        count() AS assistant_turns,
        count((thinking_blocks ?? 0) > 0) AS thinking_turns
    FROM turn
    WHERE ts > time::now() - ${days(sinceDays)}d
      AND role = 'assistant'
    GROUP BY session
);
`;

const SESSION_MODELS_SQL = (sinceDays: number) => `
SELECT
    type::string(id) AS session_id,
    model,
    source
FROM session
WHERE started_at > time::now() - ${days(sinceDays)}d;
`;

const EFFORT_SQL = (sinceDays: number) => `
SELECT source, model, reasoning_effort, count() AS sessions FROM (
    SELECT source, model, reasoning_effort
    FROM session
    WHERE started_at > time::now() - ${days(sinceDays)}d
      AND reasoning_effort != NONE
) GROUP BY source, model, reasoning_effort;
`;

const CODEX_REASONING_SQL = (sinceDays: number) => `
SELECT
    model,
    count() AS sessions,
    math::sum(reasoning_output_tokens ?? 0) AS reasoning_tokens,
    math::sum(completion_tokens ?? 0) AS completion_tokens
FROM session_token_usage
WHERE source IN ${CODEX_SOURCES_SQL}
  AND ts > time::now() - ${days(sinceDays)}d
GROUP BY model;
`;

const AGENT_MODELS_SQL = `
SELECT name, output_per_million_usd FROM agent_model;
`;

// ---------------------------------------------------------------------------
// Pure rollup (exported for tests)
// ---------------------------------------------------------------------------

/**
 * USD cost of output-billed reasoning/thinking tokens:
 * `tokens × outputPerMillionUsd / 1e6`. Returns 0 when the rate is
 * null/undefined/non-finite (model has no pricing row) - never guesses.
 */
export const reasoningCostUsd = (
    tokens: number,
    outputPerMillionUsd: number | null | undefined,
): number => {
    if (outputPerMillionUsd == null || !Number.isFinite(outputPerMillionUsd)) return 0;
    return (tokens * outputPerMillionUsd) / 1e6;
};

export interface SessionThinkingRow {
    readonly session_id: string;
    readonly blocks: number;
    readonly tokens: number;
    readonly assistant_turns: number;
    readonly thinking_turns: number;
}

// Strip the `session:` prefix + record-id delimiters. Handles both the
// backtick form (`type::string(session)` / `type::string(id)` casts ->
// session:`uuid`) AND the angle-bracket form (a raw RecordId's String() ->
// session:⟨uuid⟩, as returned by fetchSparSessionIds' SELECT VALUE id). The
// spar-session ids and the turn-scan session_id columns must normalize to the
// same bare uuid or the spar exclusion below silently misses.
const cleanSessionId = (id: string): string =>
    id
        .replace(/^session:/, "")
        .replace(/^[`⟨]+/, "")
        .replace(/[`⟩]+$/, "");

export const rollupThinkingByModel = (
    sessionRows: ReadonlyArray<SessionThinkingRow>,
    modelBySession: ReadonlyMap<string, string | null>,
    outputRateByModel: ReadonlyMap<string, number | null>,
): ThinkingModelRow[] => {
    interface Acc {
        sessions: number;
        assistant_turns: number;
        thinking_turns: number;
        thinking_blocks: number;
        thinking_tokens: number;
    }
    const byModel = new Map<string, Acc>();
    for (const row of sessionRows) {
        const bare = cleanSessionId(row.session_id);
        const model = modelBySession.get(bare) ?? null;
        if (!model) continue;
        const acc = byModel.get(model) ?? {
            sessions: 0,
            assistant_turns: 0,
            thinking_turns: 0,
            thinking_blocks: 0,
            thinking_tokens: 0,
        };
        acc.sessions += 1;
        acc.assistant_turns += row.assistant_turns;
        acc.thinking_turns += row.thinking_turns;
        acc.thinking_blocks += row.blocks;
        acc.thinking_tokens += row.tokens;
        byModel.set(model, acc);
    }
    return [...byModel.entries()]
        .map(([model, acc]) => ({
            model,
            sessions: acc.sessions,
            assistant_turns: acc.assistant_turns,
            thinking_turns: acc.thinking_turns,
            thinking_blocks: acc.thinking_blocks,
            thinking_tokens: acc.thinking_tokens,
            thinking_turn_pct: acc.assistant_turns > 0
                ? (acc.thinking_turns / acc.assistant_turns) * 100
                : 0,
            avg_tokens_per_thinking_turn: acc.thinking_turns > 0
                ? acc.thinking_tokens / acc.thinking_turns
                : 0,
            thinking_cost_usd: reasoningCostUsd(
                acc.thinking_tokens,
                // `model` is a raw session.model string; the rate map is keyed by
                // agent_model.name == normalizeModelName(raw). Normalize the lookup
                // key so mixed-case/whitespace/prefixed ids still hit the rate.
                outputRateByModel.get(normalizeModelName(model) ?? model) ?? null,
            ),
        }))
        .sort((a, b) => b.thinking_tokens - a.thinking_tokens);
};

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export const fetchThinking = Effect.fn("queries.fetchThinking")(
    function* (opts: { readonly sinceDays: number }) {
        const db = yield* SurrealClient;

        // Fetch spar variant session ids before the main query so we can
        // exclude them from behavioral totals at the JS join. fetchSparSessionIds
        // returns RecordId[] (record-vs-record exclusion for the weighted path);
        // here we normalize each via String() -> cleanSessionId to the bare uuid
        // so the Set keys match the `type::string(session)` rows below.
        const sparSessionIds = yield* fetchSparSessionIds();
        const sparSet = new Set(sparSessionIds.map((id) => cleanSessionId(String(id))));

        const [thinkingResult, sessionsResult, effortResult, reasoningResult, agentModelsResult] = yield* db.query<[
            Array<Record<string, unknown>>,
            Array<Record<string, unknown>>,
            Array<Record<string, unknown>>,
            Array<Record<string, unknown>>,
            Array<Record<string, unknown>>,
        ]>(
            SESSION_THINKING_SQL(opts.sinceDays) +
            SESSION_MODELS_SQL(opts.sinceDays) +
            EFFORT_SQL(opts.sinceDays) +
            CODEX_REASONING_SQL(opts.sinceDays) +
            AGENT_MODELS_SQL,
        );

        // Model name -> output rate ($/M); null when the catalog has no rate.
        const outputRateByModel = new Map<string, number | null>();
        for (const r of agentModelsResult ?? []) {
            if (r.name == null) continue;
            outputRateByModel.set(
                String(r.name),
                r.output_per_million_usd == null ? null : Number(r.output_per_million_usd),
            );
        }

        // Drop spar sessions at the JS join: filter sessionRows before passing
        // to rollupThinkingByModel so spar traffic doesn't inflate thinking totals.
        const sessionRows: SessionThinkingRow[] = (thinkingResult ?? [])
            .map((r) => ({
                session_id: String(r.session_id ?? ""),
                blocks: Number(r.blocks ?? 0),
                tokens: Number(r.tokens ?? 0),
                assistant_turns: Number(r.assistant_turns ?? 0),
                thinking_turns: Number(r.thinking_turns ?? 0),
            }))
            .filter((r) => !sparSet.has(cleanSessionId(r.session_id)));

        const modelBySession = new Map<string, string | null>();
        for (const r of sessionsResult ?? []) {
            const cleanId = cleanSessionId(String(r.session_id ?? ""));
            // Also exclude spar sessions from the model map so they don't
            // appear in the effort/session counts.
            if (sparSet.has(cleanId)) continue;
            modelBySession.set(
                cleanId,
                r.model == null ? null : String(r.model),
            );
        }

        const efforts: EffortRow[] = (effortResult ?? [])
            .filter((r) => r.reasoning_effort != null)
            .map((r) => ({
                source: r.source == null ? "(unknown)" : String(r.source),
                model: r.model == null ? "(unknown)" : String(r.model),
                reasoning_effort: String(r.reasoning_effort),
                sessions: Number(r.sessions ?? 0),
            }))
            .sort((a, b) => b.sessions - a.sessions);

        const codex_reasoning: CodexReasoningRow[] = (reasoningResult ?? [])
            .map((r) => {
                const reasoning = Number(r.reasoning_tokens ?? 0);
                const completion = Number(r.completion_tokens ?? 0);
                const model = r.model == null ? "(unknown)" : String(r.model);
                return {
                    model,
                    sessions: Number(r.sessions ?? 0),
                    reasoning_tokens: reasoning,
                    completion_tokens: completion,
                    reasoning_share_pct: completion > 0 ? (reasoning / completion) * 100 : 0,
                    // `model` is a raw session_token_usage.model string; normalize to
                    // the agent_model.name key the rate map uses (see rollup above).
                    reasoning_cost_usd: reasoningCostUsd(reasoning, outputRateByModel.get(normalizeModelName(model) ?? model) ?? null),
                };
            })
            .sort((a, b) => b.reasoning_tokens - a.reasoning_tokens);

        return {
            models: rollupThinkingByModel(sessionRows, modelBySession, outputRateByModel),
            efforts,
            codex_reasoning,
            window_days: opts.sinceDays,
        } satisfies ThinkingResult;
    },
);
