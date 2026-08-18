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
 *
 * Runs as 5 parallel `cacheRows` calls over the DuckDB CacheRead seam.
 * `SUM()` over a BIGINT column
 * (thinking_blocks/thinking_tokens/reasoning_output_tokens/completion_tokens)
 * widens to HUGEINT in DuckDB, so every sum is CAST back to BIGINT and
 * decoded via NumberFromBigIntColumn (see session-detail-cache.ts for the
 * same contract). `fetchSparSessionIds` reads through a separate
 * SQLite-backed `Judgment` service, not DuckDB.
 */
import { Effect, Schema } from "effect";
import { NumberFromBigIntColumn } from "@ax/lib/duckdb/columns";
import { cacheRows } from "@ax/lib/duckdb/query";
import { daysAgoExpr } from "@ax/lib/duckdb/clause";
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
// SQL (flat, deref-free aggregates; every query binds `?` = sinceDays)
// ---------------------------------------------------------------------------

const days = (sinceDays: number): number => Math.max(1, Math.trunc(sinceDays));

const SessionThinkingSchemaRow = Schema.Struct({
    session_id: Schema.String,
    blocks: NumberFromBigIntColumn,
    tokens: NumberFromBigIntColumn,
    assistant_turns: NumberFromBigIntColumn,
    thinking_turns: NumberFromBigIntColumn,
});

const SESSION_THINKING_SQL = `
SELECT
    session AS session_id,
    CAST(COALESCE(SUM(COALESCE(thinking_blocks, 0)), 0) AS BIGINT) AS blocks,
    CAST(COALESCE(SUM(COALESCE(thinking_tokens, 0)), 0) AS BIGINT) AS tokens,
    COUNT(*) AS assistant_turns,
    COUNT(*) FILTER (WHERE COALESCE(thinking_blocks, 0) > 0) AS thinking_turns
FROM turn
WHERE ts > ${daysAgoExpr}
  AND role = 'assistant'
GROUP BY session;
`;

const SessionModelSchemaRow = Schema.Struct({
    session_id: Schema.String,
    model: Schema.NullOr(Schema.String),
    source: Schema.NullOr(Schema.String),
});

const SESSION_MODELS_SQL = `
SELECT id AS session_id, model, source
FROM session
WHERE started_at > ${daysAgoExpr};
`;

const EffortSchemaRow = Schema.Struct({
    source: Schema.NullOr(Schema.String),
    model: Schema.NullOr(Schema.String),
    reasoning_effort: Schema.NullOr(Schema.String),
    sessions: NumberFromBigIntColumn,
});

const EFFORT_SQL = `
SELECT source, model, reasoning_effort, COUNT(*) AS sessions
FROM session
WHERE started_at > ${daysAgoExpr}
  AND reasoning_effort IS NOT NULL
GROUP BY source, model, reasoning_effort;
`;

const CodexReasoningSchemaRow = Schema.Struct({
    model: Schema.NullOr(Schema.String),
    sessions: NumberFromBigIntColumn,
    reasoning_tokens: NumberFromBigIntColumn,
    completion_tokens: NumberFromBigIntColumn,
});

const CODEX_REASONING_SQL = `
SELECT
    model,
    COUNT(*) AS sessions,
    CAST(COALESCE(SUM(COALESCE(reasoning_output_tokens, 0)), 0) AS BIGINT) AS reasoning_tokens,
    CAST(COALESCE(SUM(COALESCE(completion_tokens, 0)), 0) AS BIGINT) AS completion_tokens
FROM session_token_usage
WHERE source IN ${CODEX_SOURCES_SQL}
  AND ts > ${daysAgoExpr}
GROUP BY model;
`;

const AgentModelRateSchemaRow = Schema.Struct({
    name: Schema.NullOr(Schema.String),
    output_per_million_usd: Schema.NullOr(Schema.Number),
});

const AGENT_MODELS_SQL = `SELECT name, output_per_million_usd FROM agent_model;`;

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

// Strip the `session:` prefix + record-id delimiters, in both the backtick
// (session:`uuid`) and angle-bracket (session:⟨uuid⟩) forms SurrealDB used to
// emit. DuckDB stores bare uuids, so on current data this is a no-op; it stays
// because BOTH sides of the spar exclusion below must normalize the same way,
// and a mismatch there does not fail - it silently excludes nothing.
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
        const sinceDays = days(opts.sinceDays);

        // Fetch spar variant session ids before the main queries so we can
        // exclude them from behavioral totals at the JS join. Both sides run
        // through cleanSessionId so the Set keys and the scanned session_id
        // columns cannot disagree on shape.
        const sparSessionIds = yield* fetchSparSessionIds();
        const sparSet = new Set(sparSessionIds.map(cleanSessionId));

        const [thinkingResult, sessionsResult, effortResult, reasoningResult, agentModelsResult] = yield* Effect.all([
            cacheRows(SessionThinkingSchemaRow, { sql: SESSION_THINKING_SQL, params: [sinceDays] }, "thinking per-session"),
            cacheRows(SessionModelSchemaRow, { sql: SESSION_MODELS_SQL, params: [sinceDays] }, "thinking session models"),
            cacheRows(EffortSchemaRow, { sql: EFFORT_SQL, params: [sinceDays] }, "thinking effort distribution"),
            cacheRows(CodexReasoningSchemaRow, { sql: CODEX_REASONING_SQL, params: [sinceDays] }, "thinking codex reasoning"),
            cacheRows(AgentModelRateSchemaRow, { sql: AGENT_MODELS_SQL, params: [] }, "thinking agent model rates"),
        ], { concurrency: 5 });

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
