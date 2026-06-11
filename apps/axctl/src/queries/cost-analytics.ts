/**
 * `ax cost models / sessions / split`: model/cost analytics over
 * `session_token_usage`. GROUP BY stays on scalar fields of the scanned table
 * only - record derefs inside aggregates over large tables hang SurrealDB 3.x -
 * so any grouping that needs a derived dimension (origin) happens in JS after
 * a single scan.
 *
 * Tables used (read-only):
 *   session_token_usage: source, model, prompt_tokens, completion_tokens,
 *     cache_creation_input_tokens, cache_read_input_tokens,
 *     estimated_cost_usd, ts
 *   session: id, source, project, started_at, model
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { surrealLiteral } from "@ax/lib/json";

// ---------------------------------------------------------------------------
// cost models
// ---------------------------------------------------------------------------

export interface CostModelsRow {
    readonly model: string;
    readonly sessions: number;
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly cache_read_tokens: number;
    readonly cache_create_tokens: number;
    readonly cost_usd: number;
}

export interface CostModelsResult {
    readonly rows: ReadonlyArray<CostModelsRow>;
    readonly total_cost_usd: number;
}

/**
 * Fetch raw session_token_usage rows for the cost-models rollup. Avoids
 * GROUP BY + deref inside aggregates; aggregation is done in JS.
 */
const COST_MODELS_SQL = (sinceDays: number) => `
SELECT
    model,
    count() AS sessions,
    math::sum(prompt_tokens) AS prompt_tokens,
    math::sum(completion_tokens) AS completion_tokens,
    math::sum(cache_read_input_tokens) AS cache_read_tokens,
    math::sum(cache_creation_input_tokens) AS cache_create_tokens,
    math::sum(estimated_cost_usd) AS cost_usd
FROM session_token_usage
WHERE ts > time::now() - ${Math.max(1, Math.trunc(sinceDays))}d
GROUP BY model
ORDER BY cost_usd DESC;
`;

export const fetchCostModels = Effect.fn("queries.fetchCostModels")(
    function* (opts: { readonly sinceDays: number }) {
        const db = yield* SurrealClient;
        const rows = yield* db.query<[Array<Record<string, unknown>>]>(
            COST_MODELS_SQL(opts.sinceDays),
        ).pipe(Effect.map((r) => r?.[0] ?? []));

        const parsed: CostModelsRow[] = rows.map((row) => ({
            model: row.model == null ? "(unattributed)" : String(row.model),
            sessions: Number(row.sessions ?? 0),
            prompt_tokens: Number(row.prompt_tokens ?? 0),
            completion_tokens: Number(row.completion_tokens ?? 0),
            cache_read_tokens: Number(row.cache_read_tokens ?? 0),
            cache_create_tokens: Number(row.cache_create_tokens ?? 0),
            cost_usd: Number(row.cost_usd ?? 0),
        }));

        // Sort by cost desc
        parsed.sort((a, b) => b.cost_usd - a.cost_usd);

        const total_cost_usd = parsed.reduce((sum, r) => sum + r.cost_usd, 0);
        return { rows: parsed, total_cost_usd } satisfies CostModelsResult;
    },
);

// ---------------------------------------------------------------------------
// cost sessions
// ---------------------------------------------------------------------------

export interface CostSessionsRow {
    readonly session_id: string;
    readonly project: string | null;
    readonly model: string | null;
    readonly started_at: string | null;
    readonly cost_usd: number;
    readonly completion_tokens: number;
    readonly cache_read_tokens: number;
}

export interface CostSessionsResult {
    readonly rows: ReadonlyArray<CostSessionsRow>;
}

const COST_SESSIONS_SQL = (sinceDays: number, limit: number, modelFilter: string | null) => {
    const whereFragments = [
        `ts > time::now() - ${Math.max(1, Math.trunc(sinceDays))}d`,
        "estimated_cost_usd != NONE",
    ];
    if (modelFilter) {
        whereFragments.push(`model = ${surrealLiteral(modelFilter)}`);
    }
    const where = whereFragments.join(" AND ");
    return `
SELECT
    type::string(session) AS session_id,
    session.project AS project,
    model,
    type::string(session.started_at) AS started_at,
    estimated_cost_usd AS cost_usd,
    completion_tokens,
    cache_read_input_tokens AS cache_read_tokens
FROM session_token_usage
WHERE ${where}
ORDER BY estimated_cost_usd DESC
LIMIT ${Math.min(Math.max(1, Math.trunc(limit)), 500)};
`;
};

export const fetchCostSessions = Effect.fn("queries.fetchCostSessions")(
    function* (opts: {
        readonly sinceDays: number;
        readonly limit: number;
        readonly model: string | null;
    }) {
        const db = yield* SurrealClient;
        const rows = yield* db.query<[Array<Record<string, unknown>>]>(
            COST_SESSIONS_SQL(opts.sinceDays, opts.limit, opts.model),
        ).pipe(Effect.map((r) => r?.[0] ?? []));

        const parsed: CostSessionsRow[] = rows.map((row) => ({
            session_id: String(row.session_id ?? ""),
            project: row.project == null ? null : String(row.project),
            model: row.model == null ? null : String(row.model),
            started_at: row.started_at == null ? null : String(row.started_at),
            cost_usd: Number(row.cost_usd ?? 0),
            completion_tokens: Number(row.completion_tokens ?? 0),
            cache_read_tokens: Number(row.cache_read_tokens ?? 0),
        }));

        return { rows: parsed } satisfies CostSessionsResult;
    },
);

// ---------------------------------------------------------------------------
// cost split
// ---------------------------------------------------------------------------

export interface CostSplitRow {
    readonly origin: "main" | "subagent";
    readonly model: string;
    readonly sessions: number;
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly cache_read_tokens: number;
    readonly cache_create_tokens: number;
    readonly cost_usd: number;
    readonly share_pct: number;
}

export interface CostSplitTotals {
    readonly sessions: number;
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly cache_read_tokens: number;
    readonly cache_create_tokens: number;
    readonly cost_usd: number;
}

export interface CostSplitResult {
    readonly rows: ReadonlyArray<CostSplitRow>;
    readonly totals: CostSplitTotals;
}

const COST_SPLIT_SQL = (sinceDays: number) => `
SELECT
    source,
    model,
    count() AS sessions,
    math::sum(prompt_tokens) AS prompt_tokens,
    math::sum(completion_tokens) AS completion_tokens,
    math::sum(cache_read_input_tokens) AS cache_read_tokens,
    math::sum(cache_creation_input_tokens) AS cache_create_tokens,
    math::sum(estimated_cost_usd) AS cost_usd
FROM session_token_usage
WHERE ts > time::now() - ${Math.max(1, Math.trunc(sinceDays))}d
GROUP BY source, model
ORDER BY cost_usd DESC;
`;

/**
 * Aggregate into (origin × model) cells where origin is "main" (source !=
 * 'claude-subagent') or "subagent" (source == 'claude-subagent').
 * Aggregation + share computation run in JS after a single DB scan.
 */
export const fetchCostSplit = Effect.fn("queries.fetchCostSplit")(
    function* (opts: { readonly sinceDays: number }) {
        const db = yield* SurrealClient;
        const rows = yield* db.query<[Array<Record<string, unknown>>]>(
            COST_SPLIT_SQL(opts.sinceDays),
        ).pipe(Effect.map((r) => r?.[0] ?? []));

        // Aggregate per (origin × model)
        const cellMap = new Map<string, {
            origin: "main" | "subagent";
            model: string;
            sessions: number;
            prompt_tokens: number;
            completion_tokens: number;
            cache_read_tokens: number;
            cache_create_tokens: number;
            cost_usd: number;
        }>();

        let totalCost = 0;
        let totalSessions = 0;
        let totalPrompt = 0;
        let totalCompletion = 0;
        let totalCacheRead = 0;
        let totalCacheCreate = 0;

        for (const row of rows) {
            const origin: "main" | "subagent" =
                String(row.source ?? "") === "claude-subagent" ? "subagent" : "main";
            const model = row.model == null ? "(unattributed)" : String(row.model);
            const key = `${origin}\x00${model}`;

            const sessions = Number(row.sessions ?? 0);
            const prompt = Number(row.prompt_tokens ?? 0);
            const completion = Number(row.completion_tokens ?? 0);
            const cacheRead = Number(row.cache_read_tokens ?? 0);
            const cacheCreate = Number(row.cache_create_tokens ?? 0);
            const cost = Number(row.cost_usd ?? 0);

            const existing = cellMap.get(key);
            if (existing) {
                existing.sessions += sessions;
                existing.prompt_tokens += prompt;
                existing.completion_tokens += completion;
                existing.cache_read_tokens += cacheRead;
                existing.cache_create_tokens += cacheCreate;
                existing.cost_usd += cost;
            } else {
                cellMap.set(key, {
                    origin,
                    model,
                    sessions,
                    prompt_tokens: prompt,
                    completion_tokens: completion,
                    cache_read_tokens: cacheRead,
                    cache_create_tokens: cacheCreate,
                    cost_usd: cost,
                });
            }

            totalCost += cost;
            totalSessions += sessions;
            totalPrompt += prompt;
            totalCompletion += completion;
            totalCacheRead += cacheRead;
            totalCacheCreate += cacheCreate;
        }

        const cells = [...cellMap.values()].sort((a, b) => b.cost_usd - a.cost_usd);
        const splitRows: CostSplitRow[] = cells.map((cell) => ({
            ...cell,
            share_pct: totalCost > 0 ? (cell.cost_usd / totalCost) * 100 : 0,
        }));

        const totals: CostSplitTotals = {
            sessions: totalSessions,
            prompt_tokens: totalPrompt,
            completion_tokens: totalCompletion,
            cache_read_tokens: totalCacheRead,
            cache_create_tokens: totalCacheCreate,
            cost_usd: totalCost,
        };

        return { rows: splitRows, totals } satisfies CostSplitResult;
    },
);
