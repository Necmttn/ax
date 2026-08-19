/**
 * `ax cost cache` (#868): cache-bust cost attribution - what re-injects your
 * context, and what re-establishing the cache costs.
 *
 * Reads the `cache_bust_event` ledger (derived by the cache-bust SQL model:
 * one priced row per usage row carrying a cache_miss_reason). Flat GROUP BYs,
 * no derefs. Coverage is claude-only (the one harness stamping the field
 * today) so a mostly-null window reads as "the data is not there yet", not
 * "cache busts are cheap"; the reason/offender rollups stay unfiltered so
 * another harness starting to stamp the field shows up for free.
 *
 * Corroboration sums the ledger's two independent prices over the rows where
 * both exist - the read-side half of plan Q1's ±25% agreement guard.
 *
 * `fetchCacheLensCandidates` (slice B, #868) is the MINTING-side sibling of
 * `fetchCacheBustCost`: same ledger, but a per-offender rollup shaped for the
 * `derive-proposals` ingest stage's guard pipeline (corroboration/recurrence/
 * materiality) instead of the CLI's reasons+coverage view. Two flat queries
 * (offender rollup, offender x reason mix) joined in JS by "kind:name" - same
 * "no derefs, no graph traversal in aggregates" discipline as
 * dispatch-analytics.ts. Typed `CacheReadService` (not `CacheWriteService`) so
 * it can run against either the live write-path service (the stage's actual
 * caller, mid-ingest - the published snapshot doesn't have this run's writes
 * yet) or a plain read - `CacheWriteService extends CacheReadService`.
 */
import { Effect, Schema } from "effect";
import { NumberFromBigIntColumn } from "@ax/lib/duckdb/columns";
import type { CacheReadService } from "@ax/lib/duckdb/seam";

export interface CacheBustReasonRow {
    readonly reason: string;
    readonly busts: number;
    readonly sessions: number;
    /** cache_creation_input_tokens re-established across these busts. */
    readonly tokens: number;
    readonly costUsd: number;
}

export interface CacheBustOffenderRow {
    /** attribution_skill / attribution_agent exactly as the harness stamped it. */
    readonly name: string;
    readonly busts: number;
    readonly sessions: number;
    readonly costUsd: number;
}

export interface CacheBustCostResult {
    readonly reasons: ReadonlyArray<CacheBustReasonRow>;
    readonly skills: ReadonlyArray<CacheBustOffenderRow>;
    readonly agents: ReadonlyArray<CacheBustOffenderRow>;
    readonly coverage: {
        /** claude-source usage rows in the window */
        readonly totalTurns: number;
        /** ...of which carry a cache_miss_reason */
        readonly bustTurns: number;
        /** window's total claude cache-creation spend */
        readonly totalCacheCreationUsd: number;
        /** ...of which sat on busted turns */
        readonly bustCostUsd: number;
    };
    readonly corroboration: {
        /** busts where both the ingest price and the flat-rate recompute exist */
        readonly comparableBusts: number;
        readonly costUsd: number;
        readonly corroboratedUsd: number;
    };
}

export interface CacheBustCostInput {
    readonly sinceDays: number;
    readonly limit: number;
}

const sqlWindowDays = (n: number): number => Math.max(1, Math.trunc(n));

const ReasonRow = Schema.Struct({
    reason: Schema.String,
    busts: NumberFromBigIntColumn,
    sessions: NumberFromBigIntColumn,
    tokens: NumberFromBigIntColumn,
    cost_usd: Schema.NullOr(Schema.Number),
});

const OffenderRow = Schema.Struct({
    name: Schema.String,
    busts: NumberFromBigIntColumn,
    sessions: NumberFromBigIntColumn,
    cost_usd: Schema.NullOr(Schema.Number),
});

const CoverageRow = Schema.Struct({
    total_turns: NumberFromBigIntColumn,
    bust_turns: NumberFromBigIntColumn,
    total_cache_creation_usd: Schema.NullOr(Schema.Number),
    bust_cost_usd: Schema.NullOr(Schema.Number),
});

const CorroborationRow = Schema.Struct({
    comparable_busts: NumberFromBigIntColumn,
    cost_usd: Schema.NullOr(Schema.Number),
    corroborated_usd: Schema.NullOr(Schema.Number),
});

const REASONS_SQL = `
    SELECT reason,
           count(*) AS busts,
           count(DISTINCT session) AS sessions,
           CAST(coalesce(sum(cache_creation_input_tokens), 0) AS BIGINT) AS tokens,
           sum(bust_cost_usd) AS cost_usd
    FROM cache_bust_event
    WHERE ts > ?
    GROUP BY reason
    ORDER BY cost_usd DESC NULLS LAST`;

const offendersSql = (column: "attribution_skill" | "attribution_agent"): string => `
    SELECT ${column} AS name,
           count(*) AS busts,
           count(DISTINCT session) AS sessions,
           sum(bust_cost_usd) AS cost_usd
    FROM cache_bust_event
    WHERE ${column} IS NOT NULL AND ts > ?
    GROUP BY ${column}
    ORDER BY cost_usd DESC NULLS LAST`;

// Denominator from turn_token_usage (every claude usage row, busted or not);
// numerator re-derived from the same table rather than the ledger so the two
// sides of the ratio share one source and one filter.
const COVERAGE_SQL = `
    SELECT count(*) AS total_turns,
           count(*) FILTER (WHERE cache_miss_reason_type IS NOT NULL) AS bust_turns,
           coalesce(sum(estimated_cache_creation_cost_usd), 0) AS total_cache_creation_usd,
           coalesce(sum(estimated_cache_creation_cost_usd) FILTER (WHERE cache_miss_reason_type IS NOT NULL), 0) AS bust_cost_usd
    FROM turn_token_usage
    WHERE source LIKE 'claude%' AND ts > ?`;

const CORROBORATION_SQL = `
    SELECT count(*) AS comparable_busts,
           coalesce(sum(bust_cost_usd), 0) AS cost_usd,
           coalesce(sum(corroborated_cost_usd), 0) AS corroborated_usd
    FROM cache_bust_event
    WHERE bust_cost_usd IS NOT NULL AND corroborated_cost_usd IS NOT NULL AND ts > ?`;

const EMPTY_RESULT: CacheBustCostResult = {
    reasons: [],
    skills: [],
    agents: [],
    coverage: { totalTurns: 0, bustTurns: 0, totalCacheCreationUsd: 0, bustCostUsd: 0 },
    corroboration: { comparableBusts: 0, costUsd: 0, corroboratedUsd: 0 },
};

const TableProbeRow = Schema.Struct({ n: NumberFromBigIntColumn });

export const fetchCacheBustCost = Effect.fn("queries.fetchCacheBustCost")(
    function* (read: CacheReadService, input: CacheBustCostInput) {
        // A snapshot PUBLISHED before this release predates the table - it
        // appears on the next ingest's publish. Probe instead of erroring, so
        // the first post-upgrade read degrades to the empty state.
        const probe = yield* read.rows(
            TableProbeRow,
            `SELECT CAST(count(*) AS BIGINT) AS n FROM information_schema.tables
             WHERE table_name = 'cache_bust_event'`,
        );
        if ((probe[0]?.n ?? 0) === 0) return EMPTY_RESULT;

        const cutoff = new Date(Date.now() - sqlWindowDays(input.sinceDays) * 86_400_000);
        const cap = Math.max(1, Math.trunc(input.limit));

        const reasons = yield* read.rows(ReasonRow, REASONS_SQL, [cutoff]);
        const skills = yield* read.rows(OffenderRow, offendersSql("attribution_skill"), [cutoff]);
        const agents = yield* read.rows(OffenderRow, offendersSql("attribution_agent"), [cutoff]);
        const coverage = (yield* read.rows(CoverageRow, COVERAGE_SQL, [cutoff]))[0];
        const corroboration = (yield* read.rows(CorroborationRow, CORROBORATION_SQL, [cutoff]))[0];

        const toOffender = (raw: typeof OffenderRow.Type): CacheBustOffenderRow => ({
            name: raw.name,
            busts: raw.busts,
            sessions: raw.sessions,
            costUsd: raw.cost_usd ?? 0,
        });

        const result: CacheBustCostResult = {
            reasons: reasons.map((r) => ({
                reason: r.reason,
                busts: r.busts,
                sessions: r.sessions,
                tokens: r.tokens,
                costUsd: r.cost_usd ?? 0,
            })),
            skills: skills.slice(0, cap).map(toOffender),
            agents: agents.slice(0, cap).map(toOffender),
            coverage: {
                totalTurns: coverage?.total_turns ?? 0,
                bustTurns: coverage?.bust_turns ?? 0,
                totalCacheCreationUsd: coverage?.total_cache_creation_usd ?? 0,
                bustCostUsd: coverage?.bust_cost_usd ?? 0,
            },
            corroboration: {
                comparableBusts: corroboration?.comparable_busts ?? 0,
                costUsd: corroboration?.cost_usd ?? 0,
                corroboratedUsd: corroboration?.corroborated_usd ?? 0,
            },
        };
        return result;
    },
);

// ---------------------------------------------------------------------------
// Minting-side offender rollup (slice B, #868)
// ---------------------------------------------------------------------------

/** One offender (a skill or an agent, native-attributed) over the window. */
export interface CacheLensCandidateRow {
    readonly kind: "skill" | "agent";
    /** attribution_skill / attribution_agent exactly as the harness stamped it. */
    readonly name: string;
    readonly busts: number;
    readonly sessions: number;
    /** Distinct UTC calendar days carrying a bust - the recurrence proxy. */
    readonly distinctDays: number;
    /** sum(bust_cost_usd) over ALL this offender's busts. */
    readonly bustCostUsd: number;
    /** busts where BOTH prices exist - the corroboration-comparable subset. */
    readonly comparableBusts: number;
    readonly comparableBustCostUsd: number;
    readonly comparableCorroboratedCostUsd: number;
    /** reason -> count, unsorted (evaluateCacheLensCandidate picks the dominant one). */
    readonly reasonCounts: ReadonlyArray<{ readonly reason: string; readonly count: number }>;
}

const OffenderRollupRow = Schema.Struct({
    kind: Schema.Union([Schema.Literal("skill"), Schema.Literal("agent")]),
    name: Schema.String,
    busts: NumberFromBigIntColumn,
    sessions: NumberFromBigIntColumn,
    distinct_days: NumberFromBigIntColumn,
    bust_cost_usd: Schema.Number,
    comparable_busts: NumberFromBigIntColumn,
    comparable_bust_cost_usd: Schema.Number,
    comparable_corroborated_cost_usd: Schema.Number,
});

const OffenderReasonRow = Schema.Struct({
    kind: Schema.Union([Schema.Literal("skill"), Schema.Literal("agent")]),
    name: Schema.String,
    reason: Schema.String,
    n: NumberFromBigIntColumn,
});

// Union the two attribution columns into one (kind, name) shape rather than
// two separate queries per column - `kind` distinguishes them downstream, and
// the union keeps the guard/derive pipeline column-count-agnostic (a THIRD
// native attribution dimension would be one more UNION branch, not a new
// consumer-side code path).
const OFFENDER_ROLLUP_SQL = `
    WITH busts AS (
        SELECT 'skill' AS kind, attribution_skill AS name, bust_cost_usd, corroborated_cost_usd, session, ts
        FROM cache_bust_event WHERE attribution_skill IS NOT NULL AND ts > ?
        UNION ALL
        SELECT 'agent' AS kind, attribution_agent AS name, bust_cost_usd, corroborated_cost_usd, session, ts
        FROM cache_bust_event WHERE attribution_agent IS NOT NULL AND ts > ?
    )
    SELECT kind, name,
           count(*) AS busts,
           count(DISTINCT session) AS sessions,
           count(DISTINCT CAST(ts AS DATE)) AS distinct_days,
           CAST(coalesce(sum(bust_cost_usd), 0) AS DOUBLE) AS bust_cost_usd,
           count(*) FILTER (WHERE bust_cost_usd IS NOT NULL AND corroborated_cost_usd IS NOT NULL) AS comparable_busts,
           CAST(coalesce(sum(bust_cost_usd) FILTER (WHERE bust_cost_usd IS NOT NULL AND corroborated_cost_usd IS NOT NULL), 0) AS DOUBLE) AS comparable_bust_cost_usd,
           CAST(coalesce(sum(corroborated_cost_usd) FILTER (WHERE bust_cost_usd IS NOT NULL AND corroborated_cost_usd IS NOT NULL), 0) AS DOUBLE) AS comparable_corroborated_cost_usd
    FROM busts
    GROUP BY kind, name`;

const OFFENDER_REASON_SQL = `
    WITH busts AS (
        SELECT 'skill' AS kind, attribution_skill AS name, reason
        FROM cache_bust_event WHERE attribution_skill IS NOT NULL AND ts > ?
        UNION ALL
        SELECT 'agent' AS kind, attribution_agent AS name, reason
        FROM cache_bust_event WHERE attribution_agent IS NOT NULL AND ts > ?
    )
    SELECT kind, name, reason, count(*) AS n
    FROM busts
    GROUP BY kind, name, reason`;

const offenderKey = (kind: string, name: string): string => `${kind}:${name}`;

/**
 * Per-offender (skill/agent) cache-bust rollup over the window, for the
 * derive-proposals mint pipeline. `read` is whatever `CacheReadService` the
 * caller has open - mid-ingest callers pass their `CacheWriteService` (this
 * run's live writes, including the cache-bust stage that ran just before);
 * an out-of-ingest caller could pass a plain `CacheRead` against the
 * published snapshot.
 */
export const fetchCacheLensCandidates = Effect.fn("queries.fetchCacheLensCandidates")(
    function* (read: CacheReadService, input: { readonly sinceDays: number }) {
        const cutoff = new Date(Date.now() - sqlWindowDays(input.sinceDays) * 86_400_000);
        const [rollups, reasons] = yield* Effect.all([
            read.rows(OffenderRollupRow, OFFENDER_ROLLUP_SQL, [cutoff, cutoff]),
            read.rows(OffenderReasonRow, OFFENDER_REASON_SQL, [cutoff, cutoff]),
        ], { concurrency: 2 });

        const reasonsByKey = new Map<string, Array<{ reason: string; count: number }>>();
        for (const r of reasons) {
            const key = offenderKey(r.kind, r.name);
            const list = reasonsByKey.get(key) ?? [];
            list.push({ reason: r.reason, count: r.n });
            reasonsByKey.set(key, list);
        }

        return rollups.map((row): CacheLensCandidateRow => ({
            kind: row.kind,
            name: row.name,
            busts: row.busts,
            sessions: row.sessions,
            distinctDays: row.distinct_days,
            bustCostUsd: row.bust_cost_usd,
            comparableBusts: row.comparable_busts,
            comparableBustCostUsd: row.comparable_bust_cost_usd,
            comparableCorroboratedCostUsd: row.comparable_corroborated_cost_usd,
            reasonCounts: reasonsByKey.get(offenderKey(row.kind, row.name)) ?? [],
        }));
    },
);
