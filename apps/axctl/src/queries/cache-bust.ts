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
 * Corroboration compares complete Claude transcript cost with the independent
 * OTLP `claude_code.cost.usage` cost. Both values are grouped at root-session
 * grain, so one root never repeats its OTLP cost for each cache bust.
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
        /** root sessions where transcript and OTLP costs both exist */
        readonly comparableRoots: number;
        readonly estimatedUsd: number;
        readonly otlpUsd: number;
    };
}

export interface CacheBustCostInput {
    readonly sinceDays: number;
    readonly limit: number;
}

const sqlWindowDays = (n: number): number => Math.max(1, Math.trunc(n));

/** Difference from the independent value. Callers reject a non-positive
 * independent value before they call this helper. */
export const relativeCostDelta = (estimatedUsd: number, independentUsd: number): number =>
    Math.abs(estimatedUsd - independentUsd) / independentUsd;

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
    comparable_roots: NumberFromBigIntColumn,
    estimated_usd: Schema.NullOr(Schema.Number),
    otlp_usd: Schema.NullOr(Schema.Number),
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

// Parent/root lineage from `spawned` (parent -> child). This deliberately
// mirrors run-evidence-event.sql: min(in_id) makes duplicate parents
// deterministic and the depth cap stops cycles.
const ROOT_LINEAGE_CTE = `
    parent_of AS (
        SELECT out_id AS child, min(in_id) AS parent
        FROM spawned
        WHERE in_id IS NOT NULL AND out_id IS NOT NULL AND in_id <> out_id
        GROUP BY 1
    ),
    walk AS (
        SELECT child, parent, parent AS root, 1 AS depth FROM parent_of
        UNION ALL
        SELECT w.child, w.parent, p.parent AS root, w.depth + 1
        FROM walk w
        JOIN parent_of p ON p.child = w.root
        WHERE w.depth < 32
    ),
    lineage AS (
        SELECT child, arg_max(root, depth) AS root
        FROM walk
        GROUP BY child
    )`;

const CORROBORATION_SQL = `
    WITH RECURSIVE
    ${ROOT_LINEAGE_CTE},
    bust_roots AS (
        SELECT DISTINCT coalesce(l.root, cbe.session) AS root_session
        FROM cache_bust_event cbe
        LEFT JOIN lineage l ON l.child = cbe.session
        WHERE cbe.ts > ?
    ),
    transcript_cost AS (
        SELECT coalesce(l.root, ttu.session) AS root_session,
               sum(ttu.estimated_cost_usd) AS estimated_usd
        FROM turn_token_usage ttu
        LEFT JOIN lineage l ON l.child = ttu.session
        WHERE ttu.source LIKE 'claude%'
          AND ttu.estimated_cost_usd IS NOT NULL
          AND coalesce(l.root, ttu.session) IN (SELECT root_session FROM bust_roots)
        GROUP BY 1
    ),
    otlp_cost AS (
        SELECT session_id AS root_session, sum(value) AS otlp_usd
        FROM otel_metric_point
        WHERE harness = 'claude'
          AND metric = 'claude_code.cost.usage'
          AND session_id IN (SELECT root_session FROM bust_roots)
        GROUP BY 1
    )
    SELECT count(*) AS comparable_roots,
           coalesce(sum(tc.estimated_usd), 0) AS estimated_usd,
           coalesce(sum(oc.otlp_usd), 0) AS otlp_usd
    FROM bust_roots br
    JOIN transcript_cost tc ON tc.root_session = br.root_session
    JOIN otlp_cost oc ON oc.root_session = br.root_session
    WHERE tc.estimated_usd > 0 AND oc.otlp_usd > 0`;

const EMPTY_RESULT: CacheBustCostResult = {
    reasons: [],
    skills: [],
    agents: [],
    coverage: { totalTurns: 0, bustTurns: 0, totalCacheCreationUsd: 0, bustCostUsd: 0 },
    corroboration: { comparableRoots: 0, estimatedUsd: 0, otlpUsd: 0 },
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
                comparableRoots: corroboration?.comparable_roots ?? 0,
                estimatedUsd: corroboration?.estimated_usd ?? 0,
                otlpUsd: corroboration?.otlp_usd ?? 0,
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
    /** Distinct sessions carrying a bust - the recurrence proxy (see #943:
     *  a UTC-calendar-day count miscounts across timezone boundaries - one
     *  local workday straddling UTC midnight reads as two days, and two
     *  local workdays sharing a UTC date read as one). */
    readonly sessions: number;
    /** sum(bust_cost_usd) over ALL this offender's busts. */
    readonly bustCostUsd: number;
    /** root sessions where full transcript and OTLP costs both exist. */
    readonly comparableRoots: number;
    readonly comparableEstimatedUsd: number;
    readonly comparableOtlpUsd: number;
    /** reason -> count, unsorted (evaluateCacheLensCandidate picks the dominant one). */
    readonly reasonCounts: ReadonlyArray<{ readonly reason: string; readonly count: number }>;
}

const OffenderRollupRow = Schema.Struct({
    kind: Schema.Union([Schema.Literal("skill"), Schema.Literal("agent")]),
    name: Schema.String,
    busts: NumberFromBigIntColumn,
    sessions: NumberFromBigIntColumn,
    bust_cost_usd: Schema.Number,
    comparable_roots: NumberFromBigIntColumn,
    comparable_estimated_usd: Schema.Number,
    comparable_otlp_usd: Schema.Number,
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
    WITH RECURSIVE
    ${ROOT_LINEAGE_CTE},
    busts AS (
        SELECT 'skill' AS kind, attribution_skill AS name, bust_cost_usd, session
        FROM cache_bust_event WHERE attribution_skill IS NOT NULL AND ts > ?
        UNION ALL
        SELECT 'agent' AS kind, attribution_agent AS name, bust_cost_usd, session
        FROM cache_bust_event WHERE attribution_agent IS NOT NULL AND ts > ?
    ),
    offender_roots AS (
        SELECT DISTINCT b.kind, b.name, coalesce(l.root, b.session) AS root_session
        FROM busts b
        LEFT JOIN lineage l ON l.child = b.session
    ),
    transcript_cost AS (
        SELECT coalesce(l.root, ttu.session) AS root_session,
               sum(ttu.estimated_cost_usd) AS estimated_usd
        FROM turn_token_usage ttu
        LEFT JOIN lineage l ON l.child = ttu.session
        WHERE ttu.source LIKE 'claude%'
          AND ttu.estimated_cost_usd IS NOT NULL
          AND coalesce(l.root, ttu.session) IN (SELECT root_session FROM offender_roots)
        GROUP BY 1
    ),
    otlp_cost AS (
        SELECT session_id AS root_session, sum(value) AS otlp_usd
        FROM otel_metric_point
        WHERE harness = 'claude'
          AND metric = 'claude_code.cost.usage'
          AND session_id IN (SELECT root_session FROM offender_roots)
        GROUP BY 1
    ),
    comparable AS (
        SELECT r.kind, r.name, r.root_session, tc.estimated_usd, oc.otlp_usd
        FROM offender_roots r
        JOIN transcript_cost tc ON tc.root_session = r.root_session
        JOIN otlp_cost oc ON oc.root_session = r.root_session
        WHERE tc.estimated_usd > 0 AND oc.otlp_usd > 0
    ),
    comparable_rollup AS (
        SELECT kind, name,
               count(*) AS comparable_roots,
               CAST(coalesce(sum(estimated_usd), 0) AS DOUBLE) AS comparable_estimated_usd,
               CAST(coalesce(sum(otlp_usd), 0) AS DOUBLE) AS comparable_otlp_usd
        FROM comparable
        GROUP BY kind, name
    ),
    bust_rollup AS (
        SELECT kind, name,
               count(*) AS busts,
               count(DISTINCT session) AS sessions,
               CAST(coalesce(sum(bust_cost_usd), 0) AS DOUBLE) AS bust_cost_usd
        FROM busts
        GROUP BY kind, name
    )
    SELECT b.kind, b.name, b.busts, b.sessions, b.bust_cost_usd,
           coalesce(c.comparable_roots, 0) AS comparable_roots,
           coalesce(c.comparable_estimated_usd, 0) AS comparable_estimated_usd,
           coalesce(c.comparable_otlp_usd, 0) AS comparable_otlp_usd
    FROM bust_rollup b
    LEFT JOIN comparable_rollup c ON c.kind = b.kind AND c.name = b.name`;

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
            bustCostUsd: row.bust_cost_usd,
            comparableRoots: row.comparable_roots,
            comparableEstimatedUsd: row.comparable_estimated_usd,
            comparableOtlpUsd: row.comparable_otlp_usd,
            reasonCounts: reasonsByKey.get(offenderKey(row.kind, row.name)) ?? [],
        }));
    },
);
