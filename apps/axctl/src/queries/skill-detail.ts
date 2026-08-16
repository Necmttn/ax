/**
 * Per-skill detail payload powering the TUI DetailPane (incl. the 30-day
 * `daily` sparkline buckets), the web dashboard's "click recommendation
 * reason → see evidence" expand panel, and `GET /api/skills/:name/detail`.
 *
 * `fetchSkillDetail` (the dashboard-facing entry point) is ported onto the
 * DuckDB CacheRead seam below as five straightforward indexed lookups keyed
 * off the resolved skill id, rather than one SurrealQL `LET/RETURN` blob.
 * `SKILL_DETAIL_BASIC_SQL`/`SKILL_DETAIL_SQL` (built from
 * `skill-invocations-sql.ts`) are kept UNCHANGED and still exported: the TUI
 * (`tui/hooks/useSkillDetail.ts`, out of scope for this port) executes that
 * raw SurrealQL text directly against a live `SurrealClient` - it is a real,
 * still-live consumer, not dead code, so the string builder stays as-is.
 */
import { Effect, Schema } from "effect";
import { NumberFromBigIntColumn, TimestampColumn } from "@ax/lib/duckdb/columns";
import { cacheRows } from "@ax/lib/duckdb/query";
import { dateField, countField, stringField } from "@ax/lib/shared/row-fields";
import type {
    SkillDetailPayload,
    SkillPair,
    SkillProposalEvidence,
    SkillRecentInvocation,
} from "@ax/lib/shared/dashboard-types";
import { skillWithInvocationsSql } from "./skill-invocations-sql.ts";

/**
 * `daily` sparkline buckets - shared verbatim by both variants below.
 */
const DAILY_BLOCK = `    daily: (
        SELECT ts FROM invoked
        WHERE out = $s.id AND ts > time::now() - 30d
        ORDER BY ts ASC
    )`;

/**
 * 10 most recent invocations. The full variant additionally projects
 * `turn_has_error` for the dashboard's error badges; the TUI doesn't render
 * it, so the basic variant keeps the projection minimal.
 */
const recentBlock = (extraColumns: string) => `    recent: (
        SELECT ts, in.session.project AS project${extraColumns}
        FROM invoked
        WHERE out = $s.id
        ORDER BY ts DESC
        LIMIT 10
    )`;

/**
 * Two variants share this module (both compose the canonical
 * skill+invocations scaffold from `skill-invocations-sql.ts`):
 *
 * - `SKILL_DETAIL_BASIC_SQL` - the TUI hot path. The DetailPane re-queries on
 *   every (debounced) j/k selection change, so it only carries the lightweight
 *   blocks it renders: skill row, invocation counts, recent list, daily
 *   sparkline buckets. All filtered by the indexed `invoked.out`.
 * - `SKILL_DETAIL_SQL` - the full dashboard payload. Adds the evidence blocks
 *   (`corrections`, `proposals`, `paired`); `paired` looks up `skill_paired`
 *   by both endpoints (indexed: `skill_paired_in`/`skill_paired_out`). Still
 *   dashboard-only - the TUI's per-row selection keeps the lighter variant.
 */
export const SKILL_DETAIL_BASIC_SQL = skillWithInvocationsSql({
    windows: [7, 30],
    blocks: [recentBlock(""), DAILY_BLOCK],
});

export const SKILL_DETAIL_SQL = skillWithInvocationsSql({
    windows: [7, 30],
    blocks: [
        recentBlock(", turn_has_error"),
        DAILY_BLOCK,
        `    corrections: (
        SELECT ts, in.session.project AS project
        FROM invoked
        WHERE out = $s.id AND was_corrected = true
        ORDER BY ts DESC
        LIMIT 5
    )`,
        `    proposals: (
        -- Some legacy proposed edges have ts = epoch (ingest path used to skip
        -- the field). Fall back to the source turn's ts so the timeline reads
        -- correctly.
        SELECT
            (IF ts > d"1970-01-02" THEN ts ELSE in.ts END) AS ts,
            in.session.project AS project,
            context_excerpt
        FROM proposed
        WHERE out = $s.id
        ORDER BY ts DESC
        LIMIT 5
    )`,
        `    paired: (
        -- Skills that co-occurred in the same session within a turn window
        -- (denormalised by derive-signals). The pair is undirected, so we
        -- check both directions and surface the partner's name.
        -- Some legacy edges have last_seen = epoch; null those out so the
        -- UI can show "-" instead of 1970.
        SELECT
            (IF in = $s.id THEN out.name ELSE in.name END) AS partner,
            count,
            (IF last_seen > d"1970-01-02" THEN last_seen ELSE NONE END) AS last_seen
        FROM skill_paired
        WHERE in = $s.id OR out = $s.id
        ORDER BY count DESC
        LIMIT 5
    )`,
    ],
});

export const mapSkillRecentRow = (raw: unknown): SkillRecentInvocation | null => {
    if (!raw || typeof raw !== "object") return null;
    const row = raw as Record<string, unknown>;
    const ts = dateField(row, "ts") ?? "";
    if (!ts) return null;
    return {
        ts,
        project: stringField(row, "project"),
        ...(typeof row.turn_has_error === "boolean"
            ? { turn_has_error: row.turn_has_error }
            : {}),
    };
};

export const mapSkillPairRow = (raw: unknown): SkillPair | null => {
    if (!raw || typeof raw !== "object") return null;
    const row = raw as Record<string, unknown>;
    const partner = stringField(row, "partner");
    if (!partner) return null;
    return {
        partner,
        count: countField(row, "count"),
        last_seen: dateField(row, "last_seen"),
    };
};

export const mapSkillProposalRow = (raw: unknown): SkillProposalEvidence | null => {
    if (!raw || typeof raw !== "object") return null;
    const row = raw as Record<string, unknown>;
    const ts = dateField(row, "ts") ?? "";
    if (!ts) return null;
    return {
        ts,
        project: stringField(row, "project"),
        context_excerpt: stringField(row, "context_excerpt"),
    };
};

const SkillRowSchema = Schema.Struct({
    id: Schema.String,
    scope: Schema.NullOr(Schema.String),
    description: Schema.NullOr(Schema.String),
    dir_path: Schema.NullOr(Schema.String),
});

const SKILL_ROW_SQL = `SELECT id, scope, description, dir_path FROM skill WHERE name = ?;`;

const InvocationSummarySchemaRow = Schema.Struct({
    total: NumberFromBigIntColumn,
    d7: NumberFromBigIntColumn,
    d30: NumberFromBigIntColumn,
    last: Schema.NullOr(TimestampColumn),
});

/** `d7`/`d30` FILTER thresholds bind first (in text order), the skill id last. */
const INVOCATION_SUMMARY_SQL = `
SELECT
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE ts > CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - (CAST(? AS INTEGER) * INTERVAL '1 day')) AS d7,
    COUNT(*) FILTER (WHERE ts > CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - (CAST(? AS INTEGER) * INTERVAL '1 day')) AS d30,
    MAX(ts) AS last
FROM invoked
WHERE out_id = ?;
`;

const RecentInvocationSchemaRow = Schema.Struct({
    ts: TimestampColumn,
    project: Schema.NullOr(Schema.String),
    turn_has_error: Schema.NullOr(Schema.Boolean),
});

/** `invoked.session` is denormalised onto the edge - no need to dereference
 *  the source turn to reach the session's project. */
const RECENT_INVOCATIONS_SQL = `
SELECT i.ts AS ts, s.project AS project, i.turn_has_error AS turn_has_error
FROM invoked i
LEFT JOIN session s ON s.id = i.session
WHERE i.out_id = ?
ORDER BY i.ts DESC
LIMIT 10;
`;

const CorrectionSchemaRow = Schema.Struct({
    ts: TimestampColumn,
    project: Schema.NullOr(Schema.String),
});

const CORRECTIONS_SQL = `
SELECT i.ts AS ts, s.project AS project
FROM invoked i
LEFT JOIN session s ON s.id = i.session
WHERE i.out_id = ? AND i.was_corrected = TRUE
ORDER BY i.ts DESC
LIMIT 5;
`;

const ProposalSchemaRow = Schema.Struct({
    ts: TimestampColumn,
    project: Schema.NullOr(Schema.String),
    context_excerpt: Schema.NullOr(Schema.String),
});

/** `proposed` has no denormalised session, so `project` goes through the
 *  source turn. Some legacy `proposed` edges have `ts = epoch` (ingest used to
 *  skip the field) - fall back to the source turn's ts, same as the original
 *  SurrealQL `IF ts > d"1970-01-02" ...`. */
const PROPOSALS_SQL = `
SELECT
    CASE WHEN p.ts > TIMESTAMP '1970-01-02' THEN p.ts ELSE t.ts END AS ts,
    s.project AS project,
    p.context_excerpt AS context_excerpt
FROM proposed p
JOIN turn t ON t.id = p.in_id
LEFT JOIN session s ON s.id = t.session
WHERE p.out_id = ?
ORDER BY ts DESC
LIMIT 5;
`;

const PairedSchemaRow = Schema.Struct({
    partner: Schema.NullOr(Schema.String),
    count: NumberFromBigIntColumn,
    last_seen: Schema.NullOr(TimestampColumn),
});

/** Undirected pair: check both endpoints, surface the partner's name. Some
 *  legacy edges have `last_seen = epoch`; null those out (same as the
 *  original `IF last_seen > d"1970-01-02" ... ELSE NONE`). Skill id binds 3x:
 *  once to pick the partner side, twice for the endpoint filter. */
const PAIRED_SQL = `
SELECT
    CASE WHEN sp.in_id = ? THEN so.name ELSE si.name END AS partner,
    sp.count AS count,
    CASE WHEN sp.last_seen > TIMESTAMP '1970-01-02' THEN sp.last_seen ELSE NULL END AS last_seen
FROM skill_paired sp
LEFT JOIN skill si ON si.id = sp.in_id
LEFT JOIN skill so ON so.id = sp.out_id
WHERE sp.in_id = ? OR sp.out_id = ?
ORDER BY sp.count DESC
LIMIT 5;
`;

const EMPTY_SKILL_DETAIL_INVOCATIONS = { total: 0, d7: 0, d30: 0, last: null };

export const fetchSkillDetail = Effect.fn("queries.fetchSkillDetail")(
    function* (name: string) {
        const skillRows = yield* cacheRows(
            SkillRowSchema,
            { sql: SKILL_ROW_SQL, params: [name] },
            "skill detail skill row",
        );
        const skill = skillRows[0] ?? null;

        if (!skill) {
            return {
                name,
                scope: null,
                description: null,
                dir_path: null,
                invocations: EMPTY_SKILL_DETAIL_INVOCATIONS,
                recent: [],
                corrections: [],
                proposals: [],
                paired: [],
            } satisfies SkillDetailPayload;
        }

        const [invocationRows, recentRows, correctionRows, proposalRows, pairedRows] = yield* Effect.all([
            cacheRows(
                InvocationSummarySchemaRow,
                { sql: INVOCATION_SUMMARY_SQL, params: [7, 30, skill.id] },
                "skill detail invocations",
            ),
            cacheRows(
                RecentInvocationSchemaRow,
                { sql: RECENT_INVOCATIONS_SQL, params: [skill.id] },
                "skill detail recent",
            ),
            cacheRows(
                CorrectionSchemaRow,
                { sql: CORRECTIONS_SQL, params: [skill.id] },
                "skill detail corrections",
            ),
            cacheRows(
                ProposalSchemaRow,
                { sql: PROPOSALS_SQL, params: [skill.id] },
                "skill detail proposals",
            ),
            cacheRows(
                PairedSchemaRow,
                { sql: PAIRED_SQL, params: [skill.id, skill.id, skill.id] },
                "skill detail paired",
            ),
        ], { concurrency: 5 });

        const invocations = invocationRows[0];

        return {
            name,
            scope: skill.scope,
            description: skill.description,
            dir_path: skill.dir_path,
            invocations: invocations
                ? {
                    total: invocations.total,
                    d7: invocations.d7,
                    d30: invocations.d30,
                    last: dateField(invocations, "last"),
                }
                : EMPTY_SKILL_DETAIL_INVOCATIONS,
            recent: recentRows
                .map(mapSkillRecentRow)
                .filter((r): r is SkillRecentInvocation => r !== null),
            corrections: correctionRows
                .map(mapSkillRecentRow)
                .filter((r): r is SkillRecentInvocation => r !== null),
            proposals: proposalRows
                .map(mapSkillProposalRow)
                .filter((r): r is SkillProposalEvidence => r !== null),
            paired: pairedRows
                .map(mapSkillPairRow)
                .filter((r): r is SkillPair => r !== null),
        } satisfies SkillDetailPayload;
    },
);
