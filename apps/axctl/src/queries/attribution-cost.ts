/**
 * `ax cost attribution` (#867): cost by NATIVE harness attribution.
 *
 * Claude Code (since ~2026-05) stamps `attributionSkill`/`attributionAgent`
 * on each billing event, plus `diagnostics.cache_miss_reason`. The ingest
 * parser lands them on `turn_token_usage` (claude sources only; null on
 * every other provider and on all pre-cutover history until a
 * `--reparse=claude` backfill). This is GROUND TRUTH per billing event -
 * unlike `invoked`-edge attribution, which is an inference from Skill-tool
 * calls; divergence between the two is itself a signal.
 *
 * Flat GROUP BYs over `turn_token_usage`, no derefs. Every rollup uses a
 * non-null filter, and coverage reports how much of the window's claude
 * spend carries attribution at all - without it, a mostly-null window would
 * read as "this skill is cheap" instead of "the data is not there yet".
 */
import { Effect, Schema } from "effect";
import { NumberFromBigIntColumn } from "@ax/lib/duckdb/columns";
import type { CacheReadService } from "@ax/lib/duckdb/seam";

export interface AttributionRow {
    /** The skill or agent name exactly as the harness stamped it. */
    readonly name: string;
    readonly turns: number;
    readonly sessions: number;
    readonly costUsd: number;
    readonly tokens: number;
}

export interface CacheMissRow {
    readonly reason: string;
    readonly turns: number;
}

export interface ApiErrorRow {
    readonly status: string;
    readonly turns: number;
}

export interface AttributionCostResult {
    readonly skills: ReadonlyArray<AttributionRow>;
    readonly agents: ReadonlyArray<AttributionRow>;
    readonly cacheMissReasons: ReadonlyArray<CacheMissRow>;
    readonly apiErrors: ReadonlyArray<ApiErrorRow>;
    readonly coverage: {
        /** claude-source usage rows in the window */
        readonly totalTurns: number;
        /** ...of which carry a skill or agent attribution */
        readonly attributedTurns: number;
        readonly totalCostUsd: number;
        readonly attributedCostUsd: number;
    };
}

export interface AttributionCostInput {
    readonly sinceDays: number;
    readonly limit: number;
}

const sqlWindowDays = (n: number): number => Math.max(1, Math.trunc(n));

const RollupRow = Schema.Struct({
    name: Schema.String,
    turns: NumberFromBigIntColumn,
    sessions: NumberFromBigIntColumn,
    cost_usd: Schema.NullOr(Schema.Number),
    tokens: NumberFromBigIntColumn,
});

const CountRow = Schema.Struct({
    name: Schema.String,
    turns: NumberFromBigIntColumn,
});

const CoverageRow = Schema.Struct({
    total_turns: NumberFromBigIntColumn,
    attributed_turns: NumberFromBigIntColumn,
    total_cost_usd: Schema.NullOr(Schema.Number),
    attributed_cost_usd: Schema.NullOr(Schema.Number),
});

const rollupSql = (column: "attribution_skill" | "attribution_agent"): string => `
    SELECT ${column} AS name,
           count(*) AS turns,
           count(DISTINCT session) AS sessions,
           sum(estimated_cost_usd) AS cost_usd,
           CAST(coalesce(sum(estimated_tokens), 0) AS BIGINT) AS tokens
    FROM turn_token_usage
    WHERE ${column} IS NOT NULL AND source LIKE 'claude%' AND ts > ?
    GROUP BY ${column}
    ORDER BY cost_usd DESC NULLS LAST`;

const countSql = (column: "cache_miss_reason_type" | "api_error_status"): string => `
    SELECT ${column} AS name, count(*) AS turns
    FROM turn_token_usage
    WHERE ${column} IS NOT NULL AND source LIKE 'claude%' AND ts > ?
    GROUP BY ${column}
    ORDER BY turns DESC`;

const COVERAGE_SQL = `
    SELECT count(*) AS total_turns,
           count(*) FILTER (WHERE attribution_skill IS NOT NULL OR attribution_agent IS NOT NULL) AS attributed_turns,
           coalesce(sum(estimated_cost_usd), 0) AS total_cost_usd,
           coalesce(sum(estimated_cost_usd) FILTER (WHERE attribution_skill IS NOT NULL OR attribution_agent IS NOT NULL), 0) AS attributed_cost_usd
    FROM turn_token_usage
    WHERE source LIKE 'claude%' AND ts > ?`;

const toRow = (raw: typeof RollupRow.Type): AttributionRow => ({
    name: raw.name,
    turns: raw.turns,
    sessions: raw.sessions,
    costUsd: raw.cost_usd ?? 0,
    tokens: raw.tokens,
});

const EMPTY_RESULT: AttributionCostResult = {
    skills: [],
    agents: [],
    cacheMissReasons: [],
    apiErrors: [],
    coverage: { totalTurns: 0, attributedTurns: 0, totalCostUsd: 0, attributedCostUsd: 0 },
};

const ColumnProbeRow = Schema.Struct({ n: NumberFromBigIntColumn });

export const fetchAttributionCost = Effect.fn("queries.fetchAttributionCost")(
    function* (read: CacheReadService, input: AttributionCostInput) {
        // A snapshot PUBLISHED before this release predates the #867 ALTERs -
        // the columns appear on the next ingest's publish. Probe instead of
        // erroring, so the first post-upgrade read degrades to the empty
        // state (whose copy already says how to backfill).
        const probe = yield* read.rows(
            ColumnProbeRow,
            `SELECT CAST(count(*) AS BIGINT) AS n FROM information_schema.columns
             WHERE table_name = 'turn_token_usage' AND column_name = 'attribution_skill'`,
        );
        if ((probe[0]?.n ?? 0) === 0) return EMPTY_RESULT;

        const cutoff = new Date(Date.now() - sqlWindowDays(input.sinceDays) * 86_400_000);
        const cap = Math.max(1, Math.trunc(input.limit));

        const skills = yield* read.rows(RollupRow, rollupSql("attribution_skill"), [cutoff]);
        const agents = yield* read.rows(RollupRow, rollupSql("attribution_agent"), [cutoff]);
        const cacheMiss = yield* read.rows(CountRow, countSql("cache_miss_reason_type"), [cutoff]);
        const apiErrors = yield* read.rows(CountRow, countSql("api_error_status"), [cutoff]);
        const coverage = (yield* read.rows(CoverageRow, COVERAGE_SQL, [cutoff]))[0];

        const result: AttributionCostResult = {
            skills: skills.slice(0, cap).map(toRow),
            agents: agents.slice(0, cap).map(toRow),
            cacheMissReasons: cacheMiss.map((r) => ({ reason: r.name, turns: r.turns })),
            apiErrors: apiErrors.map((r) => ({ status: r.name, turns: r.turns })),
            coverage: {
                totalTurns: coverage?.total_turns ?? 0,
                attributedTurns: coverage?.attributed_turns ?? 0,
                totalCostUsd: coverage?.total_cost_usd ?? 0,
                attributedCostUsd: coverage?.attributed_cost_usd ?? 0,
            },
        };
        return result;
    },
);
